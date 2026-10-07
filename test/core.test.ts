import test from 'node:test';
import assert from 'node:assert/strict';
import { beatValue, fromNumber, parseBeat } from '../src/core/beat.ts';
import { TempoMap } from '../src/core/tempo.ts';
import { createChart, createNote, createEvent, parseChart, serializeChart, assertChart } from '../src/core/chart.ts';
import { easing, bezier } from '../src/core/easing.ts';
import { EventTrack, SpeedIntegral } from '../src/core/events.ts';
import { IntervalIndex } from '../src/core/interval-index.ts';
import { EditorSession } from '../src/application/session.ts';
import { readZip, writeZip, crc32 } from '../src/platform/archive.ts';

test('拍数负数、分母和三元表示', () => {
  assert.deepEqual(fromNumber(-0.25), [-1, 3, 4]);
  assert.equal(beatValue(parseBeat('3:1/7')), 3 + 1 / 7);
  assert.throws(() => parseBeat('0:1/0'));
  assert.throws(() => parseBeat(''));
  assert.throws(() => beatValue([0, 1, -1]));
  assert.equal(beatValue([0, 2, 4]), beatValue([0, 1, 2]));
});

test('BPM 切换、边界、倍率及随机往返', () => {
  const tempo = new TempoMap([{ bpm: 60, startTime: [4, 0, 1] }, { bpm: 120, startTime: [0, 0, 1] }]);
  assert.equal(tempo.seconds(4), 2);
  assert.equal(tempo.seconds(6, 2), 8);
  assert.equal(tempo.seconds(-2), -1);
  for (let beat = -10; beat < 100; beat += 0.13) assert.ok(Math.abs(tempo.beat(tempo.seconds(beat, 1.7), 1.7) - beat) < 1e-10);
  assert.throws(() => new TempoMap([]));
  assert.throws(() => new TempoMap([{ bpm: 0, startTime: [0, 0, 1] }]));
  const duplicate = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 100, startTime: [0, 0, 1] }]);
  assert.equal(duplicate.seconds(1), 0.6);
});

test('JSON 未知字段、null、版本和原始分数保持不变', () => {
  const chart = createChart();
  chart.META.RPEVersion = 162;
  chart.customExtension = { nested: [null, { enabled: true }] };
  chart.customExtension.negativeZero = -0;
  chart.judgeLineList[0].notes = [{ ...createNote(1, 0.5, 20), startTime: [0, 2, 4], custom: [1, 2] }];
  chart.judgeLineList[0].eventLayers.push(null);
  assert.deepEqual(parseChart(serializeChart(chart)), chart);
  assert.throws(() => parseChart('{"formatVersion":3}'));
});

test('非法数值在导入边界报出字段路径，不传入画布运行时', () => {
  const chart = createChart();
  chart.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), speed: 'fast' }];
  assert.throws(() => assertChart(chart), /notes\[0\]\.speed/);
  chart.judgeLineList[0].notes[0].speed = 1;
  chart.judgeLineList[0].extended.colorEvents = [createEvent([0, 0], [255, 255, 255])];
  assert.throws(() => assertChart(chart), /colorEvents\[0\]/);
  chart.judgeLineList[0].extended = {};
  chart.judgeLineList[0].yControl = [{ x: 0, y: null }];
  assert.throws(() => assertChart(chart), /yControl\[0\]/);
});

test('RPE 缓动编号、端点、切片及 Bezier', () => {
  for (let type = 1; type <= 29; type++) {
    assert.ok(Math.abs(easing(0, type)) < 1e-9);
    assert.ok(Math.abs(easing(1, type) - 1) < 1e-9);
    assert.ok(Number.isFinite(easing(0.3, type)));
  }
  assert.ok(Math.abs(easing(0.5, 2) - Math.SQRT1_2) < 1e-12);
  assert.equal(easing(0.5, 5), 0.25);
  assert.ok(Math.abs(easing(0.5, 5, 0.25, 0.75) - 0.375) < 1e-12);
  assert.ok(Math.abs(bezier(0.2, [0, 0, 1, 1]) - 0.2) < 1e-9);
});

test('事件使用真实秒插值，速度积分跨 BPM 及事件间隙', () => {
  const tempo = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 60, startTime: [2, 0, 1] }]);
  const track = new EventTrack([createEvent(0, 100, 0, 4)], tempo);
  assert.ok(Math.abs(track.value(1.5) - 50) < 1e-12);
  const integral = new SpeedIntegral([createEvent(0, 10, 0, 4)], tempo);
  assert.ok(Math.abs(integral.distance(3) - 1800) < 1e-8);
  assert.ok(Math.abs(integral.distance(4) - 3000) < 1e-8);
  const gap = new SpeedIntegral([createEvent(1, 1, 0, 1), createEvent(2, 2, 4, 5)], tempo);
  assert.ok(Math.abs(gap.distance(4) - 600) < 1e-8);
});

test('可见区必须包含头部在屏外的长 Hold', () => {
  const items = [{ start: 0, end: 100 }, { start: 10, end: 10 }, { start: 99, end: 101 }];
  const index = new IntervalIndex(items, item => item.start, item => item.end);
  assert.deepEqual(index.query(50, 60).map(entry => entry.index), [0]);
  assert.deepEqual(index.query(100, 100).map(entry => entry.index), [0, 2]);
});

test('编辑不改原对象，保存点、撤销分支及跨线复制', () => {
  const original = createChart();
  const session = new EditorSession(original);
  session.insertNotes([createNote(2, 2, 100, 5)]);
  session.history.markSaved();
  session.copy();
  session.addLine();
  session.paste(10, true);
  assert.equal(session.notes[0].positionX, -100);
  assert.equal(beatValue(session.notes[0].endTime), 13);
  session.travel('undo');
  session.travel('undo');
  assert.equal(session.history.dirty, false);
  session.travel('undo');
  assert.equal(session.history.dirty, true);
  session.insertNotes([createNote(1, 1, 0)]);
  assert.equal(session.history.redoStack.length, 0);
  assert.equal(original.judgeLineList[0].notes.length, 0);
});

test('无效批量修改保持整次操作原子性', () => {
  const session = new EditorSession();
  session.insertNotes([createNote(1, 1, 0), createNote(2, 3, 0, 4)]);
  const before = session.chart;
  assert.throws(() => session.transformSelection('失败操作', note => {
    if (note.type === 2) throw new Error('invalid');
    return { ...note, positionX: 55 };
  }));
  assert.equal(session.chart, before);
});

test('ZIP Unicode 路径、二进制和未知资源无损往返', async () => {
  const files = new Map([['测试/chart.json', new TextEncoder().encode(serializeChart(createChart()))], ['texture.bin', new Uint8Array([0, 255, 33])]]);
  const zip = writeZip(files);
  assert.deepEqual(await readZip(await zip.arrayBuffer()), files);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.throws(() => writeZip(new Map([['../outside', new Uint8Array()]])));
  const corrupt = new Uint8Array(await zip.arrayBuffer());
  corrupt[60] ^= 1;
  await assert.rejects(() => readZip(corrupt.buffer));
});
