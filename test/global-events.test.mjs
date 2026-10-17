import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalEventRegistry, registerPlaceholderGlobalEvent, globalEventDensity, placedGlobalEvent } from '../src/core/global-events.mjs';
import { GlobalEventDocument } from '../src/application/global-events.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { createEvent, serializeChart, parseChart } from '../src/core/chart.mjs';
import { transformEvents, eventKey, deleteEvents } from '../src/application/event-commands.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { createChartExport } from '../src/platform/files.mjs';
import { CollaborationClient } from '../src/application/collaboration-client.mjs';
import { identifyChart, chartChanges } from '../src/core/collaboration.mjs';
const owner = { kind: 'mod', id: 'weather', name: 'Weather', author: 'Writer', version: '1.0.0' };
const definition = () => ({ id: 'wind', name: 'Weather · Writer', columns: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }] });
function fixture() { const registry = new GlobalEventRegistry(); registerPlaceholderGlobalEvent(registry); const session = new EditorSession(); const document = new GlobalEventDocument(registry, () => session); return { registry, session, document }; }

test('占位全局事件仅留在会话，撤销重做与谱面历史顺序一致，保存和新会话不包含占位', () => {
  const { registry, session, document } = fixture(), original = session.chart;
  document.apply([{ type: 'rpen/placeholder', column: 'value', events: [createEvent(2, 3, 1, 2)] }], '占位测试');
  assert.equal(session.chart, original); assert.equal(session.history.dirty, false); assert.equal(session.history.undoStack.at(-1).label, '占位测试');
  assert.equal(document.read('rpen/placeholder', 'value').length, 1); assert.equal(serializeChart(session.chart).includes('globalEvents'), false);
  session.travel('undo'); assert.equal(document.read('rpen/placeholder', 'value').length, 0);
  session.travel('redo'); assert.equal(document.read('rpen/placeholder', 'value').length, 1);
  const next = new GlobalEventDocument(registry, () => new EditorSession(parseChart(serializeChart(session.chart)))); assert.equal(next.read('rpen/placeholder', 'value').length, 0);
});

test('模组多列事件自动标识来源，普通事件操作经投影写回；停用后保留只读数据', () => {
  const { registry, session, document } = fixture(); const stop = registry.register(definition(), owner);
  document.apply([{ type: 'weather/wind', column: 'x', events: [createEvent(1, 2, 2, 4)] }, { type: 'weather/wind', column: 'y', events: [createEvent(3, 5, 2, 4)] }]);
  assert.deepEqual(session.chart.globalEvents.types['weather/wind'].source, owner); assert.equal(session.chart.META.RPEVersion, 240);
  const entry = document.columns.find(entry => entry.type.id === 'weather/wind' && entry.column.id === 'x'); document.editor.eventSelection = new Set([eventKey(entry.key, 0)]);
  transformEvents(document.editor, '修改全局值', event => ({ ...event, end: 7 })); assert.equal(document.read('weather/wind', 'x')[0].end, 7);
  session.travel('undo'); assert.equal(document.read('weather/wind', 'x')[0].end, 2); session.travel('redo'); assert.equal(document.read('weather/wind', 'x')[0].end, 7);
  stop(); assert.equal(document.types.find(type => type.id === 'weather/wind').readonly, true);
  const saved = serializeChart(session.chart), restored = parseChart(saved); assert.deepEqual(restored.globalEvents, session.chart.globalEvents);
  assert.throws(() => document.apply([{ type: 'weather/wind', column: 'x', events: [] }]), /尚未加载/);
  registry.register(definition(), owner); assert.equal(document.read('weather/wind', 'x')[0].end, 7);
});

test('占位与持久化事件可一次删除并一次撤销，互不污染彼此或音符', () => {
  const { registry, session, document } = fixture(); registry.register(definition(), owner);
  document.apply([{ type: 'rpen/placeholder', column: 'value', events: [createEvent()] }, { type: 'weather/wind', column: 'x', events: [createEvent()] }]);
  document.editor.eventSelection = new Set(document.columns.flatMap(entry => entry.events.map((event, index) => eventKey(entry.key, index))));
  deleteEvents(document.editor); assert.equal(document.read('weather/wind', 'x').length, 0); assert.equal(document.read('rpen/placeholder', 'value').length, 0);
  session.travel('undo'); assert.equal(document.read('weather/wind', 'x').length, 1); assert.equal(document.read('rpen/placeholder', 'value').length, 1);
  assert.equal(session.chart.judgeLineList[0].notes.length, 0);
});

test('全局事件创建支持继承、自定义数据、重叠策略，拒绝坏数据和伪造来源', () => {
  const { registry, session, document } = fixture(); registry.register(definition(), owner); const type = document.types.find(type => type.id === 'weather/wind'), column = type.columns[0];
  const events = [createEvent(2, 8, 0, 1)]; assert.equal(placedGlobalEvent(type, column, events, 1, 2).start, 8); assert.throws(() => placedGlobalEvent(type, column, events, 0.5, 1.5), /重叠/);
  assert.throws(() => document.apply([{ type: type.id, column: 'x', events: [{ ...createEvent(), start: NaN }] }]), /非有限/);
  const cycle = createEvent(); cycle.extra = cycle; assert.throws(() => document.apply([{ type: type.id, column: 'x', events: [cycle] }]), /循环/);
  document.apply([{ type: type.id, column: 'x', events: [{ ...createEvent(), custom: { kind: 'wind' } }] }]);
  const bad = structuredClone(session.chart); bad.globalEvents.types[type.id].source.id = 'other'; assert.throws(() => parseChart(JSON.stringify(bad)), /命名空间/);
});

test('全局分布条计算覆盖区间，Next 导出排序并保留扩展，RPE 导出需要明确移除', async () => {
  const { registry, session, document } = fixture(); registry.register(definition(), owner);
  document.apply([{ type: 'weather/wind', column: 'x', events: [{ ...createEvent(0, 1, 4, 6), extra: 7 }, createEvent(0, 1, 0, 2)] }]);
  const tempo = new TempoMap(session.chart.BPMList), bins = globalEventDensity(document.read('weather/wind', 'x'), tempo, 4, 8);
  assert.deepEqual([...bins], [1, 1, 0, 0, 1, 1, 0, 0]);
  const result = createChartExport(session.chart, new Map(), 'test.json', { compatibility: 'next', format: 'json' }); const saved = JSON.parse(await result.blob.text());
  assert.deepEqual(saved.globalEvents.types['weather/wind'].columns.x.events[0].startTime, [0, 0, 1]); assert.equal(saved.globalEvents.types['weather/wind'].columns.x.events[1].extra, 7);
  assert.throws(() => createChartExport(session.chart, new Map(), 'test.json', { compatibility: 'rpe', format: 'json' }), /不支持全局/);
  const legacy = createChartExport(session.chart, new Map(), 'test.json', { compatibility: 'rpe', format: 'json', removeGlobalEvents: true }); assert.equal(JSON.parse(await legacy.blob.text()).globalEvents, undefined); assert.ok(session.chart.globalEvents);
});

test('联机中的本地占位撤销不回滚远端谱面，混合提交可撤销持久化和临时事件', () => {
  class Transport extends EventTarget { connected = true; messages = []; send(message) { this.messages.push(message); } close() {} }
  const transport = new Transport(), session = new EditorSession(identifyChart(new EditorSession().chart)), registry = new GlobalEventRegistry();
  registerPlaceholderGlobalEvent(registry); registry.register(definition(), owner);
  const document = new GlobalEventDocument(registry, () => session), client = new CollaborationClient(transport, { session: () => session, receiveChart() {}, notify(message, level) { if (level === 'error') throw Error(message); } });
  client.active = true; client.message({ type: 'welcome', id: 'me', host: 'me', chart: session.chart, revision: 0, room: 'r', invite: 't', members: [{ id: 'me', online: true }], locks: [], chat: [] });
  document.apply([{ type: 'rpen/placeholder', column: 'value', events: [createEvent()] }]); assert.equal(transport.messages.some(item => item.type === 'edit'), false);
  const previous = session.chart, remote = { ...previous, META: { ...previous.META, name: 'Remote' } };
  client.message({ type: 'edit', id: 'other', operation: 'remote', changes: chartChanges(previous, remote), revision: 1 });
  session.travel('undo'); assert.equal(session.chart.META.name, 'Remote'); assert.equal(document.read('rpen/placeholder', 'value').length, 0);
  document.apply([{ type: 'weather/wind', column: 'x', events: [createEvent()] }, { type: 'rpen/placeholder', column: 'value', events: [createEvent()] }]);
  const acknowledge = revision => { const operation = client.queue[0]; assert.ok(operation); client.message({ ...operation, type: 'edit', id: 'me', revision, stats: {} }); };
  acknowledge(2); assert.equal(document.read('weather/wind', 'x').length, 1); assert.equal(document.read('rpen/placeholder', 'value').length, 1);
  session.travel('undo'); acknowledge(3); assert.equal(document.read('weather/wind', 'x').length, 0); assert.equal(document.read('rpen/placeholder', 'value').length, 0);
  session.travel('redo'); acknowledge(4); assert.equal(document.read('weather/wind', 'x').length, 1); assert.equal(document.read('rpen/placeholder', 'value').length, 1);
});
