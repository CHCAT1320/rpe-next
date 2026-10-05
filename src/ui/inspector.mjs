import { beatValue, formatBeat, parseBeat, fromNumber } from '../core/beat.mjs';
import { NOTE_NAMES, noteIsAbove } from '../core/chart.mjs';
import { numericWheel } from './numeric-wheel.mjs';
import { visibleBeats, visibleSeconds } from '../core/note-editing.mjs';

export function renderProperties(session, reportError) {
  if (session.liveNoteEdit) return;
  const container = document.querySelector('#properties');
  container.replaceChildren();
  document.querySelector('#property-count').textContent = `${session.selection.size} 已选`;
  const selectedIndex = session.selection.values().next().value;
  const note = session.notes[selectedIndex];
  if (!note) {
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '在左侧音符区点选音符；按已配置的音符快捷键放置。Hold 两次定位起止拍，Esc 取消。拖动实时显示吸附位置；竖线吸附可单独关闭。'; container.append(hint); return;
  }
  const directionOptions = note.type === 2 ? { 0: '下方', 1: '上方' } : { 1: '上方', 2: '下方' };
  const lineOptions = Object.fromEntries((session.chart.judgeLineList ?? []).map((line, index) => [index, `${index} · ${line.Name || '未命名'}`]));
  const fields = [
    ['lineIndex', '所属线号', 'select', lineOptions], ['type', '类型', 'select', NOTE_NAMES], ['startTime', '开始拍', 'beat'], ['endTime', '结束拍', 'beat'],
    ['positionX', 'X 坐标', 'number'], ['above', '方向', 'select', directionOptions],
    ['isFake', 'Fake', 'select', { 0: '否', 1: '是' }], ['speed', '速度', 'number', 1],
    ['size', '大小', 'number', 1], ['alpha', '透明度', 'number', 255],
    ['yOffset', 'Y 偏移', 'number', 0], ['visibleTime', '可见时间', 'duration', 999999],
  ];
  for (const [key, labelText, kind, options] of fields) {
    const label = document.createElement('label');
    label.className = 'field';
    label.append(labelText);
    const duration = key === 'visibleTime';
    const beatDuration = duration && session.visibleTimeUnit === 'beats';
    const input = document.createElement(kind === 'select' ? 'select' : 'input');
    input.setAttribute('aria-label', labelText);
    if (kind === 'select') for (const [value, title] of Object.entries(options)) {
      const option = document.createElement('option'); option.value = value; option.textContent = title; input.append(option);
    }
    else input.type = kind === 'number' || duration && !beatDuration ? 'number' : 'text';
    const step = key === 'speed' ? 0.1 : key === 'size' ? 0.25 : key === 'positionX' || key === 'yOffset' || key === 'alpha' ? 5 : 1;
    if (kind === 'number') input.step = step;
    if (key === 'size') input.min = 0.01;
    if (key === 'alpha') { input.min = 0; input.max = 255; }
    input.value = key === 'lineIndex' ? session.lineIndex : kind === 'beat' ? formatBeat(note[key]) : note[key] ?? (typeof options === 'number' ? options : 0);
    if (key === 'above') input.value = noteIsAbove(note) ? 1 : note.type === 2 ? 0 : 2;
    if (beatDuration && note.visibleTime < 999999) input.value = formatBeat(fromNumber(visibleBeats(note, session.tempo, session.line.bpmfactor ?? 1)));
    if (duration) { input.min = 0; input.title = '999999 表示无限；首次滚轮调节重置为 0，之后每次增减一横线间隔拍'; }
    const apply = () => {
      try {
        if (key === 'lineIndex') { session.moveSelectionToLine(Number(input.value)); return; }
        const value = kind === 'beat' ? parseBeat(input.value) : beatDuration ? beatValue(parseBeat(input.value)) : Number(input.value);
        if (kind !== 'beat' && (input.value.trim() === '' || !Number.isFinite(value))) throw new Error('请输入有限数字');
        if (key === 'size' && value <= 0) throw new Error('大小必须大于零');
        session.transformSelection(`修改${labelText}`, current => {
          const next = { ...current, [key]: duration ? beatDuration ? visibleSeconds(current, value, session.tempo, session.line.bpmfactor ?? 1) : Math.max(0, value) : value };
          if (key === 'startTime') {
            next.endTime = current.type === 2 ? fromNumber(beatValue(current.endTime) + beatValue(value) - beatValue(current.startTime)) : value;
          }
          if (key === 'above') next.above = value === 1 ? 1 : current.type === 2 ? 0 : 2;
          if (key === 'type') {
            next.endTime = value === 2 ? fromNumber(Math.max(beatValue(current.endTime), beatValue(current.startTime) + 1)) : [...current.startTime];
            next.above = noteIsAbove(current) ? 1 : value === 2 ? 0 : 2;
          }
          if (key === 'endTime' && (current.type !== 2 || beatValue(value) < beatValue(current.startTime))) throw new Error('结束拍只能用于 Hold，且不能早于开始拍');
          return next;
        });
      } catch (error) { reportError(error); input.value = key === 'lineIndex' ? session.lineIndex : kind === 'beat' ? formatBeat(note[key]) : note[key] ?? 0; }
    };
    input.onchange = apply;
    input.oninput = () => { if (input.value.trim()) apply(); };
    input.onfocus = () => { session.liveNoteEdit = true; };
    input.onblur = () => { session.liveNoteEdit = false; queueMicrotask(() => { if (!session.liveNoteEdit) renderProperties(session, reportError); }); };
    if (kind === 'number') numericWheel(input, step);
    if (duration) {
      numericWheel(input, 1, direction => {
        const current = session.notes[session.selection.values().next().value];
        if (!current) return;
        const factor = session.line.bpmfactor ?? 1;
        const beats = current.visibleTime >= 999999 ? 0 : Math.max(0, visibleBeats(current, session.tempo, factor) + direction / session.division);
        input.value = beatDuration ? formatBeat(fromNumber(beats)) : Number(visibleSeconds(current, beats, session.tempo, factor).toFixed(8));
        apply();
      });
      const controls = document.createElement('span'); controls.className = 'duration-input';
      const unit = document.createElement('select'); unit.setAttribute('aria-label', '可见时间单位');
      unit.append(new Option('秒', 'seconds'), new Option('拍', 'beats')); unit.value = session.visibleTimeUnit ?? 'seconds';
      unit.onchange = () => { session.visibleTimeUnit = unit.value; session.liveNoteEdit = false; renderProperties(session, reportError); };
      controls.append(input, unit); label.append(controls);
    } else label.append(input);
    container.append(label);
  }
}
