import { generateCurveNotes } from '../core/curve-notes.ts';
import { beatValue, formatBeat, parseBeat } from '../core/beat.ts';
import { showDialog } from './dialog.ts';
import { assetUrl } from '../core/asset-url.ts';

export function curveDialog(session, division, anchors = []) {
  if (!session.line) throw new Error('请先添加判定线');
  const selected = [...session.selection].map(index => session.notes[index]).filter(Boolean).sort((left, right) => beatValue(left.startTime) - beatValue(right.startTime));
  const endpoints = anchors.length === 2 ? anchors : selected.length === 2 ? selected : [];
  const body = showDialog('生成曲线音符', '原版流程：先按 Ctrl+F 进入起点选择，再点击起点音符；按 Ctrl+G 进入终点选择，再点击终点音符。也可预先选中两个音符。按横线分格与密度生成中间音符，不生成端点，整次操作可一步撤销。');
  const fields = document.createElement('div'); fields.className = 'curve-fields'; body.append(fields);
  const controls = {};
  const field = (key, labelText, value, options) => {
    const label = document.createElement('label'); label.className = 'field'; label.append(labelText);
    const input = document.createElement(options ? 'select' : 'input'); input.setAttribute('aria-label', labelText);
    if (options) for (const [key, text] of options) input.append(new Option(text, key));
    input.value = value; controls[key] = input; label.append(input); fields.append(label);
  };
  field('startTime', '曲线起拍', formatBeat(endpoints[0]?.startTime ?? [0, 0, 1]));
  field('endTime', '曲线止拍', formatBeat(endpoints[1]?.startTime ?? [4, 0, 1]));
  field('startX', '曲线起点 X', endpoints[0]?.positionX ?? -405);
  field('endX', '曲线终点 X', endpoints[1]?.positionX ?? 405);
  field('density', '曲线密度', 1);
  field('type', '曲线音符类型', 4, [[4, 'Drag'], [1, 'Tap'], [3, 'Flick']]);
  field('easingType', '曲线缓动', 1, Array.from({ length: 29 }, (unused, index) => [index + 1, `缓动 ${index + 1}`]));
  const picture = document.createElement('img'); picture.width = 100; picture.height = 64; picture.alt = '所选缓动函数示意'; fields.append(picture);
  const canvas = document.createElement('canvas'); canvas.className = 'curve-preview'; canvas.width = 760; canvas.height = 220; canvas.setAttribute('aria-label', '待生成曲线音符预览'); body.append(canvas);
  const summary = document.createElement('p'); summary.setAttribute('role', 'status'); body.append(summary);
  const apply = document.querySelector('#modal-apply'); apply.hidden = false; apply.textContent = '生成音符';
  const read = () => {
    const values = Object.fromEntries(Object.entries(controls).map(([key, control]) => {
      if (!control.value.trim()) throw new Error('请填写所有曲线参数');
      return [key, key.endsWith('Time') ? parseBeat(control.value) : Number(control.value)];
    }));
    return { ...values, division };
  };
  const refresh = () => {
    const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height);
    picture.src = assetUrl(`easing/${controls.easingType.value}.svg`);
    try {
      const values = read(); const notes = generateCurveNotes(values);
      summary.textContent = `${notes.length} 个音符 · 横线 ${division} × 密度 ${values.density} · 端点不重复添加`;
      const all = [{ positionX: values.startX, startTime: values.startTime }, ...notes, { positionX: values.endX, startTime: values.endTime }];
      const minimumX = Math.min(values.startX, values.endX, ...notes.map(note => note.positionX));
      const maximumX = Math.max(values.startX, values.endX, ...notes.map(note => note.positionX));
      const start = beatValue(values.startTime); const range = beatValue(values.endTime) - start;
      for (const [index, note] of all.entries()) {
        const horizontal = 30 + (note.positionX - minimumX) / (maximumX - minimumX || 1) * 700;
        const vertical = range ? 195 - (beatValue(note.startTime) - start) / range * 170 : 110;
        context.fillStyle = index === 0 || index === all.length - 1 ? '#ffe091' : '#9de5a6';
        context.fillRect(horizontal - 7, vertical - 2, 14, 4);
      }
      apply.disabled = !notes.length;
    } catch (error) { summary.textContent = error.message; apply.disabled = true; }
  };
  fields.addEventListener('input', refresh);
  apply.onclick = () => {
    try {
      const notes = generateCurveNotes(read());
      if (notes.length) { session.focus = 'notes'; session.eventSelection.clear(); session.insertNotes(notes, '生成曲线音符'); }
      document.querySelector('#modal').close();
    } catch (error) { document.querySelector('#modal-error').textContent = error.message; }
  };
  refresh();
}
