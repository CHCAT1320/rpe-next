import { beatValue, fromNumber } from './beat.mjs';

export const GLOBAL_EVENT_VERSION = 240;
const localId = /^[a-z][a-z0-9._-]{0,95}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const check = (condition, message) => { if (!condition) throw Error('全局事件：' + message); };
const text = value => typeof value === 'string' && Boolean(value.trim());
export const globalColumnKey = (type, column) => 'global_' + [...type + '/' + column].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');

export function validateGlobalEvent(event, path = '事件') {
  check(record(event), path + '必须是对象');
  check(Object.hasOwn(event, 'start') && Object.hasOwn(event, 'end'), path + '缺少首尾值');
  const start = beatValue(event.startTime, path + '.startTime'), end = beatValue(event.endTime, path + '.endTime');
  check(end >= start, path + '结束拍不能早于开始拍');
  const inspect = (value, parents = new Set()) => {
    check(value === null || ['string', 'boolean', 'number', 'object'].includes(typeof value), path + '只能包含 JSON 数据');
    if (typeof value === 'number') check(Number.isFinite(value), path + '不能包含非有限数字');
    if (!value || typeof value !== 'object') return;
    check(!parents.has(value), path + '不能包含循环引用'); parents.add(value);
    check(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), path + '只能包含普通 JSON 对象');
    for (const item of Object.values(value)) inspect(item, parents); parents.delete(value);
  };
  inspect(event);
  if (event.easingType !== undefined) check(Number.isInteger(event.easingType) && event.easingType >= 1 && event.easingType <= 29, path + '缓动编号应为 1–29');
  for (const key of ['easingLeft', 'easingRight']) if (event[key] !== undefined) check(Number.isFinite(event[key]), path + '.' + key + '必须为有限数字');
  if (event.bezier) check(Array.isArray(event.bezierPoints) && event.bezierPoints.length === 4 && event.bezierPoints.every(Number.isFinite), path + 'Bezier 控制点无效');
  return event;
}

export function validateGlobalEvents(chart) {
  const data = chart.globalEvents; if (data === undefined) return;
  check(record(data) && data.version === 1 && record(data.types), 'globalEvents 需要 version:1 和 types 对象');
  for (const [id, type] of Object.entries(data.types)) {
    check(record(type) && text(type.name) && record(type.source) && record(type.columns), id + '缺少名称、来源或列');
    const source = type.source;
    check(['builtin', 'mod'].includes(source.kind) && text(source.id) && text(source.name), id + '来源无效');
    check(id.startsWith((source.kind === 'builtin' ? 'rpen' : source.id) + '/') && localId.test(id.split('/')[1]) && id.split('/').length === 2, id + '命名空间与来源不一致');
    if (source.kind === 'mod') check(text(source.author) && text(source.version), id + '必须标识模组名、作者及版本');
    for (const [key, column] of Object.entries(type.columns)) {
      check(localId.test(key) && record(column) && text(column.name) && Array.isArray(column.events), id + '/' + key + '列无效');
      column.events.forEach((event, index) => validateGlobalEvent(event, id + '/' + key + '[' + index + ']'));
    }
  }
}

export class GlobalEventRegistry extends EventTarget {
  constructor() { super(); this.types = new Map(); this.revision = 0; }
  register(definition, owner = { kind: 'builtin', id: 'rpen', name: 'RPE Next' }) {
    check(record(owner) && ['builtin', 'mod'].includes(owner.kind) && localId.test(owner.id) && text(owner.name), '类型来源无效');
    if (owner.kind === 'mod') check(text(owner.author) && text(owner.version), '模组来源必须包含作者与版本');
    check(record(definition) && localId.test(definition.id), '类型 id 应为小写字母开头的本地标识');
    check(text(definition.name), '类型需要名称');
    if (definition.width !== undefined) check(Number.isFinite(definition.width) && definition.width >= 24 && definition.width <= 2048, '列宽需要在 24–2048 像素之间');
    check(Array.isArray(definition.columns) && definition.columns.length > 0, '类型至少需要一列');
    const source = structuredClone(owner), id = (source.kind === 'mod' ? source.id : 'rpen') + '/' + definition.id;
    check(!this.types.has(id), '重复类型：' + id);
    const seen = new Set();
    const columns = definition.columns.map(column => {
      check(record(column) && localId.test(column.id) && !seen.has(column.id), '列 id 无效或重复'); seen.add(column.id);
      check(text(column.name), '列需要名称');
      if (column.timelineLabel !== undefined) check(text(column.timelineLabel), '时间轴短标题需要非空文字');
      const valueType = column.valueType ?? 'number';
      if (column.width !== undefined) check(Number.isFinite(column.width) && column.width >= 24 && column.width <= 2048, '列宽需要在 24–2048 像素之间');
      check(['number', 'text', 'boolean', 'color', 'json'].includes(valueType), '未知值类型：' + valueType);
      const fallback = { number: 0, text: '', boolean: false, color: [255, 255, 255], json: null }[valueType];
      const result = { ...column, valueType, defaultValue: structuredClone(column.defaultValue ?? fallback), overlap: Boolean(column.overlap) };
      validateColumnEvent({ ...result, validate: undefined }, { startTime: [0, 0, 1], endTime: [1, 0, 1], start: result.defaultValue, end: result.defaultValue });
      for (const key of ['min', 'max', 'step']) if (result[key] !== undefined) check(Number.isFinite(result[key]) && (key !== 'step' || result[key] > 0), '列数值范围无效');
      return Object.freeze(result);
    });
    const type = Object.freeze({ ...definition, id, source: Object.freeze(source), columns: Object.freeze(columns), persistent: definition.persistent !== false, readonly: false });
    this.types.set(id, type); this.changed();
    let active = true; return () => { if (!active || this.types.get(id) !== type) return; active = false; this.types.delete(id); this.changed(); };
  }
  changed() { this.revision++; this.dispatchEvent(new Event('change')); }
  list(chart) {
    const known = [...this.types.values()];
    for (const [id, stored] of Object.entries(chart.globalEvents?.types ?? {})) if (!this.types.has(id)) known.push({
      id, name: stored.name, source: stored.source, persistent: true, readonly: true, description: '对应的事件类型尚未加载；数据会完整保留。',
      width: stored.width,
      columns: Object.entries(stored.columns).map(([id, column]) => ({ id, name: column.name, timelineLabel: column.timelineLabel, valueType: column.valueType ?? 'json', width: column.width, defaultValue: null, overlap: true })),
    });
    return known;
  }
}

export function validateColumnEvent(column, event) {
  validateGlobalEvent(event);
  for (const key of ['start', 'end']) {
    const value = event[key];
    if (column.valueType === 'number') check(Number.isFinite(value), column.name + '的值需要是有限数字');
    if (column.valueType === 'text') check(typeof value === 'string', column.name + '的值需要是文字');
    if (column.valueType === 'boolean') check(typeof value === 'boolean', column.name + '的值需要是布尔值');
    if (column.valueType === 'color') check(Array.isArray(value) && value.length === 3 && value.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255), column.name + '的值需要是 0–255 的 RGB 数组');
    if (typeof value === 'number') {
      if (column.min !== undefined) check(value >= column.min, column.name + '不能小于 ' + column.min);
      if (column.max !== undefined) check(value <= column.max, column.name + '不能大于 ' + column.max);
    }
  }
  const result = column.validate?.(event); check(result !== false && typeof result !== 'string', typeof result === 'string' ? result : column.name + '校验失败');
  return event;
}

export function placedGlobalEvent(type, column, events, first, second, easingType, inst = false, preview = false) {
  check(!type.readonly, '请先启用提供此类型的模组');
  const start = Math.min(first, second), end = Math.max(first, second); if (end - start < 0.001) return null;
  if (!column.overlap) check(!events.some(event => start < beatValue(event.endTime) - 1e-8 && end > beatValue(event.startTime) + 1e-8), '该列已有重叠事件');
  const previous = events.filter(event => beatValue(event.endTime) <= start).sort((a, b) => beatValue(b.endTime) - beatValue(a.endTime))[0];
  const value = structuredClone(previous?.end ?? column.defaultValue);
  let event = { startTime: fromNumber(start), endTime: fromNumber(end), start: value, end: structuredClone(value), easingType: easingType ?? previous?.easingType ?? 1, easingLeft: 0, easingRight: 1, bezier: 0, bezierPoints: [0, 0, 1, 1], inst: inst ? 1 : 0 };
  if (preview) return event;
  if (column.create) event = column.create({ event: structuredClone(event), previous: previous && structuredClone(previous), type, column });
  if (event === null) return null; return validateColumnEvent(column, event);
}

export function registerPlaceholderGlobalEvent(registry) {
  return registry.register({ id: 'placeholder', name: '占位', description: '仅用于测试编辑操作，不产生效果、不保存到谱面。', persistent: false,
    columns: [{ id: 'value', name: '占位', valueType: 'number', defaultValue: 0 }] });
}

export function globalEventDensity(events, tempo, duration, bins = 100) {
  const delta = new Int32Array(bins + 1), result = new Uint32Array(bins); const length = Math.max(0.001, duration);
  for (const event of events) {
    const start = tempo.seconds(event.startTime), end = tempo.seconds(event.endTime);
    if (end < 0 || start > length) continue;
    const first = Math.min(bins - 1, Math.max(0, Math.floor(start / length * bins))), last = Math.min(bins - 1, Math.max(first, Math.ceil(end / length * bins) - 1));
    delta[first]++; delta[last + 1]--;
  }
  let count = 0; for (let index = 0; index < bins; index++) { count += delta[index]; result[index] = count; } return result;
}
