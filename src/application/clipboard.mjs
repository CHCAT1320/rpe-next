import { beatValue } from '../core/beat.mjs';
import { alignShaderParameters } from '../core/shader-events.mjs';
import { chartWithEventLists, eventKey, eventList } from './event-commands.mjs';
import { captureSelection, commitSelectionEdit, shiftedTime } from './batch-edit.mjs';

export function copyObjects(session) {
  const snapshot = captureSelection(session);
  const count = snapshot.notes.length + snapshot.events.length;
  if (!count) return 0;
  session.clipboard = structuredClone(snapshot.notes.map(entry => entry.note));
  session.eventClipboard = structuredClone(snapshot.events.map(({ type, event }) => ({ type, event })));
  session.clipboardVisible = true;
  return count;
}

export function cutObjects(session) {
  const count = copyObjects(session);
  if (!count) return 0;
  const updates = new Map();
  for (const { type } of session.eventClipboard) updates.set(type, eventList(session, type).filter((event, index) => !session.eventSelection.has(eventKey(type, index))));
  let chart = updates.size ? chartWithEventLists(session.chart, session.lineIndex, session.eventLayer, updates) : session.chart;
  if (session.selection.size) {
    const lines = [...chart.judgeLineList]; const line = lines[session.lineIndex];
    const notes = (line.notes ?? []).filter((note, index) => !session.selection.has(index));
    lines[session.lineIndex] = { ...line, notes, numOfNotes: notes.length }; chart = { ...chart, judgeLineList: lines };
  }
  commitSelectionEdit(session, { chart, lineIndex: session.lineIndex, eventLayer: session.eventLayer, focus: session.focus, selection: new Set(), eventSelection: new Set() }, '剪切选中项');
  return count;
}

export function clipboardStart(session) {
  let earliest = Infinity;
  for (const note of session.clipboard) earliest = Math.min(earliest, beatValue(note.startTime));
  for (const { event } of session.eventClipboard) earliest = Math.min(earliest, beatValue(event.startTime));
  return earliest;
}

export function projectClipboard(session, beat, { mirror = false, keepTime = false } = {}) {
  const earliest = clipboardStart(session);
  if (!Number.isFinite(earliest)) return { notes: [], events: [] };
  const delta = keepTime ? 0 : beat - earliest;
  const notes = session.clipboard.map(note => ({ ...shiftedTime(note, delta), positionX: note.positionX * (mirror ? -1 : 1) }));
  const events = session.eventClipboard.map(({ type, event }) => {
    let next = shiftedTime(event, delta);
    if (type === 'paintEvents' && delta && session.shaderAutoAlign !== false) next = alignShaderParameters(next);
    if (mirror && type !== 'alphaEvents' && typeof next.start === 'number' && typeof next.end === 'number') next = { ...next, start: -next.start, end: -next.end };
    return { type, event: next };
  });
  return { notes, events };
}

export function pasteObjects(session, beat, options) {
  const projected = structuredClone(projectClipboard(session, beat, options));
  if (!projected.notes.length && !projected.events.length) return false;
  let chart = session.chart;
  const selection = new Set(); const eventSelection = new Set(); const updates = new Map();
  for (const { type, event } of projected.events) {
    if (!updates.has(type)) updates.set(type, [...eventList(session, type)]);
    const events = updates.get(type); eventSelection.add(eventKey(type, events.length)); events.push(event);
  }
  if (updates.size) chart = chartWithEventLists(chart, session.lineIndex, session.eventLayer, updates);
  if (projected.notes.length) {
    const lines = [...chart.judgeLineList]; const line = lines[session.lineIndex];
    const existing = line.notes ?? [];
    const notes = [...existing, ...projected.notes];
    projected.notes.forEach((note, index) => selection.add(existing.length + index));
    lines[session.lineIndex] = { ...line, notes, numOfNotes: notes.length }; chart = { ...chart, judgeLineList: lines };
  }
  session.clipboardVisible = true;
  return commitSelectionEdit(session, { chart, lineIndex: session.lineIndex, eventLayer: session.eventLayer,
    focus: projected.notes.length ? 'notes' : 'events', selection, eventSelection }, options?.mirror ? '镜像粘贴' : '粘贴选中项');
}
