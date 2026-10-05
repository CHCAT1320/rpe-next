import { formatLineExpression, parseLineExpression } from '../application/multi-line-edit.mjs';

export class MultiLinePanel {
  constructor(host, getSession, { activate = () => {}, render = () => {}, notify = () => {}, timeline = null, persist = () => {} } = {}) {
    this.host = host; this.getSession = getSession; this.activate = activate; this.renderSession = render; this.notify = notify; this.timeline = timeline; this.persist = persist; this.drag = null; this.listScrollTop = null;
  }

  render() {
    const session = this.getSession();
    if (!session) return;
    const previousList = this.host.querySelector('.multi-line-list');
    const previousScrollTop = this.listScrollTop !== null ? this.listScrollTop : previousList?.scrollTop ?? 0;
    this.host.replaceChildren();
    const title = document.createElement('div'); title.className = 'panel-title';
    title.append('多线编辑');
    const count = document.createElement('small'); count.textContent = session.multiLineActive ? `${session.multiLineIndices.length} 条线` : '未开启'; title.append(count);
    this.host.append(title);
    const intro = document.createElement('p'); intro.className = 'hint'; intro.textContent = '多线模式会将所选判定线并列显示；点击对应区域即可编辑该线。音符合并模式会共用一个编辑区域。'; this.host.append(intro);
    const widthField = document.createElement('label'); widthField.className = 'field multi-line-width-field'; widthField.append('单线宽度');
    const widthControls = document.createElement('span'); widthControls.className = 'multi-line-width-controls';
    const currentArea = session.multiLineMode === 'events' ? 'events' : 'notes';
    const currentCanvas = currentArea === 'events' ? this.timeline?.eventsCanvas : this.timeline?.notesCanvas;
    const widthInput = document.createElement('input'); widthInput.type = 'range'; widthInput.min = 30; widthInput.max = 2400; widthInput.step = 10; widthInput.value = (currentArea === 'events' ? this.timeline?.multiLineEventWidth : this.timeline?.multiLineWidth) || currentCanvas?.clientWidth || 640; widthInput.title = '多线模式下每条线编辑区域的宽度';
    const widthValue = document.createElement('output'); widthValue.textContent = `${widthInput.value}px`;
    const setWidth = raw => {
      const value = Math.max(30, Math.min(2400, Number(raw) || 640));
      if (this.timeline) {
        const area = session.multiLineMode === 'events' ? 'events' : 'notes';
        const canvas = area === 'events' ? this.timeline.eventsCanvas : this.timeline.notesCanvas;
        const viewport = canvas?.clientWidth || 640;
        const oldOffset = this.timeline.multiLineViewportOffset(viewport, area);
        const center = oldOffset + viewport / 2;
        if (area === 'events') { this.timeline.multiLineEventWidth = value; this.timeline.multiLineEventWidthExplicit = true; }
        else { this.timeline.multiLineWidth = value; this.timeline.multiLineWidthExplicit = true; }
        const total = this.timeline.panelCount(area) * this.timeline.panelWidth(viewport, area) + Math.max(0, this.timeline.panelCount(area) - 1) * this.timeline.panelGap(viewport, area);
        const maximum = Math.max(0, total - viewport);
        const nextOffset = Math.max(0, Math.min(maximum, center - viewport / 2));
        this.timeline.multiLineScroll[area] = nextOffset;
        this.timeline.changed();
      }
      widthInput.value = value; widthValue.textContent = `${value}px`; this.persist();
    };
    widthInput.oninput = () => setWidth(widthInput.value);
    const resetWidth = document.createElement('button'); resetWidth.type = 'button'; resetWidth.textContent = '重置'; resetWidth.title = '恢复为当前编辑区域的默认宽度'; resetWidth.onclick = () => { if (this.timeline) { if (currentArea === 'events') { this.timeline.multiLineEventWidth = 0; this.timeline.multiLineEventWidthExplicit = false; } else { this.timeline.multiLineWidth = 0; this.timeline.multiLineWidthExplicit = false; } this.timeline.multiLineScroll = { notes: 0, events: 0 }; this.timeline.changed(); } widthInput.value = currentCanvas?.clientWidth || 640; widthValue.textContent = `${widthInput.value}px`; this.persist(); };
    widthControls.append(widthInput, widthValue, resetWidth); widthField.append(widthControls); this.host.append(widthField);
    const controls = document.createElement('div'); controls.className = 'multi-line-controls';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = session.multiLineEnabled ? 'active' : ''; toggle.textContent = session.multiLineEnabled ? '● 多线' : '○ 多线';
    toggle.title = '开启或关闭多线编辑'; toggle.onclick = () => { session.setMultiLineEnabled(!session.multiLineEnabled, session.multiLineMode); this.renderSession(); };
    const notes = document.createElement('button'); notes.type = 'button'; notes.className = session.multiLineMode === 'notes' ? 'active' : ''; notes.textContent = '音符'; notes.title = '多线音符模式'; notes.onclick = () => { session.setMultiLineMode('notes'); this.renderSession(); };
    const events = document.createElement('button'); events.type = 'button'; events.className = session.multiLineMode === 'events' ? 'active' : ''; events.textContent = '事件'; events.title = '多线事件模式'; events.onclick = () => { session.setMultiLineMode('events'); this.renderSession(); };
    const merge = document.createElement('button'); merge.type = 'button'; merge.className = session.multiLineMerge && session.multiLineMode === 'notes' ? 'active' : ''; merge.textContent = '合并'; merge.disabled = session.multiLineMode !== 'notes'; merge.title = '合并多线音符编辑区域'; merge.onclick = () => { session.setMultiLineMerge(!session.multiLineMerge); this.renderSession(); };
    controls.append(toggle, notes, events, merge); this.host.append(controls);
    const actions = document.createElement('div'); actions.className = 'multi-line-actions';
    for (const [label, titleText, handler] of [['加入当前线', '将当前判定线加入多线编辑', () => session.addMultiLine()], ['移出当前线', '将当前判定线移出多线编辑', () => session.removeMultiLine()], ['清空', '清空参与编辑的判定线', () => session.clearMultiLines()]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = titleText; button.onclick = () => { handler(); this.renderSession(); }; actions.append(button);
    }
    this.host.append(actions);
    const expressionField = document.createElement('label'); expressionField.className = 'field multi-line-expression-field'; expressionField.append('线号');
    const expression = document.createElement('input'); expression.type = 'text'; expression.inputMode = 'text'; expression.placeholder = '例如 0 2:4 8'; expression.value = formatLineExpression(session.multiLineIndices); expression.title = '空格分隔线号；x:y 表示包含两端的连续线号'; expressionField.append(expression); this.host.append(expressionField);
    const applyExpression = () => {
      const previous = [...session.multiLineIndices];
      try {
        const indices = parseLineExpression(expression.value, session.chart.judgeLineList?.length ?? 0);
        if (!indices.length) throw new Error('至少需要一条有效判定线');
        session.multiLineIndices = indices; session.multiLineEnabled = true; session.normalizeMultiLine(); session.notify(); this.renderSession();
      } catch (error) { expression.value = formatLineExpression(previous); this.notify(error.message, 'warning'); }
    };
    expression.addEventListener('change', applyExpression); expression.addEventListener('blur', applyExpression); expression.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyExpression(); } });
    const list = document.createElement('div'); list.className = 'multi-line-list';
    list.addEventListener('scroll', () => { this.listScrollTop = list.scrollTop; }, { passive: true });
    const syncExpression = () => { expression.value = formatLineExpression(session.multiLineIndices); };
    const setRow = (index, selected) => {
      const values = new Set(session.multiLineIndices);
      if (selected) values.add(index); else values.delete(index);
      session.multiLineIndices = [...values].sort((left, right) => left - right);
      session.multiLineEnabled = session.multiLineIndices.length > 0;
      syncExpression();
      list.querySelectorAll('.multi-line-row').forEach(row => {
        const rowIndex = Number(row.dataset.lineIndex); const active = session.multiLineIndices.includes(rowIndex);
        row.classList.toggle('selected', active); const checkbox = row.querySelector('input'); if (checkbox) checkbox.checked = active;
      });
    };
    const lines = session.chart.judgeLineList ?? [];
    for (const [index, line] of lines.entries()) {
      const row = document.createElement('label'); row.className = 'multi-line-row'; row.dataset.lineIndex = index;
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = session.isTargetLine(index); checkbox.disabled = !session.multiLineEnabled && index !== session.lineIndex;
      checkbox.onchange = () => { setRow(index, checkbox.checked); session.notify(); this.renderSession(); };
      const label = document.createElement('span'); label.textContent = `${String(index).padStart(2, '0')} · ${line.Name || '未命名'}`;
      const stats = document.createElement('small'); const events = [...(line.eventLayers ?? []), line.extended ?? {}].reduce((sum, layer) => sum + Object.values(layer ?? {}).reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0), 0); stats.textContent = `${line.notes?.length ?? 0} 音符 · ${events} 事件`;
      row.classList.toggle('current', index === session.lineIndex); row.classList.toggle('selected', checkbox.checked); row.append(checkbox, label, stats); list.append(row);
    }
    const finishDrag = () => { if (!this.drag) return; this.listScrollTop = list.scrollTop; this.drag = null; session.normalizeMultiLine(); session.notify(); this.renderSession(); };
    list.addEventListener('pointerdown', event => {
      const row = event.target.closest('.multi-line-row'); if (!row || event.button !== 0) return;
      event.preventDefault(); this.listScrollTop = list.scrollTop; list.setPointerCapture?.(event.pointerId); const index = Number(row.dataset.lineIndex); this.drag = { selected: !session.multiLineIndices.includes(index), pointerId: event.pointerId }; setRow(index, this.drag.selected);
    });
    list.addEventListener('pointermove', event => {
      if (!this.drag || (this.drag.pointerId !== undefined && event.pointerId !== this.drag.pointerId)) return;
      const rectangle = list.getBoundingClientRect(); const edge = 22;
      if (event.clientY < rectangle.top + edge) list.scrollTop -= 12;
      else if (event.clientY > rectangle.bottom - edge) list.scrollTop += 12;
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.multi-line-row');
      if (row && list.contains(row)) setRow(Number(row.dataset.lineIndex), this.drag.selected);
    });
    list.addEventListener('pointerup', finishDrag); list.addEventListener('pointercancel', finishDrag); list.addEventListener('lostpointercapture', finishDrag);
    this.listScrollTop = Math.max(0, previousScrollTop);
    list.scrollTop = this.listScrollTop;
    requestAnimationFrame(() => { if (list.isConnected) list.scrollTop = this.listScrollTop; });
    this.host.append(list);
  }
}
