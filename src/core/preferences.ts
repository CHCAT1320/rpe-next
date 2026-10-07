/**
 * The shortcut map as the editor ships it.
 *
 * Every entry is a specification string (`'LEFTCTRL&Z'`), so the key set is the closed list of
 * actions `shortcutAction` can return; `MigratedPreferences.hotkeys` is built from it.
 */
export interface DefaultHotkeys {
  AddTap: string; AddDrag: string; AddFlick: string; AddHold: string; AddEvent: string; Pause: string; Save: string;
  Undo: string; Redo: string; SelectAll: string; Copy: string; Shear: string; Paste: string; PasteMirror: string;
  ClipboardHistory: string; NumberMirror: string; NumberFill: string;
  KeepTimePaste: string; KeepTimePasteMirror: string;
  Delete: string; QuickDelete: string; LastBeat: string; NextBeat: string; Esc: string;
  StartView: string; EndView: string; JumpView: string; ReplayView: string; StartView_HOLD: string; JumpView_HOLD: string;
  SwitchUI: string; ResetCamera: string; CurveBegin: string; CurveEnd: string;
  ToggleMultiLine: string; SwitchMultiLineMode: string;
}

/** The shortcut map parsed out of a legacy `Hotkey.txt`; keys are whatever the file contained. */
export type HotkeyMap = Record<string, string>;

/**
 * The keys read out of `preferences.hotkeys`.
 *
 * Legacy files may omit entries (a test deletes one), and stored JSON may replace one with a
 * non-string, which `shortcutAction` treats as a miss so `DEFAULT_HOTKEYS` still applies.
 */
export type HotkeySource = Partial<Record<keyof DefaultHotkeys, string | null | undefined>>;

/**
 * The input shape `shortcutAction` accepts.
 *
 * Preferred over `KeyboardEvent` because the tests pass plain object literals, and because
 * `shortcutKey` deliberately treats `code` and `isComposing` as optional.
 */
export interface ShortcutEvent {
  key?: string | null;
  code?: string | null;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * The editor settings derived from a legacy `Settings.json`.
 *
 * Every field is populated (each falls back to a hard-coded default), so the migrated record is
 * always complete even when the original file was missing or partial.
 */
export interface MigratedSettings {
  cutDensity: number;
  volume: number;
  hitVolume: number;
  noteSize: number;
  lineScale: number;
  gridCount: number;
  scrollSpeed: number;
  backgroundAlpha: number;
  realtimeAlpha: number;
  scrollAcceleration: boolean;
  historyLimit: number;
  autoSave: boolean;
  autoSaveSeconds: number;
  autoSaveLimit: number;
  ratioWidth: number;
  ratioHeight: number;
  barWidth: number;
  barAlpha: number;
  highlight: boolean;
  autoplayView: boolean;
  fpsLimit: number;
  showHotkey: boolean;
  showGameUI: boolean;
}

/** What the migration did to each legacy key: applied, or kept only in the exported file. */
export interface MigrationReport {
  appliedSettings: string[];
  retainedSettings: string[];
  appliedHotkeys: string[];
  retainedHotkeys: string[];
  layoutRetained: boolean;
}

/**
 * The migration record.
 *
 * `originalSettings` keeps the raw parsed `Settings.json` — it is read back by key
 * (`preferences.originalSettings.scrollValueIncrement`), re-serialized by the JSON editor, and
 * carried through untouched — so it is typed loosely on purpose; there is no honest narrower type
 * for a user-editable document. The other three fields are produced by this module and are exact.
 */
export interface MigratedPreferences {
  version: number;
  originalSettings: Record<string, unknown>;
  originalHotkeys: HotkeyMap;
  originalUI: string;
  hotkeys: DefaultHotkeys;
  settings: MigratedSettings;
  report: MigrationReport;
}

export const DEFAULT_HOTKEYS: DefaultHotkeys = {
  AddTap: 'Q', AddDrag: 'W', AddFlick: 'E', AddHold: 'R', AddEvent: 'R', Pause: 'SPACE', Save: 'LEFTCTRL&S',
  Undo: 'LEFTCTRL&Z', Redo: 'LEFTCTRL&Y', SelectAll: 'LEFTCTRL&A', Copy: 'LEFTCTRL&C',
  Shear: 'LEFTCTRL&X', Paste: 'LEFTCTRL&V', PasteMirror: 'LEFTCTRL&B',
  ClipboardHistory: 'LEFTCTRL&V', NumberMirror: 'A', NumberFill: 'S',
  KeepTimePaste: 'LEFTCTRL&LEFTSHIFT&V', KeepTimePasteMirror: 'LEFTCTRL&LEFTSHIFT&B',
  Delete: 'DELETE', QuickDelete: 'D', LastBeat: 'LEFTARROW', NextBeat: 'RIGHTARROW', Esc: 'ESCAPE',
  StartView: 'I', EndView: 'O', JumpView: 'P', ReplayView: 'LEFTBRACKET', StartView_HOLD: 'T', JumpView_HOLD: 'U',
  SwitchUI: 'LEFTALT&N', ResetCamera: 'LEFTCTRL&M', CurveBegin: 'LEFTCTRL&F', CurveEnd: 'LEFTCTRL&G',
  ToggleMultiLine: 'J', SwitchMultiLineMode: 'K',
};
export const SUPPORTED_SETTINGS: string[] = ['CutRho', 'MusicVolume', 'maxHistorySize', 'AutoSave', 'AutoSaveGap', 'AutoSaveLimit', 'FpsLimit', 'showHotkey', 'SEVolume', 'NoteSize', 'GridlineCount', 'ScrollSpeed', 'Alpha', 'RealTimeAlpha', 'ScrollAcc', 'ratioWidth', 'ratioHeight', 'BarWidth', 'BarAlpha', 'HighLight', 'autoplayT', 'showViewUI'];

export function parseHotkeys(text: string): HotkeyMap {
  const result: HotkeyMap = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (match && !line.trim().startsWith('//')) result[match[1]] = match[2].trim();
  }
  return result;
}

export function migratePreferences(settingsText: string = '{}', hotkeyText: string = '', uiText: string = ''): MigratedPreferences {
  // `JSON.parse` returns `any`; the value is bound as `unknown` first and then narrowed, so the
  // fields read below are only reachable after the shape check — previously nothing checked them.
  const parsedSettings: unknown = JSON.parse(settingsText.replace(/^\uFEFF/, ''));
  if (!parsedSettings || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) throw new Error('Settings.json 必须为对象');
  const originalSettings = parsedSettings as Record<string, unknown>;
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

/**
 * Clamps a legacy value into range, falling back when it is not a usable number.
 *
 * The parameter is `unknown` because it comes straight out of a user-editable JSON file;
 * `Number.isFinite` is the check that makes it a number from here on.
 */
function finiteRange(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
}

const keyNames: Record<string, string> = { ' ': 'SPACE', ARROWLEFT: 'LEFTARROW', ARROWRIGHT: 'RIGHTARROW', ARROWUP: 'UPARROW', ARROWDOWN: 'DOWNARROW', '[': 'LEFTBRACKET', ']': 'RIGHTBRACKET' };

export function shortcutKey(event: ShortcutEvent): string {
  let key = String(event.key ?? '').toUpperCase();
  if (event.isComposing || ['PROCESS', 'UNIDENTIFIED', 'DEAD', ''].includes(key)) {
    const code = String(event.code ?? '').toUpperCase();
    key = /^(KEY[A-Z]|DIGIT[0-9])$/.test(code) ? code.replace(/^(KEY|DIGIT)/, '') : code;
    if (key === 'BRACKETLEFT') key = 'LEFTBRACKET';
    if (key === 'BRACKETRIGHT') key = 'RIGHTBRACKET';
  }
  return keyNames[key] ?? key;
}

export function shortcutMatches(event: ShortcutEvent, specification: unknown): boolean {
  if (typeof specification !== 'string') return false;
  const parts = specification.toUpperCase().replaceAll(' ', '').split('&');
  const control = parts.some(part => ['LEFTCTRL', 'RIGHTCTRL', 'CTRL'].includes(part));
  const shift = parts.some(part => ['LEFTSHIFT', 'RIGHTSHIFT', 'SHIFT'].includes(part));
  const alt = parts.some(part => ['LEFTALT', 'RIGHTALT', 'ALT'].includes(part));
  const keys = parts.filter(part => !/^(LEFT|RIGHT)?(CTRL|SHIFT|ALT)$/.test(part));
  const key = shortcutKey(event);
  return keys.length === 1 && keys[0] === key && control === Boolean(event.ctrlKey || event.metaKey) && shift === Boolean(event.shiftKey) && alt === Boolean(event.altKey);
}

/**
 * The action a keydown triggers.
 *
 * `preferences` is read only for `hotkeys`, and a stored shortcut may be missing or a non-string,
 * so the source is modelled as optional entries rather than a complete map — an absent or invalid
 * entry falls back to `DEFAULT_HOTKEYS`, which is exactly what the lookup already does.
 */
export function shortcutAction(event: ShortcutEvent, preferences?: { hotkeys?: HotkeySource } | null, area: string = 'notes'): string | undefined {
  const actions = Object.keys(DEFAULT_HOTKEYS).filter(action => area === 'events' ? !['AddHold', 'AddDrag', 'AddFlick'].includes(action) : action !== 'AddEvent');
  return actions.find(action => shortcutMatches(event, preferences?.hotkeys?.[action as keyof DefaultHotkeys] ?? DEFAULT_HOTKEYS[action as keyof DefaultHotkeys]));
}

export function shortcutReleased(event: ShortcutEvent, specification: unknown): boolean {
  if (typeof specification !== 'string') return false;
  const key = shortcutKey(event);
  const alias = { CONTROL: 'CTRL', META: 'CTRL', SHIFT: 'SHIFT', ALT: 'ALT' }[key];
  return specification.toUpperCase().replaceAll(' ', '').split('&').some(part => part === key || alias && part.replace(/^(LEFT|RIGHT)/, '') === alias);
}
