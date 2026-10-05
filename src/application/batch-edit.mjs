import { assertChart, noteIsAbove } from '../core/chart.mjs';
import { beatValue, fromNumber } from '../core/beat.mjs';
import { snapPosition, verticalGrid } from '../core/edit-grid.mjs';
import { alignShaderParameters } from '../core/shader-events.mjs';
import { chartWithEventLists, eventList, eventKey, selectedEvents } from './event-commands.mjs';

export const BATCH_ACTIONS = [
  ['MirrorY', '绕 X=0 镜像'], ['MirrorMid', '绕选中音符的横向中心镜像'],
  ['SideSwitch', '切换上下侧'], ['SideUp', '全部移至上侧'], ['SideDown', '全部移至下侧'],
  ['ToReal', '变为真音符'], ['ToFake', '变为假音符'], ['ToTap', '转为 Tap'],
  ['ToFlick', '转为 Flick'], ['ToDrag', '转为 Drag'], ['ToHold', '转为 Hold（新增长度 1/4 拍）'], ['AttachX', '吸附至最近竖线'],
];

export function captureSelection(session) {
  return { chart: session.chart, lineIndex: session.lineIndex, eventLayer: session.eventLayer, focus: session.focus,
    shaderAutoAlign: session.shaderAutoAlign, notes: [...session.selection].sort((left, right) => left - right).filter(index => session.notes[index]).map(index => ({ index, note: session.notes[index] })), events: selectedEvents(session) };
}

function eventSession(chart, lineIndex, eventLayer) {
  return { chart, lineIndex, eventLayer, line: chart.judgeLineList[lineIndex] };
}

export function editCapturedSelection(snapshot, { note = value => value, event = value => value, lineOffset = 0 } = {}) {
  const sourceIndex = snapshot.lineIndex;
  const count = snapshot.chart.judgeLineList.length;
  const targetIndex = ((sourceIndex + lineOffset) % count + count) % count;
  let chart = snapshot.chart;
  const selection = new Set(); const eventSelection = new Set();
  if (snapshot.notes.length) {
    const lines = [...chart.judgeLineList];
    const source = lines[sourceIndex]; const target = lines[targetIndex];
    const updates = new Map(snapshot.notes.map(entry => [entry.index, note(entry.note)]));
    let notes;
    if (sourceIndex === targetIndex) {
      notes = source.notes.map((item, index) => updates.get(index) ?? item);
      for (const index of updates.keys()) selection.add(index);
    } else {
      const remaining = source.notes.filter((item, index) => !updates.has(index));
      lines[sourceIndex] = { ...source, notes: remaining, numOfNotes: remaining.length };
      notes = [...(target.notes ?? []), ...updates.values()];
      for (let index = notes.length - updates.size; index < notes.length; index++) selection.add(index);
    }
    lines[targetIndex] = { ...target, notes, numOfNotes: notes.length };
    chart = { ...chart, judgeLineList: lines };
  }
  const types = new Set(snapshot.events.map(entry => entry.type));
  const sourceUpdates = new Map(); const targetUpdates = new Map();
  for (const type of types) {
    const selected = new Map(snapshot.events.filter(entry => entry.type === type).map(entry => {
      let next = event(entry.event, type);
      if (type === 'paintEvents' && snapshot.shaderAutoAlign !== false && beatValue(next.startTime) !== beatValue(entry.event.startTime)) next = alignShaderParameters(next);
      return [entry.index, next];
    }));
    const original = eventList(eventSession(chart, sourceIndex, snapshot.eventLayer), type);
    if (sourceIndex === targetIndex) {
      sourceUpdates.set(type, original.map((item, index) => selected.get(index) ?? item));
      for (const index of selected.keys()) eventSelection.add(eventKey(type, index));
    } else {
      sourceUpdates.set(type, original.filter((item, index) => !selected.has(index)));
      const target = [...eventList(eventSession(chart, targetIndex, snapshot.eventLayer), type)];
      for (const next of selected.values()) { eventSelection.add(eventKey(type, target.length)); target.push(next); }
      targetUpdates.set(type, target);
    }
  }
  if (sourceUpdates.size) chart = chartWithEventLists(chart, sourceIndex, snapshot.eventLayer, sourceUpdates);
  if (targetUpdates.size) chart = chartWithEventLists(chart, targetIndex, snapshot.eventLayer, targetUpdates);
  return { chart, lineIndex: targetIndex, eventLayer: snapshot.eventLayer, focus: snapshot.focus, selection, eventSelection };
}

export function commitSelectionEdit(session, result, label) {
  if (result.chart === session.chart) return false;
  assertChart(result.chart);
  const beforeSelection = session.selectionState();
  session.lineIndex = result.lineIndex; session.eventLayer = result.eventLayer; session.focus = result.focus;
  session.selection = result.selection; session.eventSelection = result.eventSelection;
  session.commit(label, result.chart, beforeSelection);
  return true;
}

export function shiftedTime(item, delta, part = 'both') {
  if (!delta) return item;
  const start = beatValue(item.startTime); const end = beatValue(item.endTime);
  return { ...item, startTime: part === 'end' ? item.startTime : fromNumber(part === 'start' ? Math.min(end, start + delta) : start + delta),
    endTime: part === 'start' ? item.endTime : fromNumber(part === 'end' ? Math.max(start, end + delta) : end + delta) };
}

export function nudgeSelection(session, direction, division, gridCount) {
  const snapshot = captureSelection(session);
  if (!snapshot.notes.length && !snapshot.events.length) return false;
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  if (horizontal && !snapshot.notes.length) return true;
  const deltaX = horizontal ? verticalGrid(gridCount).spacing / 2 * (direction === 'ArrowLeft' ? -1 : 1) : 0;
  const deltaBeat = horizontal ? 0 : (direction === 'ArrowDown' ? -1 : 1) / division;
  return commitSelectionEdit(session, editCapturedSelection(snapshot, {
    note: item => ({ ...shiftedTime(item, deltaBeat), positionX: item.positionX + deltaX }),
    event: item => shiftedTime(item, deltaBeat),
  }), '方向键移动选中项');
}

export function applyBatchAction(session, action, gridCount) {
  const snapshot = captureSelection(session);
  if (!snapshot.notes.length) return false;
  if (!BATCH_ACTIONS.some(([name]) => name === action)) throw new Error('未知批量操作');
  const positions = snapshot.notes.map(entry => entry.note.positionX);
  const middleSum = positions.reduce((value, position) => Math.min(value, position), Infinity) + positions.reduce((value, position) => Math.max(value, position), -Infinity);
  const types = { ToTap: 1, ToFlick: 3, ToDrag: 4, ToHold: 2 };
  snapshot.events = [];
  return commitSelectionEdit(session, editCapturedSelection(snapshot, { note: item => {
    if (action === 'MirrorY') return { ...item, positionX: -item.positionX };
    if (action === 'MirrorMid') return { ...item, positionX: middleSum - item.positionX };
    if (action === 'AttachX') return { ...item, positionX: snapPosition(item.positionX, gridCount) };
    if (['SideSwitch', 'SideUp', 'SideDown'].includes(action)) {
      const above = action === 'SideUp' || (action === 'SideSwitch' && !noteIsAbove(item));
      return { ...item, above: above ? 1 : item.type === 2 ? 0 : 2 };
    }
    if (action === 'ToReal' || action === 'ToFake') return { ...item, isFake: action === 'ToFake' ? 1 : 0 };
    const type = types[action];
    return { ...item, type, above: noteIsAbove(item) ? 1 : type === 2 ? 0 : 2,
      endTime: type === 2 ? item.type === 2 ? item.endTime : fromNumber(beatValue(item.startTime) + 0.25) : [...item.startTime] };
  } }), `批量 ${action}`);
}

export function controlLineOffset(delta, events = false) {
  const threshold = events ? 75 : 50;
  return Math.abs(delta) < threshold ? 0 : Math.sign(delta) * (1 + Math.floor((Math.abs(delta) - threshold) / 50));
}

export function selectionScaleAnchor(snapshot, anchorMode = 0) {
  const ordered = snapshot.notes.toSorted((left, right) => beatValue(left.note.startTime) - beatValue(right.note.startTime));
  if (!ordered.length) return null;
  if (anchorMode === 1) return ordered[0].note.positionX;
  if (anchorMode === 2) return ordered.at(-1).note.positionX;
  const minimum = ordered.reduce((value, entry) => Math.min(value, entry.note.positionX), Infinity);
  const maximum = ordered.reduce((value, entry) => Math.max(value, entry.note.positionX), -Infinity);
  return (minimum + maximum) / 2;
}

export function controlSelection(snapshot, kind, { deltaBeat = 0, deltaX = 0, dragX = 0, anchorMode = 0 } = {}) {
  if (kind === 'note-move') {
    const minimum = snapshot.notes.reduce((value, entry) => Math.min(value, entry.note.positionX), Infinity);
    const maximum = snapshot.notes.reduce((value, entry) => Math.max(value, entry.note.positionX), -Infinity);
    deltaX = Math.max(Math.min(0, -675 - minimum), Math.min(Math.max(0, 675 - maximum), deltaX));
    return editCapturedSelection(snapshot, { note: item => ({ ...shiftedTime(item, deltaBeat), positionX: item.positionX + deltaX }) });
  }
  if (kind === 'note-scale') {
    const ordered = snapshot.notes.toSorted((left, right) => beatValue(left.note.startTime) - beatValue(right.note.startTime));
    const minimum = ordered.reduce((value, entry) => Math.min(value, entry.note.positionX), Infinity);
    const maximum = ordered.reduce((value, entry) => Math.max(value, entry.note.positionX), -Infinity);
    const anchor = selectionScaleAnchor(snapshot, anchorMode);
    let rate = 1 + dragX / 300 * (anchorMode === 2 ? -1 : 1);
    if (minimum >= -675 && maximum <= 675) {
      let lower = -Infinity; let upper = Infinity;
      for (const position of [minimum, maximum]) {
        const offset = position - anchor; if (!offset) continue;
        const bounds = [(-675 - anchor) / offset, (675 - anchor) / offset];
        lower = Math.max(lower, Math.min(...bounds)); upper = Math.min(upper, Math.max(...bounds));
      }
      rate = Math.max(lower, Math.min(upper, rate));
    }
    return editCapturedSelection(snapshot, { note: item => ({ ...item, positionX: anchor + (item.positionX - anchor) * rate }) });
  }
  if (kind === 'note-line') return editCapturedSelection(snapshot, { lineOffset: controlLineOffset(dragX) });
  if (kind === 'event-move') return editCapturedSelection(snapshot, { event: item => shiftedTime(item, deltaBeat), lineOffset: controlLineOffset(dragX, true) });
  return editCapturedSelection(snapshot, { event: item => shiftedTime(item, deltaBeat, kind === 'event-start' ? 'start' : 'end') });
}
