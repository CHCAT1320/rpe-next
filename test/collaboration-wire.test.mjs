import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationMessageReader, CollaborationMessageSender, CollaborationSyncDeadline, encodeCollaborationMessage } from '../src/core/collaboration-wire.mjs';

test('同步持续有进展时跨过旧的 15/30 秒限制；结束后取消计时', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timeouts = []; const deadline = new CollaborationSyncDeadline(reason => timeouts.push(reason));
  deadline.start();
  for (let index = 0; index < 8; index++) { context.mock.timers.tick(20000); deadline.progress(); }
  assert.deepEqual(timeouts, []); deadline.stop(); context.mock.timers.tick(600000); assert.deepEqual(timeouts, []);
});

test('同步连续空闲超过一分钟仍会超时，不允许小流量无限延长总时限', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const timeouts = []; const deadline = new CollaborationSyncDeadline(reason => timeouts.push(reason));
  deadline.start(); context.mock.timers.tick(60000); assert.deepEqual(timeouts, ['idle']);
  deadline.start();
  for (let index = 0; index < 20; index++) { context.mock.timers.tick(30000); deadline.progress(); }
  assert.deepEqual(timeouts, ['idle', 'total']);
});

test('大谱面 Unicode、转义内容分片后完整恢复，每帧小于 64 KiB', () => {
  const message = { type: 'create', chart: { META: { song: '音乐.ogg', background: '曲绘.png' }, data: ('😀音符\\\n"').repeat(20000) } };
  const frames = encodeCollaborationMessage(message); const reader = new CollaborationMessageReader();
  assert.ok(frames.length > 10);
  for (const frame of frames) assert.ok(Buffer.byteLength(frame) < 65536);
  const result = frames.map(frame => reader.read(frame));
  assert.ok(result.slice(0, -1).every(message => message === null));
  assert.deepEqual(result.at(-1), message); assert.equal(reader.parts.length, 0);
});

test('拒绝乱序、超大分片和不同消息交错，普通小消息仍兼容', () => {
  const reader = new CollaborationMessageReader();
  assert.deepEqual(reader.read('{"type":"ping"}'), { type: 'ping' });
  assert.throws(() => reader.read(JSON.stringify({ type: '$rpeFrame', index: 1, total: 2, data: '{}' })), /无效/);
  assert.throws(() => reader.read(JSON.stringify({ type: '$rpeFrame', index: 0, total: 1, data: 'a'.repeat(9000) })), /无效/);
  reader.read(JSON.stringify({ type: '$rpeFrame', index: 0, total: 2, data: '{' }));
  assert.throws(() => reader.read('{"type":"ping"}'), /中断/);
});

test('发送队列等待底层缓冲排空，不丢分片或让后续消息插入当前消息', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const frames = []; const socket = { readyState: 1, bufferedAmount: 600000, send(frame) { frames.push(frame); } };
  const sender = new CollaborationMessageSender(socket);
  const chart = { type: 'create', data: 'x'.repeat(100000) }; sender.send(chart); sender.send({ type: 'presence', seconds: 42 });
  assert.equal(frames.length, 0); socket.bufferedAmount = 0; context.mock.timers.tick(8);
  const reader = new CollaborationMessageReader(receipt => sender.acknowledge(receipt)); const messages = [];
  for (const frame of frames) { const message = reader.read(frame); if (message) messages.push(message); }
  assert.deepEqual(messages, [chart, { type: 'presence', seconds: 42 }]); assert.equal(sender.bytes, 0);
  sender.close();
});

test('对端未确认时最多发送 16 片，进度使用对端确认值，重复确认不扩大发送窗口', () => {
  const frames = []; const progress = [];
  const socket = { readyState: 1, bufferedAmount: 0, send(frame) { frames.push(frame); } };
  const sender = new CollaborationMessageSender(socket, () => {}, value => progress.push(value));
  sender.send({ type: 'create', data: 'x'.repeat(600000) });
  assert.equal(frames.length, 16); assert.deepEqual(progress, []);
  const id = JSON.parse(frames[0]).id;
  assert.throws(() => sender.acknowledge({ id, received: 17 }), /无效/);
  sender.acknowledge({ id, received: 8 }); assert.equal(frames.length, 24); assert.equal(progress.at(-1).sent, 8);
  sender.acknowledge({ id, received: 8 }); assert.equal(frames.length, 24);
  const reader = new CollaborationMessageReader(); reader.read(frames[0]);
  assert.equal(reader.read(JSON.stringify({ type: '$rpeAck', id: 99, received: 1 })).type, '$rpeAck');
  assert.equal(reader.parts.length, 1);
  sender.close();
});

test('连续确认后扩大窗口但不超过 128 片，异步发送在完整确认后结束', async () => {
  const frames = []; const socket = { readyState: 1, bufferedAmount: 0, send(frame) { frames.push(frame); } };
  const sender = new CollaborationMessageSender(socket); let finished = false;
  const sent = sender.sendAsync({ type: 'asset', data: 'x'.repeat(4000000) }).then(() => { finished = true; });
  const id = JSON.parse(frames[0]).id;
  sender.acknowledge({ id, received: 16 }); assert.equal(frames.length, 48);
  sender.acknowledge({ id, received: 48 }); assert.equal(frames.length, 112);
  sender.acknowledge({ id, received: 112 }); assert.equal(frames.length, 240);
  sender.acknowledge({ id, received: 240 }); assert.equal(frames.length, 368);
  assert.equal(finished, false);
  const reader = new CollaborationMessageReader(receipt => sender.acknowledge(receipt));
  for (const frame of frames) reader.read(frame);
  await sent; assert.equal(finished, true); assert.equal(sender.bytes, 0); sender.close();
});

test('连接关闭会终止等待中的异步素材发送', async () => {
  const sender = new CollaborationMessageSender({ readyState: 1, bufferedAmount: 0, send() {} });
  const pending = sender.sendAsync({ type: 'asset', data: 'x'.repeat(40000) });
  sender.close(); await assert.rejects(pending, /关闭/);
});
