export const DEFAULT_HOTKEYS = {
  AddTap: 'Q', AddDrag: 'W', AddFlick: 'E', AddHold: 'R', AddEvent: 'R', Pause: 'SPACE', Save: 'LEFTCTRL&S',
  Undo: 'LEFTCTRL&Z', Redo: 'LEFTCTRL&Y', SelectAll: 'LEFTCTRL&A', Copy: 'LEFTCTRL&C',
  Shear: 'LEFTCTRL&X', Paste: 'LEFTCTRL&V', PasteMirror: 'LEFTCTRL&B',
  KeepTimePaste: 'LEFTCTRL&LEFTSHIFT&V', KeepTimePasteMirror: 'LEFTCTRL&LEFTSHIFT&B',
  Delete: 'DELETE', QuickDelete: 'D', LastBeat: 'LEFTARROW', NextBeat: 'RIGHTARROW', Esc: 'ESCAPE',
  StartView: 'I', EndView: 'O', JumpView: 'P', ReplayView: 'LEFTBRACKET', StartView_HOLD: 'T', JumpView_HOLD: 'U',
  SwitchUI: 'LEFTALT&N', ResetCamera: 'LEFTCTRL&M', CurveBegin: 'LEFTCTRL&F', CurveEnd: 'LEFTCTRL&G',
};
export const SUPPORTED_SETTINGS = ['MusicVolume', 'maxHistorySize', 'AutoSave', 'AutoSaveGap', 'AutoSaveLimit', 'FpsLimit', 'showHotkey', 'SEVolume', 'NoteSize', 'GridlineCount', 'ScrollSpeed', 'Alpha', 'RealTimeAlpha', 'ScrollAcc', 'ratioWidth', 'ratioHeight', 'BarWidth', 'BarAlpha', 'HighLight', 'autoplayT', 'showViewUI'];

export function parseHotkeys(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (match && !line.trim().startsWith('//')) result[match[1]] = match[2].trim();
  }
  return result;
}

export function migratePreferences(settingsText = '{}', hotkeyText = '', uiText = '') {
  const originalSettings = JSON.parse(settingsText.replace(/^\uFEFF/, ''));
  if (!originalSettings || typeof originalSettings !== 'object' || Array.isArray(originalSettings)) throw new Error('Settings.json 必须为对象');
  const originalHotkeys = parseHotkeys(hotkeyText);
  const applied = Object.keys(originalSettings).filter(key => SUPPORTED_SETTINGS.includes(key));
  return { version: 1, originalSettings, originalHotkeys, originalUI: uiText,
    hotkeys: { ...DEFAULT_HOTKEYS, ...originalHotkeys },
    settings: {
      volume: finiteRange(originalSettings.MusicVolume, 0, 1, 0.75),
      hitVolume: finiteRange(originalSettings.SEVolume, 0, 1, 0.5),
      noteSize: finiteRange(originalSettings.NoteSize, 10, 500, 175),
      lineScale: finiteRange(originalSettings.LineScale, 0.1, 10, 1.5),
      gridCount: finiteRange(originalSettings.GridlineCount, 2, 100, 11),
      scrollSpeed: finiteRange(originalSettings.ScrollSpeed, 0.1, 100, 5),
      backgroundAlpha: finiteRange(originalSettings.Alpha, 0, 255, 80) / 255,
      realtimeAlpha: finiteRange(originalSettings.RealTimeAlpha, 0, 1, 0.25),
      scrollAcceleration: originalSettings.ScrollAcc === true,
      historyLimit: Math.round(finiteRange(originalSettings.maxHistorySize, 1, 1000, 150)),
      autoSave: originalSettings.AutoSave !== false,
      autoSaveSeconds: finiteRange(originalSettings.AutoSaveGap, 1, 3600, 60),
      autoSaveLimit: Math.round(finiteRange(originalSettings.AutoSaveLimit, 1, 100, 10)),
      ratioWidth: finiteRange(originalSettings.ratioWidth, 1, 100, 3), ratioHeight: finiteRange(originalSettings.ratioHeight, 1, 100, 2),
      barWidth: finiteRange(originalSettings.BarWidth, 0.5, 10, 3), barAlpha: finiteRange(originalSettings.BarAlpha, 0.1, 2, 1),
      highlight: originalSettings.HighLight !== false, autoplayView: originalSettings.autoplayT !== false,
      fpsLimit: finiteRange(originalSettings.FpsLimit, 15, 240, 120),
      showHotkey: originalSettings.showHotkey !== false,
      showGameUI: originalSettings.showViewUI === true,
    },
    report: { appliedSettings: applied, retainedSettings: Object.keys(originalSettings).filter(key => !applied.includes(key)),
      appliedHotkeys: Object.keys(originalHotkeys).filter(key => key in DEFAULT_HOTKEYS),
      retainedHotkeys: Object.keys(originalHotkeys).filter(key => !(key in DEFAULT_HOTKEYS)),
      layoutRetained: Boolean(uiText) } };
}

function finiteRange(value, minimum, maximum, fallback) {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

const keyNames = { ' ': 'SPACE', ARROWLEFT: 'LEFTARROW', ARROWRIGHT: 'RIGHTARROW', ARROWUP: 'UPARROW', ARROWDOWN: 'DOWNARROW', '[': 'LEFTBRACKET', ']': 'RIGHTBRACKET' };

export function shortcutMatches(event, specification) {
  const parts = specification.toUpperCase().replaceAll(' ', '').split('&');
  const control = parts.some(part => ['LEFTCTRL', 'RIGHTCTRL', 'CTRL'].includes(part));
  const shift = parts.some(part => ['LEFTSHIFT', 'RIGHTSHIFT', 'SHIFT'].includes(part));
  const alt = parts.some(part => ['LEFTALT', 'RIGHTALT', 'ALT'].includes(part));
  const keys = parts.filter(part => !/^(LEFT|RIGHT)?(CTRL|SHIFT|ALT)$/.test(part));
  const key = keyNames[event.key.toUpperCase()] ?? event.key.toUpperCase();
  return keys.length === 1 && keys[0] === key && control === Boolean(event.ctrlKey || event.metaKey) && shift === Boolean(event.shiftKey) && alt === Boolean(event.altKey);
}

export function shortcutAction(event, preferences, area = 'notes') {
  const actions = Object.keys(DEFAULT_HOTKEYS).filter(action => area === 'events' ? !['AddHold', 'AddDrag', 'AddFlick'].includes(action) : action !== 'AddEvent');
  return actions.find(action => shortcutMatches(event, preferences.hotkeys[action] ?? DEFAULT_HOTKEYS[action]));
}

export function shortcutReleased(event, specification) {
  const key = keyNames[event.key.toUpperCase()] ?? event.key.toUpperCase();
  const alias = { CONTROL: 'CTRL', META: 'CTRL', SHIFT: 'SHIFT', ALT: 'ALT' }[key];
  return specification.toUpperCase().replaceAll(' ', '').split('&').some(part => part === key || alias && part.replace(/^(LEFT|RIGHT)/, '') === alias);
}
