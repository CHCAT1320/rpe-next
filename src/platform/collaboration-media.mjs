const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');

async function parallelJobs(jobs, run, signal) {
  let next = 0; let failure;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (!failure && next < jobs.length) {
      signal.throwIfAborted();
      const job = jobs[next++];
      try { await run(job); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}

export class CollaborationMedia extends EventTarget {
  constructor({ request = globalThis.fetch.bind(globalThis) } = {}) { super(); this.request = request; this.received = new Map(); }
  configure(server, room, token) {
    this.close(); this.received.clear();
    const url = new URL(server); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = `/collab/media/${encodeURIComponent(room)}/`; url.search = ''; url.hash = '';
    this.base = url; this.token = token;
  }
  progress(detail) { this.dispatchEvent(new CustomEvent('progress', { detail })); }
  async fetch(path, options, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(60000);
      try {
        const response = await this.request(new URL(path, this.base), { ...options, signal: AbortSignal.any([signal, timeout]), credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', headers: { ...options?.headers, Authorization: `Bearer ${this.token}` } });
        if (!response.ok) {
          const error = new Error((await response.json().catch(() => null))?.error ?? `素材请求失败（${response.status}）`); error.status = response.status; throw error;
        }
        return options?.binary ? new Uint8Array(await response.arrayBuffer()) : await response.json();
      } catch (error) {
        if (signal.aborted || attempt === 2 || error.status && ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  async publish(assets) {
    this.upload?.abort(); const controller = new AbortController(); this.upload = controller;
    const signal = controller.signal; const files = [];
    try {
      for (const [name, bytes] of assets) {
        signal.throwIfAborted(); this.progress({ phase: 'hash', name });
        files.push({ name, bytes, size: bytes.length, hash: await digest(bytes) });
      }
      const prepare = await this.fetch('prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: files.map(({ name, size, hash }) => ({ name, size, hash })) }) }, signal);
      if (!/^[0-9a-f]{32}$/.test(prepare.id) || prepare.chunkSize !== 1024 * 1024 || !Array.isArray(prepare.missing) || prepare.missing.length > files.length) throw new Error('服务器素材上传参数无效');
      const unique = new Map(files.map(file => [file.hash, file])); const jobs = [];
      for (const hash of prepare.missing) {
        const file = unique.get(hash); if (!file) throw new Error('服务器素材列表无效');
        for (let index = 0; index < Math.ceil(file.size / prepare.chunkSize); index++) jobs.push({ file, index });
      }
      let sent = 0; const total = prepare.missing.reduce((sum, hash) => sum + unique.get(hash).size, 0); const started = performance.now();
      await parallelJobs(jobs, async ({ file, index }) => {
        const bytes = file.bytes.subarray(index * prepare.chunkSize, (index + 1) * prepare.chunkSize);
        await this.fetch(`upload/${prepare.id}/${file.hash}/${index}`, { method: 'PUT', body: bytes }, signal);
        sent += bytes.length; this.progress({ phase: 'upload', name: file.name, bytes: sent, total, seconds: (performance.now() - started) / 1000 });
      }, signal);
      this.progress({ phase: 'commit', bytes: sent, total });
      const manifest = await this.fetch(`commit/${prepare.id}`, { method: 'POST' }, signal);
      this.progress({ phase: 'published', count: files.length, skippedBytes: files.reduce((sum, file) => sum + file.size, 0) - total });
      return manifest;
    } finally { if (this.upload === controller) this.upload = null; }
  }
  async receive(manifest, install) {
    this.download?.abort(); const controller = new AbortController(); this.download = controller;
    const signal = controller.signal;
    try {
      if (!manifest || !/^[0-9a-f]{32}$/.test(manifest.id) || manifest.chunkSize !== 1024 * 1024 || !Array.isArray(manifest.files) || manifest.files.length > 512) throw new Error('素材清单无效');
      for (const file of manifest.files) {
        if (!file || !/^[0-9a-f]{64}$/.test(file.hash) || typeof file.name !== 'string' || file.name.length > 256 || /(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)/.test(file.name) || !/\.(png|jpe?g|webp|gif|ogg|mp3|wav|flac|m4a)$/i.test(file.name) || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 128 * 1024 * 1024) throw new Error('素材清单无效');
      }
      if (manifest.files.reduce((sum, file) => sum + file.size, 0) > 512 * 1024 * 1024) throw new Error('素材组超过 512 MiB');
      for (const file of [...manifest.files].sort((left, right) => left.size - right.size)) {
        if (this.received.get(file.name) === file.hash) continue;
        signal.throwIfAborted(); const bytes = new Uint8Array(file.size); let received = 0; const started = performance.now();
        const jobs = Array.from({ length: Math.ceil(file.size / manifest.chunkSize) }, (_, index) => index);
        await parallelJobs(jobs, async index => {
          const part = await this.fetch(`file/${manifest.id}/${file.hash}/${index}`, { method: 'GET', binary: true }, signal);
          const expected = Math.min(manifest.chunkSize, file.size - index * manifest.chunkSize);
          if (part.length !== expected) throw new Error('素材下载长度不正确');
          bytes.set(part, index * manifest.chunkSize); received += part.length;
          this.progress({ phase: 'download', name: file.name, bytes: received, total: file.size, seconds: (performance.now() - started) / 1000 });
        }, signal);
        if (await digest(bytes) !== file.hash) throw new Error('素材校验失败，请重新勾选接收以重试');
        signal.throwIfAborted(); await install(file.name, bytes); signal.throwIfAborted(); this.received.set(file.name, file.hash);
      }
      this.progress({ phase: 'received', count: manifest.files.length });
    } catch (error) { if (!signal.aborted) throw error; }
    finally { if (this.download === controller) this.download = null; }
  }
  stopReceiving() { this.download?.abort(); this.download = null; }
  close() { this.upload?.abort(); this.upload = null; this.stopReceiving(); this.token = null; this.base = null; }
}
