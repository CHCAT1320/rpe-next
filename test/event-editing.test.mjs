import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSession } from '../src/application/session.mjs';
import { createChart, createEvent, createNote } from '../src/core/chart.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { EventTrack } from '../src/core/events.mjs';
import { eventKey, eventList, insertEvent, copyEvents, pasteEvents, deleteEvents, transformEvents, splitEvent } from '../src/application/event-commands.mjs';
import { HitSounds, hitTimeline } from '../src/platform/hitsounds.mjs';
import { AudioTransport } from '../src/platform/audio.mjs';
import { migratePreferences } from '../src/core/preferences.mjs';

test('音乐和打击音量分别即时应用，打击音默认 30%，迁移保留原音量', async () => {
  const context = { destination: {}, createGain: () => ({ gain: { value: 1 }, connect() {} }) };
  const audio = new AudioTransport(() => context); audio.ensureContext();
  const sounds = new HitSounds(audio);
  for (const name of ['tap', 'drag', 'flick']) sounds.buffers.set(name, {});
  await sounds.prepare();
  assert.equal(sounds.volume, 0.3);
  assert.equal(migratePreferences().settings.hitVolume, 0.3);
  audio.setVolume(0.2); sounds.setVolume(0.6);
  assert.equal(audio.gain.gain.value, 0.2); assert.equal(sounds.gain.gain.value, 0.6);
  audio.setVolume(0); assert.equal(sounds.gain.gain.value, 0.6);
  sounds.setVolume(0); assert.equal(audio.gain.gain.value, 0);
  assert.equal(migratePreferences('{"SEVolume":0.8}').settings.hitVolume, 0.8);
});
test('事件批改失败不产生部分提交，跨层镜像粘贴与撤销保持未知字段', () => {
  const session = new EditorSession();
  insertEvent(session, 'moveXEvents', { ...createEvent(10, 90, 2, 6), custom: { values: [3] } });
  const original = session.chart;
  assert.throws(() => transformEvents(session, '非法时长', event => ({ ...event, endTime: [1, 0, 1] })));
  assert.equal(session.chart, original);
  copyEvents(session);
  session.eventLayer = 1;
  pasteEvents(session, 10, false, true);
  assert.equal(eventList(session, 'moveXEvents')[0].start, -10);
  assert.equal(beatValue(eventList(session, 'moveXEvents')[0].endTime), 14);
  assert.deepEqual(eventList(session, 'moveXEvents')[0].custom, { values: [3] });
  assert.notEqual(eventList(session, 'moveXEvents')[0].custom, session.eventClipboard[0].event.custom);
  assert.equal(session.chart.judgeLineList[0].eventLayers[0], original.judgeLineList[0].eventLayers[0]);
  deleteEvents(session);
  assert.equal(eventList(session, 'moveXEvents').length, 0);
  session.travel('undo');
  assert.equal(eventList(session, 'moveXEvents').length, 1);
  session.travel('undo');
  assert.equal(session.chart, original);
});

test('事件拆分跨 BPM 与倍率保持原缓动采样，拒绝不支持的切分', () => {
  const tempo = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 180, startTime: [4, 0, 1] }]);
  for (let kind = 1; kind <= 29; kind++) {
    const event = { ...createEvent(-20, 70, 1, 8), easingType: kind, easingLeft: 0.1, easingRight: 0.9 };
    const original = new EventTrack([event], tempo, 1.5);
    const divided = new EventTrack(splitEvent(event, 3, tempo, 1.5), tempo, 1.5);
    for (let beat = 1; beat < 8; beat += 0.071) assert.ok(Math.abs(original.value(tempo.seconds(beat, 1.5)) - divided.value(tempo.seconds(beat, 1.5))) < 1e-7, `easing ${kind} beat ${beat}`);
  }
  assert.throws(() => splitEvent({ ...createEvent(0, 1), bezier: 1 }, 0.5, tempo));
  assert.throws(() => splitEvent(createEvent(0, 1), 1, tempo));
});

test('扩展事件与基础层隔离，非法颜色修改保持原子性', () => {
  const session = new EditorSession();
  insertEvent(session, 'colorEvents', { ...createEvent(), start: [255, 0, 0], end: [0, 255, 0] });
  const original = session.chart;
  assert.throws(() => transformEvents(session, '颜色', event => ({ ...event, start: [NaN, 0, 0] })));
  assert.equal(session.chart, original);
  assert.deepEqual([...session.eventSelection], [eventKey('colorEvents', 0)]);
});

test('打击音时间遵循 offset、倍率、类型及假音符', () => {
  const chart = createChart(); chart.META.offset = 100;
  chart.judgeLineList[0].bpmfactor = 2;
  chart.judgeLineList[0].notes = [createNote(1, 1, 0), createNote(4, 2, 0), createNote(3, 3, 0), { ...createNote(2, 4, 0), hitsound: 'custom.ogg' }, { ...createNote(1, 0, 0), isFake: 1 }];
  assert.deepEqual(hitTimeline(chart, new TempoMap(chart.BPMList)), [{ time: 1.1, sound: 'tap' }, { time: 2.1, sound: 'drag' }, { time: 3.1, sound: 'flick' }, { time: 4.1, sound: 'custom.ogg' }]);
});

test('打击音不重复调度，seek 和暂停取消旧声音，倍速换算启动时间', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(1, 2, 0), createNote(1, 4, 0)];
  const scheduled = [];
  const transport = { playing: true, time: 0.95, rate: 2, playRevision: 1, context: { currentTime: 10, createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(at) { this.at = at; scheduled.push(this); }, stop() { this.stopped = true; } }; return source;
  } } };
  const sounds = new HitSounds(transport); sounds.gain = {}; sounds.buffers.set('tap', {});
  const tempo = new TempoMap(chart.BPMList);
  sounds.tick(chart, tempo); sounds.tick(chart, tempo);
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].at, 10.025);
  transport.time = 1.95; transport.playRevision++;
  sounds.tick(chart, tempo);
  assert.equal(scheduled[0].stopped, true); assert.equal(scheduled.length, 2);
  transport.playing = false; sounds.tick(chart, tempo);
  assert.equal(scheduled[1].stopped, true); assert.equal(sounds.sources.size, 0);
});

test('高密度打击音限制瞬时声部，避免集中调度拖垮音频线程', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = Array.from({ length: 500 }, () => createNote(1, 2, 0));
  const scheduled = [];
  const transport = { playing: true, time: 0.95, rate: 1, playRevision: 1, context: { currentTime: 10, createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(at) { this.at = at; scheduled.push(this); }, stop() {} }; return source;
  } } };
  const sounds = new HitSounds(transport); sounds.gain = {}; sounds.buffers.set('tap', {});
  sounds.tick(chart, new TempoMap(chart.BPMList));
  assert.equal(scheduled.length, sounds.maxSameTime);
  assert.ok(scheduled.length <= sounds.maxBurst);
});

test('原版显示和音效设置转换为实际参数且保留原值', () => {
  const settings = { SEVolume: 0.4, NoteSize: 200, LineScale: 2, GridlineCount: 21, ScrollSpeed: 8, Alpha: 80, unhandled: true };
  const result = migratePreferences(JSON.stringify(settings));
  assert.equal(result.settings.hitVolume, 0.4); assert.equal(result.settings.noteSize, 200);
  assert.equal(result.settings.backgroundAlpha, 80 / 255); assert.equal(result.settings.gridCount, 21);
  assert.deepEqual(result.originalSettings, settings); assert.deepEqual(result.report.retainedSettings, ['LineScale', 'unhandled']);
});
