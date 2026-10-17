import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chunkSize = 1024 * 1024;
const roomLimit = 512 * 1024 * 1024;
const storageLimit = 2 * 1024 * 1024 * 1024;
const validHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (response, value) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };

async function body(request, limit, progress = () => {}) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('请求数据过大', 413);
    chunks.push(chunk);
    progress(size);
  }
  return Buffer.concat(chunks);
}

export class CollaborationAssetStore {
  static async create(options) { return new CollaborationAssetStore(await mkdtemp(join(tmpdir(), 'rpe-next-media-')), options); }
  constructor(root, { onDiagnostic = () => {}, onUploadProgress = () => {} } = {}) {
    this.root = root; this.rooms = new Map(); this.tasks = new Set(); this.active = 0; this.closed = false;
    this.onDiagnostic = onDiagnostic; this.onUploadProgress = onUploadProgress;
  }
  manifest(room) { return this.rooms.get(room)?.current ?? null; }
  async writeUpload(room, member, id, hash, index, read, abort, channel) {
    const state = this.rooms.get(room.id); const pending = state?.pending;
    if (!pending || pending.id !== id || state.busy) throw fail('素材上传已过期或正在提交', 409);
    const file = pending.uploads.get(hash);
    if (!file || !Number.isInteger(index) || index < 0 || index >= Math.ceil(file.size / chunkSize)) throw fail('素材块无效');
    const previous = file.writing.get(index);
    if (previous) {
      if (channel !== 'socket' || previous.channel !== 'http') throw fail('素材块仍在写入', 409);
      previous.abort(); await previous.finished;
    }
    if (state.pending !== pending || state.busy || file.writing.has(index)) throw fail('素材上传已变更', 409);
    const expected = Math.min(chunkSize, file.size - index * chunkSize);
    let finish; const finished = new Promise(resolve => { finish = resolve; });
    file.writing.set(index, { abort, finished, channel });
    let reported = -1; let reportedAt = 0;
    const report = (phase, bytes) => {
      const details = { phase, channel, index, bytes, total: expected };
      this.onDiagnostic({ ...details, phase: `media-upload-${phase}` });
      this.onUploadProgress(member, { ...details, upload: id, fileIndex: pending.files.findIndex(file => file.hash === hash) });
    };
    report('accepted', 0);
    try {
      const bytes = await read(expected, received => {
        if (reported < 0 || received === expected || received - reported >= 65536 && Date.now() - reportedAt >= 500) {
          reported = received; reportedAt = Date.now(); report('receiving', received);
        }
      });
      if (bytes.length !== expected) throw fail('素材块长度不正确');
      if (state.pending !== pending) throw fail('素材上传已被替换', 409);
      report('writing', bytes.length);
      const target = join(this.root, room.id, pending.id, `${hash}.${index}`);
      await writeFile(`${target}.tmp`, bytes, { mode: 0o600 }); await rename(`${target}.tmp`, target); file.chunks.add(index);
      report('stored', bytes.length); return { received: bytes.length };
    } catch (error) { report('failed', 0); throw error; }
    finally { file.writing.delete(index); finish(); }
  }
  async uploadSocket(room, member, message) {
    if (member.id !== room.host || member.socket?.readyState !== 1) throw fail('仅在线房主可发布素材', 403);
    if (!/^[0-9a-f]{32}$/.test(message.upload) || !validHash(message.hash) || typeof message.data !== 'string' || message.data.length > 4 * Math.ceil(chunkSize / 3) || message.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw fail('素材块无效');
    if (this.closed || this.active >= 32 || (member.mediaRequests ?? 0) >= 6) throw fail('素材请求繁忙，请稍后重试', 429);
    this.active++; member.mediaRequests = (member.mediaRequests ?? 0) + 1;
    const task = this.writeUpload(room, member, message.upload, message.hash, message.index, async () => Buffer.from(message.data, 'base64'), () => {}, 'socket');
    this.tasks.add(task);
    try { return await task; }
    finally { this.tasks.delete(task); this.active--; member.mediaRequests--; }
  }
  async resumeUpload(room, member, id) {
    if (member.id !== room.host || member.socket?.readyState !== 1) throw fail('仅在线房主可发布素材', 403);
    const state = this.rooms.get(room.id); const pending = state?.pending;
    if (this.closed || !pending || pending.id !== id || state.busy) throw fail('素材上传已过期或正在提交', 409);
    const writers = [...pending.uploads.values()].flatMap(file => [...file.writing.values()].filter(writer => writer.channel === 'http'));
    for (const writer of writers) writer.abort();
    await Promise.all(writers.map(writer => writer.finished));
    if (state.pending !== pending || state.busy) throw fail('素材上传已变更', 409);
    const completed = [...pending.uploads].flatMap(([hash, file]) => [...file.chunks].map(index => ({ hash, index })));
    this.onDiagnostic({ phase: 'media-upload-resumed', cancelledRequests: writers.length, completedChunks: completed.length });
    return { completed };
  }
  async handle(request, response, rooms, publish) {
    if (!request.url?.startsWith('/collab/media/')) return false;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    response.setHeader('Access-Control-Max-Age', '600');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return true; }
    const task = this.route(request, response, rooms, publish);
    this.tasks.add(task);
    try { await task; }
    catch (error) {
      if (!response.headersSent) { response.statusCode = error.status ?? 500; json(response, { error: error.status ? error.message : '素材服务暂不可用，请重试' }); }
      else response.destroy();
    } finally { this.tasks.delete(task); }
    return true;
  }
  async route(request, response, rooms, publish) {
    const path = request.url.split('?')[0].split('/');
    const room = rooms.get(path[3]);
    const authorization = request.headers.authorization;
    const member = room && [...room.members.values()].find(entry => entry.mediaToken && authorization === `Bearer ${entry.mediaToken}` && entry.socket?.readyState === 1);
    if (!member) throw fail('素材访问未授权或连接已断开', 403);
    if (this.closed || this.active >= 32 || (member.mediaRequests ?? 0) >= 6) throw fail('素材请求繁忙，请稍后重试', 429);
    this.active++; member.mediaRequests = (member.mediaRequests ?? 0) + 1; room.touched = Date.now();
    try {
      if (request.method === 'GET' && path[4] === 'file' && path.length === 8) {
        const current = this.manifest(room.id); const hash = path[6]; const index = Number(path[7]);
        const file = current?.id === path[5] && current.files.find(file => file.hash === hash);
        if (!file || !Number.isInteger(index) || index < 0 || index >= Math.ceil(file.size / chunkSize)) throw fail('素材不存在或已更新', 404);
        const bytes = Buffer.alloc(Math.min(chunkSize, file.size - index * chunkSize));
        const handle = await open(join(this.root, room.id, `${hash}.bin`), 'r');
        try { const result = await handle.read(bytes, 0, bytes.length, index * chunkSize); if (result.bytesRead !== bytes.length) throw fail('素材读取不完整', 500); }
        finally { await handle.close(); }
        response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Content-Length', bytes.length);
        await new Promise(resolve => { response.once('close', resolve); response.end(bytes, resolve); }); return;
      }
      if (member.id !== room.host) throw fail('仅房主可发布素材', 403);
      let state = this.rooms.get(room.id);
      if (request.method === 'POST' && path[4] === 'prepare' && path.length === 5) {
        const parsed = JSON.parse((await body(request, 256 * 1024)).toString());
        const files = parsed.files;
        if (!Array.isArray(files) || files.length > 512) throw fail('素材列表无效');
        const names = new Set(); const hashes = new Map();
        for (const file of files) {
          if (!file || typeof file.name !== 'string' || file.name.length > 256 || /(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)/.test(file.name) || !/\.(png|jpe?g|webp|gif|ogg|mp3|wav|flac|m4a)$/i.test(file.name) || !validHash(file.hash) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 128 * 1024 * 1024 || names.has(file.name)) throw fail('素材名称、大小或校验值无效');
          if (hashes.has(file.hash) && hashes.get(file.hash) !== file.size) throw fail('素材大小不一致');
          names.add(file.name); hashes.set(file.hash, file.size);
        }
        if ([...hashes.values()].reduce((sum, size) => sum + size, 0) > roomLimit) throw fail('一组素材最多 512 MiB');
        if (state?.busy || state?.pending && [...state.pending.uploads.values()].some(file => file.writing.size)) throw fail('上一组素材仍在处理中', 409);
        if (!state) { state = { cached: new Map(), current: null, pending: null, busy: true }; this.rooms.set(room.id, state); }
        else state.busy = true;
        try {
          const reserved = [...this.rooms.values()].reduce((sum, entry) => sum + [...entry.cached.values()].reduce((total, size) => total + size, 0) + (entry === state ? 0 : entry.reserved ?? 0), 0);
          const missing = [...hashes].filter(([hash, size]) => state.cached.get(hash) !== size);
          const bytes = missing.reduce((sum, [, size]) => sum + size, 0);
          if (reserved + bytes > storageLimit) throw fail('服务器素材暂存空间已满，请减少素材后重试', 507);
          state.reserved = bytes;
          if (state.pending) await rm(join(this.root, room.id, state.pending.id), { recursive: true, force: true });
          const id = randomBytes(16).toString('hex');
          const pending = { id, reserved: bytes, files: files.map(({ name, hash, size }) => ({ name, hash, size })), uploads: new Map(missing.map(([hash, size]) => [hash, { size, chunks: new Set(), writing: new Map() }])) };
          state.pending = pending;
          await mkdir(join(this.root, room.id, id), { recursive: true, mode: 0o700 });
          json(response, { id, chunkSize, missing: missing.map(([hash]) => hash) }); return;
        } finally { state.busy = false; }
      }
      if (request.method === 'POST' && path[4] === 'commit' && state?.current?.id === path[5]) { publish(room, state.current); json(response, state.current); return; }
      const pending = state?.pending;
      if (!pending || pending.id !== path[5] || state.busy) throw fail('素材上传已过期或正在提交', 409);
      if (request.method === 'PUT' && path[4] === 'upload' && path.length === 8) {
        request.setTimeout(30000, () => request.destroy());
        try {
          const result = await this.writeUpload(room, member, path[5], path[6], Number(path[7]), (expected, progress) => body(request, expected, progress), () => request.destroy(), 'http');
          json(response, result); return;
        } finally { request.setTimeout(0); }
      }
      if (request.method === 'POST' && path[4] === 'commit' && path.length === 6) {
        for (const file of pending.uploads.values()) if (file.writing.size || file.chunks.size !== Math.ceil(file.size / chunkSize)) throw fail('素材尚未上传完整', 409);
        state.busy = true;
        try {
          for (const [hash, file] of pending.uploads) {
            const target = join(this.root, room.id, `${hash}.bin`); const temporary = join(this.root, room.id, pending.id, `${hash}.tmp`);
            const handle = await open(temporary, 'w', 0o600); const digest = createHash('sha256');
            try {
              for (let index = 0; index < file.chunks.size; index++) {
                const bytes = await readFile(join(this.root, room.id, pending.id, `${hash}.${index}`)); digest.update(bytes); await handle.writeFile(bytes);
              }
            } finally { await handle.close(); }
            if (digest.digest('hex') !== hash) throw fail('素材校验失败，请重新发送');
            await rename(temporary, target); state.cached.set(hash, file.size);
          }
          const current = { id: pending.id, files: pending.files, chunkSize };
          state.current = current; state.pending = null; state.reserved = 0;
          await rm(join(this.root, room.id, pending.id), { recursive: true, force: true });
          const retained = new Set(current.files.map(file => file.hash));
          for (const hash of state.cached.keys()) if (!retained.has(hash)) {
            try { await rm(join(this.root, room.id, `${hash}.bin`), { force: true }); state.cached.delete(hash); } catch {}
          }
          publish(room, current); json(response, current); return;
        } finally { state.busy = false; }
      }
      throw fail('素材接口不存在', 404);
    } finally { this.active--; member.mediaRequests--; }
  }
  async remove(room) { this.rooms.delete(room); await rm(join(this.root, room), { recursive: true, force: true }); }
  async close() { this.closed = true; await Promise.allSettled([...this.tasks]); await rm(this.root, { recursive: true, force: true }); this.rooms.clear(); }
}
