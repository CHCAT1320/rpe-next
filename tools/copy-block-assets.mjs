import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

// Vendors the BlockArea shaders and textures extracted from Phigros 4.0.1 into the project.
//
// The dump is not part of this repository: pass its docs/ directory via RPE_BLOCK_DUMP, or place it
// at the default path below. Re-run only when the dump changes; the output is committed.
//
// The extracted .glsl files are Unity's HLSLCC output. Four of them interleave two programs with a
// binary serialisation record header between them (already mangled to U+FFFD by a UTF-8 round
// trip), so each file is split at its `#ifdef VERTEX` markers and the trailing non-text bytes are
// discarded. That yields exactly 13 programs, matching docs/render.md.

const project = fileURLToPath(new URL('../', import.meta.url));
const dump = resolve(process.env.RPE_BLOCK_DUMP ?? 'E:/studyMyGame/dump/blockArea/docs');
const source = join(dump, 'shaders');
const textureSource = join(dump, 'tex');
const output = join(project, 'public/assets/rpe/block');

const TEXTURES = ['Block.png', 'BlockNoise1.png', 'FD_Noise.png', 'PointNoise.png'];

/** Split one Unity shader dump into programs of `{ vertex, fragment }`, dropping record headers. */
export function splitShaderPrograms(text) {
  const starts = [];
  for (let index = 0; index + 13 <= text.length; index++) {
    if (text.startsWith('#ifdef VERTEX', index)) starts.push(index);
  }
  return starts.map((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : text.length;
    // Everything after the shader text is the next program's record header; cut at the first
    // control character, which never occurs inside Unity's generated GLSL.
    const slice = text.slice(start, end);
    const cut = slice.search(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    const program = cut >= 0 ? slice.slice(0, cut) : slice;
    return { vertex: section(program, '#ifdef VERTEX', '#ifdef FRAGMENT'), fragment: section(program, '#ifdef FRAGMENT', null) };
  });
}

/** Take the body of one `#ifdef` section, dropping the surrounding guards. */
function section(program, open, close) {
  const from = program.indexOf(open);
  if (from < 0) throw new Error(`缺少 ${open}`);
  let body = program.slice(from + open.length);
  if (close) {
    const to = body.indexOf(close);
    if (to < 0) throw new Error(`缺少 ${close}`);
    body = body.slice(0, to);
  }
  // Each section closes with its own `#endif` (the last one before the next guard). Inner
  // HLSLCC feature blocks also use #endif, so strip only the trailing one.
  const trailing = body.lastIndexOf('#endif');
  if (trailing < 0) throw new Error('缺少收尾 #endif');
  body = body.slice(0, trailing) + body.slice(trailing + '#endif'.length);
  return `${body.trim()}\n`;
}

await mkdir(output, { recursive: true });
const manifest = { source: `Phigros 4.0.1 BlockArea (${dump}); shaders are Unity HLSLCC GLSL ES 3.00 output, textures are Pigeon Games assets reused for technical study.`, files: [], programs: {} };

const names = (await readdir(source)).filter((name) => name.endsWith('.glsl')).sort();
for (const name of names) {
  const key = name.replace(/^Unlit_/, '').replace(/\.glsl$/, '');
  const programs = splitShaderPrograms(await readFile(join(source, name), 'latin1'));
  if (!programs.length) throw new Error(`${name}: 未找到 program`);
  for (const program of programs) {
    if (!program.vertex.includes('#version 300 es') || !program.fragment.includes('#version 300 es')) throw new Error(`${name}: program 缺少 #version`);
  }
  manifest.programs[key] = programs;
  manifest.files.push({ path: `shaders/${name}`, programs: programs.length });
}
const programCount = Object.values(manifest.programs).reduce((sum, programs) => sum + programs.length, 0);
if (programCount !== 13) throw new Error(`期望 13 个 program，实际 ${programCount} 个`);

await writeFile(join(output, 'shaders.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const name of TEXTURES) {
  await copyFile(join(textureSource, name), join(output, name));
  manifest.files.push({ path: name, sha256: createHash('sha256').update(await readFile(join(textureSource, name))).digest('hex') });
}
await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ source: manifest.source, files: manifest.files }, null, 2)}\n`);
console.log(`已提取 ${programCount} 个 program / ${names.length} 个文件，并复制 ${TEXTURES.length} 张贴图到 public/assets/rpe/block/`);
