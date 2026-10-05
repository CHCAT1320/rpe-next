import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvent } from '../src/core/chart.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { easing, bezier } from '../src/core/easing.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { cutEventParts, cutSelectedEvents, stickSelectedEvents } from '../src/application/event-tools.mjs';
import { migratePreferences } from '../src/core/preferences.mjs';
import { normalizeEditorPreferences } from '../src/platform/editor-preferences.mjs';

test('切割从最近横线向两端采样，保留余段、缓动结果和未知字段', () => {
  const source = { ...createEvent(0, 100, 0.1, 1.1), easingType: 5, custom: { value: 7 }, linkgroup: 3, inst: 1 };
  const parts = cutEventParts('moveXEvents', source, { division: 4, density: 2, beat: 0.6 });
  assert.deepEqual(parts.map(item => beatValue(item.startTime)), [0.1, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]);
  assert.equal(beatValue(parts.at(-1).endTime), 1.1);
  for (const [index, part] of parts.entries()) {
    assert.ok(Math.abs(part.start - easing((beatValue(part.startTime) - 0.1), 5) * 100) < 1e-8);
    assert.equal(part.easingType, 1); assert.equal(part.inst, 0); assert.equal(part.linkgroup, 0); assert.deepEqual(part.custom, { value: 7 });
    if (index) { assert.deepEqual(parts[index - 1].endTime, part.startTime); assert.equal(parts[index - 1].end, part.start); }
  }
  assert.equal(source.inst, 1);
  const fromStart = cutEventParts('moveXEvents', source, { division: 4, density: 2, beat: 10 });
  assert.equal(beatValue(fromStart[1].startTime), 0.225);
});

test('切割 Bezier、颜色和透明度，文字/着色器/零长度不切割', () => {
  const source = { ...createEvent(0, 100, 0, 1), bezier: 1, bezierPoints: [0.1, 0.8, 0.7, 0.2] };
  const parts = cutEventParts('moveYEvents', source, { division: 2, density: 1 });
  assert.ok(Math.abs(parts[0].end - bezier(0.5, source.bezierPoints) * 100) < 1e-8);
  const colors = cutEventParts('colorEvents', createEvent([0, 1, 10], [255, 8, 100]), { division: 2, density: 1 });
  assert.deepEqual(colors[0].end, [127, 4, 55]);
  assert.equal(cutEventParts('alphaEvents', createEvent(0, 255), { division: 2, density: 1 })[0].end, 127);
  assert.equal(cutEventParts('textEvents', createEvent('a', 'b')), null);
  assert.equal(cutEventParts('paintEvents', createEvent()), null);
  assert.equal(cutEventParts('moveXEvents', createEvent(0, 1, 1, 1)), null);
  assert.throws(() => cutEventParts('speedEvents', createEvent(0, 1, 0, 10000), { density: 128 }), /过多/);
});

test('批量切割一次撤销，选择新段并保留跳过事件，其他层不变', () => {
  const session = new EditorSession();
  session.line.eventLayers[0].moveXEvents = [createEvent(0, 10, 1, 2), createEvent(5, 6, 0, 0.5)];
  session.line.extended.textEvents = [createEvent('a', 'b')];
  session.eventSelection = new Set(['moveXEvents:0', 'textEvents:0']);
  const original = session.chart;
  assert.deepEqual(cutSelectedEvents(session, { division: 2, density: 2 }), { changed: 1, generated: 4, skipped: 1 });
  assert.equal(session.history.undoStack.length, 1);
  assert.deepEqual([...session.eventSelection], ['moveXEvents:1', 'moveXEvents:2', 'moveXEvents:3', 'moveXEvents:4', 'textEvents:0']);
  session.travel('undo'); assert.equal(session.chart, original);
});

test('粘合按时间找前一同类事件，跨间隙且钩定同步传递，保留曲线', () => {
  const session = new EditorSession();
  session.line.eventLayers[0].moveXEvents = [
    { ...createEvent(80, 90, 5, 6), easingType: 6 },
    createEvent(0, 10, 0, 1), { ...createEvent(50, 50, 3, 4), inst: 1 },
  ];
  session.eventSelection = new Set(['moveXEvents:0', 'moveXEvents:1', 'moveXEvents:2']);
  assert.deepEqual(stickSelectedEvents(session), { changed: 2, skipped: 1 });
  assert.deepEqual(session.line.eventLayers[0].moveXEvents.map(item => [item.start, item.end]), [[10, 90], [0, 10], [10, 10]]);
  assert.equal(session.line.eventLayers[0].moveXEvents[0].easingType, 6);
  assert.equal(session.history.undoStack.length, 1);
  session.travel('undo'); assert.equal(session.line.eventLayers[0].moveXEvents[0].start, 80);
});

test('迁移并保存原版 CutRho 设置', () => {
  const result = migratePreferences('{"CutRho":8}');
  assert.equal(result.settings.cutDensity, 8); assert.ok(result.report.appliedSettings.includes('CutRho'));
  assert.equal(normalizeEditorPreferences({ cutDensity: 8 }).cutDensity, 8);
});
