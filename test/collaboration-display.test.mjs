import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationPanel } from '../src/ui/collaboration.mjs';
import { collaborationMarkerPosition, collaborationLabelBackground } from '../src/ui/collaboration-display.mjs';

class Element {
  children = []; style = {}; hidden = false; value = ''; classes = new Set();
  classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  get firstElementChild() { return this.children[0]; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  blur() { this.blurred = true; }
  focus() { this.focused = true; }
}

function documentFor(context) {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  context.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}

test('第三人审批按钮在其他成员连续同步位置时保留，可正常点击', context => {
  documentFor(context);
  const panel = Object.create(CollaborationPanel.prototype); const approvals = [];
  for (const key of ['status', 'create', 'join', 'name', 'color', 'server', 'copy', 'leave', 'share', 'recovery', 'requests', 'users']) panel[key] = new Element();
  panel.transport = { peers: new Map() };
  panel.client = { id: 'host', host: 'host', active: true, ready: true, queue: [], members: [], requests: [{ request: 'third', profile: { name: 'Third' } }], approve: (...args) => approvals.push(args) };
  panel.renderState(); const approve = panel.requests.children[0].children[1];
  for (let index = 0; index < 20; index++) { panel.client.latency = index; panel.renderState(); }
  assert.equal(panel.requests.children[0].children[1], approve);
  approve.onclick(); assert.deepEqual(approvals, [['third', true]]);
});

test('协作者时间标记按音频秒、延迟与滑条轨道映射，不依赖谱面拍数', () => {
  const range = { offset: 0.5, minimum: 0, maximum: 180, width: 376 };
  assert.equal(collaborationMarkerPosition(-0.5, range), 8);
  assert.equal(collaborationMarkerPosition(89.5, range), 188);
  assert.equal(collaborationMarkerPosition(179.5, range), 368);
  assert.equal(collaborationMarkerPosition(900, range), 368);
  assert.equal(collaborationMarkerPosition(40, { ...range, minimum: -10, maximum: 90, offset: 0 }), 188);
  assert.equal(collaborationLabelBackground('#001020'), '#ffffff');
  assert.equal(collaborationLabelBackground('#ffdc70'), '#000000');
});

test('聊天发送后关闭输入框，焦点移出输入框后 Esc 仍能关闭，组合输入不被截断', () => {
  const panel = Object.create(CollaborationPanel.prototype); const sent = [];
  panel.client = { active: true }; panel.chatBox = new Element(); panel.chatInput = new Element();
  panel.transport = { send: message => sent.push(message) };
  const event = (key, target = {}) => ({ key, target, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const escape = event('Escape'); panel.handleChatKey(escape);
  assert.equal(panel.chatBox.hidden, true); assert.equal(escape.stopped, true);
  panel.chatBox.hidden = false; panel.chatInput.value = '协作消息';
  panel.handleChatKey({ ...event('Enter', panel.chatInput), isComposing: true }); assert.equal(sent.length, 0);
  panel.handleChatKey(event('Enter', panel.chatInput));
  assert.deepEqual(sent, [{ type: 'chat', text: '协作消息' }]); assert.equal(panel.chatBox.hidden, true);
});

test('聊天消息独立计时，五秒后淡出，六秒后移除，新消息不延长旧消息寿命', context => {
  documentFor(context); context.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = Object.create(CollaborationPanel.prototype);
  panel.chatLog = new Element(); panel.toast = new Element(); panel.chatBox = new Element(); panel.chatBox.hidden = true;
  panel.client = { active: true, chat: [{ name: 'First', color: '#fff', text: 'one', time: 1 }] };
  panel.renderChat(); const first = panel.toast.children[0]; context.mock.timers.tick(4000);
  panel.client.chat.push({ name: 'Second', color: '#fff', text: 'two', time: 2 }); panel.renderChat();
  context.mock.timers.tick(1000); assert.equal(first.classes.has('leaving'), true); assert.equal(panel.toast.children.length, 2);
  context.mock.timers.tick(1000); assert.equal(panel.toast.children.length, 1);
  context.mock.timers.tick(3000); assert.equal(panel.toast.children[0].classes.has('leaving'), true);
  context.mock.timers.tick(1000); assert.equal(panel.toast.children.length, 0);
});

test('输入聊天时收到的消息不会在隐藏中到期，发送关闭后完整展示并淡出', context => {
  documentFor(context); context.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = Object.create(CollaborationPanel.prototype);
  for (const key of ['chatLog', 'toast', 'chatBox', 'chatInput']) panel[key] = new Element();
  panel.client = { active: true, chat: [{ name: 'Peer', color: '#000000', text: '收到消息', time: 1 }] };
  panel.renderChat(); const message = panel.toast.children[0];
  assert.equal(panel.toast.hidden, true);
  context.mock.timers.tick(10000);
  assert.equal(panel.toast.children.length, 1); assert.equal(message.classes.has('leaving'), false);
  panel.transport = { send() {} }; panel.chatInput.value = '回复';
  panel.handleChatKey({ key: 'Enter', target: panel.chatInput, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(panel.chatBox.hidden, true); assert.equal(panel.toast.hidden, false);
  context.mock.timers.tick(5000); assert.equal(message.classes.has('leaving'), true);
  panel.openChat(); context.mock.timers.tick(10000);
  assert.equal(panel.toast.children.length, 1); assert.equal(message.classes.has('leaving'), false);
  panel.closeChat(); context.mock.timers.tick(5000); context.mock.timers.tick(1000); assert.equal(panel.toast.children.length, 0);
});

test('输入框关闭后收到自己的回传消息会立即显示浮层，重复刷新不隐藏或重置计时', context => {
  documentFor(context); context.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = Object.create(CollaborationPanel.prototype);
  for (const key of ['chatLog', 'toast', 'chatBox', 'chatInput']) panel[key] = new Element();
  panel.client = { active: true, chat: [] }; panel.renderChat(); panel.closeChat();
  panel.client.chat.push({ name: 'Self', color: '#fff', text: '已发送', time: 1 }); panel.renderChat();
  assert.equal(panel.toast.hidden, false); assert.equal(panel.toast.children[0].textContent, 'Self：已发送');
  context.mock.timers.tick(4000); panel.renderChat(); context.mock.timers.tick(1000); context.mock.timers.tick(1000);
  assert.equal(panel.toast.children.length, 0);
});
