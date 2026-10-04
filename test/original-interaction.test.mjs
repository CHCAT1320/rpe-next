import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSession } from '../src/application/session.mjs';
import { EditorPlayback } from '../src/application/playback.mjs';
import { Timeline } from '../src/ui/timeline.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { createEvent, createNote } from '../src/core/chart.mjs';
import { placedEvent } from '../src/application/event-commands.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { snapPosition, snapTime, verticalGrid, wheelSeconds } from '../src/core/edit-grid.mjs';
import { hitFrame, HIT_DURATION, DEFAULT_LINE_WIDTH, DEFAULT_LINE_HEIGHT } from '../src/core/visual-constants.mjs';
import { easingPicture } from '../src/core/easing-picture.mjs';
import { readEditorPreferences, writeEditorPreferences } from '../src/platform/editor-preferences.mjs';
import { migratePreferences, shortcutAction } from '../src/core/preferences.mjs';

function canvas() {
  return { clientWidth: 500, clientHeight: 600, style: {}, addEventListener() {}, focus() {}, setPointerCapture() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 600 }; } };
}
function editor() {
  const session = new EditorSession();
  const timeline = new Timeline(canvas(), canvas(), () => session, () => {}, () => {});
  return { session, timeline };
}

test('滚轮向上暂停并定位真实时间，继续从新位置播放；准备播放可被滚轮取消', async () => {
  let resolvePreparation;
  const sounds = { stop() {}, prepare: () => new Promise(resolve => { resolvePreparation = resolve; }) };
  const audio = { time: 10, duration: 120, rate: 1, playing: true, pause() { this.playing = false; }, seek(seconds) { this.time = seconds; }, async play() { this.playing = true; } };
  let visible = 0;
  const playback = new EditorPlayback(audio, sounds, () => { visible = audio.time; });
  playback.wheel({ deltaY: -100 }, { scrollSpeed: 5 }, 0);
  assert.equal(audio.playing, false); assert.equal(visible, 10.06);
  const request = playback.toggle({}); resolvePreparation(); await request;
  assert.equal(audio.time, 10.06); assert.equal(audio.playing, true);
  playback.pause(); const delayed = playback.toggle({});
  playback.wheel({ deltaY: 100 }, { scrollSpeed: 5 }, 1); resolvePreparation(); await delayed;
  assert.equal(audio.playing, false); assert.equal(audio.time, 10);
  assert.ok(Math.abs(wheelSeconds(-100, 120, 5, 2, false, 0, true) - 0.6) < 1e-10);
});

test('第二次空格能取消仍在准备的播放，按键重复不会产生隐式恢复', async () => {
  let ready;
  const audio = { playing: false, pause() { this.playing = false; }, async play() { this.playing = true; } };
  const playback = new EditorPlayback(audio, { stop() {}, prepare: () => new Promise(resolve => { ready = resolve; }) }, () => {});
  const first = playback.toggle({}); await playback.toggle({}); ready(); await first;
  assert.equal(audio.playing, false);
});

test('横线按秒映射跨 BPM，竖线奇偶和小数数量与吸附共享同一格点', () => {
  const tempo = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 240, startTime: [4, 0, 1] }]);
  assert.equal(beatValue(snapTime(2.04, 4, tempo)), 4.25);
  assert.equal(snapPosition(35, 11), 0);
  assert.equal(Math.abs(snapPosition(0, 10)), 75);
  assert.equal(snapPosition(35, 11, false), 35);
  assert.equal(verticalGrid(3.5).spacing, 540);
  const { timeline } = editor(); timeline.tempo = tempo;
  assert.equal(timeline.vertical(3) - timeline.vertical(4), 72);
  assert.equal(timeline.vertical(4) - timeline.vertical(5), 36);
});

test('Hold 两次定位固定首次 X，反向放置排序，同拍不制造一拍 Hold', () => {
  const { session, timeline } = editor();
  timeline.cursor = { x: timeline.horizontal(135), y: timeline.vertical(4) };
  timeline.addAtCursor(2); assert.equal(session.notes.length, 0);
  timeline.cursor = { x: timeline.horizontal(405), y: timeline.vertical(2) };
  timeline.addAtCursor(2);
  assert.equal(session.notes[0].positionX, 135); assert.equal(beatValue(session.notes[0].startTime), 2); assert.equal(beatValue(session.notes[0].endTime), 4);
  timeline.addAtCursor(2); timeline.addAtCursor(2); assert.equal(session.notes.length, 1);
  timeline.addAtCursor(2); timeline.cancelPlacement(); assert.equal(session.notes.length, 1); assert.equal(timeline.pendingHold, null);
});

test('拖动实时值和落点一致，对未在网格上的音符吸附绝对目标而非位移', () => {
  const { session, timeline } = editor(); session.insertNotes([createNote(1, 2.1, 23)]);
  const start = { x: timeline.horizontal(23), y: timeline.vertical(2.1) };
  timeline.drag = { kind: 'move', anchor: 0, start, current: { x: start.x + 40, y: start.y - 15 } };
  const ghost = timeline.movedNote(session.notes[0]);
  assert.equal(ghost.positionX, 135); assert.equal(beatValue(ghost.startTime), 2.25);
  timeline.up({ clientX: start.x + 40, clientY: start.y - 15 });
  assert.deepEqual(session.notes[0], ghost); session.travel('undo'); assert.equal(session.notes[0].positionX, 23);
});

test('事件继承前一终值与缓动，拒绝冲突；两次定位不产生隐式一拍事件', () => {
  const { session, timeline } = editor();
  session.line.eventLayers[0].moveXEvents = [{ ...createEvent(5, 42, 0, 2), easingType: 7 }];
  const candidate = placedEvent(session, 'moveXEvents', 4, 2);
  assert.equal(candidate.start, 42); assert.equal(candidate.end, 42); assert.equal(candidate.easingType, 7);
  assert.throws(() => placedEvent(session, 'moveXEvents', 1, 3));
  assert.equal(placedEvent(session, 'moveXEvents', 2, 2), null);
  timeline.eventInteraction.place('moveXEvents', 2); assert.equal(session.line.eventLayers[0].moveXEvents.length, 1);
  timeline.eventInteraction.place('moveXEvents', 4, 3); assert.equal(session.line.eventLayers[0].moveXEvents.length, 2);
  assert.equal(session.line.eventLayers[0].moveXEvents[1].easingType, 3);
  const prefs = migratePreferences(); const key = { key: 'r' };
  assert.equal(shortcutAction(key, prefs, 'notes'), 'AddHold'); assert.equal(shortcutAction(key, prefs, 'events'), 'AddEvent');
});

test('打击特效 31 帧按谱面秒播放，缓动图来自数学函数，判定线用原尺寸', () => {
  assert.equal(hitFrame(0), 1); assert.equal(hitFrame(0.015), 2); assert.equal(hitFrame(0.45), 31); assert.equal(hitFrame(HIT_DURATION), null);
  assert.equal(DEFAULT_LINE_WIDTH, 4000); assert.equal(DEFAULT_LINE_HEIGHT, 5);
  assert.match(easingPicture(1), /<svg/); assert.notEqual(easingPicture(1), easingPicture(7)); assert.doesNotMatch(easingPicture(1), /img-|NaN/);
});

test('Y 缩放、网格、实时预览和音量跨关闭恢复，非法存储安全回退', () => {
  let value;
  const storage = { getItem() { return value; }, setItem(key, next) { value = next; } };
  const preferences = { scale: 333, division: 12, gridCount: 10, snapX: false, realtime: true, realtimeAlpha: 0.35, volume: 0.2 };
  writeEditorPreferences(preferences, storage); assert.deepEqual(readEditorPreferences(storage), preferences);
  value = '{broken'; assert.deepEqual(readEditorPreferences(storage), {});
});
