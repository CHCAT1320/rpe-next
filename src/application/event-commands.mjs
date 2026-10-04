import { EVENT_TYPES, assertChart, createEvent } from '../core/chart.mjs';
import { beatValue, fromNumber } from '../core/beat.mjs';
import { EventTrack } from '../core/events.mjs';
import { shaderEvents, replaceShaderEvents, alignShaderParameters } from '../core/shader-events.mjs';

export const eventKey = (type, index) => `${type}:${index}`;
export function eventList(session, type) {
  if (type === 'paintEvents') return shaderEvents(session.chart, session.lineIndex);
  return EVENT_TYPES.includes(type) ? session.line?.eventLayers?.[session.eventLayer]?.[type] ?? [] : session.line?.extended?.[type] ?? [];
}
export function selectedEvents(session) {
  return [...session.eventSelection].map(key => {
    const [type, indexText] = key.split(':'); const index = Number(indexText);
    return { type, index, event: eventList(session, type)[index] };
  }).filter(entry => entry.event);
}

export function commitEventLists(session, label, updates, selection = session.eventSelection) {
  if (!session.line) throw new Error('请先添加判定线');
  let line = { ...session.line, extended: { ...session.line.extended }, eventLayers: [...(session.line.eventLayers ?? [])] };
  for (const [type, events] of updates) {
    for (const event of events) if (beatValue(event.endTime) < beatValue(event.startTime)) throw new Error('事件结束拍不能早于开始拍');
    if (type === 'paintEvents') continue;
    if (EVENT_TYPES.includes(type)) {
      while (line.eventLayers.length <= session.eventLayer) line.eventLayers.push({});
      line.eventLayers[session.eventLayer] = { ...line.eventLayers[session.eventLayer], [type]: events };
    }
    else line.extended[type] = events;
  }
  const lines = [...session.chart.judgeLineList]; lines[session.lineIndex] = line;
  let chart = { ...session.chart, judgeLineList: lines };
  if (updates.has('paintEvents')) chart = replaceShaderEvents(chart, session.lineIndex, updates.get('paintEvents'));
  assertChart(chart);
  session.eventSelection = new Set(selection); session.focus = 'events'; session.selection.clear();
  session.commit(label, chart);
}

export function transformEvents(session, label, transform) {
  const updates = new Map();
  const linked = new Map();
  for (const { type, index, event } of selectedEvents(session)) {
    if (!updates.has(type)) updates.set(type, [...eventList(session, type)]);
    let next = transform(event, type);
    if (type === 'paintEvents' && session.shaderAutoAlign !== false && beatValue(next.startTime) !== beatValue(event.startTime)) next = alignShaderParameters(next);
    updates.get(type)[index] = next;
    const link = Number(event.linkgroup ?? 0);
    if (link > 0 && type !== 'paintEvents') linked.set(`${type}:${link}`, next);
  }
  for (const [group, next] of linked) {
    const [type, linkText] = group.split(':'); const link = Number(linkText);
    const events = updates.get(type) ?? [...eventList(session, type)];
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (Number(event.linkgroup ?? 0) !== link || session.eventSelection.has(eventKey(type, index))) continue;
      events[index] = { ...event, start: structuredClone(next.start), end: structuredClone(next.end), easingType: next.easingType,
        easingLeft: next.easingLeft, easingRight: next.easingRight, bezier: next.bezier, bezierPoints: structuredClone(next.bezierPoints) };
    }
    updates.set(type, events);
  }
  if (updates.size) commitEventLists(session, label, updates);
}

export function insertEvent(session, type, event) {
  const events = eventList(session, type);
  commitEventLists(session, '添加事件', new Map([[type, [...events, event]]]), [eventKey(type, events.length)]);
}

export function placedEvent(session, type, first, second, easingType) {
  const start = Math.min(first, second); const end = Math.max(first, second);
  if (end - start < 0.001) return null;
  const events = eventList(session, type);
  if (type === 'paintEvents') return { startTime: fromNumber(start), endTime: fromNumber(end), shader: 'chromatic', global: false, order: 0, vars: {} };
  if (events.some(event => start < beatValue(event.endTime) && end > beatValue(event.startTime))) throw new Error('该时间范围与同轨道已有事件重叠，请调整终点或按 Esc 取消');
  const previous = events.filter(event => beatValue(event.endTime) <= start).sort((left, right) => beatValue(right.startTime) - beatValue(left.startTime))[0];
  const fallback = type === 'alphaEvents' ? 255 : type.startsWith('scale') ? 1 : type === 'speedEvents' ? 10 : type === 'textEvents' ? '' : type === 'colorEvents' ? [255, 255, 255] : 0;
  const value = structuredClone(previous?.end ?? fallback);
  return { ...createEvent(value, structuredClone(value), start, end), easingType: easingType ?? previous?.easingType ?? 1 };
}

export function deleteEvents(session) {
  const updates = new Map();
  for (const { type } of selectedEvents(session)) updates.set(type, eventList(session, type).filter((event, index) => !session.eventSelection.has(eventKey(type, index))));
  if (updates.size) commitEventLists(session, '删除事件', updates, []);
}

export function copyEvents(session) { session.eventClipboard = structuredClone(selectedEvents(session).map(({ type, event }) => ({ type, event }))); }

export function pasteEvents(session, beat, keepTime = false, mirror = false) {
  if (!session.eventClipboard.length) return;
  const earliest = session.eventClipboard.reduce((value, entry) => Math.min(value, beatValue(entry.event.startTime)), Infinity);
  const delta = keepTime ? 0 : beat - earliest;
  const updates = new Map(); const selection = [];
  for (const { type, event } of session.eventClipboard) {
    if (!updates.has(type)) updates.set(type, [...eventList(session, type)]);
    const events = updates.get(type);
    selection.push(eventKey(type, events.length));
    let pasted = { ...structuredClone(event), startTime: fromNumber(beatValue(event.startTime) + delta), endTime: fromNumber(beatValue(event.endTime) + delta) };
    if (type === 'paintEvents' && delta && session.shaderAutoAlign !== false) pasted = alignShaderParameters(pasted);
    if (mirror && ['moveXEvents', 'rotateEvents'].includes(type)) { pasted.start = -pasted.start; pasted.end = -pasted.end; }
    events.push(pasted);
  }
  commitEventLists(session, '粘贴事件', updates, selection);
}

export function splitEvent(event, beat, tempo, factor = 1) {
  const start = tempo.seconds(event.startTime, factor); const end = tempo.seconds(event.endTime, factor); const at = tempo.seconds(beat, factor);
  if (!(at > start && at < end)) throw new Error('拆分拍数必须在事件内部');
  if (event.bezier) throw new Error('Bezier 事件暂不支持无损拆分，请先使用缓动事件');
  if (typeof event.start !== 'number') throw new Error('当前拆分支持数值事件');
  const progress = (at - start) / (end - start);
  const middle = (event.easingLeft ?? 0) + ((event.easingRight ?? 1) - (event.easingLeft ?? 0)) * progress;
  const value = new EventTrack([event], tempo, factor).value(at);
  if (Math.abs(value - event.start) < 1e-10 && event.start !== event.end || Math.abs(event.end - value) < 1e-10 && event.start !== event.end) throw new Error('此缓动切点无法无损拆分，请调整拆分拍数');
  return [{ ...event, endTime: fromNumber(beat), end: value, easingRight: middle }, { ...event, startTime: fromNumber(beat), start: value, easingLeft: middle }];
}

function splitEventOriginal(event, beat, tempo, factor = 1) {
  const start = tempo.seconds(event.startTime, factor); const end = tempo.seconds(event.endTime, factor); const at = tempo.seconds(beat, factor);
  if (!(at > start && at < end)) throw new Error('拆分拍数必须在事件内部');
  if (event.bezier || typeof event.start !== 'number') throw new Error('当前拆分支持数值缓动事件');
  const value = new EventTrack([event], tempo, factor).value(at);
  return [
    { ...event, endTime: fromNumber(beat), end: value, easingType: 1, easingLeft: 0, easingRight: 1, bezier: 0, bezierPoints: [0, 0, 1, 1] },
    { ...event, startTime: fromNumber(beat), start: value },
  ];
}

export function splitSelectedEvents(session, beat, tempo) {
  const updates = new Map(); const selection = [];
  for (const { type, index, event } of selectedEvents(session)) {
    if (beatValue(event.startTime) >= beat || beatValue(event.endTime) <= beat) continue;
    const [first, second] = splitEventOriginal(event, beat, tempo, session.line.bpmfactor ?? 1);
    if (!updates.has(type)) updates.set(type, [...eventList(session, type)]);
    const events = updates.get(type); events[index] = first; events.push(second);
    events.sort((left, right) => beatValue(left.startTime) - beatValue(right.startTime) || beatValue(left.endTime) - beatValue(right.endTime));
    for (let nextIndex = 0; nextIndex < events.length; nextIndex++) if (events[nextIndex] === first || events[nextIndex] === second) selection.push(eventKey(type, nextIndex));
  }
  if (!updates.size) throw new Error('播放光标不在选中事件内部');
  commitEventLists(session, '拆分事件', updates, selection);
}
