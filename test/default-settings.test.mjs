import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, DEFAULT_EDITOR_PREFERENCES, DEFAULT_APPEARANCE } from '../src/core/default-settings.mjs';
import { migratePreferences } from '../src/core/preferences.mjs';
import { normalizeEditorPreferences } from '../src/platform/editor-preferences.mjs';

test('fresh browser and desktop preferences use the calibrated shared defaults', () => {
  assert.deepEqual(migratePreferences().settings, DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.volume, 0.51); assert.equal(DEFAULT_SETTINGS.hitVolume, 0.2573);
  assert.equal(DEFAULT_SETTINGS.noteSize, 200); assert.equal(DEFAULT_SETTINGS.gridCount, 21);
  assert.equal(DEFAULT_SETTINGS.fpsLimit, 120); assert.equal(DEFAULT_SETTINGS.autoSaveSeconds, 240);
  assert.equal(DEFAULT_SETTINGS.historyLimit, 30); assert.equal(DEFAULT_SETTINGS.realtimeAlpha, 0.05);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.scale, 600);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.eventOpacity, 0.45); assert.equal(DEFAULT_EDITOR_PREFERENCES.eventBarWidth, 0.73);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.tipsEnabled, false);
  assert.deepEqual(normalizeEditorPreferences(DEFAULT_EDITOR_PREFERENCES), DEFAULT_EDITOR_PREFERENCES);
  assert.equal(DEFAULT_APPEARANCE.editorSkin, 'inkline');
  assert.ok(!Object.keys(DEFAULT_SETTINGS).some(key => Object.hasOwn(DEFAULT_EDITOR_PREFERENCES, key)));
});

test('stored migrated settings and explicit editor settings continue to override defaults, including false and zero', () => {
  const migrated = migratePreferences(JSON.stringify({ MusicVolume: 0, GridlineCount: 9, NoteSize: 140, FpsLimit: 0, showViewUI: false, ScrollAcc: false, showHotkey: true }));
  assert.equal(migrated.settings.volume, 0); assert.equal(migrated.settings.gridCount, 9);
  assert.equal(migrated.settings.noteSize, 140); assert.equal(migrated.settings.fpsLimit, 0);
  assert.equal(migrated.settings.showGameUI, false); assert.equal(migrated.settings.scrollAcceleration, false);
  assert.equal(migrated.settings.showHotkey, true);
  const saved = { scale: 333, volume: 0.2, eventOpacity: 0.7, tipsEnabled: true };
  const editor = { ...DEFAULT_EDITOR_PREFERENCES, ...normalizeEditorPreferences(saved) };
  assert.equal(editor.scale, 333); assert.equal(editor.volume, 0.2); assert.equal(editor.eventOpacity, 0.7); assert.equal(editor.tipsEnabled, true);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.scale, 600);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.dragSensitivity, 1);
  assert.equal(normalizeEditorPreferences({ dragSensitivity: 99 }).dragSensitivity, 8);
  assert.equal(normalizeEditorPreferences({ dragSensitivity: 0 }).dragSensitivity, 0.1);
  assert.equal(normalizeEditorPreferences({ dragSensitivity: 2.5 }).dragSensitivity, 2.5);
});
