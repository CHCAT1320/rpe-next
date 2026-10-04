import { captureSelection, controlSelection, commitSelectionEdit } from '../application/batch-edit.mjs';
import { beatValue } from '../core/beat.mjs';
import { snapTime } from '../core/edit-grid.mjs';

const configurations = {
  notes: [['note-move', '整体移动音符', '#ff0088'], ['note-scale', '横向缩放；按 1/2 固定首/尾音符', '#00aabb'], ['note-line', '移动到其他判定线', '#b400ff']],
  events: [['event-move', '整体移动事件（保持长度）；横向拖动达到阈值后移线', '#ef4545'], ['event-end', '整体调整结束拍（首端不变）', '#00aabb'], ['event-start', '整体调整开始拍（尾端不变）', '#8a2be2']],
};

export class BatchControls {
  constructor(stage, timeline, getSession, enabled, reportError) {
    this.stage = stage; this.timeline = timeline; this.getSession = getSession; this.enabled = enabled; this.reportError = reportError;
    this.groups = new Map(); this.active = null; this.anchorMode = 0;
    for (const [area, entries] of Object.entries(configurations)) {
      const host = document.createElement('div'); host.className = 'batch-controls'; host.hidden = true;
      for (const [kind, title, color] of entries) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'batch-ball'; button.title = title; button.setAttribute('aria-label', title);
        button.dataset.kind = kind; button.style.setProperty('--ball-color', color);
        button.addEventListener('pointerdown', event => this.begin(event, area, kind, button));
        button.addEventListener('pointermove', event => this.move(event));
        button.addEventListener('pointerup', event => this.end(event));
        button.addEventListener('pointercancel', () => this.cancel());
        host.append(button);
      }
      const hint = document.createElement('output'); hint.className = 'batch-hint'; host.append(hint);
      stage.append(host); this.groups.set(area, { host, hint, signature: '' });
    }
    window.addEventListener('keydown', event => {
      if (!this.active) return;
      if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
      if (['1', '2'].includes(event.key) && this.active.kind === 'note-scale') { event.preventDefault(); this.anchorMode = Number(event.key); this.update(); }
    });
    window.addEventListener('keyup', event => { if (Number(event.key) === this.anchorMode) { this.anchorMode = 0; this.update(); } });
    window.addEventListener('blur', () => this.cancel());
  }

  signature(area, session) { return `${session.lineIndex}:${session.eventLayer}:${[...(area === 'notes' ? session.selection : session.eventSelection)].join(',')}`; }

  sync() {
    const session = this.getSession();
    if (this.active && (session !== this.active.session || session.chart !== this.active.snapshot.chart || this.signature(this.active.area, session) !== this.active.signature || !this.enabled())) this.cancel();
    const stage = this.stage.getBoundingClientRect();
    for (const [area, group] of this.groups) {
      const selection = area === 'notes' ? session.selection : session.eventSelection;
      group.host.hidden = !this.enabled() || selection.size < 2;
      if (this.active || group.host.hidden) continue;
      const canvas = area === 'notes' ? this.timeline.notesCanvas : this.timeline.eventsCanvas;
      const rectangle = canvas.getBoundingClientRect();
      if (!rectangle.width) { group.host.hidden = true; continue; }
      const signature = `${this.signature(area, session)}:${rectangle.width}:${rectangle.height}`;
      if (signature === group.signature) continue;
      group.signature = signature;
      const point = area === 'notes' ? this.timeline.cursor : this.timeline.eventCursor;
      const horizontal = Math.max(20, Math.min(rectangle.width - 26, (point?.x ?? rectangle.width / 2) + 50));
      const vertical = Math.max(25, Math.min(rectangle.height - 97, (point?.y ?? rectangle.height / 2) - 30));
      group.host.style.left = `${rectangle.left - stage.left + horizontal}px`;
      group.host.style.top = `${rectangle.top - stage.top + vertical}px`;
    }
  }

  begin(event, area, kind, button) {
    if (event.button !== 0 || this.active || !this.enabled()) return;
    event.preventDefault(); event.stopPropagation();
    const session = this.getSession(); const snapshot = captureSelection(session);
    if ((area === 'notes' ? snapshot.notes : snapshot.events).length < 2) return;
    if (area === 'notes') snapshot.events = []; else snapshot.notes = [];
    this.timeline.cancelPlacement();
    for (const animation of button.getAnimations()) animation.cancel();
    button.style.transform = '';
    const canvas = area === 'notes' ? this.timeline.notesCanvas : this.timeline.eventsCanvas;
    const point = this.timeline.point(event, canvas);
    this.active = { session, snapshot, kind, button, area, signature: this.signature(area, session), pointerId: event.pointerId, start: point, point, canvas,
      unit: Math.max(0.35, canvas.clientHeight / 1080), factor: session.line.bpmfactor ?? 1,
      startBeat: this.timeline.snappedBeat(point.y), startX: this.timeline.positionAt(point.x) };
    button.setPointerCapture(event.pointerId); this.timeline.changed();
  }

  move(event) {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    event.preventDefault(); this.active.point = this.timeline.point(event, this.active.canvas); this.update();
  }

  update() {
    const active = this.active; if (!active) return;
    const { point, start, kind, snapshot, factor } = active;
    const deltaX = point.x - start.x; const deltaY = point.y - start.y;
    active.button.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    const seconds = this.timeline.tempo.seconds(this.timeline.origin, factor) + (active.canvas.clientHeight - 42 - point.y) / this.timeline.scale;
    const deltaBeat = beatValue(snapTime(seconds, this.timeline.division, this.timeline.tempo, factor)) - active.startBeat;
    const result = controlSelection(snapshot, kind, { deltaBeat, deltaX: this.timeline.positionAt(point.x) - active.startX, dragX: deltaX / active.unit, anchorMode: this.anchorMode });
    active.result = result;
    const view = Object.create(active.session);
    Object.defineProperty(view, 'chart', { value: result.chart });
    Object.assign(view, { lineIndex: result.lineIndex, selection: result.selection, eventSelection: result.eventSelection });
    this.timeline.bulkPreview = { ...result, session: view };
    this.groups.get(active.area).hint.textContent = result.lineIndex !== snapshot.lineIndex ? `线 ${snapshot.lineIndex} → ${result.lineIndex}` : kind === 'note-scale' ? '横向缩放' : `Δ ${deltaBeat.toFixed(3)} 拍`;
    this.timeline.changed();
  }

  end(event) {
    const active = this.active; if (!active || event.pointerId !== active.pointerId) return;
    this.move(event);
    this.timeline.bulkPreview = null;
    try {
      if (Math.hypot(active.point.x - active.start.x, active.point.y - active.start.y) > 3) {
        if (this.getSession() !== active.session || active.session.chart !== active.snapshot.chart || this.signature(active.area, active.session) !== active.signature) throw new Error('选中内容已改变，已取消拖动');
        const result = active.result;
        this.active = null;
        commitSelectionEdit(active.session, result, `控制球${active.button.title.split('；')[0]}`);
      }
    } catch (error) { this.reportError(error); }
    this.active = null; this.returnBall(active); this.timeline.changed();
  }

  returnBall(active) {
    if (active.button.hasPointerCapture(active.pointerId)) active.button.releasePointerCapture(active.pointerId);
    const group = this.groups.get(active.area);
    const rectangle = active.canvas.getBoundingClientRect();
    group.signature = `${this.signature(active.area, this.getSession())}:${rectangle.width}:${rectangle.height}`;
    group.hint.textContent = '';
    const deltaX = active.point.x - active.start.x; const deltaY = active.point.y - active.start.y;
    active.button.style.transform = '';
    const frames = Array.from({ length: 61 }, (unused, index) => {
      const remaining = 1 - (index / 60) ** (1 / 3);
      return { transform: `translate(${deltaX * remaining}px, ${deltaY * remaining}px)`, offset: index / 60 };
    });
    active.button.animate(frames, { duration: 2000 });
  }

  cancel() {
    const active = this.active; if (!active) return;
    this.active = null; this.timeline.bulkPreview = null; this.returnBall(active); this.timeline.changed();
  }
}
