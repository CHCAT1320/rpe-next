import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmWave } from '../src/platform/pcm-wave.mjs';

test('PCM 缓存保留采样率、声道顺序和浮点采样值，跨分片连续', async () => {
  const length = 65539;
  const left = Float32Array.from({ length }, (_, index) => Math.sin(index / 100));
  const right = Float32Array.from(left, value => -value * 0.5);
  const wave = await pcmWave({ length, numberOfChannels: 2, sampleRate: 44100, getChannelData: channel => [left, right][channel] });
  assert.equal(wave.type, 'audio/wav');
  const bytes = await wave.arrayBuffer(); const view = new DataView(bytes);
  assert.equal(bytes.byteLength, 44 + length * 8);
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint32(40, true), length * 8);
  for (let frame = 0; frame < length; frame++) {
    assert.equal(view.getFloat32(44 + frame * 8, true), left[frame]);
    assert.equal(view.getFloat32(48 + frame * 8, true), right[frame]);
  }
});

test('PCM 缓存转换会让出主线程，并可在切换音乐后取消', async () => {
  let cancelled = false;
  setTimeout(() => { cancelled = true; }, 0);
  const wave = await pcmWave({ length: 65537, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => new Float32Array(65537) }, () => cancelled);
  assert.equal(wave, null);
});
