import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, parseChart, serializeChart } from '../src/core/chart.mjs';
import { LineRuntime } from '../src/core/scene.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { lineGuides, pickGuide } from '../src/core/preview-guides.mjs';
import { Preview } from '../src/ui/preview.mjs';

test('普通音符 above=2 与 Hold above=0 均向下，原字段无损保存', () => {
  const chart = createChart();
  chart.judgeLineList[0].notes = [1, 2, 3, 4].flatMap(type => [0, 1, 2].map(above => ({ ...createNote(type, 4, 0, 6), above })));
  const parsed = parseChart(JSON.stringify(chart));
  assert.deepEqual(JSON.parse(serializeChart(parsed)), chart);
  const runtime = new LineRuntime(parsed.judgeLineList[0], new TempoMap(parsed.BPMList));
  for (const entry of runtime.notes) assert.equal(Math.sign(runtime.noteState(entry, runtime.state(0), 0).y), entry.note.above === 1 ? 1 : -1);
});

test('透明、负透明、零长度及绑定 UI 线仍可点击；退出预览不穿透', () => {
  const states = [0, -255, 255].map((alpha, index) => ({ alpha, x: index * 200, y: 0, scaleX: index === 2 ? 0 : 1, rotation: 0 }));
  const guides = lineGuides(states, [{}, {}, { attachUI: 'score' }], [0, 1, 2], 1000, 600, 1);
  assert.equal(guides.length, 3);
  assert.equal(pickGuide([guides[0]], { x: 500, y: 300 }, -1), 0);
  assert.equal(pickGuide([guides[1]], { x: 700, y: 300 }, -1), 1);
  assert.equal(pickGuide([guides[2]], { x: 900, y: 300 }, -1), 2);
  const preview = new Preview({ getBoundingClientRect: () => ({ left: 10, top: 20 }) });
  Object.assign(preview, { guides, pickPreviewLines: true, viewport: { left: 0, top: 0, width: 1000, height: 600 } });
  assert.equal(preview.pick(510, 320), null);
  preview.visible = true;
  assert.equal(preview.pick(510, 320), 0);
  assert.equal(preview.pick(0, 320), null);
});
