import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { applyChanges, changeResources, cleanProfile, COLLAB_ID, COLLAB_PROTOCOL, validateData, validateIdentities, validateNewEventOverlaps } from '../src/core/collaboration.mjs';
import { assertChart } from '../src/core/chart.mjs';

const token = () => randomBytes(24).toString('base64url');
const send = (socket, message) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 32 * 1024 * 1024) { socket.close(1013, '同步过慢，请重连'); return; }
  socket.send(JSON.stringify(message));
};

export async function startCollaborationServer({ port = 4182, host = '127.0.0.1', maxRooms = 20, maxMembers = 12, onStatus = () => {}, creationKey = '' } = {}) {
  const rooms = new Map();
  const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ service: 'RPE Next 协作', protocol: COLLAB_PROTOCOL })); }
    else { response.writeHead(404); response.end('{}'); }
  });
  const wss = new WebSocketServer({ server: http, path: '/collab', maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  const status = () => onStatus({ rooms: rooms.size, users: [...rooms.values()].reduce((sum, room) => sum + [...room.members.values()].filter(member => member.socket?.readyState === WebSocket.OPEN).length, 0) });
  const broadcast = (room, message, except = null) => { for (const member of room.members.values()) if (member.id !== except) send(member.socket, message); };
  const members = room => [...room.members.values()].map(member => ({ id: member.id, ...member.profile, online: member.socket?.readyState === WebSocket.OPEN, host: member.id === room.host, stats: member.stats, presence: member.presence }));
  const publishMembers = room => { broadcast(room, { type: 'members', members: members(room) }); status(); };
  const locks = room => [...room.locks].map(([id, lock]) => ({ id, owner: lock.owner }));
  const publishLocks = room => broadcast(room, { type: 'locks', locks: locks(room) });
  const welcome = (room, member) => {
    send(member.socket, { type: 'welcome', protocol: COLLAB_PROTOCOL, id: member.id, resume: member.resume, room: room.id, invite: room.invite, host: room.host, chart: room.chart, revision: room.revision, members: members(room), locks: locks(room), chat: room.chat });
    publishMembers(room);
  };
  const memberFor = (socket, profile) => ({ id: token(), resume: token(), profile: cleanProfile(profile), socket, stats: { notes: 0, events: 0, operations: 0 }, presence: null });
  wss.on('connection', socket => {
    socket.alive = true; socket.on('pong', () => { socket.alive = true; });
    let room; let member; let pendingRoom; let windowStart = Date.now(); let count = 0; let bytes = 0;
    const timeout = setTimeout(() => { if (!member && !pendingRoom) socket.close(1008, '加入超时'); }, 15000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      try {
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; bytes = 0; }
        if (++count > 100 || (bytes += raw.length) > 70 * 1024 * 1024) throw new Error('消息发送过于频繁');
        const message = JSON.parse(raw.toString()); validateData(message);
        if (!member) {
          if (pendingRoom) throw new Error('等待房主批准');
          if (message.type === 'create') {
            if (creationKey && message.creationKey !== creationKey) throw new Error('创建密钥不正确，请向服务器维护者获取');
            if (rooms.size >= maxRooms) throw new Error('服务器房间已满');
            assertChart(message.chart); validateIdentities(message.chart);
            room = { id: token(), invite: token(), chart: message.chart, revision: 0, members: new Map(), locks: new Map(), pending: new Map(), chat: [], accepted: new Map(), touched: Date.now() };
            member = memberFor(socket, message.profile); room.host = member.id; room.members.set(member.id, member); rooms.set(room.id, room); welcome(room, member);
          } else if (message.type === 'join') {
            room = rooms.get(message.room);
            if (!room || room.invite !== message.token) throw new Error('房间不存在或邀请已失效');
            const previous = [...room.members.values()].find(entry => message.resume && entry.resume === message.resume);
            if (previous) { previous.socket?.close(4000, '已重新连接'); member = previous; member.socket = socket; welcome(room, member); }
            else {
              if (room.members.size + room.pending.size >= maxMembers) throw new Error('房间人数已满');
              if (room.members.get(room.host)?.socket?.readyState !== WebSocket.OPEN) throw new Error('房主离线，请稍后加入');
              pendingRoom = room; const request = token();
              room.pending.set(request, { socket, profile: cleanProfile(message.profile), approve: () => { member = memberFor(socket, message.profile); room.members.set(member.id, member); pendingRoom = null; welcome(room, member); }, created: Date.now() });
              send(socket, { type: 'waiting' }); send(room.members.get(room.host).socket, { type: 'request', request, profile: cleanProfile(message.profile) });
            }
          } else throw new Error('请先创建或加入房间');
          return;
        }
        room.touched = Date.now();
        if (message.type === 'ping') { send(socket, { type: 'pong', time: message.time }); return; }
        if (message.type === 'approve' && member.id === room.host) {
          const pending = room.pending.get(message.request); if (!pending) return;
          room.pending.delete(message.request);
          if (message.allow) pending.approve(); else { send(pending.socket, { type: 'error', message: '房主拒绝了加入请求' }); pending.socket.close(4003); }
        } else if (message.type === 'kick' && member.id === room.host && message.id !== room.host) {
          const target = room.members.get(message.id); if (!target) return;
          target.socket?.close(4003, '已被房主移出'); room.members.delete(target.id);
          for (const [id, lock] of room.locks) if (lock.owner === target.id) room.locks.delete(id);
          publishMembers(room); publishLocks(room);
        } else if (message.type === 'presence') {
          member.presence = { seconds: Number(message.seconds) || 0, line: Math.max(0, Math.trunc(Number(message.line) || 0)), cursor: message.cursor, latency: Math.max(0, Math.min(60000, Number(message.latency) || 0)) };
          if (JSON.stringify(member.presence).length > 2000) throw new Error('光标数据过大');
          broadcast(room, { type: 'presence', id: member.id, ...member.presence }, member.id);
        } else if (message.type === 'signal') {
          if (JSON.stringify(message.signal).length > 32768) throw new Error('连接信息过大');
          send(room.members.get(message.to)?.socket, { type: 'signal', from: member.id, signal: message.signal });
        } else if (message.type === 'locks') {
          const requested = new Set(Array.isArray(message.ids) ? message.ids.filter(id => typeof id === 'string').slice(0, 50000) : []);
          const conflicts = [...requested].filter(id => room.locks.has(id) && room.locks.get(id).owner !== member.id);
          for (const [id, lock] of room.locks) if (lock.owner === member.id && !requested.has(id)) room.locks.delete(id);
          if (!conflicts.length) for (const id of requested) room.locks.set(id, { owner: member.id, expires: Date.now() + 12000 });
          send(socket, { type: 'lock-result', conflicts }); publishLocks(room);
        } else if (message.type === 'edit') {
          if (room.accepted.has(message.operation)) { send(socket, { type: 'receipt', operation: message.operation }); return; }
          try {
            if (room.members.get(room.host)?.socket?.readyState !== WebSocket.OPEN) throw new Error('房主离线，编辑已暂停');
            if (typeof message.operation !== 'string' || message.operation.length > 100) throw new Error('操作编号无效');
            for (const change of message.changes ?? []) for (const id of changeResources(change)) {
              const lock = room.locks.get(id); if (lock && lock.owner !== member.id) throw new Error(`该物件由 ${room.members.get(lock.owner)?.profile.name ?? '其他用户'} 编辑中`);
            }
            const next = applyChanges(room.chart, message.changes); assertChart(next); validateIdentities(next); validateNewEventOverlaps(room.chart, next);
            room.chart = next; room.revision++;
            room.accepted.set(message.operation, room.revision); if (room.accepted.size > 3000) room.accepted.delete(room.accepted.keys().next().value);
            member.stats.operations++;
            for (const change of message.changes) {
              if (change.path.includes('notes')) member.stats.notes++;
              else if (change.path.some(key => typeof key === 'string' && (key.endsWith('Events') || key === 'effects'))) member.stats.events++;
            }
            broadcast(room, { type: 'edit', id: member.id, operation: message.operation, changes: message.changes, label: String(message.label ?? '联机编辑').slice(0, 80), revision: room.revision, stats: member.stats });
          } catch (error) { send(socket, { type: 'rejected', operation: message.operation, message: error.message, chart: room.chart, revision: room.revision }); }
        } else if (message.type === 'chat') {
          const text = String(message.text ?? '').trim().slice(0, 1000); if (!text) return;
          const item = { id: member.id, name: member.profile.name, color: member.profile.color, text, time: Date.now() };
          room.chat.push(item); if (room.chat.length > 100) room.chat.shift(); broadcast(room, { type: 'chat', item });
        } else if (message.type === 'asset') {
          if (member.id !== room.host) throw new Error('仅房主可发送共享素材');
          if (typeof message.name !== 'string' || message.name.length > 256 || /(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)/.test(message.name) || !/\.(png|jpe?g|webp|gif|ogg|mp3|wav|flac|m4a)$/i.test(message.name)) throw new Error('素材名称或格式不允许');
          if (!Number.isInteger(message.index) || !Number.isInteger(message.total) || message.total < 1 || message.total > 8192 || message.index < 0 || message.index >= message.total || typeof message.data !== 'string' || message.data.length > 90000 || !/^[0-9a-f]{64}$/.test(message.hash)) throw new Error('素材块无效');
          broadcast(room, { ...message, type: 'asset', from: member.id }, member.id);
        } else throw new Error('不支持的消息或无权限');
      } catch (error) { send(socket, { type: 'error', message: String(error.message).slice(0, 180) }); }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (pendingRoom) for (const [id, pending] of pendingRoom.pending) if (pending.socket === socket) pendingRoom.pending.delete(id);
      if (!member || member.socket !== socket) return;
      member.socket = null; room.touched = Date.now();
      for (const [id, lock] of room.locks) if (lock.owner === member.id) room.locks.delete(id);
      publishMembers(room); publishLocks(room);
    });
  });
  const timer = setInterval(() => {
    for (const [id, room] of rooms) {
      let changed = false;
      for (const [key, lock] of room.locks) if (lock.expires < Date.now()) { room.locks.delete(key); changed = true; }
      if (changed) publishLocks(room);
      for (const [key, pending] of room.pending) if (Date.now() - pending.created > 60000) { pending.socket.close(4003, '批准超时'); room.pending.delete(key); }
      if (![...room.members.values()].some(member => member.socket) && Date.now() - room.touched > 30 * 60 * 1000) rooms.delete(id);
    }
    status();
  }, 3000);
  timer.unref();
  const heartbeat = setInterval(() => { for (const socket of wss.clients) { if (!socket.alive) socket.terminate(); else { socket.alive = false; socket.ping(); } } }, 15000); heartbeat.unref();
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
  return { port: http.address().port, rooms, close: async () => { clearInterval(timer); clearInterval(heartbeat); for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await startCollaborationServer({ port: Number(process.env.RPE_COLLAB_PORT ?? 4182), host: process.env.RPE_COLLAB_HOST ?? '127.0.0.1', creationKey: process.env.RPE_COLLAB_KEY ?? '' });
  console.log(`RPE Next 协作服务已启动：ws://127.0.0.1:${service.port}/collab`);
  process.on('SIGINT', async () => { await service.close(); process.exit(0); });
}
