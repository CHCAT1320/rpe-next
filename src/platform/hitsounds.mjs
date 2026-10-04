import { upperBound } from '../core/beat.mjs';
import { assetBytes } from './files.mjs';
import { assetUrl } from '../core/asset-url.mjs';

export function hitTimeline(chart, tempo, offsets = [0, 0]) {
  const entries = [];
  for (const line of chart.judgeLineList ?? []) for (const note of line.notes ?? []) {
    if (note.isFake) continue;
    entries.push({ time: tempo.seconds(note.startTime, line.bpmfactor ?? 1) + (chart.META.offset ?? 0) / 1000 + (note.type === 4 ? offsets[1] : offsets[0]),
      sound: note.hitsound || note.hitSound || (note.type === 3 ? 'flick' : note.type === 4 ? 'drag' : 'tap') });
  }
  return entries.sort((left, right) => left.time - right.time);
}

export class HitSounds {
  constructor(transport) {
    this.transport = transport; this.buffers = new Map(); this.sources = new Set(); this.volume = 0.3; this.enabled = true; this.assets = new Map(); this.chartName = ''; this.generation = 0;
  }

  async prepare() {
    const context = this.transport.ensureContext();
    if (!this.gain) { this.gain = context.createGain(); this.gain.connect(context.destination); }
    this.gain.gain.value = this.volume;
    const generation = this.generation;
    const names = new Set(['tap', 'drag', 'flick', ...(this.chart?.judgeLineList ?? []).flatMap(line => (line.notes ?? []).map(note => note.hitsound || note.hitSound).filter(Boolean))]);
    await Promise.all([...names].map(async name => {
      if (this.buffers.has(name)) return;
      let bytes = assetBytes(this.assets, name, this.chartName);
      if (!bytes && ['tap', 'drag', 'flick'].includes(name)) {
        const response = await fetch(assetUrl(`rpe/SE/${name}.ogg`)); if (!response.ok) return;
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (!bytes) return;
      try {
        const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (generation === this.generation) this.buffers.set(name, decoded);
      } catch { return; }
    }));
  }

  setProject(chart, assets, chartName) { this.stop(); this.generation++; this.buffers.clear(); this.chart = chart; this.assets = assets; this.chartName = chartName; this.compiled = null; }
  setVolume(value) { this.volume = Math.max(0, Math.min(1, value)); if (this.gain) this.gain.gain.value = this.volume; }
  stop() { for (const source of this.sources) { source.stop(); source.disconnect(); } this.sources.clear(); this.revision = -1; }

  tick(chart, tempo) {
    if (!this.enabled || !this.transport.playing || this.transport.clockReady === false) { this.stop(); return; }
    if (this.compiled !== chart || this.tempo !== tempo) {
      this.stop(); this.compiled = chart; this.tempo = tempo; this.entries = hitTimeline(chart, tempo);
    }
    const time = this.transport.time; const context = this.transport.context;
    if (this.revision !== this.transport.playRevision) {
      this.stop(); this.revision = this.transport.playRevision;
      this.next = upperBound(this.entries, time - 0.02, entry => entry.time);
    }
    this.next = Math.max(this.next, upperBound(this.entries, time - 0.08, entry => entry.time));
    const until = time + 0.1 * this.transport.rate;
    while (this.next < this.entries.length && this.entries[this.next].time <= until && this.entries[this.next].time < (this.transport.scheduleHorizon ?? Infinity)) {
      const entry = this.entries[this.next++]; const buffer = this.buffers.get(entry.sound);
      if (!buffer || !this.gain) continue;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
      source.onended = () => { this.sources.delete(source); source.disconnect(); };
      source.start(context.currentTime + Math.max(0, entry.time - time) / this.transport.rate);
      this.sources.add(source);
    }
  }
}
