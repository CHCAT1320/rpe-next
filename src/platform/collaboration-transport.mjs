import { CollaborationMessageReader, CollaborationMessageSender, CollaborationSyncDeadline } from '../core/collaboration-wire.mjs';
import { CollaborationMedia } from './collaboration-media.mjs';

export class CollaborationTransport extends EventTarget {
  constructor() {
    super(); this.peers = new Map(); this.connected = false; this.closed = false; this.diagnostics = []; this.assetReceipts = new Map(); this.media = new CollaborationMedia();
    this.media.addEventListener('progress', event => {
      const progress = event.detail;
      if (['upload', 'download'].includes(progress.phase) && progress.bytes === progress.total) this.trace(`media-${progress.phase}-complete`, { bytes: progress.bytes, seconds: Number(progress.seconds.toFixed(2)), concurrency: 4 });
    });
  }
  trace(phase, details = {}) {
    this.diagnostics.push({ time: new Date().toISOString(), phase, ...details });
    if (this.diagnostics.length > 200) this.diagnostics.shift();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  connect(url, hello) {
    clearTimeout(this.retry);
    this.syncDeadline?.stop();
    this.cancelAssetTransfers(); this.media.close(); this.mediaHttp = false; this.assetDelivery = false;
    this.url = url; this.hello = { acceptOwnChart: true, ...hello }; this.closed = false;
    const socket = new WebSocket(url); this.socket = socket;
    const reader = new CollaborationMessageReader(receipt => socket.send(JSON.stringify(receipt)));
    let synchronized = false; let uploadPercent = -1; let downloadPercent = -1;
    const deadline = new CollaborationSyncDeadline(reason => {
      if (this.socket !== socket) return;
      this.trace('sync-timeout', { reason });
      this.emit('message', { type: 'error', message: reason === 'idle' ? '谱面同步已连续 60 秒没有进展，请检查网络或导出联机诊断' : '谱面同步超过 10 分钟，请检查网络或导出联机诊断' });
      socket.close();
    });
    this.syncDeadline = deadline;
    this.sender = new CollaborationMessageSender(socket, error => { this.trace('send-failed', { error: error.name }); socket.close(); }, progress => {
      if (this.socket !== socket || synchronized || !['create', 'join'].includes(progress.type)) return;
      deadline.progress();
      const percent = Math.floor(progress.sent / progress.total * 100);
      if (progress.type === 'create' && percent !== uploadPercent) {
        uploadPercent = percent;
        this.emit('state', percent === 100 ? '谱面已发送，等待服务器确认' : `正在发送谱面 ${percent}%`);
        if (percent % 10 === 0) this.trace('sync-sending', { sent: progress.sent, total: progress.total });
      }
    });
    this.trace('connect', { operation: hello.type, secure: url.startsWith('wss:'), acknowledgementWindow: 16, maximumWindow: 128 });
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.connected = true; this.trace('socket-open');
      deadline.start(); this.emit('state', '已连接，正在同步');
      try { this.send(this.hello); }
      catch (error) { this.trace('hello-failed', { error: error.name }); this.emit('message', { type: 'error', message: error.message }); socket.close(); }
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const message = reader.read(event.data);
        if (message?.type === '$rpeAck') { this.sender.acknowledge(message); return; }
        if (!synchronized) {
          if (!deadline.active) deadline.start(); else deadline.progress();
        }
        if (!message) {
          const percent = Math.floor(reader.parts.length / reader.total * 100);
          if (!synchronized && percent !== downloadPercent) { downloadPercent = percent; this.emit('state', `正在接收谱面 ${percent}%`); }
          if (reader.parts.length === 1 || reader.parts.length % 64 === 0) this.trace('sync-receiving', { parts: reader.parts.length, total: reader.total, bytes: reader.bytes });
          return;
        }
        if (!['presence', 'locks', 'pong', 'signal', 'lock-result'].includes(message.type)) this.trace('receive', { type: message.type, bytes: event.data.length, members: message.members?.length });
        if (['welcome', 'waiting', 'error'].includes(message.type)) deadline.stop();
        if (message.type === 'welcome') {
          if (message.chartAccepted) {
            if (this.hello.type !== 'create' || !this.hello.chart || message.id !== message.host || message.revision !== 0) throw new Error('谱面确认不匹配');
            message.chart = this.hello.chart;
          }
          synchronized = true;
          this.mediaHttp = message.mediaHttp === true;
          this.trace('media-channel', { binaryHttp: this.mediaHttp });
          if (this.mediaHttp) this.media.configure(url, message.room, message.mediaToken);
          this.assetDelivery = message.assetDelivery === true;
          if (this.assetDelivery && this.acceptAssets !== undefined) this.send({ type: 'asset-subscribe', enabled: this.acceptAssets });
          this.id = message.id;
          this.hello = { type: 'join', room: message.room, token: message.invite, resume: message.resume, profile: hello.profile };
        }
        if (message.type === 'asset-delivered') {
          const receipt = this.assetReceipts.get(message.delivery);
          if (receipt) { clearTimeout(receipt.timer); this.assetReceipts.delete(message.delivery); receipt.resolve(message); }
          return;
        }
        if (message.type === 'signal') { this.signal(message).catch(() => this.dropPeer(message.from)); return; }
        if (message.type === 'members' || message.type === 'welcome') {
          try { this.updatePeers(message.members); } catch (error) { this.trace('p2p-fallback', { error: error.name }); }
        }
        this.emit('message', message);
      } catch (error) { this.trace('decode-failed', { error: error.name }); this.emit('state', '收到无效消息，请导出联机诊断'); }
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      deadline.stop(); this.sender.close(); this.cancelAssetTransfers(); this.media.close(); this.trace('socket-close', { code: event.code, clean: event.wasClean, pendingParts: reader.parts.length, receivedBytes: reader.bytes });
      this.connected = false; for (const id of this.peers.keys()) this.dropPeer(id);
      this.emit('state', event.code === 4003 ? '加入被拒绝或已被移出' : `连接已断开（${event.code}），编辑暂停`);
      if (!this.closed && this.hello.resume && event.code !== 4003 && event.code !== 4000) this.retry = setTimeout(() => this.connect(url, this.hello), 2500);
    };
    socket.onerror = () => { if (this.socket === socket) { this.trace('socket-error'); this.emit('state', '连接失败，请检查服务器地址或联系维护者'); } };
  }
  send(message) {
    if (!this.connected || this.socket.readyState !== WebSocket.OPEN) throw new Error('尚未连接，修改不会发送');
    this.sender.send(message);
    if (['create', 'join', 'approve', 'edit'].includes(message.type)) this.trace('send', { type: message.type, bytes: new TextEncoder().encode(JSON.stringify(message)).byteLength });
  }
  subscribeAssets(enabled) {
    this.acceptAssets = Boolean(enabled);
    if (!enabled) this.media.stopReceiving();
    if (this.connected && this.assetDelivery) this.send({ type: 'asset-subscribe', enabled: this.acceptAssets });
  }
  async sendAsset(message) {
    if (!this.connected) throw new Error('传输连接已关闭');
    if (!this.assetDelivery) { await this.sender.sendAsync(message); return; }
    if (this.assetReceipts.size >= 4) throw new Error('素材发送窗口已满');
    const delivery = crypto.randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.assetReceipts.delete(delivery); reject(new Error('素材接收超过 60 秒没有确认，请检查接收者连接')); }, 60000);
      this.assetReceipts.set(delivery, { resolve, reject, timer });
      try { this.send({ ...message, delivery }); }
      catch (error) { clearTimeout(timer); this.assetReceipts.delete(delivery); reject(error); }
    });
    if (result.failed) throw new Error('部分接收者连接中断，请重新发送素材');
    if (!result.recipients) throw new Error('没有已开启接收素材的在线协作者');
  }
  cancelAssetTransfers() {
    for (const receipt of this.assetReceipts.values()) { clearTimeout(receipt.timer); receipt.reject(new Error('素材传输连接已关闭')); }
    this.assetReceipts.clear();
  }
  presence(message) {
    const frame = JSON.stringify({ ...message, type: 'presence', id: this.id });
    for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open' && peer.channel.bufferedAmount < 16384) peer.channel.send(frame);
    this.send(message);
  }
  updatePeers(members) {
    const online = new Set(members.filter(member => member.online && member.id !== this.id).map(member => member.id));
    for (const id of this.peers.keys()) if (!online.has(id)) this.dropPeer(id);
    if (typeof RTCPeerConnection === 'undefined') return;
    for (const id of online) if (!this.peers.has(id)) {
      const connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
      const peer = { connection, candidates: [] }; this.peers.set(id, peer);
      connection.onicecandidate = event => { if (event.candidate && this.connected) this.send({ type: 'signal', to: id, signal: { candidate: event.candidate.toJSON() } }); };
      const attach = channel => {
        peer.channel = channel;
        channel.onmessage = event => {
          if (typeof event.data !== 'string' || event.data.length > 3000) return;
          try { const message = JSON.parse(event.data); if (message.type === 'presence') this.emit('message', { ...message, id, direct: true }); } catch {}
        };
      };
      connection.ondatachannel = event => attach(event.channel);
      if (this.id < id) {
        attach(connection.createDataChannel('presence', { ordered: false, maxRetransmits: 0 }));
        connection.createOffer().then(offer => connection.setLocalDescription(offer)).then(() => this.send({ type: 'signal', to: id, signal: { description: connection.localDescription } })).catch(() => this.dropPeer(id));
      }
    }
  }
  async signal(message) {
    const peer = this.peers.get(message.from); if (!peer) return;
    if (message.signal.description) {
      await peer.connection.setRemoteDescription(message.signal.description);
      for (const candidate of peer.candidates.splice(0)) await peer.connection.addIceCandidate(candidate);
      if (message.signal.description.type === 'offer') {
        await peer.connection.setLocalDescription(await peer.connection.createAnswer());
        this.send({ type: 'signal', to: message.from, signal: { description: peer.connection.localDescription } });
      }
    } else if (message.signal.candidate) {
      if (peer.connection.remoteDescription) await peer.connection.addIceCandidate(message.signal.candidate);
      else peer.candidates.push(message.signal.candidate);
    }
  }
  dropPeer(id) { this.peers.get(id)?.connection.close(); this.peers.delete(id); }
  close() { this.closed = true; clearTimeout(this.retry); this.syncDeadline?.stop(); this.sender?.close(); this.cancelAssetTransfers(); this.media.close(); this.connected = false; const socket = this.socket; this.socket = null; socket?.close(); for (const id of this.peers.keys()) this.dropPeer(id); }
}
