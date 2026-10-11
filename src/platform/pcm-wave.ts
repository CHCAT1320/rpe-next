/**
 * The Prioritized Task Scheduling API, declared locally.
 *
 * `tsconfig.json` pins `lib` to ES2022 plus DOM, and `scheduler.yield` is not in those DOM types yet,
 * though every browser this editor targets either has it or falls back below. Declaring the one
 * member used keeps the call site on the native implementation instead of widening `lib`.
 */
declare global {
  interface Scheduler {
    yield?(): Promise<void>;
  }
  var scheduler: Scheduler | undefined;
}

/**
 * Yields to the scheduler, using the prioritised API where the browser has it.
 *
 * `scheduler.yield()` resumes as a continuation rather than a fresh task, so encoding a long buffer
 * stays responsive without the latency `setTimeout(…, 0)` adds to every chunk.
 */
const yieldEncoding = (): Promise<void> => globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));

/**
 * Encodes a decoded audio buffer as a 32-bit float WAV blob.
 *
 * The output is float rather than the 16-bit PCM the format usually carries, because the source is
 * `AudioBuffer` data that has already been through the graph; quantising here would lose precision
 * the editor can still be holding. Encoding yields between 64 Ki-frame chunks and gives up as soon as
 * `cancelled` reports true, returning `null` instead of a partial blob.
 */
export async function pcmWave(buffer: AudioBuffer, cancelled: () => boolean = () => false): Promise<Blob | null> {
  const channels = buffer.numberOfChannels;
  const dataSize = buffer.length * channels * 4;
  // `dataSize` is written into a 32-bit RIFF field below, so it has to stay inside one, and the
  // header adds 36 bytes on top of it.
  if (!Number.isSafeInteger(dataSize) || dataSize > 0xffffffff - 36 || channels < 1) throw new Error('音频大小超出 PCM 播放缓存限制');
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string): void => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); view.setUint32(4, dataSize + 36, true); text(8, 'WAVE'); text(12, 'fmt ');
  // Format 3 is IEEE float, which is what `setFloat32` below writes; the 32-bit block align follows.
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); text(36, 'data'); view.setUint32(40, dataSize, true);
  const samples = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  const parts = [new Blob([header])];
  for (let start = 0; start < buffer.length; start += 65536) {
    if (cancelled()) return null;
    const count = Math.min(65536, buffer.length - start);
    const chunk = new ArrayBuffer(count * channels * 4);
    const output = new DataView(chunk);
    for (let frame = 0; frame < count; frame++) {
      for (let channel = 0; channel < channels; channel++) output.setFloat32((frame * channels + channel) * 4, samples[channel][start + frame], true);
    }
    parts.push(new Blob([chunk]));
    await yieldEncoding();
  }
  return cancelled() ? null : new Blob(parts, { type: 'audio/wav' });
}
