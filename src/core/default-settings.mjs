// Shared defaults for new browser and desktop profiles. Saved preferences take precedence.
export const DEFAULT_SETTINGS = Object.freeze({
  "cutDensity": 4,
  "volume": 0.51,
  "hitVolume": 0.2573,
  "noteSize": 200,
  "lineScale": 1.5,
  "gridCount": 21,
  "scrollSpeed": 5,
  "wheelStopAtAudioStart": true,
  "drawEventCurves": true,
  "backgroundAlpha": 0.23529411764705882,
  "realtimeAlpha": 0.05,
  "scrollAcceleration": true,
  "historyLimit": 30,
  "autoSave": true,
  "autoSaveSeconds": 240,
  "autoSaveLimit": 10,
  "ratioWidth": 3,
  "ratioHeight": 2,
  "barWidth": 3,
  "barAlpha": 0.6,
  "highlight": true,
  "autoplayView": true,
  "fpsLimit": 120,
  "showHotkey": false,
  "showGameUI": true
});

export const DEFAULT_EDITOR_PREFERENCES = Object.freeze({
  "scale": 600,
  "division": 4,
  "snapX": true,
  "judgementOffset": 92,
  "realtime": true,
  "hitEnabled": true,
  "allLines": true,
  "toolbarMode": "icons",
  "analysisEnabled": false,
  "analysisMode": "waveform",
  "analysisAlpha": 0.2,
  "analysisWidth": 0.62,
  "notesOnly": false,
  "eventOpacity": 0.45,
  "eventBarWidth": 0.73,
  "dragSensitivity": 1,
  "tipsEnabled": false
});

export const DEFAULT_APPEARANCE = Object.freeze({
  "editorSkin": "inkline",
  "editorSkinOptions": {
    "inkline": {
      "variant": "base",
      "parameters": {}
    },
    "default": {
      "variant": "base",
      "parameters": {}
    }
  },
  "noteSkin": "default"
});
