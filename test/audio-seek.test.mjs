import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioTransport } from '../src/platform/audio.mjs';
import { EditorPlayback } from '../src/application/playback.mjs';
import { HitSounds } from '../src/platform/hitsounds.mjs';
import { createChart, createNote } from '../src/core/chart.mjs';
import { TempoMap } from '../src/core/tempo.mjs';

class SeekingMedia extends EventTarget {
  duration = 120;
  current = 0;
  target = 0;
  paused = true;
  seeking = false;
  readyState = 4;
  plays = 0;
  seeks = 0;
  get currentTime() { return this.current; }
  set currentTime(value) { this.target = value; this.seeking = true; this.seeks++; }
  finishSeek() { this.current = this.target; this.seeking = false; this.dispatchEvent(new Event('seeked')); }
  play() { this.paused = false; this.plays++; return this.pending ?? Promise.resolve(); }
  pause() { this.paused = true; }
}

function setup() {
  const starts = [];
  const context = { currentTime: 0, resume: async () => {}, destination: {},
    createGain: () => ({ gain: {}, connect() {} }),
    createBufferSource: () => ({ playbackRate: {}, connect() {}, disconnect() {}, stop() {}, start(at, offset) { starts.push({ at, offset }); } }),
  };
  const audio = new AudioTransport(() => context);
  audio.media = new SeekingMedia();
  return { audio, context, starts };
}

test('载入音乐优先保存解码样本；解码器不支持时仍可回退原生媒体', async () => {
  const original = globalThis.Audio;
  class LoadedMedia extends SeekingMedia {
    set src(value) { queueMicrotask(() => this.onloadedmetadata?.()); }
    removeAttribute() {} load() {}
  }
  globalThis.Audio = LoadedMedia;
  const { audio, context } = setup(); audio.media = null;
  context.createMediaElementSource = () => ({ connect() {}, disconnect() {} });
  const buffer = { duration: 99.8 }; context.decodeAudioData = async () => buffer;
  try {
    assert.equal(await audio.load(new ArrayBuffer(4), 'vbr.mp3'), true);
    assert.equal(audio.buffer, buffer); assert.equal(audio.usesMedia, false); assert.equal(audio.duration, 99.8);
    context.decodeAudioData = async () => { throw new Error('仅原生媒体支持此格式'); };
    assert.equal(await audio.load(new ArrayBuffer(4), 'native-only.m4a'), true);
    assert.equal(audio.buffer, null); assert.equal(audio.usesMedia, true);
    audio.clear();
  } finally { globalThis.Audio = original; }
});

test('连续拖动时间滑条后等待最后一次定位完成，等待中画面不读取旧播放头', async () => {
  const { audio, context } = setup();
  const controls = new EditorPlayback(audio, { stop() {}, prepare: async () => {} }, () => {});
  controls.seek(3); controls.seek(12); controls.seek(27);
  const playing = audio.play(); await Promise.resolve();
  context.currentTime = 3;
  assert.equal(audio.media.plays, 0); assert.equal(audio.clockReady, false);
  assert.equal(audio.time, 27); assert.equal(audio.time - 0.15, 26.85);
  audio.media.finishSeek(); await playing;
  assert.equal(audio.media.plays, 1); assert.equal(audio.clockReady, true);
  audio.media.current = 28.25; assert.equal(audio.time - 0.15, 28.1);
});

test('等待定位时暂停或再次定位，会取消旧播放请求，不会被迟到事件恢复播放', async () => {
  const { audio } = setup();
  audio.seek(10); const previous = audio.play(); await Promise.resolve();
  audio.pause(); await previous;
  audio.seek(40); const current = audio.play(); await Promise.resolve();
  assert.equal(audio.media.plays, 0); audio.media.finishSeek(); await current;
  assert.equal(audio.media.plays, 1); assert.equal(audio.time, 40);
  audio.pause(); assert.equal(audio.time, 40);
  const seeks = audio.media.seeks; await audio.play();
  assert.equal(audio.media.seeks, seeks); assert.equal(audio.time, 40);
});

test('音乐真正启动前、定位和缓冲等待中不提前调度打击音', async () => {
  const { audio, context, starts } = setup();
  let finishPlay; audio.media.pending = new Promise(resolve => { finishPlay = resolve; });
  const playing = audio.play(); await Promise.resolve();
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(1, 0, 0)];
  const sounds = new HitSounds(audio); sounds.gain = {}; sounds.buffers.set('tap', {});
  const tempo = new TempoMap(chart.BPMList);
  context.currentTime = 4; sounds.tick(chart, tempo);
  assert.equal(starts.length, 0); assert.equal(audio.time, 0);
  finishPlay(); await playing; sounds.tick(chart, tempo);
  assert.equal(starts.length, 1); assert.equal(starts[0].at, 4);
  audio.media.readyState = 1; sounds.tick(chart, tempo); assert.equal(sounds.sources.size, 0);
});

test('常速使用解码样本和同一音频时钟，反复暂停、定位不依赖压缩媒体播放头', async () => {
  const { audio, context, starts } = setup(); audio.buffer = { duration: 100 };
  for (const [index, target] of [0, 12.345, 3.2, 76.8, -0.5].entries()) {
    audio.pause(); audio.seek(target); context.currentTime = index * 10; await audio.play();
    const scheduled = starts.at(-1);
    assert.equal(scheduled.offset, Math.max(0, target));
    assert.equal(scheduled.at, context.currentTime + Math.max(0, -target));
    context.currentTime += 0.25;
    assert.ok(Math.abs(audio.time - (target + 0.25)) < 1e-9);
    audio.media.current = 99;
    assert.ok(Math.abs(audio.time - 0.125 - (target + 0.25 - 0.125)) < 1e-9);
  }
  assert.equal(audio.media.plays, 0); assert.equal(audio.duration, 100);
});

test('保调倍速切换保留音乐秒位置；原生倍速调整不反复触发 seek', async () => {
  const { audio, context } = setup(); audio.buffer = { duration: 100 };
  audio.seek(10); await audio.play(); context.currentTime = 1;
  audio.setRate(0.5); assert.equal(audio.time, 11); assert.equal(audio.usesMedia, true);
  audio.media.finishSeek(); await Promise.resolve(); await Promise.resolve();
  assert.equal(audio.media.plays, 1); audio.media.current = 12;
  const seeks = audio.media.seeks; audio.setRate(0.75);
  assert.equal(audio.media.seeks, seeks); assert.equal(audio.time, 12);
  audio.setPreservePitch(false); assert.equal(audio.usesMedia, false); assert.equal(audio.time, 12);
  context.currentTime = 2; assert.equal(audio.time, 12.75);
  audio.setRate(1); assert.equal(audio.time, 12.75);
});

test('媒体负时间预滚不会预先调度越过音乐起点的打击音', async () => {
  const { audio, context, starts } = setup();
  audio.seek(-0.05); await audio.play();
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(1, 0, 0)];
  const sounds = new HitSounds(audio); sounds.gain = {}; sounds.buffers.set('tap', {});
  const tempo = new TempoMap(chart.BPMList); sounds.tick(chart, tempo);
  assert.equal(starts.length, 0);
  context.currentTime = 0.05; audio.update(); await Promise.resolve(); sounds.tick(chart, tempo);
  assert.equal(starts.length, 1);
});
