import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createEvent, EVENT_TYPES, EXTENDED_TYPES } from '../src/core/chart.mjs';
import { createNoiseArea, createNoiseEvent, NOISE_TRACKS } from '../src/core/noise-areas.mjs';
import { ShaderRuntime } from '../src/core/shader.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { EventTrack } from '../src/core/events.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { createChartExport, packageEntries, resourceReferences, assetBytes } from '../src/platform/files.mjs';
import { readZip } from '../src/platform/archive.mjs';
import { parseInfo } from '../src/platform/legacy-text.mjs';

const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);

test('JSON 与 PEZ 默认紧凑导出，可关闭且不改变属性、文本空白或负零', async () => {
  const chart = createChart(); chart.META.name = '  保留 空格\n和换行  ';
  chart.judgeLineList[0].eventLayers[0].moveXEvents[0].start = -0;
  chart.effects = [];
  chart.custom = { empty: [], zero: 0, marker: '\u0000rpe-negative-zero\u0000', enabled: false };
  const assets = new Map([['extra.json', encode('{"custom": {"zero": -0, "label": "保留 空格"}}')]]);
  for (const compatibility of ['next', 'rpe']) for (const format of ['json', 'pez']) {
    const outputs = [];
    for (const compact of [undefined, false]) {
      const result = createChartExport(chart, assets, 'chart.json', { compatibility, format, compact });
      const entries = format === 'pez' ? await readZip(await result.blob.arrayBuffer()) : null;
      const text = entries ? decode(entries.get('chart.json')) : await result.blob.text();
      assert.equal(text.includes('\n'), compact === false);
      const parsed = JSON.parse(text);
      assert.equal(parsed.META.name, chart.META.name);
      assert.deepEqual(parsed.custom, chart.custom);
      assert.ok(Object.is(parsed.judgeLineList[0].eventLayers[0].moveXEvents[0].start, -0));
      if (entries) {
        const extra = decode(entries.get('extra.json'));
        assert.equal(extra.includes('\n'), compact === false);
        assert.ok(Object.is(JSON.parse(extra).custom.zero, -0));
      }
      outputs.push(parsed);
    }
    assert.deepEqual(outputs[0], outputs[1]);
  }
});

test('PEZ 根目录生成原 RPE 入口，引用真实资源路径并同步当前元数据', async () => {
  const chart = createChart();
  Object.assign(chart.META, { name: '新曲名', composer: '作曲', charter: '谱师', level: 'IN 15', song: 'MUSIC.ogg', background: '../images/COVER.png' });
  const assets = new Map([
    ['nested/chart.json', encode('{}')], ['nested/music.ogg', new Uint8Array([1, 2])], ['images/cover.png', new Uint8Array([3, 4])],
    ['nested/info.txt', encode('#\nName: 旧曲名\nPath: 123456\nChart: chart.json\nSong: old.ogg\n')],
    ['other/info.txt', encode('#\nPath: other\nChart: other.json\n')],
  ]);
  const original = structuredClone(chart);
  for (const compatibility of ['next', 'rpe']) {
    const result = createChartExport(chart, assets, 'nested/chart.json', { compatibility, format: 'pez' });
    const entries = await readZip(await result.blob.arrayBuffer());
    const text = decode(entries.get('info.txt'));
    assert.ok(text.startsWith('#\n'));
    const info = parseInfo(text);
    assert.equal(info.Path, '123456');
    assert.equal(info.Name, '新曲名'); assert.equal(info.Composer, '作曲'); assert.equal(info.Charter, '谱师'); assert.equal(info.Level, 'IN 15');
    assert.equal(info.Chart, 'nested/chart.json'); assert.equal(info.Song, 'nested/music.ogg'); assert.equal(info.Picture, 'images/cover.png');
    for (const key of ['Chart', 'Song', 'Picture']) assert.ok(entries.has(info[key]), key);
    assert.deepEqual(entries.get('other/info.txt'), assets.get('other/info.txt'));
    assert.deepEqual(entries.get(info.Song), assets.get('nested/music.ogg'));
    assert.deepEqual(entries.get(info.Picture), assets.get('images/cover.png'));
    const withoutMeta = { ...chart, META: { ...chart.META, song: '', background: '' } };
    const references = resourceReferences(withoutMeta, entries, info.Chart);
    assert.deepEqual(assetBytes(entries, references.song, info.Chart), assets.get('nested/music.ogg'));
    assert.deepEqual(assetBytes(entries, references.background, info.Chart), assets.get('images/cover.png'));
  }
  assert.deepEqual(chart, original); assert.equal(assets.has('info.txt'), false);
});

test('转换谱面和根目录旧入口导出时正确更新 Chart，标识不采用本机路径', () => {
  const chart = createChart(); chart.rpeNextLegacySource = { text: 'source' };
  chart.META.name = '标题\nPath: injected';
  const assets = new Map([
    ['main.pec', encode('source')], ['main.rpe.json', encode('existing')],
    ['INFO.TXT', encode('#\nPath: C:/private/chart\nChart: main.pec\n')],
  ]);
  const output = packageEntries(chart, assets, 'main.pec');
  const info = parseInfo(decode(output.get('info.txt')));
  assert.match(info.Path, /^\d+$/); assert.equal(info.Chart, 'main.rpe-1.json');
  assert.equal(info.Name, '标题 Path: injected');
  assert.equal(output.has('INFO.TXT'), false);
  assert.equal(decode(output.get('main.pec')), 'source'); assert.equal(decode(output.get('main.rpe.json')), 'existing');
  assert.ok(JSON.parse(decode(output.get(info.Chart))).META);
  assert.equal(parseInfo(decode(packageEntries(chart, assets, 'main.pec').get('info.txt'))).Path, info.Path);
  assert.equal(parseInfo(decode(packageEntries(chart, assets, 'main.pec', { identifier: '789' }).get('info.txt'))).Path, '789');
});

test('JSON/PEZ 导出按时间稳定排列事件，原 RPE 透明度端点为整数且保留负值', async () => {
  const chart = createChart(); const layer = chart.judgeLineList[0].eventLayers[0];
  const alpha = [createEvent(-10.9, -20.9, 8, 10), createEvent(255, 0, 0, 2), createEvent(0, 128.75, 4, 6)];
  alpha[0].bezier = 1; alpha[0].bezierPoints = [0.3, 0.1, 0.7, 0.9];
  layer.alphaEvents = alpha;
  layer.moveXEvents = [createEvent(20, 30, 4, 5), createEvent(0, 10, 0, 1)];
  chart.judgeLineList[0].eventLayers.push(null, { alphaEvents: [createEvent(5, 5, 0, 10)] });
  chart.judgeLineList[0].extended.scaleXEvents = [createEvent(2, 3, 4, 5), createEvent(1, 2, 0, 1), createEvent(4, 5, 0, 1)];
  const original = structuredClone(chart); const tempo = new TempoMap(chart.BPMList);
  for (const compatibility of ['next', 'rpe']) for (const format of ['json', 'pez']) {
    const result = createChartExport(chart, new Map(), 'chart.json', { compatibility, format });
    const text = format === 'json' ? await result.blob.text() : decode((await readZip(await result.blob.arrayBuffer())).get('chart.json'));
    const output = JSON.parse(text); const outputLayer = output.judgeLineList[0].eventLayers[0];
    assert.deepEqual(outputLayer.alphaEvents.map(event => beatValue(event.startTime)), [0, 4, 8]);
    assert.deepEqual(outputLayer.moveXEvents.map(event => beatValue(event.startTime)), [0, 4]);
    assert.deepEqual(output.judgeLineList[0].extended.scaleXEvents.map(event => event.start), [1, 4, 2]);
    assert.equal(output.judgeLineList[0].eventLayers[1], null);
    assert.equal(output.judgeLineList[0].eventLayers[2].alphaEvents[0].start, 5);
    assert.deepEqual(outputLayer.alphaEvents[2].bezierPoints, alpha[0].bezierPoints);
    assert.equal(outputLayer.alphaEvents[1].end, 128);
    assert.equal(outputLayer.alphaEvents[2].start, -10);
    const expected = new EventTrack(alpha.map(event => ({ ...event, start: Math.trunc(event.start), end: Math.trunc(event.end) })), tempo);
    const actual = new EventTrack(outputLayer.alphaEvents, tempo);
    for (const seconds of [0, 0.5, 1.5, 2.5, 3.5, 4.5, 6]) assert.equal(actual.value(seconds), expected.value(seconds));
  }
  assert.deepEqual(chart, original);
});

test('全部事件轨道和 extra 参数稳定排序，不改变噪域编号及 shader 渲染优先级', async () => {
  const chart = createChart(); const line = chart.judgeLineList[0];
  const events = () => [createEvent(2, 3, 8, 9), createEvent(0, 1, 0, 1), createEvent(1, 2, 4, 5)];
  for (const type of EVENT_TYPES) line.eventLayers[0][type] = events();
  for (const type of EXTENDED_TYPES) line.extended[type] = events().map(event => type === 'colorEvents' ? { ...event, start: [0, 0, 0], end: [255, 255, 255] } : type === 'textEvents' ? { ...event, start: 'a', end: 'b' } : event);
  const shaders = () => [
    { shader: 'glitch', start: 8, end: 9, order: -1, vars: { strength: events(), color: [1, 0.5, 0] } },
    { shader: 'chromatic', start: [0, 0, 1], end: [9, 0, 1], order: 5 },
  ];
  chart.effects = shaders(); chart.shaderEvents = shaders(); chart.META.effects = shaders();
  line.extended.paintEvents = shaders().map(event => ({ ...event, startTime: Array.isArray(event.start) ? event.start : [event.start, 0, 1], endTime: Array.isArray(event.end) ? event.end : [event.end, 0, 1] }));
  const area = createNoiseArea(0, 12); area.Name = 'first';
  for (const [type] of NOISE_TRACKS) area[type] = [8, 0, 4].map(beat => type === 'activeIntervals' ? { startTime: [beat, 0, 1], endTime: [beat + 1, 0, 1], readyFlash: 0.5 } : createNoiseEvent(1, 2, beat, beat + 1, { x: 0, y: 0 }));
  chart.blockAreaList = [area, { ...createNoiseArea(0, 1), Name: 'second' }];
  const before = structuredClone(chart);
  const renderOrder = source => {
    const runtime = new ShaderRuntime(); runtime.load = () => {}; runtime.compile(source, new TempoMap(source.BPMList));
    return runtime.effects.map(event => [event.shader, event.order, event.startBeat]);
  };
  const sorted = entries => entries.every((entry, index) => index === 0 || time(entries[index - 1]) <= time(entry));
  const time = entry => { const value = entry.startTime ?? entry.start; return Array.isArray(value) ? beatValue(value) : value; };
  for (const compatibility of ['next', 'rpe']) {
    const result = createChartExport(chart, new Map(), 'chart.json', { format: 'pez', compatibility, removeNoiseAreas: true });
    const entries = await readZip(await result.blob.arrayBuffer()); const output = JSON.parse(decode(entries.get('chart.json')));
    for (const type of EVENT_TYPES) assert.ok(sorted(output.judgeLineList[0].eventLayers[0][type]), type);
    for (const type of EXTENDED_TYPES) assert.ok(sorted(output.judgeLineList[0].extended[type]), type);
    for (const effects of [output.effects, output.shaderEvents, output.META.effects, JSON.parse(decode(entries.get('extra.json'))).effects]) {
      assert.ok(sorted(effects));
      for (const effect of effects) if (effect.vars) { assert.ok(sorted(effect.vars.strength)); assert.deepEqual(effect.vars.color, [1, 0.5, 0]); }
    }
    assert.deepEqual(renderOrder(output), renderOrder(chart));
    if (compatibility === 'next') {
      assert.deepEqual(output.blockAreaList.map(item => item.Name), ['first', 'second']);
      for (const [type] of NOISE_TRACKS) assert.ok(sorted(output.blockAreaList[0][type]), type);
    }
  }
  assert.deepEqual(chart, before);
});
