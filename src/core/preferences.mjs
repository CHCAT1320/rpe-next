import { normalizeShortcutKey, parseShortcut } from './shortcut-spec.mjs';

export const DEFAULT_HOTKEYS = {
  AddTap: 'Q', AddDrag: 'W', AddFlick: 'E', AddHold: 'R', AddEvent: 'R', Pause: 'SPACE', Save: 'LEFTCTRL&S',
  Undo: 'LEFTCTRL&Z', Redo: 'LEFTCTRL&Y', SelectAll: 'LEFTCTRL&A', Copy: 'LEFTCTRL&C',
  Shear: 'LEFTCTRL&X', Paste: 'LEFTCTRL&V', PasteMirror: 'LEFTCTRL&B',
  ClipboardHistory: 'LEFTCTRL&V', NumberMirror: 'A', NumberFill: 'S',
  KeepTimePaste: 'LEFTCTRL&LEFTSHIFT&V', KeepTimePasteMirror: 'LEFTCTRL&LEFTSHIFT&B',
  Delete: 'DELETE', QuickDelete: 'D', LastBeat: 'LEFTARROW', NextBeat: 'RIGHTARROW', Esc: 'ESCAPE',
  StartView: 'I', EndView: 'O', JumpView: 'P', ReplayView: 'LEFTBRACKET', StartView_HOLD: 'T', JumpView_HOLD: 'U',
  SwitchUI: 'LEFTALT&N', ResetCamera: 'LEFTCTRL&M', CurveBegin: 'LEFTCTRL&F', CurveEnd: 'LEFTCTRL&G',
  ToggleMultiLine: 'J', SwitchMultiLineMode: 'K',
  ShowLineInfo: 'TAB', PageLeft: 'LEFTARROW', PageRight: 'RIGHTARROW', PageUp: 'UPARROW', PageDown: 'DOWNARROW',
};
export const SUPPORTED_SETTINGS = ['CutRho', 'MusicVolume', 'maxHistorySize', 'AutoSave', 'AutoSaveGap', 'AutoSaveLimit', 'FpsLimit', 'showHotkey', 'SEVolume', 'NoteSize', 'LineScale', 'GridlineCount', 'ScrollSpeed', 'Alpha', 'RealTimeAlpha', 'ScrollAcc', 'ratioWidth', 'ratioHeight', 'BarWidth', 'BarAlpha', 'HighLight', 'autoplayT', 'showViewUI'];

export function parseHotkeys(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)(?:\s+(.*))?$/);
    if (match && !line.trim().startsWith('//')) result[match[1]] = match[2]?.trim() === 'NONE' ? '' : match[2]?.trim() ?? '';
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
      cutDensity: finiteRange(originalSettings.CutRho, 0.1, 128, 4),
      volume: finiteRange(originalSettings.MusicVolume, 0, 1, 0.75),
      hitVolume: finiteRange(originalSettings.SEVolume, 0, 1, 0.3),
      noteSize: finiteRange(originalSettings.NoteSize, 10, 500, 175),
      lineScale: finiteRange(originalSettings.LineScale, 0.1, 10, 1.5),
      gridCount: finiteRange(originalSettings.GridlineCount, 2, 100, 11),
      scrollSpeed: finiteRange(originalSettings.ScrollSpeed, 0.1, 100, 5),
      backgroundAlpha: finiteRange(originalSettings.Alpha, 0, 255, 80) / 255,
      realtimeAlpha: finiteRange(originalSettings.RealTimeAlpha, 0, 1, 0.1),
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

export function shortcutKey(event) {
  let key = String(event.key ?? '').toUpperCase();
  if (event.shiftKey) {
    const base = { Minus: 'MINUS', Equal: 'EQUAL', Comma: 'COMMA', Period: 'PERIOD', Slash: 'SLASH', Backslash: 'BACKSLASH', Semicolon: 'SEMICOLON', Quote: 'QUOTE', Backquote: 'TILDE', BracketLeft: 'LEFTBRACKET', BracketRight: 'RIGHTBRACKET' }[event.code];
    if (base) key = base;
    else if (/^Digit[0-9]$/.test(event.code ?? '')) key = event.code.slice(-1);
  }
  if (event.isComposing || ['PROCESS', 'UNIDENTIFIED', 'DEAD', ''].includes(key)) {
    const code = String(event.code ?? '').toUpperCase();
    key = /^(KEY[A-Z]|DIGIT[0-9])$/.test(code) ? code.replace(/^(KEY|DIGIT)/, '') : code;
    if (key === 'BRACKETLEFT') key = 'LEFTBRACKET';
    if (key === 'BRACKETRIGHT') key = 'RIGHTBRACKET';
  }
  if (['CONTROL', 'META', 'ALT', 'SHIFT'].includes(key)) return key;
  return normalizeShortcutKey(keyNames[key] ?? key);
}

export function shortcutMatches(event, specification) {
  if (typeof specification !== 'string') return false;
  const parsed = parseShortcut(specification);
  if (parsed.error || !parsed.value) return false;
  const parts = parsed.parts;
  const control = parts.some(part => ['LEFTCTRL', 'RIGHTCTRL', 'CTRL'].includes(part));
  const shift = parts.some(part => ['LEFTSHIFT', 'RIGHTSHIFT', 'SHIFT'].includes(part));
  const alt = parts.some(part => ['LEFTALT', 'RIGHTALT', 'ALT'].includes(part));
  const keys = parts.filter(part => !/^(LEFT|RIGHT)?(CTRL|SHIFT|ALT)$/.test(part));
  const key = shortcutKey(event);
  return keys.length === 1 && keys[0] === key && control === Boolean(event.ctrlKey || event.metaKey) && shift === Boolean(event.shiftKey) && alt === Boolean(event.altKey);
}

export function shortcutAction(event, preferences, area = 'notes', { hasSelection = false } = {}) {
  const actions = Object.keys(DEFAULT_HOTKEYS).filter(action => {
    if (action.startsWith('Page')) return hasSelection;
    if (hasSelection && ['LastBeat', 'NextBeat'].includes(action)) return false;
    return area === 'events' ? !['AddHold', 'AddDrag', 'AddFlick'].includes(action) : action !== 'AddEvent';
  });
  return actions.find(action => shortcutMatches(event, preferences?.hotkeys?.[action] ?? DEFAULT_HOTKEYS[action]));
}

export function shortcutReleased(event, specification) {
  if (typeof specification !== 'string') return false;
  const key = shortcutKey(event);
  const alias = { CONTROL: 'CTRL', META: 'CTRL', SHIFT: 'SHIFT', ALT: 'ALT' }[key];
  return (parseShortcut(specification).parts ?? []).some(part => part === key || alias && part.replace(/^(LEFT|RIGHT)/, '') === alias);
}
