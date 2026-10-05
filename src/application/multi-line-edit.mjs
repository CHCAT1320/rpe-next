export function normalizeLineIndices(indices, lineCount) {
  return [...new Set((indices ?? []).filter(index => Number.isInteger(index) && index >= 0 && index < lineCount))].sort((a, b) => a - b);
}

export function parseLineExpression(text, lineCount) {
  const values = [];
  for (const token of String(text ?? '').trim().split(/\s+/).filter(Boolean)) {
    const range = token.split(':');
    if (range.length === 1 && /^[-+]?\d+$/.test(token)) values.push(Number(token));
    else if (range.length === 2 && /^[-+]?\d+$/.test(range[0]) && /^[-+]?\d+$/.test(range[1])) {
      const start = Number(range[0]); const end = Number(range[1]);
      if (start > end) throw new Error(`线号范围无效：${token}`);
      for (let index = start; index <= end; index++) values.push(index);
    } else throw new Error(`无法解析线号：${token}`);
  }
  return normalizeLineIndices(values, lineCount);
}

export function formatLineExpression(indices) {
  const values = normalizeLineIndices(indices, Number.MAX_SAFE_INTEGER);
  const tokens = [];
  for (let index = 0; index < values.length;) {
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end++;
    const length = end - index + 1;
    tokens.push(length >= 3 ? `${values[index]}:${values[end]}` : values.slice(index, end + 1).join(' '));
    index = end + 1;
  }
  return tokens.join(' ');
}

export function multiLineState(session) {
  return { enabled: Boolean(session.multiLineEnabled), mode: session.multiLineMode === 'events' ? 'events' : 'notes', merge: session.multiLineMerge !== false, indices: normalizeLineIndices(session.multiLineIndices, session.chart.judgeLineList?.length ?? 0) };
}

export function setMultiLineState(session, state = {}) {
  session.multiLineEnabled = Boolean(state.enabled);
  session.multiLineMode = state.mode === 'events' ? 'events' : 'notes';
  session.multiLineMerge = state.merge !== false;
  session.multiLineIndices = normalizeLineIndices(state.indices, session.chart.judgeLineList?.length ?? 0);
  if (session.multiLineEnabled && !session.multiLineIndices.length && session.chart.judgeLineList?.length) session.multiLineIndices = [session.lineIndex];
  return multiLineState(session);
}

export function toggleLine(session, lineIndex) {
  const indices = new Set(session.multiLineIndices ?? []);
  if (indices.has(lineIndex)) indices.delete(lineIndex); else indices.add(lineIndex);
  return setMultiLineState(session, { enabled: indices.size > 0, mode: session.multiLineMode, indices: [...indices] });
}

export function lineIsSelected(session, lineIndex) { return multiLineState(session).indices.includes(lineIndex); }
