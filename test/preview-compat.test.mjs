import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, parseChart, serializeChart } from '../src/core/chart.mjs';
import { LineRuntime } from '../src/core/scene.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { lineGuides, pickGuide } from '../src/core/preview-guides.mjs';
import { Preview } from '../src/ui/preview.mjs';

function previewSurface() {
  const context = new Proxy({ calls: [] }, { get(target, key) {
    return key in target ? target[key] : (...args) => target.calls.push({ method: key, args, filter: target.filter });
  } });
  return { context, canvas: { style: {}, getContext: () => context, getBoundingClientRect: () => ({ width: 600, height: 400 }) } };
}

test('编辑背景的不透明度不会被连续绘制覆盖，模糊修改在下一帧生效', () => {
  globalThis.devicePixelRatio = 1;
  const chart = createChart(); const tempo = new TempoMap(chart.BPMList);
  const { context, canvas } = previewSurface(); const preview = new Preview(canvas);
  Object.assign(preview, { visible: true, applyShaders: false, opacity: 0.1, showHitEffects: false, images: { background: { naturalWidth: 1350, naturalHeight: 900 } } });
  preview.draw(chart, tempo, 0, 0); preview.draw(chart, tempo, 0.1, 0);
  assert.equal(canvas.style.opacity, '0.1');
  assert.equal(context.calls.filter(call => call.method === 'drawImage').at(-1).filter, 'blur(10.5px)');
  preview.backgroundBlur = 18; preview.opacity = 0.2;
  preview.draw(chart, tempo, 0.2, 0);
  assert.equal(canvas.style.opacity, '0.2');
  assert.equal(context.calls.filter(call => call.method === 'drawImage').at(-1).filter, 'blur(18px)');
  preview.backgroundBlur = 0; preview.opacity = 0;
  preview.draw(chart, tempo, 0.3, 0);
  assert.equal(canvas.style.opacity, '0');
  assert.equal(context.calls.filter(call => call.method === 'drawImage').at(-1).filter, 'none');
});

test('背景预览跳过 Tap 与 Hold 打击特效生成，正常预览仍生成特效', () => {
  globalThis.devicePixelRatio = 1;
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(1, 0, 0), createNote(2, 0, 0, 4)];
  const tempo = new TempoMap(chart.BPMList); const effects = [];
  const preview = new Preview(previewSurface().canvas);
  Object.assign(preview, { visible: true, applyShaders: false, effectsSince: -Infinity, showHitEffects: false,
    skin: { images: new Map(), head: () => true, hold: () => true, tinted(name) { if (name.startsWith('img-')) effects.push(name); return null; } } });
  preview.draw(chart, tempo, 0.05, 0); preview.draw(chart, tempo, 0.7, 0);
  assert.equal(effects.length, 0);
  preview.showHitEffects = true;
  preview.draw(chart, tempo, 0.05, 0); assert.ok(effects.length >= 2);
  effects.length = 0;
  preview.draw(chart, tempo, 0.7, 0); assert.ok(effects.length > 0);
});

test('普通音符 above=2 与 Hold above=0 均向下，原字段无损保存', () => {
  const chart = createChart();
  chart.judgeLineList[0].notes = [1, 2, 3, 4].flatMap(type => [0, 1, 2].map(above => ({ ...createNote(type, 4, 0, 6), above })));
  const parsed = parseChart(JSON.stringify(chart));
  assert.deepEqual(JSON.parse(serializeChart(parsed)), chart);
  const runtime = new LineRuntime(parsed.judgeLineList[0], new TempoMap(parsed.BPMList));
  for (const entry of runtime.notes) assert.equal(Math.sign(runtime.noteState(entry, runtime.state(0), 0).y), entry.note.above === 1 ? 1 : -1);
});

test('预览「缩放」同时改变输入控件、音符与判定块，块不是唯一的例外', () => {
  // End-to-end through `Preview.draw`, because the earlier tests only covered `drawBlocks` in
  // isolation: the control sets `preview.viewDivisor`, `draw` turns it into `viewport.scale / divisor`
  // and hands that to the notes, the judge lines *and* the blocks. A block that ignored it filled the
  // window at any divisor, which is the reported symptom.
  globalThis.devicePixelRatio = 1;
  const chart = createChart();
  chart.blockAreas = [{
    topRightPercentage: { x: 0.6, y: 0.6 }, bottomLeftPercentage: { x: 0.4, y: 0.4 },
    appearTime: 0, enableTime: 1, disableTime: 5, disappearTime: 6, isSubtract: false,
    rotateEvents: [{ anchor: { x: 0.5, y: 0.5 }, time: 0, easeType: 0, rotation: 0 }],
    moveEvents: [{ endPosition: { x: 0.75, y: 0.5 }, time: 0, easeTypeX: 0, easeTypeY: 0 }],
    scaleEvents: [{ anchor: { x: 0.5, y: 0.5 }, time: 0, easeTypeX: 0, easeTypeY: 0, scale: { x: 1, y: 1 } }],
  }];
  const tempo = new TempoMap(chart.BPMList);
  // The block screen space is `2 * orthographicSize` tall and `aspect` wide, and `previewViewport`
  // caps the logical field at 1350x900, so this 600x400 surface maps the whole canvas to the field.
  // `moveEvents[0].endPosition` puts the centre at 0.75 of the field and its width at 0.2, so at
  // relative content scale `s` the centre is `300 + 0.25 * 600 * s` and the width `0.2 * 600 * s`.
  // With `s = 1 / viewDivisor` that is 450 / 120 px at the default and 375 / 60 px at divisor 2.
  const centre = (divisor) => 300 + (0.25 * 600) / divisor;
  const blockWidth = (divisor) => (0.2 * 600) / divisor;
  const translations = (context) => context.calls.filter((call) => call.method === 'translate').map((call) => call.args);
  const widths = (context) => context.calls.filter((call) => call.method === 'fillRect').map((call) => call.args[2]);
  const run = (viewDivisor) => {
    const { context, canvas } = previewSurface();
    const preview = new Preview(canvas);
    preview.viewDivisor = viewDivisor;
    Object.assign(preview, { visible: true, applyShaders: false, showHitEffects: false, showGameUI: false, blockRenderer: 'canvas', images: {} });
    preview.draw(chart, tempo, 3, 0);
    return context;
  };
  for (const divisor of [1, 2]) {
    const context = run(divisor);
    const expectedCentre = centre(divisor);
    const found = translations(context);
    assert.ok(found.some(([x, y]) => Math.abs(x - expectedCentre) < 1e-6 && Math.abs(y - 200) < 1e-6),
      `divisor ${divisor} 时块心应在 (${expectedCentre}, 200)，实际 ${JSON.stringify(found)}`);
    const expectedWidth = blockWidth(divisor);
    assert.ok(widths(context).some((width) => Math.abs(width - expectedWidth) < 1e-6),
      `divisor ${divisor} 时块宽应为 ${expectedWidth}，实际 ${JSON.stringify(widths(context))}`);
  }
  // The two divisors must produce different geometry, i.e. the control really reaches the block.
  assert.notDeepEqual(translations(run(1)), translations(run(2)));
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
