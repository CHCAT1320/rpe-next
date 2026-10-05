import { eventList, eventKey } from './event-commands.mjs';

export function selectionState(session) {
  return { lineIndex: session.lineIndex, eventLayer: session.eventLayer, focus: session.focus,
    selection: [...session.selection].sort((left, right) => left - right), eventSelection: [...session.eventSelection].sort() };
}

export function sameSelection(left, right) {
  return Boolean(right && left.lineIndex === right.lineIndex && left.eventLayer === right.eventLayer && left.focus === right.focus
    && ['selection', 'eventSelection'].every(key => left[key].length === right[key].length && left[key].every((value, index) => value === right[key][index])));
}

function remapIndices(source, target, indices) {
  const locations = new Map(target.map((item, index) => [item, index]));
  const sourceItems = new Set(source);
  return indices.flatMap(index => {
    if (!source[index]) return [];
    const mapped = locations.get(source[index]);
    if (mapped !== undefined) return [mapped];
    return source.length === target.length && target[index] && !sourceItems.has(target[index]) ? [index] : [];
  });
}

export function remapSelection(source, target, state) {
  const line = source.judgeLineList?.[state.lineIndex]; const lines = target.judgeLineList ?? [];
  const matching = line ? lines.findIndex(candidate => candidate === line || candidate.notes === line.notes && candidate.eventLayers === line.eventLayers) : -1;
  const lineIndex = matching >= 0 ? matching : Math.max(0, Math.min(state.lineIndex, lines.length - 1));
  const sourceSession = { ...state, chart: source, line };
  const targetSession = { ...state, chart: target, lineIndex, line: lines[lineIndex] };
  const selection = remapIndices(line?.notes ?? [], targetSession.line?.notes ?? [], state.selection);
  const eventSelection = [];
  const byType = new Map();
  for (const key of state.eventSelection) {
    const [type, index] = key.split(':');
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(Number(index));
  }
  for (const [type, indices] of byType) for (const index of remapIndices(eventList(sourceSession, type), eventList(targetSession, type), indices)) eventSelection.push(eventKey(type, index));
  return { ...state, lineIndex, selection, eventSelection };
}

export function restoreSelection(session, state) {
  session.lineIndex = Math.max(0, Math.min(state.lineIndex, (session.chart.judgeLineList?.length ?? 0) - 1));
  session.eventLayer = state.eventLayer; session.focus = state.focus;
  session.selection = new Set(state.selection.filter(index => session.notes[index]));
  session.eventSelection = new Set(state.eventSelection.filter(key => {
    const [type, index] = key.split(':'); return eventList(session, type)[Number(index)];
  }));
}
