import { beatValue, fromNumber } from '../core/beat.mjs';
import { IntervalIndex } from '../core/interval-index.mjs';
import { createNote, noteIsAbove, EVENT_TYPES, EXTENDED_TYPES } from '../core/chart.mjs';
import { easing, bezier } from '../core/easing.mjs';
import { eventKey, eventList } from '../application/event-commands.mjs';
import { shaderIdentity, shaderEventLanes } from '../core/shader-events.mjs';
import { EventInteraction } from './event-interaction.mjs';
import { drawClipboard } from './clipboard-preview.mjs';
import { TempoMap } from '../core/tempo.mjs';
import { snapPosition, snapTime, verticalGrid, placementRange } from '../core/edit-grid.mjs';
import { SPECIAL_TRACKS, eventChains, simultaneousNotes, strokeIntersects } from '../core/editor-display.mjs';

export const NOTE_COLORS = { 1: '#8acbff', 2: '#8acbff', 3: '#f596ac', 4: '#f1ce76' };
const labels = ['X', 'Y', '旋转', '透明', '速度'];
const extendedLabels = SPECIAL_TRACKS.map(track => track.label);

export function prepareCanvas(canvas) {
  const rectangle = canvas.getBoundingClientRect();
  const ratio = devicePixelRatio || 1;
  const width = Math.round(rectangle.width * ratio);
  const height = Math.round(rectangle.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rectangle.width, rectangle.height);
  return { context, width: rectangle.width, height: rectangle.height };
}

export class Timeline {
  constructor(notesCanvas, eventsCanvas, getSession, onEvent, changed, reportError = console.error) {
    this.notesCanvas = notesCanvas;
    this.eventsCanvas = eventsCanvas;
    this.getSession = () => this.bulkPreview?.session ?? getSession();
    this.onEvent = onEvent;
    this.changed = changed;
    this.origin = 0;
    this.scale = 500;
    this.division = 4;
    this.snapX = true;
    this.tool = 0;
    this.layer = 0;
    this.extended = false;
    this.cursor = null;
    this.drag = null;
    this.pendingHold = null;
    this.tempo = new TempoMap(getSession().chart.BPMList);
    this.onWheel = () => {};
    this.curvePick = null;
    this.eventRects = [];
    this.eventInteraction = new EventInteraction(this, reportError);
    this.noteScale = 1;
    this.scrollSpeed = 1;
    this.gridCount = 11;
    for (const canvas of [notesCanvas, eventsCanvas]) {
      canvas.addEventListener('wheel', event => {
        event.preventDefault();
        this.onWheel(event);
        changed();
      }, { passive: false });
      canvas.addEventListener('contextmenu', event => event.preventDefault());
    }
    notesCanvas.addEventListener('pointermove', event => this.move(event));
    notesCanvas.addEventListener('pointerleave', () => { if (!this.drag) this.cursor = null; changed(); });
    notesCanvas.addEventListener('pointerdown', event => this.down(event));
    notesCanvas.addEventListener('pointerup', event => this.up(event));
    notesCanvas.addEventListener('pointercancel', () => { this.drag = null; changed(); });
  }

  point(event, canvas = this.notesCanvas) {
    const rectangle = canvas.getBoundingClientRect();
    return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
  }

  rectangleSelection() {
    if (this.drag?.kind === 'rectangle') return { drag: this.drag, canvas: this.notesCanvas, area: 'notes' };
    if (this.eventInteraction.drag?.kind === 'rectangle') return { drag: this.eventInteraction.drag, canvas: this.eventsCanvas, area: 'events' };
    return null;
  }

  rectangleStart(drag) {
    return { x: drag.start.x, y: drag.startSeconds === undefined ? drag.start.y : this.notesCanvas.clientHeight - 42 - (drag.startSeconds - this.tempo.seconds(this.origin, this.factor)) * this.scale };
  }

  rectangleTimes(drag) {
    const start = drag.startSeconds ?? this.timeAt(drag.start.y);
    const current = this.timeAt(drag.current.y);
    return [this.tempo.beat(Math.min(start, current), this.factor) - 1e-8, this.tempo.beat(Math.max(start, current), this.factor) + 1e-8];
  }

  updateRectangle(event) {
    const selection = this.rectangleSelection(); if (!selection) return;
    selection.drag.current = this.point(event, selection.canvas); this.changed();
  }

  finishRectangle(event) {
    const selection = this.rectangleSelection();
    if (!selection || ![0, 1, 2].includes(event.button)) return false;
    selection.drag.finished = true;
    if (selection.area === 'notes') this.up(event); else this.eventInteraction.up(event);
    return true;
  }

  get eventTypes() { return this.extended ? SPECIAL_TRACKS.map(track => track.key) : EVENT_TYPES; }

  eventColumnBounds(channel, width) {
    const channelWidth = width / this.eventTypes.length;
    const barWidth = channelWidth * Math.max(0.35, Math.min(1, this.eventBarWidth ?? 0.82));
    return { channelWidth, x: channel * channelWidth + (channelWidth - barWidth) / 2, width: barWidth };
  }

  get factor() { return this.getSession().line?.bpmfactor ?? 1; }
  timeAt(vertical) { return this.tempo.seconds(this.origin, this.factor) + (this.notesCanvas.clientHeight - 42 - vertical) / this.scale; }
  beatAt(vertical) { return this.tempo.beat(this.timeAt(vertical), this.factor); }
  snappedBeat(vertical) { return beatValue(snapTime(this.timeAt(vertical), this.division, this.tempo, this.factor)); }
  vertical(beat, height = this.notesCanvas.clientHeight) { return height - 42 - (this.tempo.seconds(beat, this.factor) - this.tempo.seconds(this.origin, this.factor)) * this.scale; }
  eventVertical(beat, type) { return this.vertical(beat); }
  eventBeatAt(vertical, type, snap = false) {
    const factor = this.factor;
    return snap ? beatValue(snapTime(this.timeAt(vertical), this.division, this.tempo, factor)) : this.tempo.beat(this.timeAt(vertical), factor);
  }
  get renderNoteScale() {
    const width = this.notesCanvas.clientWidth;
    const gap = this.columnGap ?? 24;
    return this.noteScale * (this.notesOnly ? width / Math.max(1, (width - gap) / 2) : 1);
  }
  horizontal(position) { return this.noteHorizontal(position); }
  noteInset() { return Math.min(48 * this.renderNoteScale, Math.max(0, this.notesCanvas.clientWidth / 2 - 1)); }
  noteWidth(note) { return 68 * this.renderNoteScale * Math.min(3, Math.max(0.2, note.size ?? 1)); }
  snapXPosition(value) {
    if (!this.snapX) return value;
    const snapped = snapPosition(value, this.gridCount);
    return [-675, 675, snapped].reduce((closest, candidate) => Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest, snapped);
  }
  noteHorizontal(position) {
    const inset = this.noteInset(); const width = Math.max(1, this.notesCanvas.clientWidth - inset * 2);
    return inset + (position - (this.cameraX ?? 0) + 675) / 1350 * width;
  }
  positionAt(horizontal) {
    return this.notePositionAt(horizontal);
  }
  notePositionAt(horizontal) {
    const inset = this.noteInset(); const width = Math.max(1, this.notesCanvas.clientWidth - inset * 2);
    const value = (horizontal - inset) / width * 1350 - 675 + (this.cameraX ?? 0);
    return this.snapXPosition(value);
  }
  clampNoteHorizontal(horizontal, width, canvasWidth = this.notesCanvas.clientWidth) {
    if (horizontal + width / 2 < 0 || horizontal - width / 2 > canvasWidth) return null;
    return horizontal;
  }

  cancelPlacement() { this.pendingHold = null; this.eventInteraction.pending = null; this.drag = null; this.eventInteraction.drag = null; this.changed(); }

  movedNote(note) {
    if (!['move', 'startTime', 'endTime'].includes(this.drag?.kind)) return note;
    if (Math.hypot(this.drag.current.x - this.drag.start.x, this.drag.current.y - this.drag.start.y) <= 4 && !this.drag.scrolled) return note;
    const anchor = this.getSession().notes[this.drag.anchor];
    const key = this.drag.kind === 'endTime' ? 'endTime' : 'startTime';
    const scroll = this.tempo.seconds(this.origin, this.factor) - (this.drag.originSeconds ?? this.tempo.seconds(this.origin, this.factor));
    const seconds = this.tempo.seconds(anchor[key], this.factor) + (this.drag.start.y - this.drag.current.y) / this.scale + scroll;
    const deltaBeat = beatValue(snapTime(seconds, this.division, this.tempo, this.factor)) - beatValue(anchor[key]);
    if (this.drag.kind !== 'move') {
      if (note.type !== 2) return note;
      const value = this.drag.kind === 'endTime' ? Math.max(beatValue(note.startTime), beatValue(note.endTime) + deltaBeat) : Math.max(0, Math.min(beatValue(note.endTime), beatValue(note.startTime) + deltaBeat));
      return { ...note, [key]: fromNumber(value) };
    }
    const rawDeltaX = (this.drag.current.x - this.drag.start.x) / Math.max(1, this.notesCanvas.clientWidth - this.noteInset() * 2) * 1350;
    const deltaX = this.snapXPosition(anchor.positionX + rawDeltaX) - anchor.positionX;
    const boundedBeat = Math.max(-beatValue(note.startTime), deltaBeat);
    return { ...note, positionX: Math.max(-675, Math.min(675, note.positionX + deltaX)), startTime: fromNumber(beatValue(note.startTime) + boundedBeat), endTime: fromNumber(beatValue(note.endTime) + boundedBeat) };
  }

  autoScroll(elapsed) {
    const drag = this.drag ?? this.eventInteraction.drag;
    if (!drag || !['move', 'startTime', 'endTime'].includes(drag.kind)) return;
    const height = this.notesCanvas.clientHeight;
    const overflow = drag.current.y < 0 ? -drag.current.y : drag.current.y > height ? height - drag.current.y : 0;
    if (!overflow) return;
    drag.scrolled = true;
    this.onDragScroll?.(Math.sign(overflow) * Math.min(900, 120 + Math.abs(overflow) * 4) / this.scale * Math.min(0.05, elapsed));
    this.changed();
  }

  refreshIndex() {
    const notes = this.getSession().notes;
    if (notes === this.indexedNotes) return;
    this.indexedNotes = notes;
    this.noteIndex = new IntervalIndex(notes, note => beatValue(note.startTime), note => Math.max(beatValue(note.startTime), beatValue(note.endTime)));
  }

  visible() {
    this.refreshIndex();
    return this.noteIndex.query(this.beatAt(this.notesCanvas.clientHeight) - 0.2, this.beatAt(0) + 0.2);
  }

  hit(position) {
    return this.visible().sort((left, right) => Number(right.item.type === 2) - Number(left.item.type === 2)).findLast(entry => this.clampNoteHorizontal(this.noteHorizontal(entry.item.positionX), this.noteWidth(entry.item)) !== null && Math.abs(this.noteHorizontal(entry.item.positionX) - position.x) <= this.noteWidth(entry.item) / 2
      && position.y >= this.vertical(entry.end) - 9 && position.y <= this.vertical(entry.start) + 9);
  }

  move(event) {
    this.cursor = this.point(event);
    this.clipboardPointer = this.cursor;
    this.hoverArea = 'notes';
    if (this.drag) {
      const previous = this.drag.current;
      this.drag.current = this.cursor;
      if (this.drag.kind === 'stroke' && (this.drag.tracing || Math.hypot(this.cursor.x - this.drag.start.x, this.cursor.y - this.drag.start.y) > 3)) {
        this.drag.tracing = true;
        this.drag.points.push(this.cursor);
        for (const entry of this.visible()) if (strokeIntersects(previous, this.cursor, {
          left: this.noteHorizontal(entry.item.positionX) - 34 * this.renderNoteScale, right: this.noteHorizontal(entry.item.positionX) + 34 * this.renderNoteScale,
          top: this.vertical(entry.end), bottom: this.vertical(entry.start),
        })) this.drag.remove ? this.getSession().selection.delete(entry.index) : this.getSession().selection.add(entry.index);
        this.getSession().notify();
      }
    }
    this.changed();
    if (!this.drag && this.notesCanvas.style) {
      const hit = this.hit(this.cursor);
      this.notesCanvas.style.cursor = hit?.item.type === 2 && (Math.abs(this.cursor.y - this.vertical(hit.end)) < 8 || Math.abs(this.cursor.y - this.vertical(hit.start)) < 8) ? 'ns-resize' : hit ? 'move' : 'crosshair';
    }
  }

  down(event) {
    if (![0, 1, 2].includes(event.button)) return;
    event.preventDefault?.();
    if (this.finishRectangle(event)) return;
    this.notesCanvas.focus();
    this.notesCanvas.setPointerCapture(event.pointerId);
    const position = this.point(event);
    this.cursor = position;
    this.clipboardPointer = position;
    this.hoverArea = 'notes';
    const hit = this.hit(position);
    const session = this.getSession();
    if (event.button === 0 && hit && this.curvePick?.(hit.item, hit.index)) return;
    session.focus = 'notes';
    if (!event.ctrlKey && !event.shiftKey && event.button !== 1) session.eventSelection.clear();
    if (event.button === 0 && (this.pendingHold || this.tool && !event.shiftKey && !event.ctrlKey)) { this.addAtCursor(this.pendingHold ? 2 : this.tool); return; }
    if (event.shiftKey || event.button === 1) {
      this.drag = { kind: 'rectangle', start: position, startSeconds: this.timeAt(position.y), current: position, append: true, remove: false };
    } else if (hit && event.button === 0) {
      if (event.ctrlKey) {
        if (session.selection.has(hit.index)) session.selection.delete(hit.index);
        else session.selection.add(hit.index);
      } else if (!session.selection.has(hit.index)) session.selection = new Set([hit.index]);
      const kind = hit.item.type === 2 && Math.abs(position.y - this.vertical(hit.end)) <= 8 ? 'endTime' : hit.item.type === 2 && Math.abs(position.y - this.vertical(hit.start)) <= 8 ? 'startTime' : 'move';
      this.drag = { kind, start: position, current: position, anchor: hit.index, originSeconds: this.tempo.seconds(this.origin, this.factor) };
      session.notify();
    } else { this.drag = { kind: 'stroke', start: position, current: position, points: [position], remove: event.button === 2 }; session.notify(); }
    this.changed();
  }

  up(event) {
    if (!this.drag) return;
    if (this.drag.kind === 'stroke' && !this.drag.remove && !this.drag.tracing && this.previewPick?.(event)) { this.drag = null; this.changed(); return; }
    if (this.drag.kind === 'stroke' && this.drag.remove && !this.drag.tracing) {
      this.drag = { ...this.drag, kind: 'rectangle', startSeconds: this.timeAt(this.drag.start.y), append: true, remove: false }; this.changed(); return;
    }
    const drag = this.drag;
    drag.current = this.point(event);
    const session = this.getSession();
    if (drag.kind === 'rectangle') {
      if (!drag.finished) { this.changed(); return; }
      this.refreshIndex();
      const left = Math.min(drag.start.x, drag.current.x);
      const right = Math.max(drag.start.x, drag.current.x);
      const [bottom, top] = this.rectangleTimes(drag);
      if (!drag.append) session.selection.clear();
      for (const entry of this.noteIndex.query(bottom, top)) {
        const horizontal = this.noteHorizontal(entry.item.positionX);
        if (horizontal >= left && horizontal <= right) drag.remove ? session.selection.delete(entry.index) : session.selection.add(entry.index);
      }
      session.notify();
    } else if (['move', 'startTime', 'endTime'].includes(drag.kind) && (drag.scrolled || Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y) > 4)) {
      const replacements = new Map([...session.selection].map(index => [session.notes[index], this.movedNote(session.notes[index])]));
      this.drag = null;
      session.transformSelection(drag.kind === 'move' ? '移动音符' : '调整 Hold 长度', note => replacements.get(note));
    }
    this.drag = null;
    this.changed();
  }

  addAtCursor(type) {
    if (!this.cursor) return false;
    this.getSession().focus = 'notes'; this.getSession().eventSelection.clear();
    const beat = this.snappedBeat(this.cursor.y);
    if (type === 2) {
      if (!this.pendingHold) this.pendingHold = { beat, positionX: this.notePositionAt(this.cursor.x) };
      else {
        const range = placementRange(fromNumber(this.pendingHold.beat), fromNumber(beat));
        if (range) this.getSession().insertNotes([createNote(2, range.start, this.pendingHold.positionX, range.end)]);
        this.pendingHold = null;
      }
      this.changed();
    } else this.getSession().insertNotes([createNote(type, beat, this.notePositionAt(this.cursor.x))]);
    return true;
  }

  grid(context, width, height, playBeat) {
    const first = Math.floor(this.beatAt(height) * this.division);
    const last = Math.ceil(this.beatAt(0) * this.division);
    const localBeatHeight = Math.abs(this.vertical(this.origin + 1) - this.vertical(this.origin));
    const stride = Math.max(1, Math.ceil(6 * this.division / localBeatHeight));
    context.font = '12px RPE, sans-serif';
    context.lineWidth = Math.max(0.5, (this.barWidth ?? 3) * 2 * width / 1920);
    for (let tick = first; tick <= last; tick += stride) {
      const beat = tick / this.division;
      const vertical = this.vertical(beat, height);
      const major = tick % this.division === 0;
      context.strokeStyle = `rgba(${major ? '0,255,255' : '255,255,0'},${Math.min(1, (this.barAlpha ?? 1) * (major ? 0.9 : tick % 2 === 0 ? 0.6 : 0.4))})`;
      context.beginPath(); context.moveTo(0, vertical); context.lineTo(width, vertical); context.stroke();
      if (tick % this.division === 0) { context.fillStyle = '#dddddd'; context.fillText(String(beat), 5, vertical - 4); }
    }
    context.strokeStyle = '#ffd76a';
    context.beginPath(); context.moveTo(0, this.vertical(playBeat, height)); context.lineTo(width, this.vertical(playBeat, height)); context.stroke();
    context.lineWidth = 1;
  }

  draw(playBeat) {
    const { context, width, height } = prepareCanvas(this.notesCanvas);
    this.grid(context, width, height, playBeat);
    context.strokeStyle = '#555555';
    const grid = verticalGrid(this.gridCount);
    const extent = 675;
    const cameraX = this.cameraX ?? 0;
    const firstGrid = Math.ceil((cameraX - extent) / grid.spacing - grid.first);
    const lastGrid = Math.floor((cameraX + extent) / grid.spacing - grid.first);
    const lanes = new Set();
    for (let index = firstGrid; index <= lastGrid; index++) lanes.add((index + grid.first) * grid.spacing);
    lanes.add(cameraX - extent); lanes.add(cameraX + extent);
    lanes.add(cameraX);
    for (const lane of lanes) {
      const center = Math.abs(lane - cameraX) < 1e-7;
      const boundary = Math.abs(Math.abs(lane - cameraX) - extent) < 1e-7;
      context.strokeStyle = center ? '#9ba5b0' : boundary ? '#737d88' : '#555555'; context.lineWidth = center ? 2 : boundary ? 1.5 : 1;
      context.beginPath(); context.moveTo(this.horizontal(lane), 0); context.lineTo(this.horizontal(lane), height); context.stroke();
    }
    context.lineWidth = 1;
    this.drawCurveGhost(context);
    drawClipboard(this, context, width, height, 'notes');
    const session = this.getSession();
    if (this.highlightChart !== session.chart || this.highlightTempo !== this.tempo) {
      this.highlightChart = session.chart; this.highlightTempo = this.tempo; this.simultaneous = simultaneousNotes(session.chart, this.tempo);
    }
    const entries = new Map(this.visible().map(entry => [entry.index, entry]));
    if (['move', 'startTime', 'endTime'].includes(this.drag?.kind)) for (const index of session.selection) entries.set(index, { item: session.notes[index], index });
    for (const entry of [...entries.values()].sort((left, right) => Number(right.item.type === 2) - Number(left.item.type === 2))) {
      const selected = session.selection.has(entry.index);
      const note = selected ? this.movedNote(entry.item) : entry.item;
      const horizontal = this.noteHorizontal(note.positionX);
      const vertical = this.vertical(beatValue(note.startTime));
      const endVertical = this.vertical(beatValue(note.endTime));
      const noteWidth = 68 * this.renderNoteScale * Math.min(3, Math.max(0.2, note.size ?? 1));
      const renderedHorizontal = this.clampNoteHorizontal(horizontal, noteWidth, width);
      if (renderedHorizontal == null) continue;
      context.globalAlpha = note.isFake ? 0.45 : noteIsAbove(note) ? 1 : 0.7;
      context.fillStyle = NOTE_COLORS[note.type];
      const highlight = this.highlight !== false && this.simultaneous.has(entry.item);
      const textured = note.type === 2 ? this.skin?.hold(context, renderedHorizontal, vertical, endVertical, noteWidth, highlight, true, note.tint ?? note.color) : this.skin?.head(context, note.type, renderedHorizontal, vertical, noteWidth, highlight, note.tint ?? note.color);
      if (!textured && note.type === 2) {
        context.globalAlpha *= 0.45;
        const top = Math.max(-10, endVertical);
        context.fillRect(renderedHorizontal - noteWidth / 2, top, noteWidth, Math.min(height + 20, vertical - top));
        context.globalAlpha = 1;
        context.fillRect(renderedHorizontal - noteWidth / 2, endVertical - 3, noteWidth, 6);
      }
      if (!textured) context.fillRect(renderedHorizontal - noteWidth / 2, vertical - 4, noteWidth, 8);
      if (selected) { context.strokeStyle = '#fff'; context.lineWidth = 2; context.strokeRect(renderedHorizontal - noteWidth / 2 - 3, vertical - 7, noteWidth + 6, 14); context.lineWidth = 1; }
      context.globalAlpha = 1;
    }
    if (this.drag?.kind === 'rectangle' && !this.marqueeOverlay) {
      context.fillStyle = '#81bfff22'; context.strokeStyle = '#81bfff';
      const start = this.rectangleStart(this.drag); const { current } = this.drag;
      context.fillRect(start.x, start.y, current.x - start.x, current.y - start.y);
      context.strokeRect(start.x, start.y, current.x - start.x, current.y - start.y);
    }
    if (this.pendingHold && this.cursor) {
      const head = this.vertical(this.pendingHold.beat); const tail = this.vertical(this.snappedBeat(this.cursor.y));
      context.globalAlpha = 0.65;
          if (!this.skin?.hold(context, this.noteHorizontal(this.pendingHold.positionX), head, tail, 68 * this.renderNoteScale)) context.fillRect(this.noteHorizontal(this.pendingHold.positionX) - 20, Math.min(head, tail), 40, Math.abs(tail - head));
      context.globalAlpha = 1;
    } else if (this.cursor && this.tool) {
      context.fillStyle = NOTE_COLORS[this.tool] + '88';
      const vertical = this.vertical(this.snappedBeat(this.cursor.y));
      context.fillRect(this.noteHorizontal(this.notePositionAt(this.cursor.x)) - 24, vertical - 3, 48, 6);
    }
    context.globalAlpha = 1;
    if (this.drag?.kind === 'stroke') {
      context.strokeStyle = this.drag.remove ? '#ff8080' : '#80ffff'; context.beginPath();
      this.drag.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke();
    }
    if (Number.isFinite(this.scaleAxis)) {
      context.save(); context.strokeStyle = '#fff3a3'; context.lineWidth = 2; context.setLineDash([8, 5]);
      const horizontal = this.noteHorizontal(this.scaleAxis);
      context.beginPath(); context.moveTo(horizontal, 0); context.lineTo(horizontal, height); context.stroke(); context.restore();
    }
    if (!this.notesOnly) this.drawEvents(playBeat);
  }

  drawCurveGhost(context) {
    let ghost = [];
    try { ghost = this.curveGhost?.() ?? []; } catch { ghost = []; }
    if (ghost.length) {
      context.save(); context.globalAlpha = 0.95; context.strokeStyle = '#fff1a8'; context.fillStyle = NOTE_COLORS[ghost[0].type] ?? '#fff'; context.lineWidth = 2.5; context.setLineDash([6, 3]);
      context.beginPath();
      ghost.forEach((note, index) => {
        const horizontal = this.noteHorizontal(note.positionX); const vertical = this.vertical(beatValue(note.startTime));
        if (index === 0) context.moveTo(horizontal, vertical); else context.lineTo(horizontal, vertical);
      });
      context.stroke();
      context.setLineDash([]);
      for (const note of ghost) {
        if (note.anchor) continue;
        const horizontal = this.noteHorizontal(note.positionX); const vertical = this.vertical(beatValue(note.startTime));
        const width = 52 * this.renderNoteScale;
        const renderedHorizontal = this.clampNoteHorizontal(horizontal, width);
        if (renderedHorizontal == null) continue;
        context.fillRect(renderedHorizontal - width / 2, vertical - 5, width, 10); context.strokeRect(renderedHorizontal - width / 2 - 2, vertical - 7, width + 4, 14);
      }
      context.restore();
    }
  }

  drawEvents(playBeat) {
    const { context, width, height } = prepareCanvas(this.eventsCanvas);
    this.grid(context, width, height, playBeat);
    drawClipboard(this, context, width, height, 'events');
    const session = this.getSession();
    const layer = (this.extended ? { ...session.line?.extended, paintEvents: eventList(session, 'paintEvents') } : session.line?.eventLayers?.[this.layer]) ?? {};
    const indexKey = `${session.lineIndex}:${this.extended}:${this.layer}`;
    if (this.indexedLayer !== session.chart || this.eventIndexKey !== indexKey) {
      this.indexedLayer = session.chart; this.eventIndexKey = indexKey;
      this.shaderLanes = shaderEventLanes(layer.paintEvents ?? []);
      this.eventIndexes = this.eventTypes.map(type => new IntervalIndex(layer[type] ?? [], event => beatValue(event.startTime), event => beatValue(event.endTime)));
      this.chains = this.eventTypes.map(type => eventChains(layer[type] ?? []));
      this.chainRanges = this.chains.map(groups => new Map(groups.flatMap(group => group.entries.map(entry => [entry.index, group]))));
    }
    this.eventRects = [];
    this.eventTypes.forEach((type, channel) => {
      const { channelWidth, x: barX, width: barWidth } = this.eventColumnBounds(channel, width);
      const horizontal = channel * channelWidth;
      context.strokeStyle = '#334154'; context.beginPath(); context.moveTo(horizontal, 0); context.lineTo(horizontal, height); context.stroke();
      const entries = this.eventIndexes[channel].query(this.eventBeatAt(height, type), this.eventBeatAt(0, type));
      if (type === 'paintEvents') {
        this.drawShaderEvents(context, entries, channel, width, height);
        context.fillStyle = '#303030'; context.fillRect(horizontal, 0, channelWidth, 23);
        context.fillStyle = '#f5f5f5'; context.font = '12px RPE, sans-serif'; context.fillText('着色器', horizontal + 6, 16);
        return;
      }
      const ranges = this.chainRanges[channel];
      const seamlessGroups = new Set();
      if (this.seamlessEvents) for (const group of new Set(entries.map(entry => ranges.get(entry.index)))) {
        if (!group || group.entries.length < 2) continue;
        const linkedSelection = group.entries.some(candidate => {
          const selected = this.getSession().eventSelection.has(eventKey(type, candidate.index));
          const linked = Number(candidate.event.linkgroup ?? 0) > 0;
          return selected || linked;
        });
        if (linkedSelection) continue;
        seamlessGroups.add(group);
        const first = group.entries[0].event; const last = group.entries.at(-1).event;
        const chainTop = Math.max(0, this.vertical(beatValue(last.endTime)));
        const chainBottom = Math.min(height, this.vertical(beatValue(first.startTime)));
        if (chainBottom <= chainTop) continue;
        context.globalAlpha = this.eventOpacity ?? 0.25;
        context.fillStyle = '#e58d24'; context.fillRect(barX, chainTop, barWidth, chainBottom - chainTop);
        context.globalAlpha = 1; context.strokeStyle = '#ffa334'; context.lineWidth = 1;
        context.strokeRect(barX, chainTop, barWidth, chainBottom - chainTop);
      }
      for (const entry of entries) {
        const vertical = this.vertical(entry.end);
        const bottom = this.vertical(entry.start);
        const rectangle = { x: barX, y: Math.max(0, vertical), width: barWidth, height: Math.max(2, Math.min(height, bottom) - Math.max(0, vertical)), index: entry.index, type };
        this.eventRects.push(rectangle);
        const selected = this.getSession().eventSelection.has(eventKey(type, entry.index));
        const linked = Number(entry.item.linkgroup ?? 0) > 0;
        const chain = ranges.get(entry.index);
        const seamless = seamlessGroups.has(chain);
        context.globalAlpha = this.eventOpacity ?? 0.25;
        context.fillStyle = selected ? '#ffe091' : linked ? '#ffe044' : '#e58d24';
        if (!seamless) context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
        context.strokeStyle = selected ? '#fff2bd' : linked ? '#ffe044' : '#ffa334'; context.lineWidth = selected ? 2 : 1;
        if (linked) context.setLineDash([4, 3]);
        if (!seamless) context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
        context.setLineDash([]);
        context.globalAlpha = 1;
        context.lineWidth = 2;
        context.save(); context.beginPath(); context.rect(rectangle.x, rectangle.y, rectangle.width, rectangle.height); context.clip();
        const group = ranges.get(entry.index);
        context.beginPath();
        for (let step = 0; step <= 36; step++) {
          const progress = step / 36; const event = entry.item;
          const amount = event.bezier ? bezier(progress, event.bezierPoints) : easing(progress, event.easingType, event.easingLeft ?? 0, event.easingRight ?? 1);
          const value = event.start + (event.end - event.start) * amount;
          const normalized = group.max - group.min > 0.01 ? (value - group.min) / (group.max - group.min) : 0.5;
          const horizontalValue = rectangle.x + 6 + normalized * (rectangle.width - 12); const verticalValue = bottom - progress * (bottom - vertical);
          if (step === 0) context.moveTo(horizontalValue, verticalValue); else context.lineTo(horizontalValue, verticalValue);
        } if (Number.isFinite(entry.item.start) && Number.isFinite(entry.item.end) && group.max - group.min > 0.01) context.stroke(); context.restore(); context.lineWidth = 1;
      }
      const visibleGroups = new Set(entries.map(entry => ranges.get(entry.index)));
      const formatValue = value => typeof value === 'number' ? value.toFixed(2) : Array.isArray(value) ? value.join(',') : value;
      context.font = `${this.eventValueFontSize ?? 13}px RPE, sans-serif`;
      for (const group of visibleGroups) {
        const first = group.entries[0].event; const last = group.entries.at(-1).event;
        const top = this.vertical(beatValue(last.endTime)); const bottom = this.vertical(beatValue(first.startTime));
        context.fillStyle = top < 23 ? '#80ffa0' : '#f6e5ce';
        context.textAlign = 'center';
        context.fillText(formatValue(Number.isFinite(group.max) ? group.max : last.end), horizontal + channelWidth / 2, Math.max(36, top + 13), channelWidth - 12);
        context.fillStyle = bottom > height ? '#ffe080' : '#f6e5ce';
        if (bottom - top > 26) context.fillText(formatValue(Number.isFinite(group.min) ? group.min : first.start), horizontal + channelWidth / 2, Math.min(height - 5, bottom - 5), channelWidth - 12);
        context.textAlign = 'left';
      }
      context.fillStyle = '#303030'; context.fillRect(horizontal, 0, channelWidth, 23);
      context.fillStyle = '#f5f5f5'; context.fillText((this.extended ? extendedLabels : labels)[channel], horizontal + 6, 16);
    });
    const drag = this.eventInteraction.drag;
    if (drag?.kind === 'rectangle') {
      if (!this.marqueeOverlay) {
      context.fillStyle = '#ffcc4430'; context.strokeStyle = '#ffdd77';
      const start = this.rectangleStart(drag);
      context.fillRect(start.x, start.y, drag.current.x - start.x, drag.current.y - start.y);
      context.strokeRect(start.x, start.y, drag.current.x - start.x, drag.current.y - start.y);
      }
    } else if (drag?.kind === 'stroke') {
      context.strokeStyle = '#80ffff'; context.beginPath();
      drag.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke();
    } else if (drag) {
      const deltaBeat = this.eventInteraction.delta();
      context.strokeStyle = '#fff'; context.setLineDash([5, 3]);
      for (const rectangle of this.eventRects) if (this.getSession().eventSelection.has(eventKey(rectangle.type, rectangle.index))) {
        const event = layer[rectangle.type][rectangle.index];
        const top = this.eventVertical(beatValue(event.endTime) + (drag.kind === 'startTime' ? 0 : deltaBeat), rectangle.type);
        const bottom = this.eventVertical(beatValue(event.startTime) + (drag.kind === 'endTime' ? 0 : deltaBeat), rectangle.type);
        const height = bottom - top;
        context.strokeRect(rectangle.x, top, rectangle.width, height);
      } context.setLineDash([]);
    }
    this.eventInteraction.draw(context, width);
  }

  drawShaderEvents(context, entries, channel, width, height) {
    const bounds = this.eventColumnBounds(channel, width);
    for (const entry of entries) {
      const placement = this.shaderLanes.get(entry.index);
      const laneWidth = bounds.width / placement.count;
      const name = shaderIdentity(entry.item);
      const top = Math.max(23, this.eventVertical(entry.end, 'paintEvents'));
      const bottom = Math.min(height, this.eventVertical(entry.start, 'paintEvents'));
      if (bottom < top) continue;
      const rectangle = { x: bounds.x + placement.lane * laneWidth, y: top, width: Math.max(2, laneWidth - (placement.count > 1 ? 2 : 0)), height: Math.max(2, bottom - top), index: entry.index, type: 'paintEvents' };
      this.eventRects.push(rectangle);
      const selected = this.getSession().eventSelection.has(eventKey('paintEvents', entry.index));
      context.save();
      context.globalAlpha = this.eventOpacity ?? 0.25; context.fillStyle = selected ? '#98ffbd' : '#c6a1ff';
      context.fillRect(rectangle.x, top, rectangle.width, rectangle.height);
      context.globalAlpha = 1; context.strokeStyle = selected ? '#98ffbd' : '#c6a1ff'; context.lineWidth = selected ? 2 : 1;
      context.strokeRect(rectangle.x, top, rectangle.width, rectangle.height);
      context.beginPath(); context.rect(rectangle.x, top, rectangle.width, rectangle.height); context.clip();
      context.fillStyle = '#efe5ff'; context.font = `${this.eventValueFontSize ?? 13}px RPE, sans-serif`; context.textAlign = 'center';
      context.fillText(name, rectangle.x + rectangle.width / 2, top + 16, rectangle.width - 4);
      if (rectangle.height > 40) context.fillText(`#${entry.item.order ?? 0}${entry.item.global ? ' · UI' : ''}`, rectangle.x + rectangle.width / 2, top + 33, rectangle.width - 4);
      context.restore();
    }
  }
}
