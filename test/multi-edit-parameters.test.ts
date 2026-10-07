import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiEditParameters } from '../src/application/multi-edit-parameters.ts';

function storageFixture(initial = '{}') {
  let text = initial; return { getItem: () => text, setItem: (key, value) => { text = value; } };
}

test('批量草稿、历史、命名收藏持久化且音符事件独立，重置不删除历史收藏', () => {
  const storage = storageFixture(); const store = new MultiEditParameters(storage);
  const value = { ...store.read('events'), mode: 'clone', targets: '0 2 4', retainSource: false, channels: { moveXEvents: { lower: 10, upper: 90 } } };
  store.update('events', value); store.remember('events', value); store.save('events', ' 克隆一组 ', value);
  value.channels.moveXEvents.lower = 99;
  const reload = new MultiEditParameters(storage);
  assert.equal(reload.read('events').channels.moveXEvents.lower, 10);
  assert.equal(reload.read('events').retainSource, false); assert.equal(reload.saved.events[0].value.retainSource, false);
  assert.equal(reload.history.events[0].mode, 'clone'); assert.equal(reload.saved.events[0].name, '克隆一组');
  assert.equal(reload.read('notes').mode, 'form');
  reload.reset('events'); assert.equal(reload.read('events').mode, 'form'); assert.equal(reload.saved.events.length, 1);
  assert.equal(reload.read('events').retainSource, true);
  reload.save('events', '克隆一组', reload.read('events')); assert.equal(reload.saved.events.length, 1);
  reload.remove('events', '克隆一组'); assert.equal(new MultiEditParameters(storage).saved.events.length, 0);
});

test('历史去重、限制数量，损坏存储和写入失败不阻塞编辑', () => {
  for (const initial of ['null', 'bad', '[]', '{"history":{"notes":{}}}']) assert.equal(new MultiEditParameters(storageFixture(initial)).read('notes').field, 'x');
  const messages = []; const store = new MultiEditParameters({ getItem() {}, setItem() { throw new Error('quota'); } }, message => messages.push(message));
  const value = store.read('notes');
  for (let index = 0; index < 53; index++) store.remember('notes', { ...value, lower: index });
  store.remember('notes', { ...value, lower: 52 });
  assert.equal(store.history.notes.length, 50); assert.equal(store.history.notes[0].lower, 3);
  assert.ok(messages.length); assert.throws(() => store.save('notes', '  ', value), /名称/);
});
