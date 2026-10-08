export class CollaborationTransport extends EventTarget {
  constructor() { super(); this.peers = new Map(); this.connected = false; this.closed = false; }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  connect(url, hello) {
    clearTimeout(this.retry);
    this.url = url; this.hello = hello; this.closed = false;
    const socket = new WebSocket(url); this.socket = socket;
    socket.onopen = () => { if (this.socket !== socket) return; this.connected = true; this.send(this.hello); this.emit('state', '已连接，正在同步'); };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') {
          this.id = message.id;
          this.hello = { type: 'join', room: message.room, token: message.invite, resume: message.resume, profile: hello.profile };
        }
        if (message.type === 'signal') { this.signal(message).catch(() => this.dropPeer(message.from)); return; }
        if (message.type === 'members' || message.type === 'welcome') this.updatePeers(message.members);
        this.emit('message', message);
      } catch { this.emit('state', '收到无效消息'); }
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.connected = false; for (const id of this.peers.keys()) this.dropPeer(id);
      this.emit('state', event.code === 4003 ? '加入被拒绝或已被移出' : '连接已断开，编辑暂停');
      if (!this.closed && this.hello.resume && event.code !== 4003 && event.code !== 4000) this.retry = setTimeout(() => this.connect(url, this.hello), 2500);
    };
    socket.onerror = () => { if (this.socket === socket) this.emit('state', '连接失败，请检查服务器地址或联系维护者'); };
  }
  send(message) {
    if (!this.connected || this.socket.readyState !== WebSocket.OPEN) throw new Error('尚未连接，修改不会发送');
    if (this.socket.bufferedAmount > 8 * 1024 * 1024) throw new Error('网络拥堵，请稍后重试');
    this.socket.send(JSON.stringify(message));
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
  close() { this.closed = true; clearTimeout(this.retry); this.connected = false; const socket = this.socket; this.socket = null; socket?.close(); for (const id of this.peers.keys()) this.dropPeer(id); }
}
