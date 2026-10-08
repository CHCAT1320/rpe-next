import { COLLAB_ID, identifyChart, chartChanges, applyChanges, inverseChanges, changeResources, cleanProfile, validateData, validateIdentities, shareChartReferences } from '../core/collaboration.mjs';
import { assertChart } from '../core/chart.mjs';
import { eventListAt } from './event-commands.mjs';
import { remapSelection, restoreSelection } from './selection-history.mjs';

export class CollaborationClient extends EventTarget {
  constructor(transport, { session, receiveChart, notify, interactionBusy = () => false }) {
    super(); this.transport = transport; this.getSession = session; this.receiveChart = receiveChart; this.notify = notify;
    this.interactionBusy = interactionBusy;
    this.queue = []; this.undo = []; this.redo = []; this.members = []; this.locks = new Map(); this.requests = []; this.chat = []; this.state = '未连接';
    transport.addEventListener('message', event => this.message(event.detail));
    transport.addEventListener('state', event => { this.state = event.detail; this.changed(); });
  }
  changed() { this.dispatchEvent(new Event('change')); }
  connect(server, profile, invitation = null, creationKey = '') {
    this.queue = []; this.undo = []; this.redo = []; this.requests = []; this.chat = []; this.authoritative = null; this.deferred = null;
    this.profile = cleanProfile(profile); this.server = server;
    const chart = invitation ? null : identifyChart(this.getSession().chart);
    try { this.transport.connect(server, invitation ? { type: 'join', ...invitation, profile: this.profile } : { type: 'create', chart, profile: this.profile, creationKey }); }
    catch (error) { this.active = false; this.state = '连接未建立'; this.changed(); throw error; }
    this.active = true;
    this.session = this.getSession(); this.session.collaboration = this;
    this.state = '连接中'; this.changed();
  }
  get ready() { return this.active && this.transport.connected && this.authoritative && this.members.some(member => member.id === this.host && member.online); }
  attach(session) { session.collaboration = this; this.session = session; this.syncHistory(); }
  syncHistory() { if (this.session) { this.session.history.undoStack = this.undo; this.session.history.redoStack = this.redo; } }
  setChart(chart, local = false) {
    const session = this.session; const source = session.chart; const selection = session.selectionState();
    chart = shareChartReferences(source, chart);
    session.history.document = chart;
    if (!local) restoreSelection(session, remapSelection(source, chart, selection));
    this.syncHistory(); session.notify();
  }
  commit(label, chart) {
    try {
      if (!this.ready) throw new Error('联机尚未就绪或房主离线，编辑暂停');
      const next = identifyChart(chart); const changes = chartChanges(this.session.chart, next); if (!changes.length) return;
      for (const change of changes) for (const id of changeResources(change)) {
        const owner = this.locks.get(id); if (owner && owner !== this.id) throw new Error(`该物件由 ${this.members.find(member => member.id === owner)?.name ?? '其他用户'} 编辑中`);
      }
      const operation = { type: 'edit', operation: crypto.randomUUID(), label, changes };
      this.queue.push(operation); this.setChart(next, true); this.flush(); this.changed();
    } catch (error) { this.notify(error.message, 'warning'); this.session.notify(); }
  }
  flush() {
    const first = this.queue[0];
    if (!first || first.sent || !this.ready) return;
    this.transport.send({ type: 'edit', operation: first.operation, label: first.label, changes: first.changes }); first.sent = true;
  }
  travel(direction) {
    if (this.queue.length) { this.notify('等待本次修改同步完成后再撤销', 'warning'); return; }
    const entry = (direction === 'undo' ? this.undo : this.redo).at(-1); if (!entry) return;
    try {
      const changes = direction === 'undo' ? inverseChanges(entry.changes) : entry.changes;
      const next = applyChanges(this.session.chart, changes);
      this.commit(`${direction === 'undo' ? '撤销' : '重做'}：${entry.label}`, next);
      if (this.queue.length) this.queue.at(-1).travel = { direction, entry };
    } catch (error) { this.notify(`无法覆盖他人的后续修改：${error.message}`, 'warning'); }
  }
  message(message) {
    try {
      if (message.type === 'welcome') {
        validateData(message.chart); assertChart(message.chart); validateIdentities(message.chart);
        this.id = message.id; this.host = message.host; this.room = message.room; this.token = message.invite;
        const reconnect = Boolean(this.authoritative); this.authoritative = message.chart; this.revision = message.revision; this.members = message.members; this.chat = message.chat;
        this.locks = new Map(message.locks.map(lock => [lock.id, lock.owner]));
        if (!reconnect) { this.receiveChart(message.chart, this.id === this.host); this.attach(this.getSession()); this.undo = []; this.redo = []; this.setChart(message.chart); }
        else {
          this.recoveryChart = this.queue.length ? structuredClone(this.session.chart) : this.recoveryChart;
          this.setChart(message.chart);
          const pending = this.queue.splice(0);
          if (pending.length) this.notify('重连已恢复最新谱面；未确认操作已保留为本地恢复副本', 'warning');
          this.recovery = pending;
        }
        this.state = '已连接'; this.syncHistory();
        if (!reconnect) this.notify('已加入联机房间：按 / 打开聊天，Enter 发送，Esc 关闭', 'success', 6000);
      } else if (message.type === 'members') this.members = message.members;
      else if (message.type === 'locks') this.locks = new Map(message.locks.map(lock => [lock.id, lock.owner]));
      else if (message.type === 'lock-result' && message.conflicts.length) this.notify('选中内容正由其他人编辑，暂不可修改', 'warning');
      else if (message.type === 'waiting') this.state = '等待房主批准';
      else if (message.type === 'request') this.requests.push(message);
      else if (message.type === 'pong') this.latency = Math.max(0, Date.now() - message.time);
      else if (message.type === 'presence') {
        const member = this.members.find(member => member.id === message.id);
        if (member && Number.isFinite(message.seconds) && Number.isInteger(message.line)) {
          if (message.direct) member.directAt = performance.now();
          if (message.direct || performance.now() - (member.directAt ?? -10000) > 1500) member.presence = message;
          member.seen = performance.now();
        }
      } else if (message.type === 'chat') { this.chat.push(message.item); if (this.chat.length > 100) this.chat.shift(); }
      else if (message.type === 'edit') {
        if (message.revision <= this.revision) return;
        const next = applyChanges(this.authoritative, message.changes); assertChart(next); validateIdentities(next); this.authoritative = next; this.revision = message.revision;
        const own = this.queue.find(entry => entry.operation === message.operation);
        if (own) {
          this.queue = this.queue.filter(entry => entry !== own);
          if (own.travel) {
            const { direction, entry } = own.travel;
            (direction === 'undo' ? this.undo : this.redo).pop(); (direction === 'undo' ? this.redo : this.undo).push(entry);
          } else { this.undo.push({ label: own.label, changes: own.changes }); this.redo = []; if (this.undo.length > 150) this.undo.shift(); }
        }
        const member = this.members.find(member => member.id === message.id); if (member) member.stats = message.stats;
        this.rebase();
      } else if (message.type === 'rejected') {
        this.recoveryChart = structuredClone(this.session.chart);
        this.recovery = [...this.queue]; this.queue = []; this.authoritative = message.chart; this.revision = message.revision;
        this.setChart(message.chart); this.notify(message.message, 'warning');
      } else if (message.type === 'error') this.notify(message.message, 'error');
      else if (message.type === 'asset') this.dispatchEvent(new CustomEvent('asset', { detail: message }));
      this.changed();
    } catch (error) { this.transport.trace?.('apply-failed', { type: message.type, error: error.name }); this.state = '同步异常，已暂停'; this.transport.close(); this.notify(error.message, 'error'); this.changed(); }
  }
  rebase() {
    let chart = this.authoritative;
    try { for (const pending of this.queue) chart = applyChanges(chart, pending.changes); }
    catch { this.recoveryChart = structuredClone(this.session.chart); this.recovery = [...this.queue]; this.queue = []; chart = this.authoritative; this.notify('操作与他人修改冲突，已恢复确认版本', 'warning'); }
    if (this.interactionBusy()) this.deferred = chart; else { this.deferred = null; this.setChart(chart); }
    this.flush();
  }
  finishInteraction() { if (this.deferred && !this.interactionBusy()) { this.deferred = null; this.rebase(); } }
  selectionIds() {
    const session = this.session; if (!session) return [];
    const ids = session.selectedNoteEntries().map(entry => entry.note[COLLAB_ID]);
    const groups = session.multiLineActive && session.multiLineMode === 'events' ? session.multiEventSelection : new Map([[session.lineIndex, session.eventSelection]]);
    for (const [line, keys] of groups) for (const key of keys) {
      const [type, index] = key.split(':'); ids.push(eventListAt(session, line, type)?.[index]?.[COLLAB_ID]);
    }
    return [...new Set(ids.filter(Boolean))];
  }
  approve(request, allow) { this.transport.send({ type: 'approve', request, allow }); this.requests = this.requests.filter(entry => entry.request !== request); this.changed(); }
  leave() {
    this.active = false; this.transport.close();
    if (this.session) {
      this.session.collaboration = null;
      if (this.authoritative) { this.session.history.undoStack = []; this.session.history.redoStack = []; }
      this.session.notify();
    }
    this.authoritative = null; this.deferred = null; this.queue = []; this.members = []; this.requests = []; this.chat = []; this.locks.clear(); this.state = '已离开，当前谱面保留在本地'; this.changed();
  }
}
