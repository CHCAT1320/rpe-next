import { formatBeat } from '../core/beat.ts';
import type { Beat } from '../core/types.ts';

const ROW_HEIGHT = 44;
const OVERSCAN = 4;

/**
 * The slice of a noise area this list renders.
 *
 * `noise-areas.ts` does not export a noise-area type yet, so this stays a local structural view
 * naming only the fields read below (`Name`, `isInvert`, `appearTime`, `disappearTime`).
 */
interface NoiseListArea {
  Name?: string;
  isInvert?: boolean;
  appearTime: Beat;
  disappearTime: Beat;
}

export class NoiseAreaList {
  select: (index: number) => void;
  areas: NoiseListArea[];
  selected: number;
  rows: Map<number, HTMLButtonElement>;
  element: HTMLDivElement;
  content: HTMLDivElement;
  resize: ResizeObserver;
  /** The queued animation frame handle; unset until `schedule` first runs. */
  pending?: number | null;
  constructor(select: (index: number) => void) {
    this.select = select; this.areas = []; this.selected = -1; this.rows = new Map();
    this.element = document.createElement('div'); this.element.className = 'noise-list';
    this.element.setAttribute('role', 'listbox'); this.element.setAttribute('aria-label', '噪域列表'); this.element.tabIndex = 0;
    this.content = document.createElement('div'); this.content.className = 'noise-list-content'; this.element.append(this.content);
    this.element.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.element.addEventListener('keydown', event => {
      // The listener sits on the list box, so the event target is the focused row button; the
      // assertion states that without adding a guard the original never had.
      const origin = event.target as HTMLElement;
      const current = Number(origin.closest('[data-noise-index]')?.getAttribute('data-noise-index') ?? Math.max(0, this.selected));
      const targets: Record<string, number | undefined> = { ArrowUp: current - 1, ArrowDown: current + 1, Home: 0, End: this.areas.length - 1 };
      const target = targets[event.key];
      if (target === undefined || !this.areas.length) return;
      event.preventDefault(); event.stopPropagation();
      const index = Math.max(0, Math.min(this.areas.length - 1, target));
      this.reveal(index); this.rows.get(index)?.focus({ preventScroll: true });
    });
    this.resize = new ResizeObserver(() => this.schedule()); this.resize.observe(this.element);
  }
  schedule(): void {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => { this.pending = null; this.draw(); });
  }
  update(areas: NoiseListArea[], selected: number): void {
    this.areas = areas; this.selected = selected;
    const height = areas.length * ROW_HEIGHT;
    if (this.content.style.height !== height + 'px') this.content.style.height = height + 'px';
    this.draw();
  }
  reset(): void { this.element.scrollTop = 0; this.update([], -1); }
  reveal(index: number): void {
    const top = index * ROW_HEIGHT; const bottom = top + ROW_HEIGHT;
    if (top < this.element.scrollTop) this.element.scrollTop = top;
    else if (bottom > this.element.scrollTop + this.element.clientHeight) this.element.scrollTop = bottom - this.element.clientHeight;
    this.draw();
  }
  draw(): void {
    const height = this.element.clientHeight || 400;
    const scrollTop = Math.max(0, Math.min(this.element.scrollTop, this.areas.length * ROW_HEIGHT - height));
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(this.areas.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    for (const [index, row] of this.rows) if (index < first || index >= end) { row.remove(); this.rows.delete(index); }
    for (let index = first; index < end; index++) {
      const area = this.areas[index]; let row = this.rows.get(index);
      if (!row) {
        // `dataset` and `setAttribute` stringify their argument themselves, so `String` here states
        // the same conversion the DOM performs and leaves the stored value identical.
        row = document.createElement('button'); row.type = 'button'; row.dataset.noiseIndex = String(index);
        row.setAttribute('role', 'option'); row.setAttribute('aria-posinset', String(index + 1));
        row.style.top = index * ROW_HEIGHT + 'px'; row.style.height = ROW_HEIGHT - 4 + 'px';
        row.onclick = () => this.select(index); this.rows.set(index, row); this.content.append(row);
      }
      const text = index + ' · ' + (area.Name || '未命名噪域') + (area.isInvert ? ' · 反转' : '');
      if (row.textContent !== text) row.textContent = text;
      row.title = formatBeat(area.appearTime) + ' → ' + formatBeat(area.disappearTime);
      row.classList.toggle('active', index === this.selected); row.setAttribute('aria-selected', String(index === this.selected)); row.setAttribute('aria-setsize', String(this.areas.length));
    }
  }
}
