import { validateCurvePreset } from './curve-trajectory.mjs';

export function parseCurvePreset(source) {
  let value;
  try { value = JSON.parse(source); }
  catch (error) { throw new Error(`JSON 语法错误：${error.message}`); }
  return validateCurvePreset(value);
}

export function saveCurvePreset(presets, preset, originalName = null) {
  const valid = validateCurvePreset(preset);
  const index = originalName === null ? -1 : presets.findIndex(entry => entry.name === originalName);
  if (originalName !== null && index < 0) throw new Error('原预设已不存在，请作为新预设保存');
  if (presets.some((entry, position) => entry.name === valid.name && position !== index)) throw new Error('已有同名预设，请修改 name 或先编辑已有预设');
  const result = [...presets];
  if (index < 0) result.push(valid); else result[index] = valid;
  return result;
}

export function deleteCurvePreset(presets, name) {
  return presets.filter(entry => entry.name !== name);
}

export function copyCurvePreset(presets, preset) {
  const valid = validateCurvePreset(preset);
  let name = valid.name; let index = 1;
  while (presets.some(entry => entry.name === name)) {
    const suffix = `（副本 ${index++}）`;
    name = valid.name.slice(0, 80 - suffix.length) + suffix;
  }
  return { ...valid, name };
}
