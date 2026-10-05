import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createLine, createNote, createEvent } from '../src/core/chart.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { compileExpression, compileBatchScript } from '../src/core/batch-script.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { captureSelection, commitSelectionEdit } from '../src/application/batch-edit.mjs';
import { previewMultiEdit, previewEventClones, batchOperation } from '../src/application/multi-edit.mjs';
import { shaderEvents } from '../src/core/shader-events.mjs';
import { RpeSkin } from '../src/ui/skin.mjs';
import { MultiEditPanel } from '../src/ui/multi-edit.mjs';

function fixture() {
  const chart = createChart(); chart.judgeLineList.push(createLine('target'), createLine('last'));
  chart.judgeLineList[0].notes = [createNote(1, 2, -100), createNote(2, 4, 50, 5), createNote(4, 6, 100)];
  chart.judgeLineList[0].eventLayers[0].moveXEvents = [createEvent(0, 10, 1, 2), createEvent(10, 20, 3, 4), createEvent(20, 30, 5, 6)];
  const session = new EditorSession(chart); session.selection = new Set([2, 0, 1]);
  session.eventSelection = new Set(['moveXEvents:2', 'moveXEvents:0', 'moveXEvents:1']); return session;
}

test('克隆可移除源事件，同线目标只移除原件，重复目标与未选中事件完整保留', () => {
  const session = fixture(); session.focus = 'events'; session.selection.clear(); session.eventSelection = new Set(['moveXEvents:0', 'moveXEvents:2']);
  const original = session.chart;
  const result = previewEventClones(captureSelection(session), { targets: '0 1 0', increment: 4, division: 4, retainSource: false });
  assert.equal(session.chart, original);
  assert.equal(result.chart.judgeLineList[0].eventLayers[0].moveXEvents.length, 5);
  assert.equal(result.chart.judgeLineList[1].eventLayers[0].moveXEvents.length, 3);
  assert.equal(result.chart.judgeLineList[0].eventLayers[0].moveXEvents[0], original.judgeLineList[0].eventLayers[0].moveXEvents[1]);
  assert.deepEqual([...result.eventSelection], ['moveXEvents:1', 'moveXEvents:2', 'moveXEvents:3', 'moveXEvents:4']);
  commitSelectionEdit(session, result, '克隆');
  session.travel('undo'); assert.equal(session.chart, original); assert.deepEqual([...session.eventSelection], ['moveXEvents:0', 'moveXEvents:2']);
  session.travel('redo'); assert.equal(session.chart, result.chart); assert.equal(session.eventSelection.size, 4);
  const other = previewEventClones(captureSelection(fixture()), { targets: '1', retainSource: false });
  assert.equal(other.chart.judgeLineList[0].eventLayers[0].moveXEvents.length, 0);
  assert.equal(other.eventSelection.size, 0);
});

test('多事件虚影以共同数值范围绘制，首尾整体平移不会归一化为相同曲线', () => {
  const starts = []; const strokes = [];
  const context = { save() {}, restore() {}, setLineDash() {}, beginPath() {}, rect() {}, clip() {}, strokeRect() {}, fillRect() {}, fillText() {},
    moveTo(horizontal, vertical) { starts.push([horizontal, vertical]); }, lineTo() {}, stroke() { strokes.push(this.strokeStyle); } };
  const session = fixture();
  const canvas = { clientWidth: 500, clientHeight: 600, getContext: () => context };
  const panel = Object.create(MultiEditPanel.prototype);
  Object.assign(panel, { active: true, kind: 'events', getSession: () => session, previewEnabled: { checked: true },
    timeline: { eventsCanvas: canvas, eventTypes: ['moveXEvents'], vertical: beat => 550 - beat * 100, eventColumnBounds: () => ({ x: 10, width: 80 }) },
    result: { changes: [{ lineIndex: 0, index: 0, type: 'moveXEvents', before: createEvent(0, 10, 1, 2), after: createEvent(100, 110, 1, 2) }] } });
  panel.drawTimeline();
  assert.equal(starts.length, 2); assert.equal(starts[0][1], starts[1][1]);
  assert.ok(starts[1][0] - starts[0][0] > 50);
  assert.deepEqual(strokes, ['#a4b0bd', '#8effd0']);
});

test('有限脚本解析算术、条件、函数、顺序赋值，拒绝执行任意代码和非有限结果', () => {
  assert.equal(compileExpression('clamp(-2 + pow(3, 2), 0, 5)')({}), 5);
  assert.equal(compileExpression('i % 2 == 0 && N > 1 ? lerp(-10, 10, u) : 0')({ i: 2, N: 4, u: 1 }), 10);
  assert.equal(compileExpression('true || missing')({}), 1);
  assert.equal(compileExpression('2 ^ 3 ^ 2')({}), 512);
  for (const text of ['window.alert(1)', 'constructor(1)', '1/0', 'sqrt(-1)', 'unknown', 'this.constructor.constructor(1)']) assert.throws(() => compileExpression(text)({}));
  for (const text of ['__proto__ = 1', 'while(true) {}', 'x = fetch(1)', 'x = 1; document = 2']) assert.throws(() => compileBatchScript(text, ['x']));
});

test('原版六种修改方式', () => {
  assert.deepEqual(['By', 'To', 'Times', 'Max', 'Min', 'Flip'].map(mode => batchOperation(5, 3, mode)), [8, 3, 15, 5, 3, 1]);
});

test('音符 RGB 编辑使用原版 tint 字段，贴图染色保留 Hold 三段尺寸', () => {
  const session = fixture(); session.notes[0].tint = [100, 200, 150];
  const result = previewMultiEdit(captureSelection(session), 'notes', { field: 'red', operation: 'To', lower: 10, upper: 30 });
  assert.deepEqual(result.changes[0].after.tint, [10, 200, 150]);
  assert.equal(result.changes[0].after.color, undefined);
  const skin = new RpeSkin(() => {}); const tinted = [];
  for (const name of ['Hold3', 'HoldHead', 'HoldEnd', 'Tap2']) skin.images.set(name, { naturalWidth: 100, naturalHeight: 10 });
  skin.tinted = (name, color) => { tinted.push([name, color]); return { name }; };
  const draws = []; const context = { save() {}, restore() {}, translate() {}, scale() {}, drawImage(...args) { draws.push(args); } };
  skin.hold(context, 0, 100, 0, 50, false, true, [10, 20, 30]);
  assert.deepEqual(tinted.map(([name]) => name), ['Hold3', 'HoldEnd', 'HoldHead']);
  assert.ok(draws.every(args => args.slice(1).every(Number.isFinite)));
  tinted.length = 0; skin.head(context, 1, 0, 0, 50, false, [255, 255, 255]); assert.equal(tinted.length, 0);
});

test('音符按时间排序分配 0…1，周期与筛选生效；预览无副作用且一次撤销', () => {
  const session = fixture(); const original = session.chart;
  const result = previewMultiEdit(captureSelection(session), 'notes', { field: 'x', operation: 'To', lower: -200, upper: 200, cycle: '1 -1 1' });
  assert.equal(session.chart, original); assert.equal(session.history.undoStack.length, 0);
  assert.deepEqual(result.chart.judgeLineList[0].notes.map(note => note.positionX), [-200, -0, 200]);
  commitSelectionEdit(session, result, '多音符编辑'); assert.equal(session.history.undoStack.length, 1);
  session.travel('undo'); assert.equal(session.chart, original); session.travel('redo'); assert.equal(session.chart, result.chart);
  const selected = fixture();
  const filtered = previewMultiEdit(captureSelection(selected), 'notes', { field: 'speed', operation: 'To', lower: 2, upper: 4, noteType: 2 });
  assert.deepEqual(filtered.chart.judgeLineList[0].notes.map(note => note.speed), [1, 2, 1]);
  const skipped = previewMultiEdit(captureSelection(selected), 'notes', { field: 'x', operation: 'To', lower: 7, upper: 7, cycle: '1 _ 1', condition: 't1 >= 2' });
  assert.deepEqual(skipped.chart.judgeLineList[0].notes.map(note => note.positionX), [7, 50, 7]);
});

test('脚本按语句顺序修改拍数，非 Hold 保持首尾同拍，跨线移动保留扩展属性', () => {
  const session = fixture(); session.notes[1].custom = { preserved: true };
  const snapshot = captureSelection(session);
  const result = previewMultiEdit(snapshot, 'notes', { mode: 'script', script: 't1 += 1; t2 += 1; x = -x; size = 1 + i / 4; line = i % 2;' });
  assert.equal(result.chart.judgeLineList[0].notes.length, 2); assert.equal(result.chart.judgeLineList[1].notes.length, 1);
  const hold = result.chart.judgeLineList[1].notes[0]; assert.equal(beatValue(hold.startTime), 5); assert.equal(beatValue(hold.endTime), 6); assert.deepEqual(hold.custom, { preserved: true });
  assert.equal(session.notes.length, 3);
  const tail = previewMultiEdit(snapshot, 'notes', { field: 't2', operation: 'By', lower: 1, upper: 1 });
  assert.equal(beatValue(tail.chart.judgeLineList[0].notes[0].startTime), 3);
  assert.throws(() => previewMultiEdit(snapshot, 'notes', { mode: 'script', script: 'line = 999;' }), /不存在/);
  assert.throws(() => previewMultiEdit(snapshot, 'notes', { mode: 'script', script: 't2 = 0;' }), /结束拍/);
});

test('原版事件普通属性从 1/N 分配，Duration 首尾相接，Order 内容换槽且时间不变', () => {
  const snapshot = captureSelection(fixture());
  const result = previewMultiEdit(snapshot, 'events', { field: 'both', operation: 'By', lower: 0, upper: 30 });
  assert.deepEqual(result.changes.map(change => change.after.start), [10, 30, 50]);
  const durations = previewMultiEdit(snapshot, 'events', { field: 'duration', operation: 'To', lower: 1, upper: 3 });
  assert.deepEqual(durations.changes.map(change => [beatValue(change.after.startTime), beatValue(change.after.endTime)]), [[1, 2], [2, 4], [4, 7]]);
  const order = previewMultiEdit(snapshot, 'events', { field: 'order', operation: 'Flip', lower: 0.5, upper: 0.5 });
  assert.deepEqual(order.changes.map(change => change.after.start), [20, 10, 0]);
  assert.deepEqual(order.changes.map(change => beatValue(change.after.startTime)), [1, 3, 5]);
});

test('事件 Line 是复制并保留源事件，修改单端后解除不再相同的钩定', () => {
  const session = fixture(); const events = session.line.eventLayers[0].moveXEvents;
  events[0].end = 0; events[0].inst = 1;
  const moved = previewMultiEdit(captureSelection(session), 'events', { field: 'line', operation: 'To', lower: 1, upper: 1 });
  assert.equal(moved.chart.judgeLineList[0].eventLayers[0].moveXEvents.length, 3);
  assert.equal(moved.chart.judgeLineList[1].eventLayers[0].moveXEvents.length, 4);
  const result = previewMultiEdit(captureSelection(session), 'events', { field: 'end', operation: 'By', lower: 1, upper: 1 });
  assert.equal(result.changes[0].after.inst, 0);
});

test('扰动预览稳定，应用与预览完全一致，换种子重新采样', () => {
  const snapshot = captureSelection(fixture()); const options = { field: 'x', disturbance: '-10 10', seed: 9 };
  const first = previewMultiEdit(snapshot, 'notes', options); const second = previewMultiEdit(snapshot, 'notes', options);
  assert.deepEqual(first.chart, second.chart);
  assert.notDeepEqual(first.chart, previewMultiEdit(snapshot, 'notes', { ...options, seed: 10 }).chart);
});

test('特殊层着色器克隆保留参数并按新起拍对齐；颜色文字完整保留', () => {
  const session = fixture();
  session.line.extended = {
    colorEvents: [{ ...createEvent(), start: [10, 20, 30], end: [30, 40, 50] }],
    textEvents: [{ ...createEvent(), start: 'hello', end: 'world' }],
    paintEvents: [{ startTime: [1, 0, 1], endTime: [2, 0, 1], shader: 'chromatic', vars: { power: [{ ...createEvent(1, 2, 1, 2), custom: true }] }, custom: { keep: 1 } }],
  };
  session.eventSelection = new Set(['colorEvents:0', 'textEvents:0', 'paintEvents:0']);
  const result = previewEventClones(captureSelection(session), { targets: '1 2', increment: 4, division: 4 });
  const shader = shaderEvents(result.chart, 2)[0];
  assert.equal(beatValue(shader.startTime), 2);
  assert.equal(beatValue(shader.vars.power[0].startTime), 2);
  assert.deepEqual(shader.custom, { keep: 1 });
  assert.deepEqual(result.chart.judgeLineList[2].extended.colorEvents[0].start, [10, 20, 30]);
  assert.equal(result.chart.judgeLineList[2].extended.textEvents[0].start, 'hello');
});

test('无匹配、错误时间和非法脚本整次失败，不污染原谱', () => {
  const session = fixture(); const original = structuredClone(session.chart); const snapshot = captureSelection(session);
  assert.throws(() => previewMultiEdit(snapshot, 'events', { mode: 'script', script: 'start += 1; t2 = i == 2 ? -1 : t2;' }), /结束拍/);
  assert.throws(() => previewMultiEdit(snapshot, 'notes', { condition: 'false' }), /没有匹配/);
  assert.throws(() => previewMultiEdit(snapshot, 'notes', { mode: 'script', script: 'type = 99;' }), /音符类型/);
  assert.deepEqual(session.chart, original); assert.equal(session.history.undoStack.length, 0);
});

test('克隆按线号序列而非线号数值累加横线增量，复制保留 Bezier、绑定与自定义字段', () => {
  const session = fixture(); session.eventSelection = new Set(['moveXEvents:0']);
  Object.assign(session.line.eventLayers[0].moveXEvents[0], { bezier: 1, bezierPoints: [0.2, 0.4, 0.6, 0.8], linkgroup: 9, custom: { value: 7 } });
  const result = previewEventClones(captureSelection(session), { targets: '2 1 2', increment: '2', division: 4,
    channels: { moveXEvents: { lower: 0, upper: 100, cycle: '1 -1' } } });
  assert.deepEqual(result.changes.map(change => beatValue(change.after.startTime)), [1, 1.5, 2]);
  assert.deepEqual(result.changes.map(change => change.after.start), [0, -50, 100]);
  assert.equal(result.chart.judgeLineList[0].eventLayers[0].moveXEvents.length, 3);
  assert.equal(result.chart.judgeLineList[2].eventLayers[0].moveXEvents.length, 3);
  assert.deepEqual(result.changes[0].after.bezierPoints, [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(result.changes[0].after.custom, { value: 7 });
  assert.notEqual(result.changes[0].after.custom, session.line.eventLayers[0].moveXEvents[0].custom);
  assert.throws(() => previewEventClones(captureSelection(session), { targets: '3' }), /已有/);
});
