const yieldEncoding = () => globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(resolve => setTimeout(resolve, 0));

export async function pcmWave(buffer, cancelled = () => false) {
  const channels = buffer.numberOfChannels;
  const dataSize = buffer.length * channels * 4;
  if (!Number.isSafeInteger(dataSize) || dataSize > 0xffffffff - 36 || channels < 1) throw new Error('音频大小超出 PCM 播放缓存限制');
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); view.setUint32(4, dataSize + 36, true); text(8, 'WAVE'); text(12, 'fmt ');
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
