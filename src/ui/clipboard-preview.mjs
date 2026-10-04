import { beatValue } from '../core/beat.mjs';
import { clipboardStart, projectClipboard } from '../application/clipboard.mjs';

const colors = { 1: '#0099ff', 2: '#0099ff', 3: '#ff3333', 4: '#ffff33' };

export function clipboardBeat(timeline) {
  return timeline.clipboardPointer ? timeline.snappedBeat(timeline.clipboardPointer.y) : timeline.origin;
}

export function drawClipboard(timeline, context, width, height, area) {
  const session = timeline.getSession();
  if (session.clipboardVisible === false || timeline.bulkPreview || timeline.pendingHold || timeline.eventInteraction.pending) return;
  const projected = projectClipboard(session, clipboardBeat(timeline), timeline.clipboardMode);
  if (!projected.notes.length && !projected.events.length) return;
  context.save();
  context.globalAlpha = 0.175;
  if (area === 'notes') for (const note of projected.notes) {
    const horizontal = timeline.noteHorizontal(note.positionX); const noteWidth = timeline.noteWidth(note);
    const bottom = timeline.vertical(beatValue(note.startTime)); const top = timeline.vertical(beatValue(note.endTime));
    if (bottom < -10 || top > height + 10 || timeline.clampNoteHorizontal(horizontal, noteWidth, width) === null) continue;
    context.fillStyle = colors[note.type];
    context.fillRect(horizontal - noteWidth / 2, Math.max(-10, note.type === 2 ? top : bottom - 5), noteWidth, note.type === 2 ? Math.min(height + 20, bottom - Math.max(-10, top)) : 10);
  }
  if (area === 'events') for (const { type, event } of projected.events) {
    const channel = timeline.eventTypes.indexOf(type); if (channel < 0) continue;
    const top = Math.max(23, timeline.eventVertical(beatValue(event.endTime), type));
    const bottom = Math.min(height, timeline.eventVertical(beatValue(event.startTime), type));
    if (bottom < top) continue;
    const bounds = timeline.eventColumnBounds(channel, width);
    context.fillStyle = '#ffa334'; context.fillRect(bounds.x, top, bounds.width, Math.max(2, bottom - top));
  }
  context.globalAlpha = 0.7; context.strokeStyle = '#ff5cab'; context.lineWidth = 1;
  const source = timeline.vertical(clipboardStart(session));
  context.beginPath(); context.moveTo(0, source); context.lineTo(width, source); context.stroke();
  context.restore();
}
