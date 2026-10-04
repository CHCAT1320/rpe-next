import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCurveNotes } from '../src/core/curve-notes.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { createChart, createLine, createNote, createEvent, serializeChart, parseChart } from '../src/core/chart.mjs';
import { gameUiLayout, gameUiBindings, scoreAt } from '../src/core/game-ui.mjs';
import { drawGameUi } from '../src/ui/game-ui.mjs';
import { previewViewport } from '../src/core/editor-display.mjs';
import { Preview } from '../src/ui/preview.mjs';
import { Timeline } from '../src/ui/timeline.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { isPlaybackSpace } from '../src/ui/keyboard.mjs';
import { normalizeEditorPreferences } from '../src/platform/editor-preferences.mjs';
import { migratePreferences, shortcutAction } from '../src/core/preferences.mjs';

const curve = { startTime: [0, 0, 1], endTime: [4, 0, 1], startX: -400, endX: 400 };
function canvas(context = {}) {
  return { clientWidth: 600, clientHeight: 600, addEventListener() {}, getContext: () => context,
    getBoundingClientRect: () => ({ width: 600, height: 600 }) };
}
function recordingContext() {
  const calls = [];
  const context = new Proxy({ calls }, { get(target, key) {
    return key in target ? target[key] : (...args) => calls.push({ method: key, args, font: target.font, alpha: target.globalAlpha, color: target.fillStyle });
  } });
  return context;
}

test('曲线按横线分格 × 密度生成，不含端点，29 种缓动均有效，可一次撤销', () => {
  for (let easingType = 1; easingType <= 29; easingType++) {
    const notes = generateCurveNotes({ ...curve, easingType });
    assert.equal(notes.length, 15);
    assert.equal(beatValue(notes[0].startTime), 0.25);
    assert.equal(beatValue(notes.at(-1).startTime), 3.75);
    assert.ok(notes.every(note => note.type === 4 && Number.isFinite(note.positionX) && note.above === 1 && note.speed === 1 && note.isFake === 0));
    assert.ok(notes.every(note => beatValue(note.startTime) === beatValue(note.endTime)));
  }
  const notes = generateCurveNotes(curve); assert.equal(notes[7].positionX, 0);
  const session = new EditorSession(); const original = session.chart;
  session.insertNotes(notes, '生成曲线音符'); assert.equal(session.history.undoStack.length, 1);
  session.travel('undo'); assert.equal(session.chart, original);
  session.travel('redo'); assert.equal(session.notes.length, 15);
  assert.deepEqual(parseChart(serializeChart(session.chart)), session.chart);
});

test('曲线保留七分拍与分数起拍，同拍使用横向等距，非法输入不生成', () => {
  const notes = generateCurveNotes({ ...curve, division: 7, startTime: [0, 1, 3], endTime: [1, 1, 3] });
  assert.equal(notes.length, 6); assert.deepEqual(notes[0].startTime, [0, 10, 21]); assert.deepEqual(notes.at(-1).startTime, [1, 4, 21]);
  const same = generateCurveNotes({ ...curve, endTime: curve.startTime, density: 3, easingType: 29 });
  assert.deepEqual(same.map(note => note.positionX), [-200, 0, 200]);
  assert.equal(generateCurveNotes({ ...curve, density: 0.5 }).length, 7);
  for (const value of [{ density: 0 }, { density: Infinity }, { type: 2 }, { endTime: [-1, 0, 1] }, { endTime: [100, 0, 1], density: 1000 }]) assert.throws(() => generateCurveNotes({ ...curve, ...value }));
});

test('预览全局 Hold 层低于其他音符，绑定线隐藏本体但保留音符，缩放不漏远音符', () => {
  globalThis.devicePixelRatio = 1;
  const chart = createChart(); chart.judgeLineList.push(createLine());
  chart.judgeLineList[0].notes = [createNote(1, 1, 0)];
  chart.judgeLineList[1].notes = [createNote(2, 1, 0, 3)];
  chart.judgeLineList[1].attachUI = 'name';
  const context = recordingContext(); const preview = new Preview(canvas(context)); preview.visible = true;
  const order = [];
  preview.skin = { tinted: () => null, head: () => { order.push('tap'); return true; }, hold: () => { order.push('hold'); return true; } };
  preview.draw(chart, new TempoMap(chart.BPMList), 0, 0);
  assert.deepEqual(order, ['hold', 'tap']);
  assert.equal(context.calls.filter(call => call.method === 'fillRect' && call.color !== '#111').length, 1);
  chart.judgeLineList[0].notes = [createNote(1, 6, 0)];
  const tempo = new TempoMap(chart.BPMList); preview.viewDivisor = 10; order.length = 0;
  preview.draw(chart, tempo, 0, 0); assert.ok(order.includes('tap'));
  preview.viewDivisor = 1; order.length = 0; preview.draw(chart, tempo, 0, 0); assert.ok(!order.includes('tap'));
});

test('编辑区重叠点选优先 Tap，X 偏移反变换与绝对竖线吸附一致，Y 轴不受影响', () => {
  const session = new EditorSession(); session.insertNotes([createNote(1, 1, 0), createNote(2, 1, 0, 3)]);
  const timeline = new Timeline(canvas(), canvas(), () => session, () => {}, () => {});
  const vertical = timeline.vertical(1); assert.equal(timeline.hit({ x: timeline.horizontal(0), y: vertical }).item.type, 1);
  timeline.cameraX = 270; timeline.snapX = false;
  for (const position of [-900, 0, 135, 980]) assert.ok(Math.abs(timeline.positionAt(timeline.horizontal(position)) - position) < 1e-9);
  timeline.snapX = true; assert.equal(timeline.positionAt(timeline.horizontal(140)), 135);
  timeline.notesOnly = true; assert.equal(timeline.vertical(1), vertical);
});

test('游戏 UI 遵循原 UI.txt 边距、字体尺寸，横竖比例转换保持边距', () => {
  const base = new Map(gameUiLayout(1350, 900).map(item => [item.key, item]));
  assert.equal(base.get('combonumber').fontSize, 67); assert.equal(base.get('score').fontSize, 49);
  assert.equal(base.get('bar').height, 8); assert.equal(base.get('pause').width, 42);
  for (const ratio of [16 / 9, 9 / 16, 1, 32 / 9]) {
    const view = previewViewport(900, 600, ratio);
    const width = view.width / view.scale; const height = view.height / view.scale;
    const adapted = new Map(gameUiLayout(width, height).map(item => [item.key, item]));
    for (const [key, item] of base) {
      const changed = adapted.get(key);
      assert.ok(Math.abs((changed.x - item.edgeX * width / 2) - (item.x - item.edgeX * 675)) < 1e-9);
      assert.ok(Math.abs((changed.y - item.edgeY * height / 2) - (item.y - item.edgeY * 450)) < 1e-9);
    }
  }
});

test('UI 绑定使用已解析的父线、叠层和扩展事件，后绑定覆盖且移除后恢复默认', () => {
  const chart = createChart(); chart.META.name = 'Test';
  const parent = chart.judgeLineList[0]; parent.eventLayers[0].moveXEvents = [createEvent(200)]; parent.attachUI = 'name';
  const child = createLine(); child.father = 0; child.attachUI = 'name'; child.eventLayers[0].moveXEvents = [createEvent(50)];
  child.eventLayers[0].alphaEvents = [createEvent(128)]; child.extended.scaleXEvents = [createEvent(2)]; chart.judgeLineList.push(child);
  const preview = new Preview(canvas(recordingContext())); preview.visible = true;
  preview.draw(chart, new TempoMap(chart.BPMList), 0, 0);
  const states = preview.scene.sample(0); const binding = gameUiBindings(chart, states).get('name');
  assert.equal(binding.x, 250); assert.equal(binding.scaleX, 2); assert.equal(binding.alpha, 128);
  assert.deepEqual(binding.color, [255, 255, 255]);
  const context = recordingContext(); const view = previewViewport(1350, 900);
  drawGameUi(context, chart, states, [], 0, -1, view, 0.5, null, 60);
  const text = context.calls.find(call => call.method === 'fillText' && call.args[0] === 'Test');
  assert.equal(text.font, '17.5px RPEGame, sans-serif'); assert.equal(text.alpha, 128 / 255);
  const position = context.calls.filter(call => call.method === 'translate').at(-2);
  assert.ok(Math.abs(position.args[0] - 481.7) < 1e-9);
  parent.attachUI = ''; child.attachUI = ''; assert.equal(gameUiBindings(chart, states).size, 0);
  assert.deepEqual(parseChart(serializeChart(chart)), chart);
});

test('连击严格越过判定时间，Hold 尾计数且忽略假音符', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(1, 1, 0), createNote(2, 0, 0, 4), { ...createNote(3, 0, 0), isFake: 1 }];
  const preview = new Preview(canvas(recordingContext())); preview.visible = true; preview.draw(chart, new TempoMap(chart.BPMList), 0, 0);
  assert.deepEqual(preview.completionTimes, [0.5, 2]);
  assert.deepEqual(scoreAt(preview.completionTimes, 0.5), { combo: 0, score: 0 });
  assert.deepEqual(scoreAt(preview.completionTimes, 2), { combo: 1, score: 500000 });
  assert.deepEqual(scoreAt(preview.completionTimes, 2.001), { combo: 2, score: 1000000 });
});

test('空格优先播放涵盖非文本控件，文本和组合输入豁免；新增视图设置与热键可迁移', () => {
  const target = type => ({ closest(selector) { return selector === 'input' && type ? { type } : null; } });
  for (const type of [null, 'range', 'checkbox', 'radio', 'button', 'color']) assert.equal(isPlaybackSpace({ key: ' ', target: target(type) }), true);
  for (const type of ['text', 'number', 'search', 'email']) assert.equal(isPlaybackSpace({ key: ' ', target: target(type) }), false);
  assert.equal(isPlaybackSpace({ key: ' ', target: { isContentEditable: true } }), false);
  assert.equal(isPlaybackSpace({ key: ' ', isComposing: true }), false);
  const preference = migratePreferences('{"showViewUI":true}'); assert.equal(preference.settings.showGameUI, true);
  assert.equal(shortcutAction({ key: 'n', altKey: true }, preference), 'SwitchUI');
  assert.equal(shortcutAction({ key: 'f', ctrlKey: true }, preference), 'CurveBegin');
  assert.equal(shortcutAction({ key: 'g', ctrlKey: true }, preference), 'CurveEnd');
  assert.deepEqual(normalizeEditorPreferences({ notesOnly: true, showGameUI: true, cameraX: 540, viewDivisor: 2, scale: 333 }), { scale: 333, cameraX: 540, viewDivisor: 2, notesOnly: true, showGameUI: true });
});
