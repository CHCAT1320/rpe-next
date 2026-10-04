export function createSettingsPanel() {
  const dialog = document.createElement('dialog'); dialog.id = 'settings-modal';
  const title = document.createElement('h2'); title.textContent = '设置'; dialog.append(title);
  const body = document.createElement('div'); body.className = 'settings-body'; dialog.append(body);
  const group = (heading, fields) => {
    const section = document.createElement('section'); const title = document.createElement('h3'); title.textContent = heading; section.append(title);
    for (const [id, text, type, value, minimum, maximum, step] of fields) {
      const label = document.createElement('label'); label.className = 'field'; label.append(text);
      const input = document.createElement('input'); input.id = id; input.type = type; input.setAttribute('aria-label', text);
      if (type === 'checkbox') input.checked = value; else input.value = value;
      if (minimum !== undefined) input.min = minimum; if (maximum !== undefined) input.max = maximum; if (step !== undefined) input.step = step;
      label.append(input); section.append(label);
    }
    body.append(section);
  };
  group('显示与网格', [['bar-width', '节拍线宽度', 'range', 3, 0.5, 10, 0.1], ['bar-alpha', '节拍线亮度', 'range', 1, 0.1, 2, 0.05], ['event-value-size', '事件数值字号', 'range', 13, 8, 28, 1], ['event-opacity', '事件条不透明度', 'range', 0.25, 0.05, 1, 0.05], ['event-bar-width', '事件条宽度比例', 'range', 0.82, 0.35, 1, 0.01], ['highlight-notes', '同时音符高亮', 'checkbox', true], ['seamless-events', '连续事件无接缝', 'checkbox', true], ['background-blur', '背景高斯模糊', 'range', 10.5, 0, 30, 0.5]]);
  group('音频与播放', [['volume', '音乐音量', 'range', 0.75, 0, 1, 0.01], ['hit-volume', '打击音效音量', 'range', 0.3, 0, 1, 0.01], ['hit-enabled', '启用打击音效', 'checkbox', true], ['autoplay-view', '进入预览自动播放', 'checkbox', true], ['scroll-speed', '滚轮时间调整速度', 'range', 5, 0.1, 100, 0.1]]);
  group('实时预览判定线', [['line-numbers', '显示判定线编号', 'checkbox', true], ['line-arrows', '显示方向箭头', 'checkbox', true], ['line-tint', '当前判定线染色', 'checkbox', true], ['merge-line-numbers', '合并相近且同向的编号', 'checkbox', true], ['pick-preview-lines', '点击预览判定线切换编辑线', 'checkbox', true]]);
  group('提示与通知', [['tips-enabled', '显示右下角 Tips', 'checkbox', true], ['success-notifications', '显示绿色完成通知', 'checkbox', true]]);
  group('自动保存', [['autosave-enabled', '启用自动保存', 'checkbox', true], ['autosave-seconds', '自动保存间隔（秒）', 'number', 60, 1, 3600, 1], ['autosave-limit', '每谱保留备份数', 'number', 10, 1, 100, 1]]);
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '按固定间隔保存包含媒体的恢复副本，持续编辑不会推迟保存；手动保存更新谱面库。Y 缩放为绝对像素/秒，不随 BPM 或预览比例变化。'; body.append(hint);
  for (const selector of ['.preview-settings', '.display-settings', '.compatibility-details']) body.append(document.querySelector(selector));
  const hotkeys = document.createElement('button'); hotkeys.id = 'advanced-preferences'; hotkeys.textContent = '热键与原版配置';
  const close = document.createElement('button'); close.textContent = '完成'; close.onclick = () => dialog.close();
  const actions = document.createElement('div'); actions.className = 'modal-actions'; actions.append(hotkeys, close); dialog.append(actions); document.body.append(dialog);
  return dialog;
}
