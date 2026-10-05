import { beatValue, fromNumber } from '../core/beat.mjs';
import { eventKey, eventList, selectedEvents, transformEvents, placedEvent, insertEvent } from '../application/event-commands.mjs';
import { strokeIntersects } from '../core/editor-display.mjs';
import { shaderEventLanes } from '../core/shader-events.mjs';

export class EventInteraction {
  constructor(timeline, reportError) {
    this.timeline = timeline; this.canvas = timeline.eventsCanvas; this.reportError = reportError; this.drag = null; this.pending = null;
    this.canvas.addEventListener('pointerdown', event => this.down(event));
    this.canvas.addEventListener('pointermove', event => this.move(event));
    this.canvas.addEventListener('pointerup', event => this.up(event));
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; timeline.changed(); });
    this.canvas.addEventListener('pointerleave', () => { if (!this.drag) this.timeline.eventCursor = null; });
  }

  hit(point) { return this.timeline.eventRects.findLast(rectangle => point.x >= rectangle.x && point.x <= rectangle.x + rectangle.width && point.y >= rectangle.y && point.y <= rectangle.y + rectangle.height); }
  delta() {
    if (!this.drag?.anchor) return 0;
    const start = this.drag.anchor;
    const factor = this.timeline.factor;
    const scroll = this.timeline.tempo.seconds(this.timeline.origin, this.timeline.factor) - (this.drag.originSeconds ?? this.timeline.tempo.seconds(this.timeline.origin, this.timeline.factor));
    const targetSeconds = this.timeline.tempo.seconds(start, factor) + (this.drag.start.y - this.drag.current.y) / this.timeline.scale + scroll;
    const target = this.timeline.tempo.beat(targetSeconds, factor);
    return Math.round(target * this.timeline.division) / this.timeline.division - beatValue(start);
  }

  place(type, beat, easingType) {
    const session = this.timeline.getSession();
    if (!session.line) return false;
    const point = this.timeline.eventCursor;
    if (beat === undefined && !point) return false;
    const channel = Math.max(0, Math.min(this.timeline.eventTypes.length - 1, Math.floor((point?.x ?? 0) / (this.canvas.clientWidth / this.timeline.eventTypes.length))));
    const eventType = this.pending?.type ?? type ?? this.timeline.eventTypes[channel];
    const at = beat ?? this.timeline.eventBeatAt(point.y, eventType, true);
    session.focus = 'events'; session.eventLayer = this.timeline.layer; session.selection.clear();
    if (!this.pending) {
      this.pending = { type: eventType, beat: at };
      session.notify();
    } else {
      let event;
      try { event = placedEvent(session, this.pending.type, this.pending.beat, at, easingType); }
      catch (error) { this.timeline.notify?.(error.message, 'error'); return false; }
      if (event) insertEvent(session, this.pending.type, event);
      this.pending = null;
    }
    this.timeline.changed(); return true;
  }

  down(event) {
    if (![0, 1, 2].includes(event.button)) return;
    event.preventDefault?.();
    if (this.timeline.finishRectangle(event)) return;
    const session = this.timeline.getSession(); const point = this.timeline.point(event, this.canvas); const rectangle = this.hit(point);
    this.timeline.eventCursor = point; this.timeline.hoverArea = 'events';
    this.timeline.clipboardPointer = point;
    if (event.button === 0 && this.timeline.tool && !rectangle && !event.shiftKey && !event.ctrlKey) {
      try { this.place(null); } catch (error) { this.timeline.notify?.(error.message, 'error'); }
      return;
    }
    if (this.pending) {
      if (event.button === 2) { this.pending = null; this.timeline.changed(); }
      else try { this.place(); } catch (error) { this.timeline.notify?.(error.message, 'error'); }
      return;
    }
    session.focus = 'events'; session.eventLayer = this.timeline.layer;
    if (!event.ctrlKey && !event.shiftKey && event.button !== 1) session.selection.clear();
    this.canvas.focus(); this.canvas.setPointerCapture(event.pointerId);
    if (event.shiftKey || event.button === 1) this.drag = { kind: 'rectangle', start: point, startSeconds: this.timeline.timeAt(point.y), current: point, append: true, remove: false };
    else if (rectangle && event.button === 0) {
      const key = eventKey(rectangle.type, rectangle.index);
      if (event.ctrlKey) { if (session.eventSelection.has(key)) session.eventSelection.delete(key); else session.eventSelection.add(key); }
      else if (!session.eventSelection.has(key)) session.eventSelection = new Set([key]);
      const kind = Math.abs(point.y - rectangle.y) < 6 ? 'endTime' : Math.abs(point.y - (rectangle.y + rectangle.height)) < 6 ? 'startTime' : 'move';
      const selected = selectedEvents(session).find(entry => entry.type === rectangle.type && entry.index === rectangle.index);
      this.drag = { kind, type: rectangle.type, start: point, current: point, anchor: selected?.event[kind === 'endTime' ? 'endTime' : 'startTime'], originSeconds: this.timeline.tempo.seconds(this.timeline.origin, this.timeline.factor) };
    } else this.drag = { kind: 'stroke', start: point, current: point, points: [point], remove: event.button === 2 };
    session.notify();
  }

  move(event) {
    const point = this.timeline.point(event, this.canvas);
    this.timeline.eventCursor = point;
    this.timeline.clipboardPointer = point;
    this.timeline.hoverArea = 'events';
    if (this.drag) {
      const previous = this.drag.current; this.drag.current = point;
      if (this.drag.kind === 'stroke' && (this.drag.tracing || Math.hypot(point.x - this.drag.start.x, point.y - this.drag.start.y) > 3)) {
        this.drag.tracing = true;
        this.drag.points.push(point); const session = this.timeline.getSession();
        for (const rectangle of this.timeline.eventRects) if (strokeIntersects(previous, point, { left: rectangle.x, right: rectangle.x + rectangle.width, top: rectangle.y, bottom: rectangle.y + rectangle.height })) {
          const key = eventKey(rectangle.type, rectangle.index); this.drag.remove ? session.eventSelection.delete(key) : session.eventSelection.add(key);
        }
        session.notify();
      }
    }
    const hit = this.hit(point);
    this.canvas.style.cursor = hit && (Math.abs(point.y - hit.y) < 6 || Math.abs(point.y - hit.y - hit.height) < 6) ? 'ns-resize' : hit ? 'move' : 'crosshair';
    this.timeline.changed();
  }

  up(event) {
    if (!this.drag) return;
    if (this.drag.kind === 'stroke' && !this.drag.remove && !this.drag.tracing && this.timeline.previewPick?.(event)) { this.drag = null; this.timeline.changed(); return; }
    this.drag.current = this.timeline.point(event, this.canvas);
    if (this.drag.kind === 'stroke' && this.drag.remove && !this.drag.tracing) {
      this.drag = { ...this.drag, kind: 'rectangle', startSeconds: this.timeline.timeAt(this.drag.start.y), append: true, remove: false }; this.timeline.changed(); return;
    }
    if (this.drag.kind === 'rectangle' && !this.drag.finished) { this.timeline.changed(); return; }
    const drag = this.drag; const delta = this.delta(); this.drag = null;
    const session = this.timeline.getSession();
    try {
      if (drag.kind === 'rectangle') {
        if (!drag.append) session.eventSelection.clear();
        const [bottom, top] = this.timeline.rectangleTimes(drag);
        const left = Math.min(drag.start.x, drag.current.x); const right = Math.max(drag.start.x, drag.current.x);
        this.timeline.eventTypes.forEach((type, channel) => {
          const bounds = this.timeline.eventColumnBounds(channel, this.canvas.clientWidth);
          if (bounds.x >= right || bounds.x + bounds.width <= left) return;
          const items = eventList(session, type); const lanes = type === 'paintEvents' ? shaderEventLanes(items) : null;
          items.forEach((item, index) => {
            if (beatValue(item.startTime) > top || beatValue(item.endTime) < bottom) return;
            if (lanes) {
              const lane = lanes.get(index); const width = bounds.width / lane.count;
              const horizontal = bounds.x + lane.lane * width;
              if (horizontal >= right || horizontal + Math.max(2, width - (lane.count > 1 ? 2 : 0)) <= left) return;
            }
            const key = eventKey(type, index); drag.remove ? session.eventSelection.delete(key) : session.eventSelection.add(key);
          });
        });
        session.notify();
      } else if (delta && Math.abs(drag.current.y - drag.start.y) > 3 && selectedEvents(session).length) {
        transformEvents(session, drag.kind === 'move' ? '移动事件' : '调整事件时长', current => ({ ...current,
          startTime: drag.kind === 'endTime' ? current.startTime : fromNumber(beatValue(current.startTime) + delta),
          endTime: drag.kind === 'startTime' ? current.endTime : fromNumber(beatValue(current.endTime) + delta) }));
      }
    } catch (error) { this.reportError(error); }
    this.timeline.changed();
  }

  draw(context, width) {
    if (!this.pending) return;
    const channel = this.timeline.eventTypes.indexOf(this.pending.type);
    if (channel < 0) return;
    const end = this.timeline.eventCursor ? this.timeline.eventBeatAt(this.timeline.eventCursor.y, this.pending.type, true) : this.pending.beat;
    let valid = true;
    try { placedEvent(this.timeline.getSession(), this.pending.type, this.pending.beat, end); } catch { valid = false; }
    const top = Math.min(this.timeline.eventVertical(this.pending.beat, this.pending.type), this.timeline.eventVertical(end, this.pending.type));
    const height = Math.max(2, Math.abs(this.timeline.eventVertical(this.pending.beat, this.pending.type) - this.timeline.eventVertical(end, this.pending.type)));
    const { x: barX, width: barWidth } = this.timeline.eventColumnBounds(channel, width);
    context.fillStyle = valid ? '#ffd76a60' : '#ff404080'; context.strokeStyle = valid ? '#ffe499' : '#ff8080';
    context.fillRect(barX, top, barWidth, height);
    context.strokeRect(barX, top, barWidth, height);
  }
}
