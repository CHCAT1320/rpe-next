import { formatBeat, parseBeat } from '../core/beat.mjs';
import { easing, bezier } from '../core/easing.mjs';
import { selectedEvents, transformEvents, deleteEvents, eventList, eventListAt, eventKey } from '../application/event-commands.mjs';
import { captureSelection, editCapturedSelection, commitSelectionEdit } from '../application/batch-edit.mjs';

import { EASING_NAMES, createEasingPicker } from './easing-picker.mjs';
import { numericWheel } from './numeric-wheel.mjs';
import { beatInputControl } from './beat-input.mjs';
import { EVENT_WHEEL_STEPS } from '../core/note-editing.mjs';
import { renderShaderInspector } from './shader-inspector.mjs';
import { canCutEvent } from '../application/event-tools.mjs';
import { runEventTool } from './event-tools.mjs';
import { editorSkinContext } from './editor-skin-canvas.mjs';
export { EASING_NAMES } from './easing-picker.mjs';
const galleryState = { open: false };

function inspectorEntries(session) {
  if (session.multiLineActive && session.multiLineMode === 'events') {
    return [...(session.multiEventSelection ?? new Map())].flatMap(([lineIndex, keys]) => [...keys].map(key => {
      const [type, indexText] = String(key).split(':'); const index = Number(indexText);
      return { type, index, lineIndex, event: eventListAt(session, lineIndex, type)?.[index] };
    })).filter(entry => entry.event);
  }
  return selectedEvents(session);
}

function applyEventTransform(session, label, transform) {
  if (session.multiLineActive && session.multiLineMode === 'events') {
    const result = editCapturedSelection(captureSelection(session), { event: transform });
    commitSelectionEdit(session, result, label);
  } else transformEvents(session, label, transform);
}

export function renderEventInspector(session, tempo, currentBeat, reportError, notify = () => {}, sampler = null) {
  if (session.liveEventEdit) return;
  const container = document.querySelector('#event-properties'); container.replaceChildren();
  const entries = inspectorEntries(session); const event = entries[0]?.event; const eventType = entries[0]?.type;
  document.querySelector('#event-selection-count').textContent = `${entries.length} 已选`;
  if (!event) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '点击事件查看属性；拖动移动，拖动上/下边缘调整时间。Shift 框选，Ctrl 多选。事件区按 R 两次确定起止拍，Esc 取消。'; container.append(hint); return; }
  if (eventType === 'paintEvents') { renderShaderInspector(container, session, reportError, () => renderEventInspector(session, tempo, currentBeat, reportError, notify)); return; }
  const safely = action => { try { action(); } catch (error) { reportError(error); } };
  const valueKind = (type, value) => type === 'colorEvents' && Array.isArray(value) ? 'array' : type === 'textEvents' && typeof value === 'string' ? 'text' : Array.isArray(value) ? 'array' : 'number';
  const valueTitle = eventType === 'alphaEvents' ? ['起始透明度', '结束透明度'] : eventType === 'speedEvents' ? ['起始速度', '结束速度'] : eventType === 'colorEvents' ? ['起始颜色', '结束颜色'] : eventType === 'textEvents' ? ['起始文字', '结束文字'] : ['起始值', '结束值'];
  const fields = [['startTime', '开始拍', 'beat'], ['endTime', '结束拍', 'beat'], ['start', valueTitle[0], valueKind(eventType, event.start)], ['end', valueTitle[1], valueKind(eventType, event.end)], ['easingLeft', '缓动左边界', 'number'], ['easingRight', '缓动右边界', 'number'], ['linkgroup', '绑定组编号', 'number']];
  const applyField = (input, key, title, kind, quiet = false) => {
    const update = () => {
    let value;
    if (kind === 'beat') value = parseBeat(input.value);
    else if (kind === 'array') {
      const values = input.value.split(',').map(Number);
      if (values.length !== 3 || values.some(number => !Number.isFinite(number))) throw new Error('颜色必须是 R,G,B 三个有限数字');
      value = values.map(number => Math.max(0, Math.min(255, number)));
    } else if (kind === 'number') {
      value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value)) return;
      if (eventType === 'alphaEvents' && (key === 'start' || key === 'end')) value = Math.trunc(Math.max(0, Math.min(255, value)));
      if (key === 'easingLeft' || key === 'easingRight') value = Math.max(0, Math.min(1, value));
      if (key === 'linkgroup') value = Math.max(0, Math.round(value));
    } else value = input.value;
    applyEventTransform(session, `修改事件${title}`, current => ({ ...current, [key]: value, ...(current.inst && (key === 'start' || key === 'end') ? { start: value, end: structuredClone(value) } : {}) }));
    };
    try { update(); } catch (error) { if (!quiet) reportError(error); }
  };
  const samplePanel = (key, title, kind, value) => {
    const panel = document.createElement('div'); panel.className = 'event-sample-panel'; panel.hidden = true;
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = `${title}取样 · 拖动控制条实时预览，完成后统一应用`;
    panel.append(hint);
    const target = { type: eventType, index: entries[0].index, lineIndex: entries[0].lineIndex ?? session.lineIndex, field: key };
    let sampleValue = structuredClone(value);
    const applySample = next => safely(() => {
      sampleValue = structuredClone(next);
      if (sampler) sampler.updateValueDraft(target, next);
      else applyEventTransform(session, `取样${title}`, current => ({ ...current, [key]: next, ...(current.inst && (key === 'start' || key === 'end') ? { start: structuredClone(next), end: structuredClone(next) } : {}) }));
    });
    const addRange = (labelText, min, max, step, initial, update) => {
      const label = document.createElement('label'); label.className = 'field'; label.append(labelText);
      const range = document.createElement('input'); range.type = 'range'; range.min = min; range.max = max; range.step = step; range.value = initial; range.setAttribute('aria-label', `${title}${labelText}`);
      const output = document.createElement('output'); output.textContent = String(initial);
      range.onpointerdown = () => { sampler?.beginValueDraft(); session.liveEventEdit = true; };
      range.oninput = () => { const next = update(Number(range.value)); output.textContent = Array.isArray(next) ? next.join(', ') : String(next); applySample(next); };
      label.append(range, output); panel.append(label);
    };
    if (kind === 'array') {
      const colors = Array.isArray(value) ? value : [255, 255, 255]; sampleValue = [...colors];
      const picker = document.createElement('input'); picker.type = 'color'; picker.value = '#' + colors.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join(''); picker.setAttribute('aria-label', `${title}取色板`); picker.oninput = () => { const hex = picker.value.slice(1); const next = [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)); applySample(next); }; panel.append(picker);
      for (const [index, channel] of ['R', 'G', 'B'].entries()) addRange(channel, 0, 255, 1, colors[index], next => { const result = [...sampleValue]; result[index] = next; return result; });
    } else if (eventType === 'alphaEvents') {
      const wrap = document.createElement('div'); wrap.className = 'alpha-sample-wrap';
      const range = document.createElement('input'); range.type = 'range'; range.min = 0; range.max = 255; range.step = 1; range.value = Number(value) || 0; range.className = 'alpha-sample-gradient'; range.setAttribute('aria-label', `${title}透明度取样`);
      const output = document.createElement('output'); output.textContent = String(range.value); range.onpointerdown = () => { sampler?.beginValueDraft(); session.liveEventEdit = true; }; range.oninput = () => { output.textContent = String(range.value); applySample(Number(range.value)); }; wrap.append(range, output); panel.append(wrap);
    } else {
      const limits = eventType === 'alphaEvents' ? [0, 255, 1] : eventType === 'speedEvents' ? [-20, 20, 0.01] : eventType === 'rotateEvents' ? [-360, 360, 0.1] : [-2000, 2000, 0.1];
      addRange('数值', ...limits, Number(value) || 0, next => next);
    }
    const actions = document.createElement('div'); actions.className = 'event-sample-actions';
    const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = '应用全部取样'; apply.onclick = () => sampler ? sampler.finishValue(true) : undefined;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消取样'; cancel.onclick = () => sampler ? sampler.finishValue(false) : undefined;
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '收起取样';
    actions.append(apply, cancel, close); panel.append(actions);
    return { panel, close };
  };
  for (const [key, title, kind] of fields) {
    const label = document.createElement('label'); label.className = 'field'; label.append(title);
    const input = document.createElement('input'); input.type = kind === 'number' ? 'number' : 'text'; input.step = 'any'; input.setAttribute('aria-label', `事件${title}`);
    input.dataset.rpenField = key; label.dataset.rpenField = key;
    if (key === 'easingLeft' || key === 'easingRight') { input.min = 0; input.max = 1; }
    if (eventType === 'alphaEvents' && (key === 'start' || key === 'end')) { input.min = 0; input.max = 255; }
    if (eventType === 'speedEvents' && (key === 'start' || key === 'end')) { input.min = -20; input.max = 20; }
    if (key === 'linkgroup') { input.min = 0; input.step = 1; }
    input.value = kind === 'beat' ? formatBeat(event[key]) : kind === 'array' ? event[key].join(', ') : event[key] ?? (key === 'easingRight' ? 1 : 0);
    input.onfocus = () => { session.liveEventEdit = true; };
    input.onblur = () => { session.liveEventEdit = false; queueMicrotask(() => { if (!session.liveEventEdit) renderEventInspector(session, tempo, currentBeat, reportError, notify, sampler); }); };
    input.oninput = event => { if (!event.isComposing && (kind !== 'number' || input.value.trim())) applyField(input, key, title, kind, true); };
    input.onchange = () => applyField(input, key, title, kind);
    if (kind === 'number') {
      const step = key === 'easingLeft' || key === 'easingRight' ? 0.05 : key === 'linkgroup' ? 1 : session.eventWheelSteps?.[eventType] ?? EVENT_WHEEL_STEPS[eventType] ?? 1;
      input.step = step; numericWheel(input, step);
    }
    const controls = document.createElement('span'); controls.className = 'event-input-controls'; controls.append(kind === 'beat' ? beatInputControl(input, () => session.division, reportError) : input);
    const samplingField = key === 'start' || key === 'end';
    const samplingType = ['moveXEvents', 'moveYEvents', 'rotateEvents', 'alphaEvents', 'speedEvents', 'colorEvents'].includes(eventType);
    if (samplingField && samplingType) {
      if (sampler && ['moveXEvents', 'moveYEvents', 'rotateEvents'].includes(eventType) && ['start', 'end'].includes(key)) {
        const open = document.createElement('button'); open.type = 'button'; open.className = 'sample-button'; open.textContent = '⌖'; open.title = `${title}：在预览中拖动取样`;
        open.onclick = () => sampler.begin({ type: eventType, index: entries[0].index, field: key, lineIndex: entries[0].lineIndex ?? session.lineIndex });
        controls.append(open);
      } else {
        const sampling = samplePanel(key, title, kind, event[key]);
        const open = document.createElement('button'); open.type = 'button'; open.className = 'sample-button'; open.textContent = '⌖'; open.title = '展开取样控制';
        sampling.close.onclick = () => { sampling.panel.hidden = true; open.hidden = false; };
        open.onclick = () => { sampler?.beginValueDraft(); session.liveEventEdit = true; sampling.panel.hidden = false; open.hidden = true; };
        controls.append(open); label.append(controls); container.append(label); container.insertBefore(sampling.panel, label); continue;
      }
    }
    label.append(controls); container.append(label);
  }
  const lockLabel = document.createElement('label'); lockLabel.className = 'field'; lockLabel.append('钩定（首尾同步）');
  const lock = document.createElement('input'); lock.type = 'checkbox'; lock.checked = Boolean(event.inst); lock.setAttribute('aria-label', '钩定');
  lock.onchange = () => safely(() => applyEventTransform(session, '修改事件钩定', current => ({ ...current, inst: lock.checked ? 1 : 0, ...(lock.checked ? { end: structuredClone(current.start) } : {}) })));
  lockLabel.append(lock); container.append(lockLabel);
  const link = Number(event.linkgroup ?? 0);
  const group = document.createElement('button'); group.type = 'button'; group.className = 'wide-button'; group.textContent = `选中绑定组 ${link}`;
  group.onclick = () => safely(() => {
    if (link <= 0) return;
    const selection = new Set();
    for (const type of session.line?.eventLayers?.[session.eventLayer] ? Object.keys(session.line.eventLayers[session.eventLayer]) : []) for (const [index, candidate] of (eventList(session, type) ?? []).entries()) if (Number(candidate.linkgroup) === link) selection.add(eventKey(type, index));
    if (session.line?.extended) for (const type of Object.keys(session.line.extended)) for (const [index, candidate] of (eventList(session, type) ?? []).entries()) if (Number(candidate.linkgroup) === link) selection.add(eventKey(type, index));
    session.eventSelection = selection; session.notify();
  });
  if (link > 0) container.append(group);
  const label = document.createElement('label'); label.className = 'field'; label.append('缓动');
  const select = document.createElement('select'); select.setAttribute('aria-label', '事件缓动');
  EASING_NAMES.forEach((name, index) => { const option = document.createElement('option'); option.value = index + 1; option.textContent = `${index + 1} · ${name}`; select.append(option); });
  select.value = event.easingType ?? 1;
  select.onchange = () => safely(() => applyEventTransform(session, '修改缓动', current => ({ ...current, easingType: Number(select.value), bezier: 0 })));
  label.append(select); container.append(label);
  container.append(createEasingPicker(event.easingType ?? 1, value => safely(() => applyEventTransform(session, '修改缓动', current => ({ ...current, easingType: value, bezier: 0 }))), galleryState).element);
  const curve = document.createElement('canvas'); curve.width = 260; curve.height = 100; curve.className = 'easing-preview'; curve.setAttribute('aria-label', '缓动曲线预览');
  const context = editorSkinContext(curve.getContext('2d'), 'easing'); context.strokeStyle = '#ffd76a'; context.lineWidth = 2; context.beginPath();
  for (let index = 0; index <= 100; index++) {
    const progress = index / 100;
    const value = event.bezier ? bezier(progress, event.bezierPoints) : easing(progress, event.easingType, event.easingLeft ?? 0, event.easingRight ?? 1);
    const horizontal = 10 + progress * 240; const vertical = 80 - value * 60;
    if (index === 0) context.moveTo(horizontal, vertical); else context.lineTo(horizontal, vertical);
  } context.stroke(); container.append(curve);
  context.save(); context.strokeStyle = '#8da4c7'; context.setLineDash([3, 3]);
  for (const boundary of [event.easingLeft ?? 0, event.easingRight ?? 1]) { const x = 10 + Math.max(0, Math.min(1, boundary)) * 240; context.beginPath(); context.moveTo(x, 10); context.lineTo(x, 88); context.stroke(); }
  context.restore();
  const bezierLabel = document.createElement('label'); bezierLabel.className = 'field'; bezierLabel.append('Bezier');
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(event.bezier); enabled.setAttribute('aria-label', '启用 Bezier');
  enabled.onchange = () => safely(() => applyEventTransform(session, '切换 Bezier', current => ({ ...current, bezier: Number(enabled.checked), bezierPoints: Array.isArray(current.bezierPoints) && current.bezierPoints.length === 4 && current.bezierPoints.slice(2).some(Number) ? current.bezierPoints : [0, 0, 1, 1] })));
  bezierLabel.append(enabled); container.append(bezierLabel);
  if (event.bezier) {
    const bezierPoints = Array.isArray(event.bezierPoints) && event.bezierPoints.length === 4 && event.bezierPoints.slice(2).some(Number) ? event.bezierPoints : [0, 0, 1, 1];
    const points = document.createElement('input'); points.setAttribute('aria-label', 'Bezier 控制点'); points.value = bezierPoints.join(', '); points.className = 'wide-field';
    points.onchange = () => safely(() => applyEventTransform(session, '修改 Bezier', current => ({ ...current, bezierPoints: points.value.split(',').map(Number) })));
    container.append(points);
    const dragCanvas = document.createElement('canvas'); dragCanvas.width = 260; dragCanvas.height = 100; dragCanvas.className = 'easing-preview bezier-editor';
    let draftPoints = [...bezierPoints]; let dragPoint = null; let dragChanged = false;
    const drawBezier = () => { const draw = editorSkinContext(dragCanvas.getContext('2d'), 'bezier'); draw.clearRect(0, 0, 260, 100); draw.strokeStyle = '#65748a'; draw.setLineDash([3, 3]); draw.beginPath(); draw.moveTo(10, 80); draw.lineTo(10 + draftPoints[0] * 240, 80 - draftPoints[1] * 60); draw.moveTo(250, 20); draw.lineTo(10 + draftPoints[2] * 240, 80 - draftPoints[3] * 60); draw.stroke(); draw.setLineDash([]); draw.strokeStyle = '#ffd76a'; draw.lineWidth = 2; draw.beginPath(); for (let index = 0; index <= 100; index++) { const progress = index / 100; const value = bezier(progress, draftPoints); const x = 10 + progress * 240; const y = 80 - value * 60; index ? draw.lineTo(x, y) : draw.moveTo(x, y); } draw.stroke(); draw.fillStyle = '#fff2a8'; for (const point of [[draftPoints[0], draftPoints[1]], [draftPoints[2], draftPoints[3]]]) { draw.beginPath(); draw.arc(10 + point[0] * 240, 80 - point[1] * 60, 5, 0, Math.PI * 2); draw.fill(); } };
    drawBezier();
    const commitBezier = () => { if (!dragChanged) return; const committed = [...draftPoints]; safely(() => applyEventTransform(session, '拖动 Bezier 控制点', current => ({ ...current, bezierPoints: committed }))); dragChanged = false; };
    const canvasPoint = pointer => {
      const rect = dragCanvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (pointer.clientX - rect.left - 10) / 240)),
        y: Math.max(0, Math.min(1, 1 - ((pointer.clientY - rect.top - 20) / 60))),
      };
    };
    dragCanvas.onpointerdown = pointer => {
      pointer.preventDefault();
      const point = canvasPoint(pointer);
      const candidates = [0, 2].map(index => ({ index, distance: Math.hypot(point.x - draftPoints[index], point.y - draftPoints[index + 1]) }));
      const nearest = candidates.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best);
      if (nearest.distance > 0.14) return;
      dragPoint = nearest.index;
      dragChanged = false;
      dragCanvas.setPointerCapture(pointer.pointerId);
    };
    dragCanvas.onpointermove = pointer => {
      if (dragPoint == null) return;
      pointer.preventDefault();
      const point = canvasPoint(pointer);
      draftPoints[dragPoint] = point.x; draftPoints[dragPoint + 1] = point.y;
      points.value = draftPoints.map(value => value.toFixed(3)).join(', ');
      dragChanged = true;
      drawBezier();
    };
    const finishDrag = pointer => {
      if (dragPoint == null) return;
      if (pointer?.pointerId !== undefined && dragCanvas.hasPointerCapture(pointer.pointerId)) dragCanvas.releasePointerCapture(pointer.pointerId);
      commitBezier(); dragPoint = null;
    };
    dragCanvas.onpointerup = finishDrag;
    dragCanvas.onpointercancel = finishDrag;
    container.append(dragCanvas);
  }
  const actions = document.createElement('div'); actions.className = 'action-grid';
  for (const [action, title] of [['stick', '粘合前一事件'], ['cut', '切割事件']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
    if (action === 'cut') { button.disabled = !canCutEvent(eventType, event); button.title = '按横线细分 × 切割密度生成线性事件段；密度可在设置中调整。文字、着色器不支持切割。'; }
    button.onclick = () => runEventTool(session, action, notify, currentBeat()); actions.append(button);
  }
  for (const [title, action] of [['首尾交换', () => transformEvents(session, '交换事件首尾', current => ({ ...current, start: current.end, end: current.start }))], ['删除事件', () => deleteEvents(session)]]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.onclick = () => safely(action); actions.append(button);
  } container.append(actions);
}
