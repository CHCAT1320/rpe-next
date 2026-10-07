import { CURVE_PRESETS, TRAJECTORY_DEFAULTS, sampleCurveTrajectory, presetOptions, validateCurvePreset } from '../core/curve-trajectory.mjs';
import { createTrajectoryEvent, trajectoryChart, splitTrajectoryChart } from '../application/trajectory-commands.mjs';
import { parseBeat, formatBeat } from '../core/beat.mjs';
import { SceneRuntime } from '../core/scene.mjs';
import { previewViewport } from '../core/editor-display.mjs';
import { download } from '../platform/files.mjs';
import { prepareCanvas } from './timeline.mjs';
import { trajectorySplitSettings } from '../core/trajectory-simplify.mjs';

const STORAGE_KEY = 'rpe-next-trajectory-presets-v1';
const COMMON_FIELDS = [
  ['trimStart', '截取起点（0–1）', 'number', 0, 1, 0.01], ['trimEnd', '截取终点（0–1）', 'number', 0, 1, 0.01],
  ['rotation', '整体旋转（度）', 'number', -3600, 3600, 1],
  ['scaleX', '横向倍率', 'number', -100, 100, 0.1], ['scaleY', '纵向倍率', 'number', -100, 100, 0.1],
  ['alignStart', '将截取后的起点对齐', 'checkbox'], ['startX', '实际起点 X', 'number', -100000, 100000, 1], ['startY', '实际起点 Y', 'number', -100000, 100000, 1],
  ['randomness', '随机化程度', 'range', 0, 1, 0.01], ['seed', '随机种子', 'number', 0, 100000, 1],
];

function field(host, key, title, value, type = 'text', minimum, maximum, step, choices) {
  const label = document.createElement('label'); label.className = 'field'; label.append(title);
  const input = document.createElement(choices ? 'select' : 'input');
  input.dataset.key = key; input.setAttribute('aria-label', title);
  if (choices) input.replaceChildren(...choices.map(([value, text]) => new Option(text, value)));
  else input.type = type;
  if (minimum !== undefined) input.min = minimum;
  if (maximum !== undefined) input.max = maximum;
  input.step = step ?? 'any';
  if (type === 'checkbox') input.checked = Boolean(value); else input.value = value ?? '';
  if (key === 'seed') {
    const controls = document.createElement('span'); controls.className = 'trajectory-seed';
    const randomize = document.createElement('button'); randomize.type = 'button'; randomize.textContent = '⚄'; randomize.title = '随机种子'; randomize.setAttribute('aria-label', '生成随机种子');
    randomize.onclick = () => { const previous = Number(input.value); input.value = (previous + 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 100000) % 100001; input.dispatchEvent(new Event('input', { bubbles: true })); };
    controls.append(input, randomize); label.append(controls);
  } else label.append(input);
  host.append(label); return input;
}
const action = (title, run) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = title; button.onclick = run; return button; };
function readFields(host, base) {
  const result = { ...base };
  for (const input of host.querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    result[key] = input.type === 'checkbox' ? input.checked : ['number', 'range'].includes(input.type) ? (input.value.trim() ? Number(input.value) : NaN) : input.value;
  }
  return result;
}
function drawPath(canvas, points, progress = 0) {
  const context = canvas.getContext('2d'); const width = canvas.width; const height = canvas.height;
  context.clearRect(0, 0, width, height); context.fillStyle = '#242424'; context.fillRect(0, 0, width, height);
  if (!points?.length) return;
  const xs = points.map(point => point.x); const ys = points.map(point => point.y);
  const left = Math.min(...xs); const right = Math.max(...xs); const bottom = Math.min(...ys); const top = Math.max(...ys);
  const scale = Math.min((width - 24) / Math.max(1, right - left), (height - 24) / Math.max(1, top - bottom));
  const map = point => [width / 2 + (point.x - (left + right) / 2) * scale, height / 2 - (point.y - (top + bottom) / 2) * scale];
  context.lineWidth = 2; context.strokeStyle = '#edd38c'; context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(...map(point)) : context.moveTo(...map(point))); context.stroke();
  context.fillStyle = '#76efaf'; context.beginPath(); context.arc(...map(points[Math.min(points.length - 1, Math.floor(progress * (points.length - 1)))]), 4, 0, Math.PI * 2); context.fill();
}

export class TrajectoryPanel {
  constructor(host, getContext, { invalidate, notify, activate }) {
    this.host = host; this.getContext = getContext; this.invalidate = invalidate; this.notify = notify; this.activate = activate;
    this.options = structuredClone(TRAJECTORY_DEFAULTS); this.segments = 128;
    this.splitSettings = trajectorySplitSettings();
    this.startTime = [1, 0, 1]; this.endTime = [5, 0, 1]; this.enabled = true; this.animate = true;
    this.overlay = document.createElement('canvas'); this.overlay.className = 'trajectory-overlay'; this.overlay.hidden = true;
    document.querySelector('.stage').append(this.overlay);
    this.custom = [];
    try { this.custom = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]').map(validateCurvePreset); } catch { this.custom = []; }
  }

  open(event = null, lineIndex, layerIndex) {
    const { session, timeline } = this.getContext();
    this.active = true; this.editing = event; this.presetDraft = null;
    this.lineIndex = lineIndex ?? session.lineIndex; this.layerIndex = layerIndex ?? Math.min(3, timeline.layer);
    if (event) { this.options = structuredClone(event.trajectory.options); this.startTime = [...event.startTime]; this.endTime = [...event.endTime]; this.segments = event.trajectory.segments ?? 128; this.splitSettings = trajectorySplitSettings(event.trajectory.split); }
    this.render(); this.activate('trajectory'); this.refresh();
  }

  hide() { this.active = false; this.overlay.hidden = true; this.previewChart = null; }

  render() {
    this.host.replaceChildren();
    this.content = document.createElement('div'); this.content.className = 'trajectory-scroll'; this.host.append(this.content);
    this.fields = document.createElement('div'); this.fields.className = 'trajectory-fields';
    field(this.fields, 'lineIndex', '目标线号', this.lineIndex, 'number', 0, this.getContext().session.chart.judgeLineList.length - 1, 1);
    field(this.fields, 'layerIndex', '基础层', this.layerIndex, 'number', 0, 3, 1);
    field(this.fields, 'startTime', '开始拍', formatBeat(this.startTime));
    field(this.fields, 'endTime', '结束拍', formatBeat(this.endTime));
    field(this.fields, 'mode', '方程类型', this.options.mode, 'text', undefined, undefined, undefined, [['parametric', '参数方程 x(t), y(t)'], ['polar', '极坐标 r(θ)']]);
    for (const [key, title] of [['xExpression', 'x(t)'], ['yExpression', 'y(t)'], ['parameterStart', '参数 t 起点'], ['parameterEnd', '参数 t 终点'], ['radiusExpression', 'r(θ)'], ['angleStart', 'θ 起点（弧度）'], ['angleEnd', 'θ 终点（弧度）'], ['rotationExpression', '判定线角度（可空）']]) field(this.fields, key, title, this.options[key]);
    field(this.fields, 'tangentRotation', '自动计算切线角度（顺时针为正）', this.options.tangentRotation, 'checkbox');
    for (const [key, title] of [['easingX', 'X / θ 参数缓动'], ['easingY', 'Y 参数缓动']]) field(this.fields, key, title, this.options[key], 'number', 1, 29, 1);
    for (const [key, title, type, minimum, maximum, step] of COMMON_FIELDS) field(this.fields, key, title, this.options[key], type, minimum, maximum, step);
    const parameters = field(this.fields, 'parametersJson', '表达式参数（JSON）', JSON.stringify(this.options.parameters ?? {})); parameters.title = '例如 {"radius":200}，表达式可直接使用 radius';
    field(this.fields, 'segments', '拆分 / 兼容导出段数', this.segments, 'number', 4, 8192, 1);
    field(this.fields, 'simplify', '拆分时以较少缓动事件近似', this.splitSettings.simplify, 'checkbox');
    field(this.fields, 'tolerance', '拆分容忍度（坐标 / 度）', this.splitSettings.tolerance, 'number', 0.001, 10000, 0.1);
    field(this.fields, 'replace', '替换区间内已有事件', this.replace, 'checkbox');
    this.content.append(this.fields);
    this.fields.oninput = () => {
      try {
        const values = readFields(this.fields, this.options);
        this.lineIndex = Number(values.lineIndex); this.layerIndex = Number(values.layerIndex);
        this.startTime = parseBeat(values.startTime); this.endTime = parseBeat(values.endTime);
        this.segments = values.segments; this.replace = values.replace;
        this.splitSettings = trajectorySplitSettings({ simplify: values.simplify, tolerance: values.tolerance });
        this.options = { ...values, parameters: JSON.parse(values.parametersJson) };
        for (const key of ['startTime', 'endTime', 'lineIndex', 'layerIndex', 'segments', 'replace', 'parametersJson', 'simplify', 'tolerance']) delete this.options[key];
        this.presetDraft = null; this.refresh();
      } catch (error) { this.error(error); }
    };
    const syntax = document.createElement('details'); syntax.className = 'trajectory-syntax';
    const summary = document.createElement('summary'); summary.textContent = '语法与坐标说明';
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = '这里生成判定线的 X、Y 位移和可选旋转事件，不生成音符。t 在指定参数区间变化；θ / theta 使用弧度，pi / π 为圆周率；兼容原版 $t$、Pi。u 为轨迹进度 0–1。支持 + - * / ^、比较、条件 ? :，以及 sin cos tan sqrt abs min max floor round lerp clamp ease。坐标采用原 RPE 的中心原点、X 向右、Y 向上（1350×900），角度事件以度为单位。截取后仍覆盖完整起止拍；整体旋转不改变判定线自身角度。随机曲线同一种子始终一致。轨迹在 X 轨道显示为一个整体，拖动和拉伸同时作用于 X、Y 和角度；需要普通事件时再拆分。';
    hint.textContent += ' 自动切线角度在变换后的曲线上数值求导，采用 RPE 顺时针为正的角度并连续展开跨周角度；勾选后保留但暂不使用手填角度。拆分近似的容忍度相对于等分碎事件，限制每轴坐标或角度的最大偏差。';
    syntax.append(summary, hint); this.content.append(syntax);
    this.controls = document.createElement('div');
    field(this.controls, 'enabled', '在左侧预览轨迹', this.enabled, 'checkbox');
    field(this.controls, 'animate', '暂停时循环演示', this.animate, 'checkbox');
    this.controls.oninput = () => { Object.assign(this, readFields(this.controls, {})); this.invalidate(); };
    this.content.append(this.controls);
    this.canvas = document.createElement('canvas'); this.canvas.width = 500; this.canvas.height = 240; this.canvas.className = 'trajectory-preview'; this.canvas.setAttribute('aria-label', '轨迹动态预览'); this.content.append(this.canvas);
    this.message = document.createElement('p'); this.message.className = 'hint'; this.message.setAttribute('role', 'status'); this.content.append(this.message);
    const actions = document.createElement('div'); actions.className = 'trajectory-footer';
    this.applyButton = action(this.editing ? '应用轨迹修改' : '生成整体轨迹事件', () => this.apply());
    this.splitButton = action('拆分为普通事件', () => this.split()); this.splitButton.hidden = !this.editing;
    this.applyButton.className = 'primary';
    actions.append(this.splitButton, action('返回谱面工具', () => this.activate('chart')), this.applyButton); this.host.append(actions);
    this.gallery = document.createElement('div'); this.gallery.className = 'trajectory-gallery'; this.content.append(this.gallery); this.renderPresets();
    this.renderCustom();
  }

  renderPresets() {
    this.gallery.replaceChildren();
    for (const category of ['基本图形', '进阶图形', '其他', '自定义']) {
      const group = document.createElement('details'); const title = document.createElement('summary'); title.textContent = category; group.append(title);
      const grid = document.createElement('div'); grid.className = 'trajectory-preset-grid'; group.append(grid);
      for (const preset of [...CURVE_PRESETS, ...this.custom].filter(entry => entry.category === category)) {
        const card = action(preset.name, () => this.expandPreset(preset, card, grid)); card.setAttribute('aria-expanded', 'false');
        const canvas = document.createElement('canvas'); canvas.width = 150; canvas.height = 90; canvas.setAttribute('aria-hidden', 'true');
        try { drawPath(canvas, sampleCurveTrajectory(presetOptions(preset), 129)); } catch {}
        card.prepend(canvas); grid.append(card);
      }
      this.gallery.append(group);
    }
  }

  expandPreset(preset, card, grid) {
    const closing = card.getAttribute('aria-expanded') === 'true';
    this.gallery.querySelectorAll('.trajectory-preset-editor').forEach(element => element.remove());
    this.gallery.querySelectorAll('[aria-expanded]').forEach(element => element.setAttribute('aria-expanded', 'false'));
    this.presetDraft = null;
    if (closing) { this.refresh(); return; }
    card.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div'); panel.className = 'trajectory-preset-editor';
    grid.insertBefore(panel, card.nextSibling);
    const title = document.createElement('strong'); title.textContent = preset.name + ' · 调整后填入'; panel.append(title);
    const base = presetOptions(preset);
    const parameters = document.createElement('div'); panel.append(parameters);
    for (const entry of preset.parameters) field(parameters, entry.key, entry.label ?? entry.key, entry.value, 'number', entry.min, entry.max, entry.step ?? 1);
    const common = document.createElement('div'); panel.append(common);
    for (const [key, label, type, minimum, maximum, step] of COMMON_FIELDS) field(common, key, label, base[key], type, minimum, maximum, step);
    const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 220; canvas.className = 'trajectory-preview'; panel.append(canvas);
    const error = document.createElement('p'); error.className = 'hint'; panel.append(error);
    const update = () => {
      try {
        const options = { ...base, ...readFields(common, {}), parameters: readFields(parameters, {}) };
        const points = sampleCurveTrajectory(options, 257);
        this.presetDraft = { options, points, canvas, preset }; error.textContent = '当前仅预览预设草稿；正式填入后才更改上方参数。'; this.refresh();
      } catch (problem) { error.textContent = problem.message; this.presetDraft = null; this.error(problem); }
    };
    panel.oninput = update;
    panel.append(action('正式填入轨迹参数', () => {
      if (!this.presetDraft) return;
      this.options = structuredClone(this.presetDraft.options);
      for (const input of this.fields.querySelectorAll('[data-key]')) {
        const key = input.dataset.key;
        if (key === 'parametersJson') input.value = JSON.stringify(this.options.parameters);
        else if (Object.hasOwn(this.options, key)) { if (input.type === 'checkbox') input.checked = this.options[key]; else input.value = this.options[key]; }
      }
      this.presetDraft = null; this.refresh(); error.textContent = '已填入上方轨迹参数，可生成或继续调整。';
    }));
    update();
  }

  renderCustom() {
    const group = document.createElement('details'); const title = document.createElement('summary'); title.textContent = '编写 / 保存 / 导入自定义预设'; group.append(title);
    const name = field(group, 'name', '预设名称', '我的轨迹');
    const source = document.createElement('textarea'); source.className = 'trajectory-preset-source'; source.setAttribute('aria-label', '自定义预设 JSON');
    source.value = JSON.stringify({ name: '我的轨迹', mode: 'parametric', xExpression: 'radius*cos(2*pi*t)', yExpression: 'radius*sin(2*pi*t)', parameters: [{ key: 'radius', label: '半径', value: 200, min: 1, max: 2000, step: 1 }] }, null, 2); group.append(source);
    const help = document.createElement('p'); help.className = 'hint'; help.textContent = 'parameters 声明每个预设的独立控件：key、label、value 和可选 min/max/step。表达式只允许数学计算，不执行 JavaScript。预设仅保存在本机；导出单个 JSON 可分享。'; group.append(help);
    const save = preset => { const valid = validateCurvePreset(preset); const custom = [...this.custom.filter(entry => entry.name !== valid.name), valid]; localStorage.setItem(STORAGE_KEY, JSON.stringify(custom)); this.custom = custom; this.renderPresets(); this.notify('自定义轨迹预设已保存', 'success'); };
    const guarded = callback => () => { try { callback(); } catch (error) { this.error(error); } };
    group.append(action('保存上方参数为预设', guarded(() => save({ ...this.options, name: name.value, parameters: Object.entries(this.options.parameters ?? {}).map(([key, value]) => ({ key, label: key, value })) }))),
      action('保存编写的预设', guarded(() => save(JSON.parse(source.value)))),
      action('导出当前预设', guarded(() => { const preset = validateCurvePreset({ ...this.options, name: name.value, parameters: Object.entries(this.options.parameters ?? {}).map(([key, value]) => ({ key, label: key, value })) }); download(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }), preset.name + '.trajectory.json'); })));
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.json'; file.hidden = true;
    file.onchange = async () => { try { const selected = file.files[0]; if (!selected) return; if (selected.size > 65536) throw new Error('预设文件不能超过 64 KiB'); save(JSON.parse(await selected.text())); } catch (error) { this.error(error); } finally { file.value = ''; } };
    group.append(action('导入单个预设', () => file.click()), file); this.content.append(group);
  }

  error(error) { this.message.textContent = error.message; this.message.classList.add('error'); this.previewChart = null; this.points = null; this.worldPoints = null; this.applyButton.disabled = true; this.invalidate(); }

  refresh() {
    if (!this.active) return;
    try {
      const { session } = this.getContext();
      this.baseChart = session.chart;
      const options = this.presetDraft?.options ?? this.options;
      this.event = createTrajectoryEvent(options, this.startTime, this.endTime, this.segments, this.splitSettings);
      this.points = sampleCurveTrajectory(options, 257);
      this.previewChart = trajectoryChart(session.chart, this.lineIndex, this.layerIndex, this.event, this.editing, true);
      this.scene = new SceneRuntime(); this.scene.compile(this.previewChart, this.getContext().tempo);
      const { tempo } = this.getContext(); const factor = session.chart.judgeLineList[this.lineIndex].bpmfactor ?? 1;
      this.beginSeconds = tempo.seconds(this.startTime, factor); this.endSeconds = tempo.seconds(this.endTime, factor);
      this.worldPoints = this.points.map((point, index) => this.scene.sample(this.beginSeconds + (this.endSeconds - this.beginSeconds) * index / (this.points.length - 1))[this.lineIndex]);
      this.message.textContent = this.presetDraft ? '预设草稿预览中；生成前请先正式填入参数。' : 'X 轨道保存一个整体轨迹事件，包含 Y 和可选角度；拖动端点可整体改变时长。';
      this.message.classList.remove('error'); this.applyButton.disabled = Boolean(this.presetDraft);
      for (const key of ['xExpression', 'yExpression', 'parameterStart', 'parameterEnd']) this.fields.querySelector('[data-key="' + key + '"]').closest('label').hidden = this.options.mode === 'polar' || Boolean(this.options.shape);
      for (const key of ['radiusExpression', 'angleStart', 'angleEnd']) this.fields.querySelector('[data-key="' + key + '"]').closest('label').hidden = this.options.mode !== 'polar';
      this.fields.querySelector('[data-key="rotationExpression"]').disabled = Boolean(this.options.tangentRotation);
      this.fields.querySelector('[data-key="tolerance"]').disabled = !this.splitSettings.simplify;
      this.invalidate();
    } catch (error) { this.error(error); }
  }

  apply() {
    try {
      const { session } = this.getContext();
      if (this.presetDraft) throw new Error('请先正式填入预设参数');
      const event = createTrajectoryEvent(this.options, this.startTime, this.endTime, this.segments, this.splitSettings);
      const chart = trajectoryChart(session.chart, this.lineIndex, this.layerIndex, event, this.editing, this.replace);
      this.editing = event;
      session.focus = 'events'; session.eventLayer = this.layerIndex;
      session.selection.clear(); session.eventSelection = new Set();
      session.commit('生成 / 更新曲线轨迹', chart);
      this.splitButton.hidden = false; this.applyButton.textContent = '应用轨迹修改';
      this.refresh(); this.notify('整体曲线轨迹已应用', 'success');
    } catch (error) { this.error(error); }
  }

  split() {
    try {
      const { session } = this.getContext();
      const chart = splitTrajectoryChart(session.chart, this.lineIndex, this.layerIndex, this.editing, { ...this.splitSettings, segments: this.segments });
      this.editing = null; session.eventSelection.clear(); session.multiEventSelection.clear(); session.commit('拆分曲线轨迹', chart);
      this.activate('chart'); this.notify('已拆分为普通 X、Y / 旋转事件，可一次撤销', 'success');
    } catch (error) { this.error(error); }
  }

  tick(timestamp, seconds, playing, renderer) {
    if (!this.active) return null;
    if (this.baseChart !== this.getContext().session.chart) {
      if (this.editing) {
        const selected = this.getContext().session.chart.judgeLineList.flatMap(line => (line.eventLayers ?? []).flatMap(layer => layer?.moveXEvents ?? [])).find(event => event.trajectory === this.editing.trajectory);
        if (selected) { this.editing = selected; this.startTime = selected.startTime; this.endTime = selected.endTime; for (const key of ['startTime', 'endTime']) this.fields.querySelector('[data-key="' + key + '"]').value = formatBeat(this[key]); }
        else { this.editing = null; this.splitButton.hidden = true; this.applyButton.textContent = '生成整体轨迹事件'; }
      }
      this.refresh();
    }
    const progress = playing || !this.animate ? Math.max(0, Math.min(1, (seconds - this.beginSeconds) / (this.endSeconds - this.beginSeconds))) : timestamp / 2500 % 1;
    drawPath(this.canvas, this.points, progress);
    if (this.presetDraft) drawPath(this.presetDraft.canvas, this.presetDraft.points, progress);
    this.overlay.hidden = !this.enabled || !this.worldPoints || this.getContext().previewVisible;
    if (!this.overlay.hidden) {
      const { context, width, height } = prepareCanvas(this.overlay);
      const viewport = previewViewport(width, height, renderer.aspectRatio ?? 1.5); const scale = viewport.scale / (renderer.viewDivisor ?? 1);
      context.save(); context.beginPath(); context.rect(viewport.left, viewport.top, viewport.width, viewport.height); context.clip();
      context.strokeStyle = '#62e6ba'; context.lineWidth = 2; context.globalAlpha = 0.8; context.beginPath();
      const screen = point => [width / 2 + point.x * scale, height / 2 - point.y * scale];
      this.worldPoints.forEach((point, index) => index ? context.lineTo(...screen(point)) : context.moveTo(...screen(point))); context.stroke();
      const marker = this.worldPoints[Math.min(this.worldPoints.length - 1, Math.floor(progress * (this.worldPoints.length - 1)))];
      context.fillStyle = '#9cffcc'; context.beginPath(); context.arc(...screen(marker), 6, 0, Math.PI * 2); context.fill();
      context.font = '13px RPE, sans-serif'; context.fillText('轨迹预览 · L' + this.lineIndex, 18 + viewport.left, 24 + viewport.top); context.restore();
    }
    return this.enabled && this.previewChart ? { chart: this.previewChart, seconds: playing || !this.animate ? seconds : this.beginSeconds + (this.endSeconds - this.beginSeconds) * progress } : null;
  }
}
