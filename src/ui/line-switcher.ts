import { lineOverviewWindow, lineOverviewLayout, stepOverviewLine, LineOverviewIndex } from '../core/line-overview.ts';
import { shaderEvents } from '../core/shader-events.ts';
import { NOTE_COLORS } from './timeline.ts';
import { isDefaultLineGroup, isDefaultLineName, lineFeatureLabels, lineGroupName } from '../core/line-groups.ts';

export class LineSwitcher {
  constructor(stage, getContext, { select = () => {} } = {}) {
    this.stage = stage; this.getContext = getContext; this.enabled = true; this.active = false;
    this.select = select; this.browseRow = null; this.animation = null;
    this.notesOnly = false; this.eventsOnly = false;
    this.cache = new Map(); this.cards = new Map(); this.lastFrame = -Infinity;
    this.host = document.createElement('section'); this.host.className = 'line-switcher'; this.host.hidden = true;
    this.host.setAttribute('aria-label', '附近判定线速览');
    this.filters = document.createElement('div'); this.filters.className = 'line-switcher-filters';
    this.filterInputs = new Map();
    for (const [key, label] of [['notesOnly', '音符'], ['eventsOnly', '事件']]) {
      const control = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox';
      input.setAttribute('aria-label', `只显示编辑可视范围内有${label}的判定线`);
      control.title = `只显示编辑可视范围内有${label}的判定线；两项勾选时需同时满足`;
      control.append(input, `视野内有${label}`); this.filters.append(control); this.filterInputs.set(key, input);
      input.addEventListener('change', () => {
        this[key] = input.checked; this.browseRow = null; this.animateFollow = false;
        this.lastFrame = -Infinity; this.draw(performance.now());
      });
    }
    const body = document.createElement('div'); body.className = 'line-switcher-body';
    this.viewport = document.createElement('div'); this.viewport.className = 'line-switcher-viewport';
    this.content = document.createElement('div'); this.content.className = 'line-switcher-content';
    this.grid = document.createElement('div'); this.grid.className = 'line-switcher-grid';
    this.empty = document.createElement('div'); this.empty.className = 'line-switcher-empty'; this.empty.hidden = true;
    this.empty.textContent = '当前可视范围内没有符合条件的判定线'; this.empty.setAttribute('role', 'status');
    this.slider = document.createElement('input'); this.slider.type = 'range'; this.slider.className = 'line-switcher-scroll';
    this.slider.min = 0; this.slider.step = 1; this.slider.setAttribute('aria-label', '浏览判定线缩略图'); this.slider.setAttribute('aria-orientation', 'vertical');
    this.content.append(this.grid); this.viewport.append(this.content, this.empty); body.append(this.viewport, this.slider);
    this.host.append(this.filters, body); stage.append(this.host);
    this.slider.addEventListener('input', () => {
      this.browseRow = Number(this.slider.value); this.lastFrame = -Infinity; this.draw(performance.now());
    });
    this.viewport.addEventListener('scroll', () => this.renderWindow());
    this.host.addEventListener('pointerdown', event => event.stopPropagation());
    this.host.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      if (event.deltaY) { this.step(event.deltaY); this.show(); }
    }, { passive: false });
    window.addEventListener('keyup', event => { if (['Control', 'Meta'].includes(event.key)) this.release(); }, true);
    window.addEventListener('blur', () => this.hide());
    window.addEventListener('pointerdown', event => { if (!this.host.contains(event.target)) this.hide(); }, true);
  }

  show() {
    if (!this.enabled) return;
    this.animateFollow = this.active; this.browseRow = null;
    this.active = true; this.host.hidden = false;
    this.lastFrame = -Infinity; this.draw(performance.now());
  }

  release() { this.hide(); }

  reset() {
    this.hide(); this.notesOnly = false; this.eventsOnly = false; this.browseRow = null;
    for (const input of this.filterInputs.values()) input.checked = false;
    this.cache.clear(); this.chart = null; this.filterKey = null;
  }

  lineIndex(index, chart, tempo, layer = 0, extended = false) {
    const key = `${index}:${layer}:${extended ? 1 : 0}`;
    if (!this.cache.has(key)) this.cache.set(key, new LineOverviewIndex(chart.judgeLineList[index], tempo, extended ? shaderEvents(chart, index) : [], layer, extended));
    return this.cache.get(key);
  }

  filteredLines({ chart, tempo, start, end, layer = 0, extended = false }) {
    if (chart !== this.chart || tempo !== this.tempo) {
      this.cache.clear(); this.chart = chart; this.tempo = tempo; this.filterKey = null;
    }
    const key = `${this.notesOnly}:${this.eventsOnly}:${start}:${end}:${layer}:${extended ? 1 : 0}`;
    if (this.filterKey === key) return this.indices;
    this.filterKey = key;
    this.indices = chart.judgeLineList.map((line, index) => index).filter(index =>
      !this.notesOnly && !this.eventsOnly || this.lineIndex(index, chart, tempo, layer, extended).matches(start, end, this.notesOnly, this.eventsOnly));
    return this.indices;
  }

  step(direction) {
    const context = this.getContext();
    const index = stepOverviewLine(context.selected, direction, this.filteredLines(context));
    return index === null ? false : this.select(index);
  }

  hide() { this.cancelScroll(); this.active = false; this.host.hidden = true; }

  cancelScroll() { if (this.animation != null) cancelAnimationFrame(this.animation); this.animation = null; }

  scrollTo(top, animate) {
    if (animate && this.targetTop === top && this.animation !== null) return;
    this.cancelScroll(); this.targetTop = top;
    const start = this.viewport.scrollTop; const distance = top - start;
    if (!animate || Math.abs(distance) < 1 || Math.abs(distance) > this.stride * this.layout.rows * 2) {
      this.viewport.scrollTop = top; this.renderWindow(); return;
    }
    const started = performance.now();
    const frame = timestamp => {
      const progress = Math.min(1, Math.max(0, (timestamp - started) / 140));
      this.viewport.scrollTop = start + distance * (1 - (1 - progress) ** 3);
      this.renderWindow();
      this.animation = progress < 1 ? requestAnimationFrame(frame) : null;
    };
    this.animation = requestAnimationFrame(frame);
  }

  draw(timestamp) {
    if (!this.active || timestamp - this.lastFrame < 100) return;
    const { chart, tempo, seconds, selected, start, end, visible, layer = 0, extended = false } = this.getContext();
    if (!visible || !this.enabled || !chart.judgeLineList.length) { this.hide(); return; }
    this.lastFrame = timestamp;
    const changedChart = chart !== this.chart || tempo !== this.tempo;
    const indices = this.filteredLines({ chart, tempo, start, end, layer, extended });
    const width = this.stage.clientWidth; const height = this.stage.clientHeight;
    const layout = lineOverviewLayout(width, height);
    const resized = JSON.stringify(layout) !== JSON.stringify(this.layout);
    this.layout = layout; const { columns, rows, thumbnailHeight, panelWidth } = layout;
    this.context = { chart, tempo, seconds, selected, start, end, layer, extended: Boolean(extended) };
    this.stride = thumbnailHeight + 26;
    const visibleRows = Math.min(rows, Math.max(1, Math.floor((height - 38) / this.stride)));
    const overview = lineOverviewWindow(indices.indexOf(selected), indices.length, columns, visibleRows, this.browseRow);
    this.visibleRows = visibleRows;
    this.host.style.top = `${Math.max(0, (height - (visibleRows * this.stride - 4 + 38)) / 2)}px`;
    this.host.style.transform = 'translateX(-50%)';
    this.viewport.style.height = `${Math.max(1, Math.min(visibleRows, overview.totalRows)) * this.stride - 4}px`;
    this.content.style.height = `${Math.max(0, overview.totalRows * this.stride - 4)}px`;
    this.empty.hidden = indices.length > 0;
    this.grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    this.host.style.setProperty('--thumbnail-height', `${thumbnailHeight}px`);
    this.host.style.width = `${panelWidth}px`;
    this.slider.hidden = overview.maxRow === 0; this.slider.max = overview.maxRow; this.slider.value = overview.firstRow;
    this.slider.setAttribute('aria-valuetext', indices.length ? `浏览线 ${indices[overview.indices[0]]} 至 ${indices[overview.indices.at(-1)]}，当前线 ${selected}` : '没有符合条件的判定线');
    this.scrollTo(overview.firstRow * this.stride, this.browseRow === null && this.animateFollow && !resized && !changedChart);
    this.renderWindow(true);
  }

  renderWindow(refresh = false) {
    if (!this.active || !this.context || !this.layout) return;
    const { chart, tempo, seconds, selected, start, end, layer, extended } = this.context;
    const { columns } = this.layout; const rows = this.visibleRows;
    const firstRow = Math.floor(this.viewport.scrollTop / this.stride);
    const first = Math.max(0, firstRow - 1) * columns;
    const last = Math.min(this.indices.length, (firstRow + rows + 2) * columns);
    const indices = this.indices.slice(first, last);
    const signature = `${columns}:${indices.join(',')}`;
    this.grid.style.top = `${Math.max(0, firstRow - 1) * this.stride}px`;
    if (signature !== this.signature) {
      this.signature = signature;
      const cards = new Map();
      for (const index of indices) cards.set(index, this.cards.get(index) ?? this.createCard(index));
      this.cards = cards; this.grid.replaceChildren(...[...cards.values()].map(entry => entry.card));
      refresh = true;
    }
    if (!refresh) return;
    for (const index of indices) {
      const line = chart.judgeLineList[index];
      const sample = this.lineIndex(index, chart, tempo, layer, extended).sample(seconds, start, end);
      const { card, title, lineGroup, name, group, canvas, info } = this.cards.get(index);
      card.classList.toggle('selected', index === selected);
      card.setAttribute('aria-current', String(index === selected));
      const defaultName = String(line?.Name ?? '').trim() === 'Untitled' || isDefaultLineName(line, index);
      title.querySelector('.line-switcher-number').textContent = `${index === selected ? '▶ ' : ''}${index}`;
      name.textContent = defaultName ? '' : ` · ${String(line.Name).trim()}`;
      lineGroup.textContent = isDefaultLineGroup(chart, line) ? '' : ` · ${lineGroupName(chart, line)}`;
      group.textContent = lineFeatureLabels(line).map(label => label.replace('父线=', '父=').replace('贴图=', '图=')).join(' · ');
      group.hidden = !group.textContent;
      info.textContent = `余 ${sample.notesLeft} 音 / ${sample.eventsLeft} 事`;
      card.setAttribute('aria-label', `${title.textContent}${lineGroup.textContent}${name.textContent}，${info.textContent}，视野内 ${sample.notes.length} 音符、${sample.events.length} 事件`);
      drawLineThumbnail(canvas, sample, seconds, start, end);
    }
  }

  createCard(index) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'line-switcher-card';
    const title = document.createElement('strong'); const number = document.createElement('span'); number.className = 'line-switcher-number'; const lineGroup = document.createElement('span'); lineGroup.className = 'line-switcher-line-group'; const name = document.createElement('span'); name.className = 'line-switcher-line-name'; title.append(number, lineGroup, name);
    const group = document.createElement('em'); group.className = 'line-switcher-group';
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 90; canvas.setAttribute('aria-hidden', 'true');
    const info = document.createElement('small'); card.append(title, group, canvas, info);
    card.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      this.browseRow = Math.round(this.viewport.scrollTop / this.stride);
      this.select(index); this.lastFrame = -Infinity; this.draw(performance.now());
    };
    return { card, title, lineGroup, name, group, canvas, info };
  }
}

export function drawLineThumbnail(canvas, sample, seconds, start, end) {
  const context = canvas.getContext('2d'); const width = canvas.width; const height = canvas.height;
  const vertical = time => height - 5 - (time - start) / Math.max(0.01, end - start) * (height - 10);
  context.clearRect(0, 0, width, height); context.fillStyle = '#303030'; context.fillRect(0, 0, width, height);
  context.strokeStyle = '#555555'; context.lineWidth = 1;
  for (const position of [10, 82, 154, 162]) { context.beginPath(); context.moveTo(position, 0); context.lineTo(position, height); context.stroke(); }
  for (const entry of sample.events.slice(0, 1500)) {
    context.fillStyle = entry.channel === 5 ? '#ab7cca99' : '#cfaa5877';
    context.fillRect(166 + entry.channel * 12, vertical(entry.end), 10, Math.max(2, vertical(entry.start) - vertical(entry.end)));
  }
  const notes = sample.notes.slice(0, 1500);
  for (const hold of [true, false]) for (const entry of notes) {
    const note = entry.item; if ((note.type === 2) !== hold) continue;
    const horizontal = 10 + (note.positionX + 675) / 1350 * 144;
    if (horizontal < 0 || horizontal > 160) continue;
    context.fillStyle = NOTE_COLORS[note.type] ?? '#fff'; context.globalAlpha = note.isFake ? 0.35 : 0.9;
    if (hold) context.fillRect(horizontal - 4, vertical(entry.end), 8, Math.max(2, vertical(entry.start) - vertical(entry.end)));
    context.fillRect(horizontal - 7, vertical(entry.start) - 1, 14, 3);
  }
  context.globalAlpha = 1; context.fillStyle = '#ecdfb0'; context.fillRect(0, vertical(seconds), width, 1);
}
