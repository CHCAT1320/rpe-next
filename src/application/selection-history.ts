import type { AnyEventType, Chart } from '../core/types.ts';
import type { EditorSession } from './session.ts';
import { eventList, eventKey } from './event-commands.ts';
import type { EventEditSession } from './event-commands.ts';

/**
 * One selection snapshot.
 *
 * Every field is optional: snapshots are also produced by callers that carry only part of the
 * editor state (`batch-edit.ts`, undo entries read back from storage), and `sameSelection` is
 * documented to answer `false` for a missing right-hand snapshot rather than to throw.
 */
export interface SelectionState {
  lineIndex?: number;
  eventLayer?: number;
  focus?: string;
  selection?: number[];
  eventSelection?: string[];
  multiLineSelection?: [line: number, indices: number[]][];
  multiEventSelection?: [line: number, keys: string[]][];
  multiLineEnabled?: boolean;
  multiLineMode?: string;
  multiLineMerge?: boolean;
  multiLineIndices?: number[];
}

/**
 * The session-shaped object `eventList` needs: only `chart`, `lineIndex` and `eventLayer` are read,
 * which lets `remapSelection` pass a snapshot spread instead of a real session.
 */
export type EventListHost = { chart: Chart; lineIndex: number; eventLayer: number };

export function selectionState(session: EditorSession): SelectionState {
  return { lineIndex: session.lineIndex, eventLayer: session.eventLayer, focus: session.focus,
    selection: [...session.selection].sort((left, right) => left - right), eventSelection: [...session.eventSelection].sort(),
    multiLineSelection: [...(session.multiLineSelection ?? new Map())].map(([line, values]) => [line, [...values].sort((left, right) => left - right)] as [number, number[]]).sort((left, right) => left[0] - right[0]),
    multiEventSelection: [...(session.multiEventSelection ?? new Map())].map(([line, values]) => [line, [...values].sort()] as [number, string[]]).sort((left, right) => left[0] - right[0]),
    multiLineEnabled: session.multiLineEnabled, multiLineMode: session.multiLineMode, multiLineMerge: session.multiLineMerge, multiLineIndices: [...(session.multiLineIndices ?? [])] };
}

/**
 * Identity test for content that reaches into a snapshot with a dynamic key.
 *
 * `unknown` is only an admission that the value is indexed dynamically here; callers pass the
 * `SelectionState` snapshots above, and a non-snapshot argument is meant to fail the comparison.
 */
function listValue(snapshot: unknown, key: string): unknown[] {
  return ((snapshot as Record<string, unknown>)[key] as unknown[]) ?? [];
}

export function sameSelection(left: SelectionState, right: SelectionState | null | undefined): boolean {
  return Boolean(right && left.lineIndex === right.lineIndex && left.eventLayer === right.eventLayer && left.focus === right.focus
    && left.multiLineEnabled === right.multiLineEnabled && left.multiLineMode === right.multiLineMode && left.multiLineMerge === right.multiLineMerge
    && JSON.stringify(left.multiLineIndices ?? []) === JSON.stringify(right.multiLineIndices ?? [])
    && JSON.stringify(left.multiLineSelection ?? []) === JSON.stringify(right.multiLineSelection ?? [])
    && JSON.stringify(left.multiEventSelection ?? []) === JSON.stringify(right.multiEventSelection ?? [])
    && ['selection', 'eventSelection'].every(key => listValue(left, key).length === listValue(right, key).length && listValue(left, key).every((value, index) => value === listValue(right, key)[index])));
}

function remapIndices(source: readonly unknown[], target: readonly unknown[], indices: readonly number[]): number[] {
  const locations = new Map(target.map((item, index) => [item, index]));
  const sourceItems = new Set(source);
  return indices.flatMap(index => {
    if (!source[index]) return [];
    const mapped = locations.get(source[index]);
    if (mapped !== undefined) return [mapped];
    return source.length === target.length && target[index] && !sourceItems.has(target[index]) ? [index] : [];
  });
}

/**
 * A snapshot spread used as the session argument of `eventList`.
 *
 * `remapSelection` has no `EditorSession` to hand over — it works on two raw documents — so it
 * builds this stand-in. The casts are the narrowing `EventEditSession` asks for: `type` is a plain
 * `string` split out of a selection key, and the snapshot only supplies the three fields `eventList`
 * actually reads. Runtime behaviour is unchanged; the stand-in is only ever passed to `eventList`.
 */
function sessionHost(state: SelectionState, chart: Chart, lineIndex: number): EventEditSession {
  return { ...state, chart, lineIndex,
    eventLayer: state.eventLayer ?? 0,
    eventSelection: new Set(state.eventSelection ?? []),
    multiLineActive: false,
    multiLineMode: state.multiLineMode ?? 'notes',
    multiEventSelection: new Map(),
    selection: new Set(state.selection ?? []),
    focus: state.focus ?? 'notes',
    eventClipboard: [],
    selectionState: () => state,
    commit: () => {},
  };
}

/** Narrows a `type:index` key part back to the event-track union the event helpers expect. */
function eventType(type: string): AnyEventType {
  return type as AnyEventType;
}

export function remapSelection(source: Chart, target: Chart, state: SelectionState): SelectionState {
  // `lineIndex` is optional on the snapshot type but always present in the snapshots produced by
  // `selectionState`; the local fallback keeps the arithmetic below plain `number` without changing
  // what an out-of-range or missing index resolves to.
  const stateLineIndex = state.lineIndex ?? 0;
  const line = source.judgeLineList?.[stateLineIndex]; const lines = target.judgeLineList ?? [];
  const matching = line ? lines.findIndex(candidate => candidate === line || candidate.notes === line.notes && candidate.eventLayers === line.eventLayers) : -1;
  const lineIndex = matching >= 0 ? matching : Math.max(0, Math.min(stateLineIndex, lines.length - 1));
  const selection = remapIndices(line?.notes ?? [], lines[lineIndex]?.notes ?? [], state.selection ?? []);
  const eventSelection: string[] = [];
  const byType = new Map<string, number[]>();
  for (const key of state.eventSelection ?? []) {
    const [type, index] = key.split(':');
    (byType.get(type) ?? byType.set(type, []).get(type)!).push(Number(index));
  }
  for (const [type, indices] of byType) for (const index of remapIndices(eventList(sessionHost(state, source, stateLineIndex), eventType(type)), eventList(sessionHost(state, target, lineIndex), eventType(type)), indices)) eventSelection.push(eventKey(eventType(type), index));
  const multiEventSelection = (state.multiEventSelection ?? []).flatMap(([sourceLineIndex, keys]) => {
    const sourceLine = source.judgeLineList?.[sourceLineIndex]; const targetLine = target.judgeLineList?.[sourceLineIndex];
    if (!sourceLine || !targetLine) return [];
    const byType = new Map<string, number[]>();
    for (const key of keys) { const [type, index] = String(key).split(':'); (byType.get(type) ?? byType.set(type, []).get(type)!).push(Number(index)); }
    const mapped: string[] = [];
    for (const [type, indices] of byType) for (const index of remapIndices(eventList(sessionHost(state, source, sourceLineIndex), eventType(type)), eventList(sessionHost(state, target, sourceLineIndex), eventType(type)), indices)) mapped.push(eventKey(eventType(type), index));
    return mapped.length ? [[sourceLineIndex, mapped] as [number, string[]]] : [];
  });
  const multiLineSelection = (state.multiLineSelection ?? []).flatMap(([sourceLineIndex, indices]) => {
    const sourceNotes = source.judgeLineList?.[sourceLineIndex]?.notes ?? [];
    const targetNotes = target.judgeLineList?.[sourceLineIndex]?.notes ?? [];
    const mapped = remapIndices(sourceNotes, targetNotes, indices);
    return mapped.length ? [[sourceLineIndex, mapped] as [number, number[]]] : [];
  });
  return { ...state, lineIndex, selection, eventSelection, multiLineSelection, multiEventSelection };
}

export function restoreSelection(session: EditorSession, state: SelectionState): void {
  session.lineIndex = Math.max(0, Math.min(state.lineIndex ?? 0, (session.chart.judgeLineList?.length ?? 0) - 1));
  session.eventLayer = state.eventLayer ?? 0; session.focus = state.focus ?? 'notes';
  session.selection = new Set((state.selection ?? []).filter(index => session.notes[index]));
  session.multiLineSelection = new Map((state.multiLineSelection ?? []).map(([lineIndex, indices]) => [lineIndex, new Set(indices.filter(index => session.chart.judgeLineList?.[lineIndex]?.notes?.[index]))] as [number, Set<number>]).filter(([, values]) => values.size));
  session.eventSelection = new Set((state.eventSelection ?? []).filter(key => {
    const [type, index] = key.split(':'); return eventList(session, eventType(type))[Number(index)];
  }));
  session.multiEventSelection = new Map((state.multiEventSelection ?? []).map(([lineIndex, keys]) => [lineIndex, new Set(keys.filter(key => {
    const [type, index] = String(key).split(':'); const line = session.chart.judgeLineList?.[lineIndex];
    // A spread drops the class prototype, so `selectionState`/`commit`/`multiLineActive` are re-supplied
    // unchanged to keep the object a valid `EventEditSession`; only `chart`/`lineIndex`/`line` matter here.
    const host: EventEditSession = { ...session, chart: session.chart, lineIndex, line,
      multiLineActive: session.multiLineActive, selectionState: () => session.selectionState(), commit: session.commit.bind(session) };
    return line && eventList(host, eventType(type))[Number(index)];
  }))] as [number, Set<string>]).filter(([, keys]) => keys.size));
  session.multiLineEnabled = state.multiLineEnabled ?? false;
  session.multiLineMode = state.multiLineMode === 'events' ? 'events' : 'notes';
  session.multiLineMerge = state.multiLineMerge ?? true;
  session.multiLineIndices = [...(state.multiLineIndices ?? [])];
  session.normalizeMultiLine();
}
