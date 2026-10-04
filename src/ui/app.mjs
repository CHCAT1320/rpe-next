import { EditorSession } from '../application/session.mjs';
import { assertChart, createChart, diagnose, EVENT_TYPES, previewLimitations } from '../core/chart.mjs';
import { beatValue, parseBeat, formatBeat, fromNumber, upperBound } from '../core/beat.mjs';
import { TempoMap } from '../core/tempo.mjs';
import { AudioTransport } from '../platform/audio.mjs';
import { openFiles, exportChart, exportPackage, assetBytes, resourceReferences, attachExternalEffects } from '../platform/files.mjs';
import { listDrafts, readDraft, saveSnapshot } from '../platform/recovery.mjs';
import { Timeline, prepareCanvas } from './timeline.mjs';
import { Preview } from './preview.mjs';
import { renderProperties } from './inspector.mjs';
import { showDialog, editJson, choose, confirmAction, dialogOpen } from './dialog.mjs';
import { migratePreferences, shortcutAction, shortcutReleased } from '../core/preferences.mjs';
import { directoryEntries, uploadedEntries, scanMigration } from '../platform/migration.mjs';
import { readProject, readPreferences, storePreferences, storeProject } from '../platform/library.mjs';
import { migrationDialog } from './migration-dialog.mjs';
import { manageLines } from './line-dialog.mjs';
import { HELP_TEXT } from './help.mjs';
import { download } from '../platform/files.mjs';
import { RpeSkin } from './skin.mjs';
import { ProjectImages } from '../platform/images.mjs';
import { HitSounds } from '../platform/hitsounds.mjs';
import { renderEventInspector } from './event-inspector.mjs';
import { eventKey, eventList, commitEventLists, deleteEvents, copyEvents, pasteEvents, transformEvents } from '../application/event-commands.mjs';
import { shaderEvents, replaceShaderEvents } from '../core/shader-events.mjs';
import { renderMetadataPanel, renderBpmPanel } from './forms.mjs';
import { EditorPlayback } from '../application/playback.mjs';
import { readEditorPreferences, writeEditorPreferences } from '../platform/editor-preferences.mjs';
import { ProjectHome } from './home.mjs';
import { createSettingsPanel } from './settings.mjs';
import { AutoSaveClock } from '../application/autosave.mjs';
import { SPECIAL_TRACKS, MAX_BASE_LAYERS } from '../core/editor-display.mjs';
import { UI_BINDINGS } from '../core/game-ui.mjs';
import { isPlaybackSpace } from './keyboard.mjs';
import { setRatioOptions, applyViewControls } from './view-controls.mjs';
import { generateCurveNotes } from '../core/curve-notes.mjs';
import { createEasingPicker } from './easing-picker.mjs';
import { numericWheel } from './numeric-wheel.mjs';
import { SceneRuntime } from '../core/scene.mjs';
import { assetUrl } from '../core/asset-url.mjs';

const element = selector => document.querySelector(selector);
const displayFields = [
  ['bar-width', 'barWidth', 3], ['bar-alpha', 'barAlpha', 1], ['event-value-size', 'eventValueSize', 13], ['event-opacity', 'eventOpacity', 0.25], ['event-bar-width', 'eventBarWidth', 0.82], ['seamless-events', 'seamlessEvents', true],
  ['background-blur', 'backgroundBlur', 10.5], ['scroll-speed', 'scrollSpeed', 5], ['tips-enabled', 'tipsEnabled', true], ['success-notifications', 'successNotifications', true],
  ['line-numbers', 'lineNumbers', true], ['line-arrows', 'lineArrows', true], ['line-tint', 'lineTint', true], ['merge-line-numbers', 'mergeLineNumbers', true], ['pick-preview-lines', 'pickPreviewLines', true],
  ['preserve-pitch', 'preservePitch', true], ['autoplay-view', 'autoplayView', true], ['highlight-notes', 'highlight', true],
  ['autosave-enabled', 'autoSave', true], ['autosave-seconds', 'autoSaveSeconds', 60], ['autosave-limit', 'autoSaveLimit', 10],
];
const settingsDialog = createSettingsPanel();
let session = new EditorSession();
let assets = new Map();
let chartName = 'chart.json';
let recoveryId = crypto.randomUUID();
let tempo = new TempoMap(session.chart.BPMList);
let tempoEntries = session.chart.BPMList;
let dirtyFrame = true;
let lastDraftDocument;
let preferences = migratePreferences();
let libraryProject = null;
let saving = false;
let editorPreferences = readEditorPreferences();
let atHome = true;
let hasDocument = false;
let previewReturnTime = 0;
let placementContext;
let heldPreview;
let curveStart;
let curveEnd;
let curveAnchorMode = null;
let curveEditorOpen = false;
let curveEasingPicker;
let curveValues = { startTime: [0, 0, 1], endTime: [4, 0, 1], startX: -405, endX: 405, density: 1, type: 4, easingType: 1 };
let loop = null;
let activePaneName = 'chart';
let lastSelectionSignature = '';
let editTimeSeconds = 0;
let editClockTick = performance.now();
let lastDiagnosticSignature = null;
const audio = new AudioTransport();
const hitSounds = new HitSounds(audio);
const preview = new Preview(element('#preview'));
const realtimePreview = new Preview(element('#realtime-preview'));
const lineInfoScene = new SceneRuntime();
const invalidate = () => { dirtyFrame = true; };
preview.invalidate = realtimePreview.invalidate = invalidate;
realtimePreview.applyShaders = false;
realtimePreview.showHitEffects = false;
const skin = new RpeSkin(invalidate);
const images = new ProjectImages(invalidate, message => status(message));
const timeline = new Timeline(element('#notes'), element('#events'), () => session, editEvent, invalidate, error => reportError(error));
function drawTimelineStrips() {
  const height = timeline.notesCanvas.clientHeight; if (!height) return;
  const noteFrame = prepareCanvas(element('#note-density')); const historyFrame = prepareCanvas(element('#history-strip'));
  const times = []; const secondsFor = (beat, factor = 1) => tempo.seconds(beat, factor);
  for (const line of session.line ? [session.line] : []) {
    const factor = line.bpmfactor ?? 1;
    for (const note of line.notes ?? []) times.push(secondsFor(note.startTime, factor));
    for (const layer of [...(line.eventLayers ?? []), line.extended ?? {}]) for (const [type, events] of Object.entries(layer ?? {})) if (type !== 'paintEvents' && Array.isArray(events)) for (const event of events) times.push(secondsFor(event.startTime, factor));
    for (const event of shaderEvents(session.chart, session.lineIndex)) times.push(secondsFor(event.startTime, factor));
  }
  const duration = Math.max(0.001, audio.duration > 0 ? audio.duration : (times.length ? Math.max(...times) : 1));
  const bins = Math.max(96, Math.min(900, Math.max(Math.round(height), Math.ceil(duration * 8)))); const noteBins = new Array(bins).fill(0); const eventBins = new Array(bins).fill(0);
  const add = (target, seconds) => target[Math.max(0, Math.min(bins - 1, Math.floor(seconds / duration * bins)))]++;
  for (const line of session.line ? [session.line] : []) {
    const factor = line.bpmfactor ?? 1;
    for (const note of line.notes ?? []) add(noteBins, secondsFor(note.startTime, factor));
    const layer = timeline.extended ? (line === session.line ? line.extended : null) : line.eventLayers?.[timeline.layer];
    for (const [type, events] of Object.entries(layer ?? {})) if (type !== 'paintEvents' && Array.isArray(events)) for (const event of events) add(eventBins, secondsFor(event.startTime, factor));
    if (timeline.extended) for (const event of shaderEvents(session.chart, session.lineIndex)) add(eventBins, secondsFor(event.startTime, factor));
  }
  const maximum = Math.max(1, ...noteBins, ...eventBins);
  const historyEntries = session.recentEdits ?? [];
  for (let index = 0; index < bins; index++) {
    const y = height - (index + 1) * height / bins; const barHeight = Math.max(1, height / bins - 1); const half = Math.max(1, noteFrame.width / 2 - 2);
    const noteValue = noteBins[index] ? Math.log1p(noteBins[index]) / Math.log1p(maximum) : 0;
    const eventValue = eventBins[index] ? Math.log1p(eventBins[index]) / Math.log1p(maximum) : 0;
    if (noteValue) { noteFrame.context.fillStyle = '#56b9d4'; noteFrame.context.globalAlpha = noteValue; noteFrame.context.fillRect(2, y, half, barHeight); }
    if (eventValue) { noteFrame.context.fillStyle = '#d39b55'; noteFrame.context.globalAlpha = eventValue; noteFrame.context.fillRect(noteFrame.width - half - 2, y, half, barHeight); }
  }
  historyEntries.forEach((command, index) => {
    const start = Math.max(0, Math.min(duration, command.start)); const end = Math.max(start, Math.min(duration, command.end)); const y1 = height - end / duration * height; const y2 = height - start / duration * height;
    const alpha = Math.max(0.25, (index + 1) / historyEntries.length); historyFrame.context.globalAlpha = alpha; historyFrame.context.fillStyle = '#c69b55'; historyFrame.context.fillRect(2, Math.min(y1, y2) - 1, historyFrame.width - 4, Math.max(2, Math.abs(y2 - y1) + 2));
  });
  const markerY = height - Math.max(0, Math.min(duration, chartSeconds())) / duration * height;
  for (const frame of [noteFrame, historyFrame]) { frame.context.globalAlpha = 1; frame.context.strokeStyle = '#f5e59a'; frame.context.lineWidth = 1; frame.context.beginPath(); frame.context.moveTo(0, markerY + .5); frame.context.lineTo(frame.width, markerY + .5); frame.context.stroke(); }
}
function seekFromStrip(event) {
  const rect = event.currentTarget.getBoundingClientRect(); const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  const times = []; for (const line of session.chart.judgeLineList ?? []) for (const note of line.notes ?? []) times.push(tempo.seconds(note.startTime, line.bpmfactor ?? 1));
  const duration = Math.max(0.001, audio.duration > 0 ? audio.duration : (times.length ? Math.max(...times) : 1)); playback.seek((1 - ratio) * duration + offsetSeconds());
}
element('#note-density').addEventListener('click', seekFromStrip);
element('#history-strip').addEventListener('click', seekFromStrip);
timeline.curvePick = note => {
  if (!curveAnchorMode) return false;
  const anchor = { startTime: [...note.startTime], positionX: note.positionX, type: note.type };
  if (curveAnchorMode === 'start') {
    curveStart = anchor;
    curveAnchorMode = null;
    element('#curve-start')?.classList.remove('active');
    curveValues.startTime = anchor.startTime; curveValues.startX = anchor.positionX; updateCurvePanel();
    status('曲线起点已选择；请选择终点音符');
    invalidate();
    return true;
  }
  if (!curveStart) { curveAnchorMode = null; status('请先选择曲线起点'); return true; }
  curveEnd = anchor;
  curveAnchorMode = null;
  element('#curve-end')?.classList.remove('active');
  curveValues.endTime = anchor.startTime; curveValues.endX = anchor.positionX; updateCurvePanel();
  status('曲线终点已选择，可在右侧调整参数并生成');
  return true;
};
timeline.curveGhost = () => {
  if (!curveEditorOpen || !curveStart) return [];
  const exists = anchor => session.notes.some(note => note.positionX === anchor.positionX && beatValue(note.startTime) === beatValue(anchor.startTime));
  const anchors = [{ startTime: [...curveValues.startTime], positionX: curveValues.startX, type: curveValues.type, anchor: exists(curveStart) && curveValues.startX === curveStart.positionX && beatValue(curveValues.startTime) === beatValue(curveStart.startTime) }];
  if (!curveEnd) return anchors;
  const end = { startTime: [...curveValues.endTime], positionX: curveValues.endX, type: curveValues.type, anchor: exists(curveEnd) && curveValues.endX === curveEnd.positionX && beatValue(curveValues.endTime) === beatValue(curveEnd.startTime) };
  try {
    return [...anchors, ...generateCurveNotes({ ...curveValues, division: timeline.division }), end];
  } catch { return [...anchors, end]; }
};
timeline.skin = skin; preview.skin = skin; preview.images = images;
realtimePreview.skin = skin; realtimePreview.images = images;
skin.load();
document.fonts.load('35px RPEGame').then(invalidate);
const status = message => { element('#status').textContent = message; };
const notificationTimers = new Set();
function notify(message, level = 'success', duration = 2800) {
  if (level === 'success' && editorPreferences.successNotifications === false) return;
  const host = element('#notifications'); if (!host) return;
  const item = document.createElement('div'); item.className = `editor-notification ${level}`; item.textContent = message; host.append(item);
  requestAnimationFrame(() => item.classList.add('visible'));
  const timer = setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 260); notificationTimers.delete(timer); }, duration); notificationTimers.add(timer);
}
timeline.notify = (message, level = 'warning') => notify(message, level);
const reportError = error => { status(error.message); notify(error.message, 'error', 5000); showDialog('操作未完成', error.message); };
const tips = [
  'Tips: 坐标系范围为 [-675,675]x[-450,450]', 'Tips: 速度为10表示每秒移动 1200 像素~', 'Tips: 编辑器的分辨率正比于 1920*1080', 'Tips: 很多金色的组件都是可以被点击的',
  'Tips: 谱面名可不为英文，但标识名只能是一串数字', 'Tips: 添加资源文件时闪退可能是其损坏，常见于直接改后缀名', 'Tips: CTRL+滚轮 可以快速切换线',
  'Tips: 选中事件 CTRL+滚轮 可以微调事件数值', 'Tips: 善用多音符和多事件编辑能在几步内做出大量常用效果', 'Tips: 开启实时显示预览可能会降低帧率',
  'Tips: 如果帧率过低，可以试试降低分辨率哦', 'Tips: 请务必安装 /Resources/fonts 中的字体！', 'Tips: 按住 Z键 用鼠标左右键可以拖动音符和事件的头或尾',
  'Tips: 速度事件只能线性变化', 'Tips: 按住 T 和 Y 可以分别进行两种预览', 'Tips: UIOP 键对应左上角的四个预览相关按钮',
  'Tips: 最好让右上部的两条横线时刻保持绿色（认真', 'Tips: .pez就是压缩文件', 'Tips: 右上部第一条线为红色代表很可能有严重错误，看看纠错！',
  'Tips: 按住 CTRL键 并按下数字可以跳转所在线号', 'Tips: 按住 CTRL 并点击可以进行单击多选', 'Tips: 按住 SHIFT键 点击并移动鼠标，再次点击鼠标以进行框选',
  'Tips: 按下 D键和鼠标右键 可以删除选中的内容', 'Tips: 常看谱面纠错是个好习惯', 'Tips: Error尽量改，Warning仔细看，Caution作参考',
  'Tips: 自动保存会表明每个文件保存的时间', 'Tips: 不要调戏音频库————', 'Tips: 新建的线会放入一个各类事件来垫底，不应该被删除',
  'Tips: 编辑器配置在 Settings.json 中存储', 'Tips: 编辑器热键在 Hotkey.txt 中存储', 'Tips: 编辑器UI在 UI.txt 中存储',
  'Tips: 试试在曲线填充中用 CTRL+F/G', 'Tips: 有很多东西可以在设置中调整', 'Tips: BPM 列表过长的时候可以用滚轮或方向键操作',
  'Tips: 移动和旋转事件最好不要全用线性变化', 'Tips: 慎用音符差速', 'Tips: 竖线不宜调太多或太少', 'Tips: 不确定采音的时候，试试倍速！',
  'Tips: 判定线遮罩属性指是否显示线下方的音符', 'Tips: 每条判定线可以更改贴图，需将贴图放在 /Resources下', 'Tips: 判定线 Z轴属性 用来控制线之间的遮挡关系',
  'Tips: 即使开了自动保存，多保存依然是好习惯', 'Tips: Tip大概每 10 秒切换一次', 'Tips: 事件编辑窗下方的按钮用来切换层级',
  'Tips: 实时预览帧率过低时可以降低分辨率', 'Tips: 密度条显示音符和当前事件层的分布',
  'Tips: 次透明化控制选中线以外的音符透明度，试试置为负数？', 'Tips: 选中音符按住 CTRL键 使用滚轮可以调整音符宽度', 'Tips: 线上标注的数字可以在设置中关闭',
  'Tips: 粘合会将事件的初始数值置为前一个的结束数值', 'Tips: 下方的状态栏会显示一些有用的信息', 'Tips: 不限量的判定线！',
  'Tips: 如果太多音符闪退，或许是电脑内存不够用', 'Tips: 你无法删除所有线', 'Tips: 开始框选后松开 SHIFT，就可以随意调整时刻',
  'Tips: 研究表明，对自己谱面的喜爱程度随时间而快速下降', 'Tips: 不支持脑内想法投射', 'Tips: 据说演出应该锦上添花而不是雪中送碳',
  'Tips: 集齐所有Tips召唤神龙', 'Tips: 世界是离散的', 'Tips: 怎么也飞不出，花花的世界', 'Tips: 没有 tips 就是最好的 tips',
  'Tips: 不要弄错你的目标判定线哦～', 'Tips: 长时间使用电脑要注意保持正确姿势哦', 'Tips: Re:Phiedit 被玩坏了！这绝对不是 Re:Phiedit 的错，绝对不是！'
];
let tipIndex = 0;
function rotateTip() { const target = element('#tips'); if (!target || editorPreferences.tipsEnabled === false || atHome) { if (target) target.textContent = ''; return; } target.textContent = tips[tipIndex++ % tips.length]; }
setInterval(rotateTip, 10000);
const offsetSeconds = () => Number(session.chart.META.offset ?? 0) / 1000;
const chartSeconds = () => audio.time - offsetSeconds();
const resetEditClock = chart => {
  editTimeSeconds = Number.isFinite(Number(chart?.chartTime)) ? Math.max(0, Number(chart.chartTime)) : 0;
  editClockTick = performance.now();
};
const advanceEditClock = timestamp => {
  const elapsed = Math.max(0, (timestamp - editClockTick) / 1000);
  if (hasDocument && !atHome && !document.hidden) editTimeSeconds += elapsed;
  editClockTick = timestamp;
};
const formatEditTime = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')} h, ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')} m, ${String(Math.floor(seconds) % 60).padStart(2, '0')} s`;
const currentBeat = () => tempo.beat(chartSeconds(), session.line?.bpmfactor ?? 1);
const playback = new EditorPlayback(audio, hitSounds, () => {
  timeline.origin = currentBeat();
  preview.effectsSince = realtimePreview.effectsSince = chartSeconds();
  invalidate();
});
timeline.onDragScroll = seconds => playback.seek(audio.time + seconds);
const autoSave = new AutoSaveClock(async () => {
  const current = session; const snapshot = { ...current.chart, chartTime: editTimeSeconds };
  await saveSnapshot(libraryProject?.id ?? recoveryId, chartName, snapshot, [...assets], editorPreferences.autoSaveLimit ?? preferences.settings.autoSaveLimit, { lineIndex: current.lineIndex, seconds: audio.time });
  if (current === session) { lastDraftDocument = current.chart; status('自动备份已保存（包含音乐、曲绘与编辑位置）'); notify('自动备份已保存', 'success'); }
}, error => status(`自动保存失败：${error.message}，请手动保存或导出 PEZ`));
timeline.onWheel = event => {
  if (event.ctrlKey) {
    const count = session.chart.judgeLineList?.length ?? 0;
    if (count) { timeline.cancelPlacement(); session.selectLine((session.lineIndex + Math.sign(event.deltaY) + count) % count); }
  } else playback.wheel(event, { ...preferences.settings, scrollSpeed: editorPreferences.scrollSpeed ?? preferences.settings.scrollSpeed }, performance.now() / 1000);
};
const previewWheel = event => {
  event.preventDefault();
  playback.wheel(event, { ...preferences.settings, scrollSpeed: editorPreferences.scrollSpeed ?? preferences.settings.scrollSpeed }, performance.now() / 1000);
};
element('.preview-wrap').addEventListener('wheel', previewWheel, { passive: false });
const pickPreviewLine = (renderer, event) => {
  const index = renderer.pick(event.clientX, event.clientY);
  if (index === null) return false;
  timeline.cancelPlacement(); session.selectLine(index); return true;
};
element('#preview').addEventListener('click', event => { if (preview.visible) pickPreviewLine(preview, event); });
timeline.previewPick = () => false;
const home = new ProjectHome(async id => {
  const project = await readProject(id);
  if (!project) throw new Error('此项目不存在');
  guardReplace(() => loadCandidate({ chart: project.chart, name: project.chartName, info: project.info, project }, new Map(project.assets)).catch(reportError));
}, reportError, project => {
  if (libraryProject?.id === project.id) {
    const renamed = libraryProject.chart.META.name !== project.chart.META.name;
    libraryProject = project;
    if (!session.history.dirty) {
      session.commit('更新项目信息', project.chart); session.history.markSaved(); renderSession();
    } else if (renamed) session.commit('更新项目名称', { ...session.chart, META: { ...session.chart.META, name: project.chart.META.name } });
  }
});

function setHome(visible) {
  atHome = visible;
  if (visible) { lineInfoVisible = false; element('#line-info-overlay')?.setAttribute('hidden', ''); }
  element('#document-name').textContent = visible ? '谱面库' : `${session.history.dirty ? '● ' : ''}${session.chart.META.name ?? chartName}`;
  element('#home').hidden = !visible;
  element('.workspace').hidden = visible;
  element('.transport').hidden = visible;
  element('#resume-editor').hidden = !hasDocument;
  for (const selector of ['#save', '#export-json', '#package']) element(selector).disabled = !hasDocument;
  if (visible) { playback.pause(); timeline.cancelPlacement(); home.refresh().catch(reportError); }
  invalidate();
}

function persistEditor() {
  editorPreferences = { ...editorPreferences, scale: timeline.scale, division: timeline.division, gridCount: timeline.gridCount, snapX: timeline.snapX,
    realtime: realtimePreview.visible, realtimeAlpha: Number(element('#realtime-alpha').value), volume: audio.volume, hitVolume: hitSounds.volume,
    hitEnabled: hitSounds.enabled, allLines: preview.allLines, toolbarMode: editorPreferences.toolbarMode ?? 'compact' };
  try { writeEditorPreferences(editorPreferences); } catch (error) { status(`设置保存失败：${error.message}`); }
}

function activatePane(name) {
  activePaneName = name;
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  for (const button of document.querySelectorAll('[data-pane]')) button.classList.toggle('active', button.dataset.pane === name);
}
for (const button of document.querySelectorAll('[data-pane]')) button.onclick = () => {
  const pane = button.dataset.pane;
  if (['notes', 'events'].includes(pane)) session.focus = pane;
  activatePane(pane);
};
for (const button of document.querySelectorAll('[data-return-chart]')) button.onclick = () => activatePane('chart');
for (const form of document.querySelectorAll('#properties, #event-properties')) form.addEventListener('submit', event => { event.preventDefault(); document.activeElement?.blur(); });
for (const button of document.querySelectorAll('[data-icon]')) button.style.setProperty('--icon', `url('${assetUrl(`rpe/Texture/icon/${button.dataset.icon}.png`)}')`);
function togglePreview(force, stay = false, replay = false) {
  const visible = force ?? !preview.visible;
  if (visible && (!preview.visible || replay)) {
    previewReturnTime = audio.time; timeline.cancelPlacement();
    if (replay) playback.seek(0);
    if ((editorPreferences.autoplayView ?? preferences.settings.autoplayView) && !audio.playing && !playback.pending) togglePlayback().catch(reportError);
  }
  if (!visible && preview.visible) playback.seek(stay ? audio.time : previewReturnTime);
  preview.visible = visible;
  element('.preview-wrap').hidden = !preview.visible;
  element('#view-toggle').classList.toggle('active', preview.visible);
  element('#preview-title').textContent = session.chart.META.name ?? '';
  timeline.origin = currentBeat();
  invalidate();
}

function listen(selector, callback) {
  element(selector).addEventListener('click', async () => {
    try { await callback(); } catch (error) { reportError(error); }
  });
}

let lineInfoVisible = false;
const lineInfoNumber = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '0.00';
function selectedEventSpeed(type, event) {
  if (!event) return null;
  const duration = tempo.seconds(event.endTime, session.line?.bpmfactor ?? 1) - tempo.seconds(event.startTime, session.line?.bpmfactor ?? 1);
  if (!Number.isFinite(duration) || Math.abs(duration) < 0.000001 || !Number.isFinite(event.start) || !Number.isFinite(event.end)) return null;
  const rate = (event.end - event.start) / duration;
  if (type === 'moveXEvents') return `X ${lineInfoNumber(rate / 120)}`;
  if (type === 'moveYEvents') return `Y ${lineInfoNumber(rate / 120)}`;
  if (type === 'rotateEvents') return `R ${lineInfoNumber(rate)}`;
  if (type === 'speedEvents') return `Speed ${lineInfoNumber(rate / 120)}`;
  return null;
}
function updateLineInfo() {
  const overlay = element('#line-info-overlay');
  if (!overlay) return;
  if (!lineInfoVisible || !session.line || atHome) { overlay.hidden = true; return; }
  lineInfoScene.compile(session.chart, tempo);
  const seconds = chartSeconds();
  const states = lineInfoScene.sample(seconds);
  const state = states[session.lineIndex] ?? { x: 0, y: 0, rotation: 0, alpha: 255 };
  const runtime = lineInfoScene.lines[session.lineIndex];
  const scrollSpeed = runtime?.speeds?.reduce((sum, track) => sum + (track.value(seconds) || 0), 0) ?? 0;
  const line = session.line;
  const lineText = `Pos: (${lineInfoNumber(state.x)},${lineInfoNumber(state.y)})  Dir: ${lineInfoNumber(state.rotation)}  Alpha: ${lineInfoNumber(state.alpha, 0)}  Speed: ${lineInfoNumber(scrollSpeed)}`;
  const dt = 1 / 120;
  const before = lineInfoScene.sample(seconds - dt)[session.lineIndex] ?? state;
  const after = lineInfoScene.sample(seconds + dt)[session.lineIndex] ?? state;
  const xSpeed = (after.x - before.x) / (2 * dt) / 120;
  const ySpeed = (after.y - before.y) / (2 * dt) / 120;
  const rotateSpeed = (after.rotation - before.rotation) / (2 * dt);
  const activeSpeeds = [];
  for (const [type, label] of [['moveXEvents', 'X'], ['moveYEvents', 'Y'], ['rotateEvents', 'R'], ['speedEvents', 'Speed']]) {
    for (const track of runtime?.tracks?.[type] ?? []) {
      for (const entry of track.events ?? []) {
        if (seconds < entry.start || seconds > entry.end) continue;
        const rate = selectedEventSpeed(type, entry.event);
        if (rate) activeSpeeds.push(rate);
        else if (type === 'speedEvents') activeSpeeds.push(`${label} ${lineInfoNumber(track.value(seconds))}`);
      }
    }
  }
  const selectedSpeeds = [];
  for (const key of session.eventSelection ?? []) {
    const separator = key.lastIndexOf(':');
    const type = separator < 0 ? key : key.slice(0, separator);
    const index = Number(key.slice(separator + 1));
    const event = eventList(session, type)[index];
    const speed = selectedEventSpeed(type, event);
    if (speed) selectedSpeeds.push(speed);
  }
  const eventSpeed = selectedSpeeds.length ? selectedSpeeds : activeSpeeds;
  const eventText = `X Y R Speed: ${lineInfoNumber(xSpeed)}, ${lineInfoNumber(ySpeed)}, ${lineInfoNumber(rotateSpeed)}${eventSpeed.length ? `\nEvent Speed: ${eventSpeed.slice(0, 6).join(', ')}` : ''}`;
  overlay.textContent = `${lineText}\n${eventText}`;
  overlay.hidden = false;
}

function renderSession() {
  const context = `${session.lineIndex}:${timeline.layer}`;
  if (placementContext !== context) { timeline.cancelPlacement(); placementContext = context; }
  if (tempoEntries !== session.chart.BPMList) { tempoEntries = session.chart.BPMList; tempo = new TempoMap(tempoEntries); }
  timeline.tempo = tempo;
  session.tempo = tempo; session.division = timeline.division;
  updateLineInfo();
  session.eventWheelSteps = Object.fromEntries(['moveXEvents', 'moveYEvents', 'rotateEvents', 'alphaEvents', 'speedEvents', 'scaleXEvents', 'scaleYEvents'].flatMap((key, index) => Number.isFinite(preferences.originalSettings.scrollValueIncrement?.[index]) ? [[key, preferences.originalSettings.scrollValueIncrement[index]]] : []));
  timeline.origin = currentBeat();
  element('#document-name').textContent = atHome ? '谱面库' : `${session.history.dirty ? '● ' : ''}${session.chart.META.name ?? chartName}`;
  element('#note-count').textContent = `${session.notes.length} notes`;
  const countEvents = line => [...(line.eventLayers ?? []), line.extended ?? {}].reduce((total, layer) => total + Object.entries(layer ?? {}).filter(([type, events]) => type !== 'paintEvents' && Array.isArray(events)).reduce((count, [, events]) => count + events.length, 0), 0) + shaderEvents(session.chart, session.chart.judgeLineList?.indexOf(line) ?? -1).length;
  const totalLines = session.chart.judgeLineList?.length ?? 0;
  const totalNotes = (session.chart.judgeLineList ?? []).reduce((count, line) => count + (line.notes?.length ?? 0), 0);
  const totalEvents = (session.chart.judgeLineList ?? []).reduce((count, line) => count + countEvents(line), 0);
  const chartInfo = [['谱面统计', `Notes: ${session.notes.length}  Events: ${countEvents(session.line ?? {})}  TotalLines: ${totalLines}  TotalNotes: ${totalNotes}  TotalEvents: ${totalEvents}  Time: ${formatEditTime(editTimeSeconds)}`]];
  element('#chart-info').replaceChildren(...chartInfo.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    return [term, description];
  }));
  if (!session.liveBeatEdit) element('#offset').value = session.chart.META.offset ?? 0;
  element('#selection-info').textContent = session.focus === 'events' ? `${session.eventSelection.size} 个事件已选` : `${session.selection.size} 个音符已选`;
  element('#undo').disabled = !session.history.undoStack.length;
  element('#redo').disabled = !session.history.redoStack.length;
  const lineList = element('#line-list');
  const scrollPosition = lineList.scrollTop;
  lineList.replaceChildren();
  element('#line-select').replaceChildren();
  (session.chart.judgeLineList ?? []).forEach((line, index) => {
    const button = document.createElement('button');
    button.textContent = `${String(index).padStart(2, '0')}  ${line.Name || '未命名'}`;
    button.classList.toggle('active', index === session.lineIndex);
    button.onclick = () => { session.selectLine(index); };
    lineList.append(button);
    const option = document.createElement('option'); option.value = index; option.textContent = `${index} · ${line.Name || '未命名'}`; element('#line-select').append(option);
  });
  element('#line-select').value = session.lineIndex;
  const binding = session.line?.attachUI ?? '';
  element('#attach-ui').replaceChildren(new Option('不绑定', ''), ...UI_BINDINGS.map(([key, label]) => new Option(label, key)));
  if (binding && !UI_BINDINGS.some(([key]) => key === binding)) element('#attach-ui').append(new Option(`保留未知绑定：${binding}`, binding));
  element('#attach-ui').value = binding;
  lineList.scrollTop = scrollPosition;
  updateLayerButtons();
  const liveIssues = diagnose(session.chart);
  const liveSignature = liveIssues.map(issue => `${issue.severity}:${issue.path}:${issue.message}`).sort().join('|');
  if (lastDiagnosticSignature !== null && liveSignature !== lastDiagnosticSignature && activePaneName !== 'diagnose') {
    const previous = new Set(lastDiagnosticSignature.split('|').filter(Boolean));
    const addedErrors = liveIssues.filter(issue => issue.severity === 'error' && !previous.has(`${issue.severity}:${issue.path}:${issue.message}`));
    if (addedErrors.length) notify(`谱面检查新增 ${addedErrors.length} 个错误`, 'error', 4200);
  }
  lastDiagnosticSignature = liveSignature;
  if (activePaneName === 'diagnose') renderDiagnostics();
  if (activePaneName === 'history') renderHistoryPanel();
  if (activePaneName === 'metadata') renderMetadataPanel(session, element('#metadata-editor'), () => { activatePane('chart'); renderSession(); });
  if (activePaneName === 'bpm') renderBpmPanel(session, element('#bpm-editor'), () => { activatePane('chart'); renderSession(); });
  session.eventLayer = timeline.layer;
  renderProperties(session, reportError);
  if (!session.liveEventEdit) renderEventInspector(session, tempo, currentBeat, reportError);
  decorateBeatInputs();
  if (session.eventSelection.size) {
    timeline.eventPlacementType = session.eventSelection.values().next().value.split(':')[0];
  }
  const selectionSignature = `${session.focus}|${[...session.selection].sort((left, right) => left - right).join(',')}|${[...session.eventSelection].sort().join(',')}`;
  if (selectionSignature !== lastSelectionSignature) {
    lastSelectionSignature = selectionSignature;
    const selectionCount = session.focus === 'events' ? session.eventSelection.size : session.selection.size;
    if (curveEditorOpen) activatePane('curve');
    else if (selectionCount === 1) activatePane(session.focus === 'events' ? 'events' : 'notes');
    else activatePane('chart');
  }
  const limits = previewLimitations(session.chart);
  element('#compatibility').textContent = '已使用原 RPE 音符素材与打击音；支持封面、静态纹理、多线与控制曲线。尚需原版逐帧对照。' + (limits.length ? `需进一步验证：${limits.join('、')}。` : '');
  invalidate();
}

session.addEventListener('change', renderSession);

function replaceChart(chart, name, nextAssets = new Map()) {
  assertChart(chart);
  playback.pause(); audio.clear();
  hitSounds.stop(); images.clear(); libraryProject = null;
  session.removeEventListener('change', renderSession);
  session = new EditorSession(chart);
  lastSelectionSignature = '';
  activatePane('chart');
  session.history.limit = preferences.settings.historyLimit;
  session.addEventListener('change', renderSession);
  recoveryId = crypto.randomUUID();
  lastDraftDocument = undefined;
  autoSave.reset(performance.now());
  heldPreview = null; curveStart = null; curveEnd = null; curveAnchorMode = null; curveEditorOpen = false; loop = null; element('#loop-enabled').checked = false;
  assets = nextAssets;
  chartName = name;
  resetEditClock(chart);
  hitSounds.setProject(chart, assets, name);
  images.load(chart, assets, name);
  timeline.origin = 0;
  timeline.layer = 0;
  timeline.cancelPlacement();
  preview.visible = false; element('.preview-wrap').hidden = true; element('#view-toggle').classList.remove('active');
  element('#preview-title').textContent = chart.META.name ?? '';
  element('#music-name').textContent = '无音乐 · 时钟预览';
  element('#scrubber').max = 600;
  renderSession();
  hasDocument = true; setHome(false);
  status(`已打开 ${name}`);
}

function guardReplace(action) {
  if (session.history.dirty) confirmAction('切换谱面？', action);
  else action();
}

async function loadCandidate(candidate, nextAssets) {
  attachExternalEffects([candidate], nextAssets);
  replaceChart(candidate.chart, candidate.name, nextAssets);
  libraryProject = candidate.project ?? null;
  images.load(candidate.chart, assets, chartName, candidate.info);
  const references = resourceReferences(candidate.chart, assets, chartName, candidate.info);
  const bytes = assetBytes(assets, references.song, chartName);
  if (bytes) await loadMusic(bytes, references.song, false);
  else if (references.song) status(`谱面已打开，未找到音乐：${references.song}，请手动选择音乐`);
  if (session.chart === candidate.chart && candidate.project?.viewState) {
    const view = candidate.project.viewState;
    if (Number.isInteger(view.lineIndex) && session.chart.judgeLineList?.[view.lineIndex]) session.selectLine(view.lineIndex);
    if (Number.isFinite(view.seconds)) playback.seek(view.seconds);
  }
}

async function loadMusic(bytes, name, updateMetadata = true) {
  const chartPosition = chartSeconds();
  playback.pause();
  const loadingSession = session;
  const loaded = await audio.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name);
  if (!loaded || session !== loadingSession) return;
  assets.set(name, bytes);
  element('#music-name').textContent = name;
  element('#scrubber').max = audio.duration;
  if (updateMetadata) session.commit('选择音乐', { ...session.chart, META: { ...session.chart.META, song: name } });
  playback.seek(chartPosition + offsetSeconds());
}

function seekBeat(value, pause = true) {
  playback.seek(tempo.seconds(value, session.line?.bpmfactor ?? 1) + (session.chart.META.offset ?? 0) / 1000, pause);
  invalidate();
}

async function togglePlayback() {
  if (!audio.playing && !playback.pending) preview.effectsSince = realtimePreview.effectsSince = chartSeconds() - 0.001;
  await playback.toggle(session.chart);
  invalidate();
}

async function save(packageMode = false, exportOnly = false) {
  if (!packageMode && !exportOnly) {
    if (saving) return;
    saving = true;
    const savingSession = session; const snapshot = { ...session.chart, chartTime: editTimeSeconds };
    const project = { ...(libraryProject ?? { id: crypto.randomUUID(), source: 'Next 本地项目', imported: Date.now() }),
      chart: snapshot, chartName, assets: [...assets], bytes: [...assets.values()].reduce((sum, bytes) => sum + bytes.length, 0), updated: Date.now(), viewState: { lineIndex: session.lineIndex, seconds: audio.time } };
    try {
      await storeProject(project);
      savingSession.history.markSaved(savingSession.chart);
      if (session === savingSession) { libraryProject = project; renderSession(); status('已保存到谱面库，包含当前资源；可导出 PEZ 备份'); notify('已保存到谱面库', 'success'); }
    } finally { saving = false; }
    return;
  }
  const snapshot = { ...session.chart, chartTime: editTimeSeconds };
  if (packageMode) exportPackage(snapshot, assets, chartName);
  else exportChart(snapshot, chartName);
  status(packageMode ? '已发起 PEZ 下载；包含当前载入的附属资源' : '已发起 JSON 下载；音乐和图片请另行保留');
}

function validateCommit(label, next) { assertChart(next); session.commit(label, next); }

function eventCollection(type) {
  if (type === 'paintEvents') return eventList(session, type);
  return EVENT_TYPES.includes(type) ? session.line?.eventLayers?.[timeline.layer]?.[type] ?? [] : session.line?.extended?.[type] ?? [];
}

function replaceEvents(type, events) {
  if (!Array.isArray(events)) throw new Error('事件列表必须为数组');
  if (type === 'paintEvents') { commitEventLists(session, '编辑着色器事件', new Map([[type, events]])); return; }
  session.updateLine('编辑事件', line => {
    let next;
    if (EVENT_TYPES.includes(type)) {
      const layers = [...(line.eventLayers ?? [])];
      layers[timeline.layer] = { ...layers[timeline.layer], [type]: events };
      next = { ...line, eventLayers: layers };
    } else next = { ...line, extended: { ...line.extended, [type]: events } };
    const lines = [...session.chart.judgeLineList]; lines[session.lineIndex] = next;
    assertChart({ ...session.chart, judgeLineList: lines });
    for (const event of events) {
      if (beatValue(event.endTime) < beatValue(event.startTime)) throw new Error('事件结束拍不能早于开始拍');
      if (type !== 'textEvents' && type !== 'colorEvents' && (!Number.isFinite(event.start) || !Number.isFinite(event.end))) throw new Error('数值事件的 start/end 必须为有限数字');
    }
    return next;
  });
}

function editEvent(type, index, beat = currentBeat()) {
  if (!session.line) { status('请先添加判定线'); return; }
  timeline.eventPlacementType = type;
  timeline.extended = !EVENT_TYPES.includes(type);
  timeline.indexedLayer = null;
  session.focus = 'events'; session.eventLayer = timeline.layer; session.selection.clear();
  activatePane('events');
  if (index !== null) { session.eventSelection = new Set([eventKey(type, index)]); session.notify(); return; }
  timeline.eventInteraction.place(type, beat);
  status(timeline.eventInteraction.pending ? '移到事件终点，按 R 或点击完成；Esc 取消' : '事件放置完成');
}

listen('#new', () => guardReplace(() => replaceChart(createChart(), 'chart.json')));
listen('#home-new', () => element('#new').click());
listen('#home-open', () => element('#open').click());
listen('#home-migrate', () => element('#migrate').click());
listen('#resume-editor', () => setHome(false));
listen('#open', () => { element('#file-input').click(); });
element('#file-input').addEventListener('change', async event => {
  try {
    const loaded = await openFiles(event.target.files);
    if (!loaded) return;
    const proceed = () => {
      if (loaded.candidates.length === 1) loadCandidate(loaded.candidates[0], loaded.assets).catch(reportError);
      else choose('选择谱面', '包中有多份 RPE 谱面，其他文件会随 PEZ 导出保留。', loaded.candidates, candidate => `${candidate.name} · ${candidate.chart.META.name ?? ''}`, candidate => loadCandidate(candidate, loaded.assets));
    };
    guardReplace(proceed);
  } catch (error) { reportError(error); }
  finally { event.target.value = ''; }
});
listen('#save', () => save());
listen('#export-json', () => save(false, true));
listen('#package', () => save(true));
listen('#view-toggle', () => togglePreview());
listen('#close-preview', () => togglePreview(false, true));
listen('#background', () => element('#background-input').click());
element('#background-input').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file) return;
    const loadingSession = session;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (session !== loadingSession) return;
    assets.set(file.name, bytes);
    session.commit('选择封面', { ...session.chart, META: { ...session.chart.META, background: file.name } });
    await images.load(session.chart, assets, chartName);
  } catch (error) { reportError(error); }
  finally { event.target.value = ''; }
});
listen('#music', () => element('#music-input').click());
element('#music-input').addEventListener('change', async event => {
  try {
    const loadingSession = session;
    const file = event.target.files[0];
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (session === loadingSession) await loadMusic(bytes, file.name);
    }
  }
  catch (error) { reportError(error); }
  finally { event.target.value = ''; }
});
listen('#recover', async () => {
  const drafts = await listDrafts(atHome ? null : (libraryProject?.id ?? recoveryId));
  choose('恢复自动备份', drafts.length ? '新备份包含媒体；0.3 及更早的草稿仅包含谱面。恢复后请保存到谱面库。' : '此浏览器尚无自动备份。', drafts,
    draft => `${draft.title} · ${new Date(draft.updated).toLocaleString()}`,
    entry => { guardReplace(async () => {
      try {
        const draft = await readDraft(entry.id);
        if (!draft) throw new Error('此备份已被轮替，请重新打开备份列表');
        await loadCandidate({ chart: draft.chart, name: draft.name, project: { viewState: draft.viewState } }, new Map(draft.assets ?? []));
        libraryProject = null; session.history.savedDocument = null; renderSession();
      } catch (error) { reportError(error); }
    }); });
});
listen('#play', togglePlayback);
listen('#rewind', () => seekBeat(0));
listen('#seek', () => seekBeat(beatValue(parseBeat(element('#seek-beat').value))));
element('#scrubber').addEventListener('input', event => playback.seek(Number(event.target.value)));
element('#rate').addEventListener('change', event => audio.setRate(Number(event.target.value)));
element('#offset').addEventListener('change', event => {
  const value = Number(event.target.value);
  if (!Number.isFinite(value)) { event.target.value = session.chart.META.offset ?? 0; return; }
  const chartPosition = chartSeconds();
  session.commit('修改谱面延迟', { ...session.chart, META: { ...session.chart.META, offset: value } });
  playback.seek(chartPosition + value / 1000);
});
function nudgeBeatInput(input, direction) {
  try {
    const current = beatValue(parseBeat(input.value || '0'));
    const next = Math.max(0, current + direction / Math.max(1, timeline.division));
    input.value = formatBeat(fromNumber(next));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (error) { reportError(error); }
}
function decorateBeatInputs() {
  for (const input of document.querySelectorAll('#properties input[aria-label$="拍"], #event-properties input[aria-label$="拍"]')) {
    if (input.dataset.beatDecorated) continue;
    input.dataset.beatDecorated = 'true';
    const holder = input.parentElement;
    const wrapper = document.createElement('span'); wrapper.className = 'beat-input-wrap';
    const nudge = document.createElement('span'); nudge.className = 'beat-nudge';
    for (const [direction, symbol] of [[1, '▴'], [-1, '▾']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = symbol; button.title = direction < 0 ? '减少一格' : '增加一格';
      button.dataset.beatNudge = String(direction); button.onclick = () => nudgeBeatInput(input, direction); nudge.append(button);
    }
    input.replaceWith(wrapper); wrapper.append(input, nudge);
    input.addEventListener('wheel', event => { event.preventDefault(); nudgeBeatInput(input, event.deltaY < 0 ? 1 : -1); }, { passive: false });
  }
}
element('#chart-info-toggle').addEventListener('click', event => {
  const info = element('#chart-info'); info.hidden = !info.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!info.hidden));
});
element('#volume').addEventListener('input', event => { audio.setVolume(Number(event.target.value)); persistEditor(); });
element('#preview-mode').addEventListener('change', event => { preview.allLines = realtimePreview.allLines = event.target.value === 'all'; persistEditor(); invalidate(); });
for (const [selector, property, minimum, maximum, integer] of [['#division', 'division', 1, 100, true], ['#grid-count', 'gridCount', 2, 100, false], ['#y-scale', 'scale', 20, 2000, false]]) {
  element(selector).addEventListener('change', event => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) timeline[property] = Math.max(minimum, Math.min(maximum, integer ? Math.round(value) : value));
    event.target.value = timeline[property]; session.division = timeline.division; updateCurvePanel(); persistEditor(); invalidate();
    if (property === 'scale') element('#y-scale-slider').value = timeline.scale;
  });
}
element('#y-scale-slider').addEventListener('input', event => {
  timeline.scale = Number(event.target.value); element('#y-scale').value = timeline.scale; persistEditor(); invalidate();
});
element('#snap-x').addEventListener('change', event => { timeline.snapX = event.target.checked; persistEditor(); invalidate(); });
function updateLayerButtons() {
  const container = element('#layer');
  if (!container.children.length) for (let index = 0; index <= MAX_BASE_LAYERS; index++) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = index === MAX_BASE_LAYERS ? '特' : String(index);
    button.onclick = () => {
      timeline.cancelPlacement(); timeline.extended = index === MAX_BASE_LAYERS;
      if (!timeline.extended) timeline.layer = index;
      timeline.indexedLayer = null; session.eventLayer = timeline.layer; session.eventSelection.clear();
      timeline.eventPlacementType = timeline.eventTypes[0]; session.notify();
    };
    container.append(button);
  }
  const bottom = timeline.beatAt(timeline.notesCanvas.clientHeight); const top = timeline.beatAt(0);
  [...container.children].forEach((button, index) => {
    const layer = index === MAX_BASE_LAYERS ? session.line?.extended : session.line?.eventLayers?.[index];
    const allowedTypes = index === MAX_BASE_LAYERS ? SPECIAL_TRACKS.map(track => track.key) : EVENT_TYPES;
    const events = allowedTypes.filter(type => type !== 'paintEvents').flatMap(type => Array.isArray(layer?.[type]) ? layer[type] : []);
    const shaders = index === MAX_BASE_LAYERS ? shaderEvents(session.chart, session.lineIndex) : [];
    const visible = events.some(event => beatValue(event.endTime) >= bottom && beatValue(event.startTime) <= top) || shaders.some(event => beatValue(event.endTime) >= timeline.eventBeatAt(timeline.notesCanvas.clientHeight, 'paintEvents') && beatValue(event.startTime) <= timeline.eventBeatAt(0, 'paintEvents'));
    events.push(...shaders);
    button.dataset.state = !events.length ? 'empty' : visible ? 'visible' : 'outside';
    button.classList.toggle('active', timeline.extended ? index === MAX_BASE_LAYERS : index === timeline.layer);
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
    button.title = `${index === MAX_BASE_LAYERS ? '特殊层' : `第 ${index} 层`} · ${!events.length ? '空层' : visible ? '当前视野内有事件' : '事件在当前视野外'}`;
  });
}
element('#line-select').addEventListener('change', event => { timeline.cancelPlacement(); session.selectLine(Number(event.target.value)); });
element('#hit-volume').addEventListener('input', event => { hitSounds.setVolume(Number(event.target.value)); persistEditor(); });
element('#hit-enabled').addEventListener('change', event => { hitSounds.enabled = event.target.checked; hitSounds.stop(); persistEditor(); });
element('#realtime-enabled').addEventListener('change', event => { realtimePreview.visible = event.target.checked; element('#realtime-preview').hidden = !event.target.checked; persistEditor(); invalidate(); });
element('#realtime-alpha').addEventListener('input', event => { realtimePreview.opacity = Number(event.target.value); persistEditor(); invalidate(); });
for (const selector of ['#loop-start', '#loop-end', '#loop-enabled']) element(selector).addEventListener('change', () => {
  try {
    const start = beatValue(parseBeat(element('#loop-start').value));
    const end = beatValue(parseBeat(element('#loop-end').value));
    if (start < 0 || end <= start) throw new Error('循环止拍必须大于起拍，起拍不能为负');
    loop = element('#loop-enabled').checked ? { start, end } : null;
  } catch (error) { loop = null; element('#loop-enabled').checked = false; reportError(error); }
});
for (const button of document.querySelectorAll('[data-tool]')) button.onclick = () => {
  timeline.cancelPlacement();
  timeline.tool = Number(button.dataset.tool);
  for (const item of document.querySelectorAll('[data-tool]')) item.classList.toggle('active', item === button);
  invalidate();
};
function travel(direction, silent = false) {
  timeline.cancelPlacement();
  const stack = direction === 'undo' ? session.history.undoStack : session.history.redoStack;
  const command = stack.at(-1);
  if (!command) { notify(direction === 'undo' ? '没有可撤销的编辑' : '没有可重做的编辑', 'warning'); return; }
  session.travel(direction);
  if (!silent) notify(`${direction === 'undo' ? '撤销' : '重做'}：${command.label}`, 'success');
}
listen('#undo', () => travel('undo'));
listen('#redo', () => travel('redo'));
listen('#curve-notes', openCurvePanel);
listen('#curve-start', () => captureCurve(false));
listen('#curve-end', () => captureCurve(true));
function switchNoteView() {
  timeline.cancelPlacement(); timeline.hoverArea = 'notes'; session.focus = 'notes';
  activatePane('notes');
  editorPreferences.notesOnly = !timeline.notesOnly;
  applyDisplaySettings(); persistEditor(); session.notify();
}
function resetCamera(resetPreview = false) {
  editorPreferences.cameraX = 0;
  if (resetPreview) editorPreferences.viewDivisor = 1;
  applyDisplaySettings(); persistEditor();
}
function captureCurve(end) {
  if (preview.visible) return;
  if (!curveEditorOpen) openCurvePanel();
  curveAnchorMode = end ? 'end' : 'start';
  if (end && !curveStart) { curveAnchorMode = null; throw new Error('请先按 Ctrl+F 选择曲线起点'); }
  element('#curve-start')?.classList.toggle('active', !end);
  element('#curve-end')?.classList.toggle('active', end);
  status(end ? '曲线终点选择中：点击一个音符' : '曲线起点选择中：点击一个音符');
}
listen('#notes-only', switchNoteView);
listen('#reset-camera', () => resetCamera(true));
listen('#game-ui', () => { editorPreferences.showGameUI = !preview.showGameUI; applyDisplaySettings(); persistEditor(); });
element('#preview-ratio').onchange = event => {
  [editorPreferences.ratioWidth, editorPreferences.ratioHeight] = event.target.value.split(':').map(Number);
  applyDisplaySettings(); persistEditor();
};
for (const [id, key] of [['camera-x', 'cameraX'], ['view-divisor', 'viewDivisor']]) element(`#${id}`).onchange = event => {
  if (!event.target.value.trim() || !event.target.validity.valid) { applyDisplaySettings(); return; }
  editorPreferences[key] = Number(event.target.value); applyDisplaySettings(); persistEditor();
};
element('#toolbar-mode').onclick = () => {
  const modes = ['compact', 'icons', 'wide'];
  const current = editorPreferences.toolbarMode ?? 'compact';
  editorPreferences.toolbarMode = modes[(modes.indexOf(current) + 1) % modes.length];
  applyDisplaySettings(); persistEditor();
};
element('#attach-ui').onchange = event => {
  const value = event.target.value;
  session.updateLine('绑定游戏 UI', line => ({ ...line, attachUI: value }));
};
function copySelection() {
  if (session.focus === 'events') { copyEvents(session); status(`已复制 ${session.eventClipboard.length} 个事件`); }
  else { session.copy(); status(`已复制 ${session.clipboard.length} 个音符`); }
}
function deleteSelection() { if (session.focus === 'events') deleteEvents(session); else session.deleteSelection(); }
function pasteSelection(mirror = false, keepTime = false) {
  if (session.focus === 'events') pasteEvents(session, currentBeat(), keepTime, mirror);
  else session.paste(currentBeat(), mirror, keepTime);
}
listen('#copy', copySelection);
listen('#cut', () => { copySelection(); deleteSelection(); });
listen('#paste', () => pasteSelection());
listen('#delete', deleteSelection);
listen('#mirror', () => {
  if (session.focus === 'events') transformEvents(session, '镜像 X / 旋转事件', (event, type) => ['moveXEvents', 'rotateEvents'].includes(type) ? { ...event, start: -event.start, end: -event.end } : event);
  else session.transformSelection('镜像音符', note => ({ ...note, positionX: -note.positionX }));
});
listen('#manage-lines', () => { timeline.cancelPlacement(); manageLines(session); });
listen('#metadata', () => { activatePane('metadata'); renderMetadataPanel(session, element('#metadata-editor'), () => { activatePane('chart'); renderSession(); }); });
listen('#bpm', () => { activatePane('bpm'); renderBpmPanel(session, element('#bpm-editor'), () => { activatePane('chart'); renderSession(); }); });
function renderHistoryPanel() {
  const host = element('#history-results'); if (!host) return;
  host.replaceChildren();
  const history = session.history; const current = history.undoStack.length;
  const entries = [{ label: '当前可回退的起点', index: 0 }, ...history.undoStack.map((command, index) => ({ label: command.label, index: index + 1 })), ...history.redoStack.toReversed().map((command, index) => ({ label: command.label, index: current + index + 1 }))];
  for (const entry of entries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = entry.index === current ? 'active' : ''; button.textContent = `${entry.index === current ? '● ' : ''}${entry.index} · ${entry.label}`;
    button.onclick = () => { const direction = entry.index < current ? 'undo' : 'redo'; for (let count = 0; count < Math.abs(entry.index - current); count++) travel(direction, true); renderHistoryPanel(); notify(`已定位到编辑历史第 ${entry.index} 步`, 'success', 1800); };
    host.append(button);
  }
}
listen('#history-panel', () => { activatePane('history'); renderHistoryPanel(); });
listen('#line-properties', () => {
  if (!session.line) throw new Error('请先添加判定线');
  const { notes, eventLayers, extended, ...properties } = session.line;
  editJson('判定线属性', '保留未编辑字段。父子线和控制曲线已接入预览；自定义纹理等仍待完成。', properties, next => {
    const lines = [...session.chart.judgeLineList];
    lines[session.lineIndex] = { ...next, notes, eventLayers, extended };
    validateCommit('判定线属性', { ...session.chart, judgeLineList: lines });
  });
});
listen('#event-list', () => {
  const type = session.eventSelection.values().next().value?.split(':')[0] ?? timeline.eventTypes[0];
  editJson(type, '可以批量编辑、复制及删除事件；应用作为一步撤销。', eventCollection(type), events => replaceEvents(type, events));
});
function deleteDiagnosticIssue(issue) {
  if (issue.path.startsWith('paintEvents[')) {
    session.commit('删除着色器检查项', replaceShaderEvents(session.chart, issue.line, shaderEvents(session.chart, issue.line).filter((event, index) => index !== issue.index)));
    notify('已删除检查项对应对象', 'success'); return;
  }
  const chart = structuredClone(session.chart);
  if (issue.path.startsWith('notes[') && chart.judgeLineList?.[issue.line]) chart.judgeLineList[issue.line].notes.splice(issue.index, 1);
  else if (issue.path === 'father' && chart.judgeLineList?.[issue.line]) chart.judgeLineList[issue.line].father = -1;
  else if (issue.path.startsWith('BPMList[')) chart.BPMList.splice(issue.index, 1);
  else if (issue.line != null && issue.path.match(/^\w+Events\[/)) {
    const type = issue.path.slice(0, issue.path.indexOf('[')); const line = chart.judgeLineList?.[issue.line];
    const layer = issue.extended ? line?.extended : line?.eventLayers?.[issue.layer];
    if (!layer?.[type]) return;
    layer[type].splice(issue.index, 1);
  }
  else return;
  session.commit('删除检查项', chart); notify('已删除检查项对应对象', 'success');
}
function renderDiagnostics() {
  const host = element('#diagnose-results'); if (!host) return;
  host.replaceChildren();
  const issues = diagnose(session.chart); const visible = element('#diagnose-show-low')?.checked !== false;
  const signature = issues.map(issue => `${issue.severity}:${issue.path}:${issue.message}`).sort().join('|');
  if (lastDiagnosticSignature !== null && signature !== lastDiagnosticSignature) {
    const previous = new Set(lastDiagnosticSignature.split('|').filter(Boolean));
    const added = issues.filter(issue => !previous.has(`${issue.severity}:${issue.path}:${issue.message}`));
    if (added.some(issue => issue.severity === 'error')) notify(`谱面检查发现 ${added.filter(issue => issue.severity === 'error').length} 个错误`, 'error', 4200);
    else if (added.some(issue => issue.severity === 'warning')) notify(`谱面检查新增 ${added.filter(issue => issue.severity === 'warning').length} 个警告`, 'warning', 3600);
  }
  lastDiagnosticSignature = signature;
  const category = issue => {
    const top = issue.path.startsWith('notes[') ? '音符' : issue.path.match(/Events\[/) ? '事件' : '其他';
    const sub = issue.message.includes('超出') ? '超界' : issue.message.includes('重叠') ? '重叠' : issue.message.includes('时长') ? '时长' : issue.message.includes('父线') ? '父线' : '其他';
    return [top, sub];
  };
  for (const [severity, title] of [['error', '错误'], ['warning', '警告'], ['info', '提示']]) {
    const list = issues.filter(issue => issue.severity === severity && (visible || severity !== 'info'));
    const details = document.createElement('details'); details.className = `diagnose-group ${severity}`; details.open = true;
    const summary = document.createElement('summary'); summary.textContent = `${title}（${list.length}）`; details.append(summary);
    const groupedIssues = new Map();
    for (const issue of list) { const [kind, sub] = category(issue); if (!groupedIssues.has(kind)) groupedIssues.set(kind, new Map()); if (!groupedIssues.get(kind).has(sub)) groupedIssues.get(kind).set(sub, []); groupedIssues.get(kind).get(sub).push(issue); }
    for (const [kind, subgroups] of groupedIssues) {
      const parent = document.createElement('details'); parent.className = 'diagnose-subgroup'; parent.open = true;
      const parentSummary = document.createElement('summary'); parentSummary.textContent = `${kind}（${[...subgroups.values()].reduce((sum, entries) => sum + entries.length, 0)}）`; parent.append(parentSummary);
      for (const [sub, grouped] of subgroups) {
        const subgroup = document.createElement('details'); subgroup.className = 'diagnose-subgroup'; subgroup.open = true;
        const subsummary = document.createElement('summary'); subsummary.textContent = `${sub}（${grouped.length}）`; subgroup.append(subsummary);
        for (const issue of grouped) {
          const row = document.createElement('div'); row.className = `diagnose-item ${severity}`;
          const locate = document.createElement('button'); locate.type = 'button'; locate.textContent = `Line ${issue.line} · ${issue.beat} 拍 · ${issue.message}`;
          locate.onclick = () => { session.selectLine(issue.line); seekBeat(issue.beat); notify(`已定位到 Line ${issue.line} · ${issue.beat} 拍`, 'success', 1800); };
          const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.disabled = !issue.path.includes('[') && issue.path !== 'father'; remove.onclick = () => deleteDiagnosticIssue(issue);
          row.append(locate, remove); subgroup.append(row);
        }
        parent.append(subgroup);
      }
      details.append(parent);
    }
    host.append(details);
  }
  if (!issues.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '未发现当前检查规则覆盖的问题。'; host.append(empty); }
}
listen('#diagnose', () => { activatePane('diagnose'); renderDiagnostics(); });
element('#diagnose-show-low').addEventListener('change', renderDiagnostics);
element('#diagnose-close').addEventListener('click', () => activatePane('chart'));
element('#history-close').addEventListener('click', () => activatePane('chart'));

function curveField(id, label, value, type = 'text', options = []) {
  const row = document.createElement('label'); row.className = 'field'; row.append(label);
  const input = type === 'select' ? document.createElement('select') : document.createElement('input');
  input.id = id;
  if (type === 'select') input.replaceChildren(...options.map(([optionValue, optionLabel]) => new Option(optionLabel, optionValue)));
  else { input.type = type; input.step = 'any'; }
  input.value = value; row.append(input);
  if (type === 'number') numericWheel(input, id === 'curve-density' ? 0.25 : 1, direction => { input.value = Number(input.value) + direction * (id === 'curve-density' ? 0.25 : 1); input.dispatchEvent(new Event('input', { bubbles: true })); });
  return row;
}
function generatedCurveCount() {
  if (!curveStart || !curveEnd) return 0;
  try { return generateCurveNotes({ ...curveValues, division: timeline.division }).length; } catch { return 0; }
}
function updateCurvePanel() {
  if (!curveEditorOpen) return;
  const root = element('#curve-editor');
  if (!root.children.length) {
    root.append(curveField('curve-start-time', '起点拍', formatBeat(curveValues.startTime)), curveField('curve-end-time', '终点拍', formatBeat(curveValues.endTime)),
      curveField('curve-start-x', '起点 X', curveValues.startX, 'number'), curveField('curve-end-x', '终点 X', curveValues.endX, 'number'),
      curveField('curve-density', '密度', curveValues.density, 'number'), curveField('curve-type', '类型', curveValues.type, 'select', [['1', 'Tap'], ['3', 'Flick'], ['4', 'Drag']]), curveField('curve-easing', '缓动编号（1–29）', curveValues.easingType, 'number'));
    root.addEventListener('input', () => {
      try {
        curveValues = { startTime: parseBeat(element('#curve-start-time').value), endTime: parseBeat(element('#curve-end-time').value), startX: Number(element('#curve-start-x').value), endX: Number(element('#curve-end-x').value), density: Number(element('#curve-density').value), type: Number(element('#curve-type').value), easingType: Number(element('#curve-easing').value) };
        element('#curve-summary').textContent = `${generatedCurveCount()} 个中间音符 · 端点不重复添加`;
        curveEasingPicker.select(curveValues.easingType);
        invalidate();
      } catch (error) { element('#curve-summary').textContent = error.message; }
    });
    const summary = document.createElement('p'); summary.id = 'curve-summary'; summary.className = 'hint'; root.append(summary);
    curveEasingPicker = createEasingPicker(curveValues.easingType, value => { curveValues.easingType = value; updateCurvePanel(); });
    root.append(curveEasingPicker.element);
  }
  const values = [['#curve-start-time', formatBeat(curveValues.startTime)], ['#curve-end-time', formatBeat(curveValues.endTime)], ['#curve-start-x', curveValues.startX], ['#curve-end-x', curveValues.endX], ['#curve-density', curveValues.density], ['#curve-type', curveValues.type], ['#curve-easing', curveValues.easingType]];
  for (const [selector, value] of values) if (document.activeElement !== element(selector)) element(selector).value = value;
  element('#curve-summary').textContent = `${generatedCurveCount()} 个中间音符 · 端点不重复添加`;
  curveEasingPicker.select(curveValues.easingType);
  invalidate();
}
function openCurvePanel() {
  curveEditorOpen = true; curveStart = null; curveEnd = null; curveAnchorMode = null;
  element('#curve-start')?.classList.remove('active'); element('#curve-end')?.classList.remove('active');
  activatePane('curve'); updateCurvePanel(); status('曲线编辑：请选择起点音符');
}
function closeCurvePanel() {
  curveEditorOpen = false; curveStart = null; curveEnd = null; curveAnchorMode = null;
  element('#curve-start')?.classList.remove('active'); element('#curve-end')?.classList.remove('active');
  activatePane('chart'); invalidate();
}
listen('#curve-generate', () => {
  try {
    const notes = generateCurveNotes({ ...curveValues, division: timeline.division });
    if (!notes.length) throw new Error('当前参数没有可生成的中间音符');
    session.focus = 'notes'; session.eventSelection.clear(); session.insertNotes(notes, '生成曲线音符'); closeCurvePanel(); notify(`已生成 ${notes.length} 个曲线音符`, 'success');
  } catch (error) { reportError(error); }
});
listen('#curve-cancel', closeCurvePanel);
listen('#help', () => showDialog('Re:PhiEdit Next · 迁移预览版', HELP_TEXT));

let playbackSpaceHeld = false;
window.addEventListener('keydown', event => {
  if (atHome || !hasDocument || event.key !== 'Tab' || dialogOpen() || event.isComposing) return;
  const target = event.target;
  const textEntry = target?.isContentEditable || target?.tagName === 'TEXTAREA' || (target?.tagName === 'INPUT' && ['text', 'search', 'url', 'email', 'password'].includes(target.type));
  if (textEntry) return;
  event.preventDefault();
  if (event.repeat) return;
  lineInfoVisible = !lineInfoVisible;
  updateLineInfo();
}, true);
window.addEventListener('keyup', event => {
  if (event.key !== 'Tab') return;
  event.preventDefault();
}, true);
window.addEventListener('blur', () => { lineInfoVisible = false; element('#line-info-overlay')?.setAttribute('hidden', ''); });
window.addEventListener('keydown', event => {
  if (atHome || !hasDocument || !isPlaybackSpace(event)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  playbackSpaceHeld = true;
  if (!event.repeat) togglePlayback().catch(reportError);
}, true);
window.addEventListener('keyup', event => {
  if (event.key !== ' ' || !playbackSpaceHeld) return;
  event.preventDefault(); event.stopImmediatePropagation(); playbackSpaceHeld = false;
}, true);
window.addEventListener('blur', () => { playbackSpaceHeld = false; });
window.addEventListener('keydown', async event => {
  const target = event.target;
  const textEntry = target?.isContentEditable || target?.tagName === 'TEXTAREA' || (target?.tagName === 'INPUT' && ['text', 'search', 'url', 'email', 'password'].includes(target.type));
  if (atHome || dialogOpen() || event.isComposing || textEntry) return;
  const area = timeline.hoverArea ?? session.focus;
  const action = shortcutAction(event, preferences, area);
  let handled = true;
  try {
    if (event.repeat && ['Pause', 'AddHold', 'AddEvent', 'AddTap', 'StartView', 'EndView', 'JumpView', 'ReplayView', 'StartView_HOLD', 'JumpView_HOLD'].includes(action)) { event.preventDefault(); return; }
    if (timeline.eventInteraction.pending && /^[0-9]$/.test(event.key) && !event.ctrlKey && !event.altKey) timeline.eventInteraction.place(undefined, undefined, Number(event.key) || 10);
    else if (action === 'Save') { event.preventDefault(); await save(); }
    else if (action === 'Undo') travel('undo');
    else if (action === 'Redo') travel('redo');
    else if (action === 'SelectAll') {
      if (session.focus === 'events') session.eventSelection = new Set(timeline.eventTypes.flatMap(type => eventList(session, type).map((event, index) => eventKey(type, index))));
      else session.selection = new Set(session.notes.map((note, index) => index));
      session.notify();
    }
    else if (action === 'Copy') copySelection();
    else if (action === 'Shear') { copySelection(); deleteSelection(); }
    else if (['Paste', 'PasteMirror', 'KeepTimePaste', 'KeepTimePasteMirror'].includes(action)) pasteSelection(action.endsWith('Mirror'), action.startsWith('KeepTime'));
    else if (action === 'Pause') { event.preventDefault(); await togglePlayback(); }
    else if (['StartView', 'ReplayView', 'StartView_HOLD', 'JumpView_HOLD'].includes(action)) {
      if (action.endsWith('_HOLD')) heldPreview = { action, code: event.code };
      togglePreview(true, false, action === 'ReplayView');
    }
    else if (action === 'EndView') togglePreview(false);
    else if (action === 'JumpView') togglePreview(false, true);
    else if (action === 'SwitchUI') switchNoteView();
    else if (action === 'ResetCamera') resetCamera();
    else if (action === 'CurveBegin' || action === 'CurveEnd') captureCurve(action === 'CurveEnd');
    else if (preview.visible && ['AddTap', 'AddDrag', 'AddFlick', 'AddHold', 'AddEvent'].includes(action)) handled = false;
    else if (area === 'events' && ['AddTap', 'AddEvent'].includes(action)) handled = timeline.eventInteraction.place();
    else if (['AddTap', 'AddDrag', 'AddFlick', 'AddHold'].includes(action)) handled = timeline.addAtCursor({ AddTap: 1, AddDrag: 4, AddFlick: 3, AddHold: 2 }[action]);
    else if (action === 'Delete') deleteSelection();
    else if (action === 'QuickDelete' && session.focus === 'events' && timeline.eventCursor) {
      const hit = timeline.eventInteraction.hit(timeline.eventCursor);
      if (hit) { session.eventSelection = new Set([eventKey(hit.type, hit.index)]); deleteEvents(session); }
    } else if (action === 'QuickDelete' && timeline.cursor) {
      const hit = timeline.hit(timeline.cursor);
      if (hit) { session.selection = new Set([hit.index]); session.deleteSelection(); }
    } else if (['LastBeat', 'NextBeat'].includes(action)) seekBeat(Math.max(0, currentBeat() + (action === 'LastBeat' ? -1 : 1) / timeline.division));
    else if (action === 'Esc') { session.selection.clear(); session.eventSelection.clear(); timeline.cancelPlacement(); curveAnchorMode = null; curveStart = null; curveEnd = null; curveEditorOpen = false; togglePreview(false); activatePane('chart'); session.notify(); }
    else handled = false;
    if (handled) event.preventDefault();
  } catch (error) { event.preventDefault(); reportError(error); }
});
window.addEventListener('keyup', event => {
  if (heldPreview && (event.code === heldPreview.code || shortcutReleased(event, preferences.hotkeys[heldPreview.action]))) {
    togglePreview(false, heldPreview.action === 'JumpView_HOLD'); heldPreview = null;
  }
});
window.addEventListener('blur', () => { if (heldPreview) { togglePreview(false); heldPreview = null; } });

window.addEventListener('beforeunload', event => { if (session.history.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('resize', invalidate);
element('#modal').addEventListener('close', () => { if (atHome) home.refresh().catch(reportError); });
new ResizeObserver(invalidate).observe(element('.canvases'));
let lastPaint = 0;
let lastInfoTick = 0;
let lastFrameTime = 0;
let frameSampleStart = 0;
let frameSampleCount = 0;
let measuredFps = 0;
let lastTick = 0;
function frame(timestamp) {
  const elapsed = lastTick ? (timestamp - lastTick) / 1000 : 0; lastTick = timestamp;
  audio.update();
  if (!atHome) timeline.autoScroll(elapsed);
  frameSampleCount++;
  if (timestamp - frameSampleStart >= 500) { measuredFps = frameSampleCount * 1000 / (timestamp - frameSampleStart); frameSampleStart = timestamp; frameSampleCount = 0; }
  advanceEditClock(timestamp);
  if (hasDocument && !atHome && timestamp - lastInfoTick > 500) {
    const info = element('#chart-info dd');
    if (info && !element('#chart-info').hidden) info.textContent = info.textContent.replace(/Time: .*$/, `Time: ${formatEditTime(editTimeSeconds)}  FPS: ${measuredFps.toFixed(1)}`);
    lastInfoTick = timestamp;
  }
  if (hasDocument && !atHome && !document.hidden) autoSave.tick(timestamp, editorPreferences.autoSave ?? preferences.settings.autoSave,
    editorPreferences.autoSaveSeconds ?? preferences.settings.autoSaveSeconds, session.history.dirty && session.chart !== lastDraftDocument);
  if (audio.playing && loop && currentBeat() >= loop.end) seekBeat(loop.start, false);
  if (audio.playing && audio.time >= audio.duration) { audio.pause(); invalidate(); }
  hitSounds.tick(session.chart, tempo);
  if (!atHome && (audio.playing || dirtyFrame) && timestamp - lastFrameTime >= 1000 / preferences.settings.fpsLimit) {
    lastFrameTime = timestamp;
    const start = performance.now();
    const beat = currentBeat();
    session.editSeconds = Math.max(0, chartSeconds());
    updateLineInfo();
    if (audio.playing) timeline.origin = beat;
    timeline.draw(beat);
    drawTimelineStrips();
    updateLayerButtons();
    preview.duration = realtimePreview.duration = audio.duration;
    preview.draw(session.chart, tempo, chartSeconds(), session.lineIndex);
    if (!preview.visible) realtimePreview.draw(session.chart, tempo, chartSeconds(), session.lineIndex);
    element('#play').textContent = audio.playing ? 'Ⅱ 暂停' : '▶ 播放';
    element('#clock').textContent = `${chartSeconds().toFixed(3)} s`;
    element('#scrubber').value = audio.time;
    const tempoPoint = tempo.points[Math.max(0, upperBound(tempo.points, beat, point => point.beat) - 1)];
    element('#bpm-display').textContent = `${(60 / tempoPoint.secondsPerBeat).toFixed(2)} BPM`;
    const draggedNote = ['move', 'startTime', 'endTime'].includes(timeline.drag?.kind) ? timeline.movedNote(session.notes[timeline.drag.anchor]) : null;
    const positionInput = element('#properties input[aria-label="X 坐标"]');
    if (draggedNote && positionInput && document.activeElement !== positionInput) positionInput.value = Number(draggedNote.positionX).toFixed(2);
    element('#cursor-position').textContent = draggedNote ? `X ${draggedNote.positionX.toFixed(2)} · ${beatValue(draggedNote.startTime).toFixed(3)} 拍` : timeline.cursor ? `X ${timeline.positionAt(timeline.cursor.x).toFixed(2)} · ${timeline.snappedBeat(timeline.cursor.y).toFixed(3)} 拍` : '';
    if (timestamp - lastPaint > 400) {
      element('#performance').textContent = `绘制 ${(performance.now() - start).toFixed(1)} ms`;
      lastPaint = timestamp;
    }
    dirtyFrame = false;
  }
  requestAnimationFrame(frame);
}
applyPreferences(preferences);
setHome(true);
requestAnimationFrame(frame);

function applyPreferences(next) {
  preferences = next;
  audio.setVolume(editorPreferences.volume ?? next.settings.volume);
  element('#volume').value = audio.volume;
  hitSounds.setVolume(editorPreferences.hitVolume ?? next.settings.hitVolume);
  element('#hit-volume').value = hitSounds.volume;
  preview.noteSize = realtimePreview.noteSize = next.settings.noteSize;
  preview.lineScale = next.settings.lineScale;
  preview.backgroundAlpha = realtimePreview.backgroundAlpha = next.settings.backgroundAlpha;
  timeline.noteScale = next.settings.noteSize / 175;
  timeline.gridCount = editorPreferences.gridCount ?? next.settings.gridCount;
  timeline.scale = editorPreferences.scale ?? 500;
  timeline.division = editorPreferences.division ?? 4;
  timeline.snapX = editorPreferences.snapX ?? true;
  element('#grid-count').value = timeline.gridCount; element('#division').value = timeline.division; element('#y-scale').value = timeline.scale; element('#snap-x').checked = timeline.snapX;
  element('#y-scale-slider').value = timeline.scale;
  realtimePreview.visible = editorPreferences.realtime ?? true;
  element('#realtime-enabled').checked = realtimePreview.visible; element('#realtime-preview').hidden = !realtimePreview.visible;
  element('#realtime-alpha').value = editorPreferences.realtimeAlpha ?? next.settings.realtimeAlpha;
  realtimePreview.opacity = Number(element('#realtime-alpha').value);
  hitSounds.enabled = editorPreferences.hitEnabled ?? true; element('#hit-enabled').checked = hitSounds.enabled;
  preview.allLines = realtimePreview.allLines = editorPreferences.allLines ?? true; element('#preview-mode').value = preview.allLines ? 'all' : 'current';
  timeline.scrollSpeed = next.settings.scrollSpeed / 5;
  session.history.limit = next.settings.historyLimit;
  element('#hotkey-help').hidden = !next.settings.showHotkey;
  element('#hotkey-help').textContent = `Tap ${next.hotkeys.AddTap} · Drag ${next.hotkeys.AddDrag} · Flick ${next.hotkeys.AddFlick} · Hold ${next.hotkeys.AddHold} 两次定位 · 事件 ${next.hotkeys.AddEvent} 两次定位 · 播放 ${next.hotkeys.Pause}。预览 ${next.hotkeys.StartView}，返回 ${next.hotkeys.EndView}，留在当前时间 ${next.hotkeys.JumpView}；按住预览 ${next.hotkeys.StartView_HOLD}/${next.hotkeys.JumpView_HOLD}。布局 ${next.hotkeys.SwitchUI}，重置视区 ${next.hotkeys.ResetCamera}，曲线端点 ${next.hotkeys.CurveBegin}/${next.hotkeys.CurveEnd}。滚轮向上前进并暂停；Shift 或右键两次框选，空白处拖动划线选择。`;
  applyDisplaySettings();
  renderSession();
}

function applyMigratedPreferences(next) {
  editorPreferences = { ...editorPreferences, volume: next.settings.volume, hitVolume: next.settings.hitVolume, gridCount: next.settings.gridCount, realtimeAlpha: next.settings.realtimeAlpha,
    ratioWidth: next.settings.ratioWidth, ratioHeight: next.settings.ratioHeight, barWidth: next.settings.barWidth, barAlpha: next.settings.barAlpha,
    autoSave: next.settings.autoSave, autoSaveSeconds: next.settings.autoSaveSeconds, autoSaveLimit: next.settings.autoSaveLimit, autoplayView: next.settings.autoplayView, highlight: next.settings.highlight, showGameUI: next.settings.showGameUI };
  applyPreferences(next); persistEditor();
}

listen('#migrate', async () => {
  const content = showDialog('选择原 RPE 主文件夹', '请选择包含 Resources、Hotkey.txt、Settings.json 的目录。读取后会先展示项目清单，再由你选择迁移内容。');
  if (window.showDirectoryPicker) {
    const select = document.createElement('button'); select.type = 'button'; select.className = 'primary'; select.textContent = '只读选择文件夹';
    select.onclick = async () => {
      try {
        const directory = await window.showDirectoryPicker({ mode: 'read' });
        status('正在扫描旧 RPE 目录…');
        const entries = await directoryEntries(directory);
        migrationDialog(await scanMigration(entries, directory.name), applyMigratedPreferences);
      } catch (error) { if (error.name !== 'AbortError') reportError(error); }
    };
    content.append(select);
  }
  const fallback = document.createElement('button'); fallback.type = 'button'; fallback.textContent = '兼容方式选择文件夹';
  fallback.onclick = () => element('#directory-input').click(); content.append(fallback);
});
element('#directory-input').addEventListener('change', async event => {
  try {
    if (!event.target.files.length) return;
    status('正在扫描旧 RPE 目录…');
    const entries = uploadedEntries(event.target.files);
    const name = event.target.files[0].webkitRelativePath.split('/')[0];
    migrationDialog(await scanMigration(entries, name), applyMigratedPreferences);
  } catch (error) { reportError(error); }
  finally { event.target.value = ''; }
});
listen('#library', () => {
  if (atHome) return;
  playback.pause();
  if (!session.history.dirty) { setHome(true); return; }
  choose('返回主界面前保存修改？', '保存会更新谱面库及资源；不保存会丢弃本次未保存修改。', ['保存并返回', '不保存并返回'], value => value, async value => {
    if (value === '保存并返回') {
      await save();
      if (session.history.dirty) throw new Error('仍有未保存修改，请等待保存结束后重试');
    }
    else { hasDocument = false; session.history.markSaved(); }
    setHome(true);
  });
});
listen('#preferences', () => settingsDialog.showModal());
listen('#advanced-preferences', () => {
  settingsDialog.close();
  const content = showDialog('热键与设置', '已迁移热键会用于实际操作。未支持的项目保留在导出文件中；浏览器系统快捷键可能无法覆盖。');
  const report = document.createElement('p');
  report.textContent = `已应用热键：${preferences.report.appliedHotkeys.join('、') || '默认热键'}。仅保留设置：${preferences.report.retainedSettings.join('、') || '无'}。`;
  content.append(report);
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑热键 / 设置';
  edit.onclick = () => editJson('编辑热键 / 设置', '修改 originalSettings 和 originalHotkeys，应用后生效。其他字段为迁移记录。', preferences, next => {
    const nextPreferences = migratePreferences(JSON.stringify(next.originalSettings), Object.entries(next.originalHotkeys).map(([key, value]) => `${key} ${value}`).join('\n'), next.originalUI);
    storePreferences(nextPreferences).then(() => applyMigratedPreferences(nextPreferences)).catch(reportError);
  });
  const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.textContent = '导出全部迁移配置';
  exportButton.onclick = () => download(new Blob([JSON.stringify(preferences, null, 2)], { type: 'application/json' }), 'rpe-next-preferences.json');
  content.append(edit, exportButton);
});
readPreferences().then(saved => {
  if (saved) applyPreferences(migratePreferences(JSON.stringify(saved.originalSettings), Object.entries(saved.originalHotkeys).map(([key, value]) => `${key} ${value}`).join('\n'), saved.originalUI));
}).catch(error => status(`无法读取偏好设置：${error.message}`));

function applyDisplaySettings() {
  for (const [id, key, fallback] of displayFields) {
    const control = element(`#${id}`); const value = editorPreferences[key] ?? preferences.settings[key] ?? fallback;
    if (control.type === 'checkbox') control.checked = value; else control.value = value;
  }
  const ratioWidth = editorPreferences.ratioWidth ?? preferences.settings.ratioWidth;
  const ratioHeight = editorPreferences.ratioHeight ?? preferences.settings.ratioHeight;
  setRatioOptions(element('#preview-ratio'), ratioWidth, ratioHeight);
  preview.aspectRatio = realtimePreview.aspectRatio = ratioWidth / ratioHeight;
  applyViewControls({ ...editorPreferences, showGameUI: editorPreferences.showGameUI ?? preferences.settings.showGameUI }, timeline, [preview, realtimePreview]);
  for (const renderer of [preview, realtimePreview]) for (const key of ['lineNumbers', 'lineArrows', 'lineTint', 'mergeLineNumbers', 'pickPreviewLines']) renderer[key] = editorPreferences[key] ?? true;
  const toolbarMode = editorPreferences.toolbarMode ?? 'compact';
  element('.editor-toolbar').classList.remove('mode-compact', 'mode-icons', 'mode-wide');
  element('.editor-toolbar').classList.add(`mode-${toolbarMode}`);
  element('#toolbar-mode').title = `工具栏：${toolbarMode === 'icons' ? '图标' : toolbarMode === 'wide' ? '完整' : '紧凑'}（点击切换）`;
  timeline.barWidth = Number(element('#bar-width').value); timeline.barAlpha = Number(element('#bar-alpha').value);
  timeline.eventValueFontSize = Number(element('#event-value-size').value); timeline.eventOpacity = Number(element('#event-opacity').value); timeline.eventBarWidth = Number(element('#event-bar-width').value);
  timeline.seamlessEvents = element('#seamless-events').checked;
  preview.backgroundBlur = realtimePreview.backgroundBlur = Number(element('#background-blur').value);
  timeline.highlight = preview.highlight = realtimePreview.highlight = element('#highlight-notes').checked;
  audio.setPreservePitch(element('#preserve-pitch').checked);
  rotateTip();
  invalidate();
}
for (const [id, key] of displayFields) element(`#${id}`).addEventListener(element(`#${id}`).type === 'number' ? 'change' : 'input', event => {
  const control = event.target;
  if (control.type === 'checkbox') editorPreferences[key] = control.checked;
  else if (control.value.trim() && control.validity.valid && Number.isFinite(Number(control.value))) editorPreferences[key] = Number(control.value);
  else return;
  applyDisplaySettings(); persistEditor();
});
timeline.eventPlacementType = timeline.eventTypes[0];
