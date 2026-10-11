import { noiseRuntime, NOISE_AREA_COLORS } from '../core/noise-areas.ts';
import type { NoiseArea } from '../core/noise-areas.ts';
import { IntervalIndex } from '../core/interval-index.ts';
import { NoiseEdgeFilter } from './noise-edge-filter.ts';
import type { Chart } from '../core/types.ts';
import type { Point } from '../core/editor-display.ts';
import type { TempoMap } from '../core/tempo.ts';

const rank: Record<string, number> = { disabled: 0, ready: 1, active: 2 };

/**
 * The noise-area type this renderer works with.
 *
 * `noise-areas.ts` exports the real shape (re-exported from `types.ts`, which is where `Chart`
 * declares the list), so the local structural view this file used to carry is gone.
 */
type NoisePreviewArea = NoiseArea;

/** One sampled instant of an area, as `noiseRuntime(...).sample()` returns it. */
interface NoiseSample {
  state: string;
  alpha: number;
  activationMix: number;
  points: Point[];
  center: Point;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** The part of the area runtime this file calls. */
interface NoiseAreaRuntime {
  sample(seconds: number): NoiseSample;
}

/** A guide is a sampled area plus the source index and screen path the renderer attaches to it. */
interface NoiseGuide extends NoiseSample {
  area: NoisePreviewArea;
  index: number;
  /** Filled in by `draw` for every entry it keeps, so it is absent on the sampled literals. */
  path?: Path2D;
}

/** A named offscreen layer and its 2D context, as returned by `layer`. */
interface NoiseLayer {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

/** The two layers `drawLayer` hands back to `draw` for compositing. */
interface NoiseLayerPair {
  material: HTMLCanvasElement;
  coverage: HTMLCanvasElement;
}

function polygon(points: Point[], width: number, height: number, scale: number): Path2D {
  const path = new Path2D();
  const winding = points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0);
  const ordered = winding < 0 ? [...points].reverse() : points;
  ordered.forEach((point, index) => { const horizontal = width / 2 + point.x * scale; const vertical = height / 2 - point.y * scale; if (index) path.lineTo(horizontal, vertical); else path.moveTo(horizontal, vertical); });
  path.closePath(); return path;
}

export class NoisePreview {
  layers: Map<string, HTMLCanvasElement>;
  edgeFilter: NoiseEdgeFilter;
  /**
   * The frame state `draw` rebuilds on every call. `declare` states the types without emitting the
   * field declarations the original never wrote, so a preview that has never drawn still reads
   * `undefined` for each of these and every guard below behaves exactly as before.
   */
  declare guides: NoiseGuide[];
  declare hitEntries: NoiseGuide[];
  declare width: number;
  declare height: number;
  declare source: NoisePreviewArea[] | undefined;
  declare tempo: TempoMap | undefined;
  declare lifetimes: IntervalIndex<NoisePreviewArea> | undefined;
  /** Set from the saved editor preferences; unset reads as seamless, as `!== false` did before. */
  declare seamless: boolean | undefined;
  constructor() { this.layers = new Map(); this.edgeFilter = new NoiseEdgeFilter(); }
  layer(name: string, width: number, height: number, ratio: number): NoiseLayer {
    let canvas = this.layers.get(name);
    if (!canvas) { canvas = document.createElement('canvas'); this.layers.set(name, canvas); }
    const pixelsWidth = Math.max(1, Math.round(width * ratio)); const pixelsHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelsWidth || canvas.height !== pixelsHeight) { canvas.width = pixelsWidth; canvas.height = pixelsHeight; }
    // `getContext('2d')` answers null only for a context kind this canvas cannot provide.
    const context = canvas.getContext('2d')!; context.setTransform(ratio, 0, 0, ratio, 0, 0); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.clearRect(0, 0, width, height);
    return { canvas, context };
  }
  draw(target: CanvasRenderingContext2D, chart: Chart, tempo: TempoMap, seconds: number, width: number, height: number, scale: number, selected: number | undefined = -1): void {
    // `Chart` keeps an open-ended index signature, so the noise fields are narrowed here; the value
    // is read once into `areas` and reused, matching the repeated `chart.blockAreaList` reads.
    const areas = chart.blockAreaList as NoisePreviewArea[] | undefined;
    this.guides = []; this.hitEntries = []; this.width = width; this.height = height;
    if (!areas?.length || !width || !height) return;
    if (this.source !== areas || this.tempo !== tempo) {
      this.source = areas; this.tempo = tempo;
      this.lifetimes = new IntervalIndex<NoisePreviewArea>(areas, area => tempo.seconds(area.appearTime), area => tempo.seconds(area.disappearTime));
    }
    // The index was just built whenever the source or the tempo changed.
    this.guides = this.lifetimes!.query(seconds, seconds).filter(entry => seconds < entry.end).map(entry => {
      const runtime: NoiseAreaRuntime = noiseRuntime(entry.item, tempo);
      const sample: NoiseSample = runtime.sample(seconds);
      return { area: entry.item, index: entry.index, ...sample };
    });
    const margin = Math.max(2, scale * 5);
    const entries = this.guides.filter(entry => entry.scaleX !== 0 && entry.scaleY !== 0 &&
      !entry.points.every(point => width / 2 + point.x * scale < -margin) && !entry.points.every(point => width / 2 + point.x * scale > width + margin) &&
      !entry.points.every(point => height / 2 - point.y * scale < -margin) && !entry.points.every(point => height / 2 - point.y * scale > height + margin));
    if (!entries.length) return;
    for (const entry of entries) entry.path = polygon(entry.points, width, height, scale);
    const ratio = globalThis.devicePixelRatio || 1;
    entries.sort((left, right) => rank[left.state] - rank[right.state] || left.index - right.index);
    this.hitEntries = entries;
    const composite = this.layer('composite', width, height, ratio);
    for (const state of ['disabled', 'ready', 'active']) {
      const group = entries.filter(entry => entry.state === state);
      if (!group.length) continue;
      const options = chart.noiseAreaOptions as { ignoreTripleInversion?: boolean } | undefined;
      const layer = this.drawLayer(group, width, height, scale, ratio, options?.ignoreTripleInversion === true);
      composite.context.globalCompositeOperation = 'destination-out'; composite.context.drawImage(layer.coverage, 0, 0, width, height);
      composite.context.globalCompositeOperation = 'source-over'; composite.context.drawImage(layer.material, 0, 0, width, height);
    }
    target.save(); target.drawImage(composite.canvas, 0, 0, width, height); target.restore();
  }
  drawLayer(entries: NoiseGuide[], width: number, height: number, scale: number, ratio: number, singleInversion: boolean): NoiseLayerPair {
    const normal = this.layer('normal', width, height, ratio);
    const seamless = this.seamless !== false;
    const hasInversion = entries.some(entry => entry.area.isInvert);
    singleInversion &&= hasInversion;
    const normalPath = new Path2D();
    const parity = new Path2D();
    const invertedUnion = singleInversion ? this.layer('inverted-union', width, height, ratio) : null;
    const invertedOverlap = singleInversion ? this.layer('inverted-overlap', width, height, ratio) : null;
    for (const entry of entries) {
      // Every entry reaching here had `path` filled in by `draw`, which is the only caller.
      if (entry.area.isInvert && singleInversion) {
        invertedOverlap!.context.save(); invertedOverlap!.context.clip(entry.path!);
        invertedOverlap!.context.drawImage(invertedUnion!.canvas, 0, 0, width, height); invertedOverlap!.context.restore();
        invertedUnion!.context.fillStyle = '#fff'; invertedUnion!.context.fill(entry.path!);
      }
      else if (entry.area.isInvert) parity.addPath(entry.path!);
      else normalPath.addPath(entry.path!);
    }
    normal.context.fillStyle = '#fff'; normal.context.fill(normalPath);
    const coverage = hasInversion ? this.layer('coverage', width, height, ratio) : normal;
    if (hasInversion) {
      coverage.context.drawImage(normal.canvas, 0, 0, width, height);
      coverage.context.globalCompositeOperation = 'xor'; coverage.context.fillStyle = '#fff';
      if (singleInversion) {
        invertedUnion!.context.globalCompositeOperation = 'destination-out'; invertedUnion!.context.drawImage(invertedOverlap!.canvas, 0, 0, width, height);
        coverage.context.drawImage(invertedUnion!.canvas, 0, 0, width, height);
      } else coverage.context.fill(parity, 'evenodd');
    }
    const material = this.layer('material', width, height, ratio);
    const edges = seamless && entries.some(entry => entry.activationMix > 0) ? this.layer('edges', width, height, ratio) : null;
    const uniform = seamless && entries[0].state !== 'ready';
    const inverted = !uniform && hasInversion ? this.layer('inverted', width, height, ratio) : null;
    const outlines = uniform && edges ? new Path2D() : null;
    for (const entry of entries) {
      if (!uniform) {
        // `hasInversion` is true whenever any entry is inverted, so this layer exists on that branch.
        const context = entry.area.isInvert ? inverted!.context : material.context;
        const color = NOISE_AREA_COLORS.appearance.slice(0, 3).map((value, index) => Math.round(value + (NOISE_AREA_COLORS.active[index] - value) * entry.activationMix));
        context.save(); context.clip(entry.path!); context.clearRect(0, 0, width, height);
        context.fillStyle = `rgba(${color.slice(0, 3).join(',')},${entry.alpha})`; context.fillRect(0, 0, width, height);
        if (!seamless && entry.activationMix > 0) { context.strokeStyle = `rgba(${NOISE_AREA_COLORS.edge.slice(0, 3).join(',')},${entry.activationMix})`; context.lineWidth = Math.max(2, scale * 5); context.stroke(entry.path!); }
        context.restore();
      }
      if (outlines) outlines.addPath(entry.path!);
      else if (edges && entry.activationMix > 0) {
        edges.context.strokeStyle = `rgba(${NOISE_AREA_COLORS.edge.slice(0, 3).join(',')},${entry.activationMix})`;
        edges.context.lineWidth = Math.max(2, scale * 5); edges.context.stroke(entry.path!);
      }
    }
    // `outlines` is only built when `edges` is, so the layer is present on this branch.
    if (outlines) { edges!.context.strokeStyle = `rgb(${NOISE_AREA_COLORS.edge.slice(0, 3).join(',')})`; edges!.context.lineWidth = Math.max(2, scale * 5); edges!.context.stroke(outlines); }
    if (inverted) {
      inverted.context.globalCompositeOperation = 'destination-out'; inverted.context.drawImage(normal.canvas, 0, 0, width, height);
      material.context.drawImage(inverted.canvas, 0, 0, width, height);
    }
    if (uniform) {
      const color = entries[0].state === 'active' ? NOISE_AREA_COLORS.active : NOISE_AREA_COLORS.appearance;
      material.context.fillStyle = `rgba(${color.slice(0, 3).join(',')},${color[3]})`; material.context.fillRect(0, 0, width, height);
    }
    material.context.globalCompositeOperation = 'destination-in'; material.context.drawImage(coverage.canvas, 0, 0, width, height);
    if (edges) {
      const radius = Math.max(1, scale * 2.5);
      const edgeQuality = entries.length > 48 ? 0.5 : 1;
      const filtered = this.edgeFilter.render(coverage.canvas, edges.canvas, radius / width, radius / height, NOISE_AREA_COLORS.edge, edgeQuality);
      if (filtered) {
        material.context.globalCompositeOperation = 'source-over'; material.context.drawImage(filtered, 0, 0, width, height);
        return { material: material.canvas, coverage: coverage.canvas };
      }
      const interior = this.layer('interior', width, height, ratio);
      interior.context.drawImage(coverage.canvas, 0, 0, width, height);
      interior.context.globalCompositeOperation = 'destination-in';
      for (let direction = 0; direction < 8; direction++) {
        const angle = direction * Math.PI / 4;
        interior.context.drawImage(coverage.canvas, Math.cos(angle) * radius, Math.sin(angle) * radius, width, height);
      }
      edges.context.globalCompositeOperation = 'destination-out'; edges.context.drawImage(interior.canvas, 0, 0, width, height);
      edges.context.globalCompositeOperation = 'destination-in'; edges.context.drawImage(coverage.canvas, 0, 0, width, height);
      material.context.globalCompositeOperation = 'source-over'; material.context.drawImage(edges.canvas, 0, 0, width, height);
    }
    return { material: material.canvas, coverage: coverage.canvas };
  }
  pick(horizontal: number, vertical: number): number | null {
    const context = this.layers.get('normal')?.getContext('2d');
    if (!context || !this.hitEntries?.length) return null;
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
    try {
      for (let index = this.hitEntries.length - 1; index >= 0; index--) {
        const entry = this.hitEntries[index];
        if (context.isPointInPath(entry.path!, horizontal, vertical)) return entry.index;
      }
      return null;
    } finally { context.restore(); }
  }
  drawGuides(context: CanvasRenderingContext2D, scale: number, selected: number | undefined, showNames: boolean): void {
    for (const entry of this.guides ?? []) {
      const focused = entry.index === selected;
      if (!showNames && !focused) continue;
      context.save();
      const horizontal = this.width / 2 + entry.center.x * scale; const vertical = this.height / 2 - entry.center.y * scale;
      context.translate(horizontal, vertical); context.rotate(entry.rotation);
      context.strokeStyle = focused ? '#ffe39a' : '#ffc9b5'; context.fillStyle = context.strokeStyle; context.lineWidth = 1.5;
      context.beginPath(); context.arc(0, 0, 3.5, 0, Math.PI * 2); context.moveTo(-8, 0); context.lineTo(8, 0); context.moveTo(0, -8); context.lineTo(0, 8); context.stroke();
      if (showNames) { context.font = `${Math.max(11, 30 * scale)}px RPEGame, sans-serif`; context.textAlign = 'center'; context.textBaseline = 'bottom'; context.fillText(entry.area.Name || `噪域 ${entry.index}`, 0, -10); }
      context.restore();
    }
  }
}
