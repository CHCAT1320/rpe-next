import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Renders the ported BlockArea pipeline on a real GL driver and reports what reached the
// framebuffer.
//
// The unit tests use a stub GL context, so they can only prove pass order, fixed-function state and
// sampler wiring. This runs the same pipeline inside Electron's Chromium: the vendored GLSL has to
// actually compile, link and rasterise. Run with `node tools/verify-block-gl.mjs`; it re-executes
// itself under Electron.

const project = fileURLToPath(new URL('../', import.meta.url));
const bundlePath = join(project, '.block-harness', 'harness.js');

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const child = spawn(electron, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    // DeepSeek Harness is itself an Electron app and exports this; leaving it set makes
    // `require('electron')` resolve to a path string instead of the API.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RPE_BLOCK_VERIFY: '1' },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app, BrowserWindow } = await import('electron');

  const TIMES = [58.7, 66, 73.5];
  const WIDTH = 480;
  const HEIGHT = 270;

  async function buildBundle() {
    const { build } = await import('vite');
    const result = await build({
      root: project,
      configFile: false,
      logLevel: 'error',
      build: {
        write: false,
        minify: false,
        target: 'es2022',
        lib: { entry: join(project, 'tools/block-harness-entry.mjs'), formats: ['iife'], name: 'BlockHarness', fileName: 'harness' },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const chunk = outputs.find((item) => item.type === 'chunk');
    if (!chunk) throw new Error('打包未产出 chunk');
    await mkdir(join(project, '.block-harness'), { recursive: true });
    await writeFile(bundlePath, chunk.code);
    return chunk.code;
  }

  // Hardware acceleration is deliberately left enabled: it is far faster, and the fallback to
  // SwiftShader is still a real GLSL compiler if no GPU is reachable.
  await app.whenReady();
  const report = { ok: false };
  try {
    process.stderr.write('打包 harness… ');
    const code = await buildBundle();
    process.stderr.write('完成\n');
    const shaders = JSON.parse(await readFile(join(project, 'public/assets/rpe/block/shaders.json'), 'utf8'));
    const materials = JSON.parse(await readFile(join(project, 'public/assets/rpe/block/materials.json'), 'utf8'));
    const blocks = JSON.parse(await readFile(join(project, 'test/fixtures/block-area.json'), 'utf8'));
    const assetBase = pathToFileURL(join(project, 'public/assets/rpe/block/')).href;

    const window = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false,
      webPreferences: { webSecurity: false, backgroundThrottling: false },
    });
    window.webContents.on('console-message', (_event, _level, message) => {
      if (/error|warn/i.test(message)) report.shaderLog = `${report.shaderLog ?? ''}${message}\n`;
    });
    await window.loadURL('data:text/html,<html><body></body></html>');
    await window.webContents.executeJavaScript(code);
    process.stderr.write('渲染中… ');
    const outcome = await window.webContents.executeJavaScript(
      `BlockHarness.run(${JSON.stringify({ shaders, materials, assetBase, blocks, times: TIMES, width: WIDTH, height: HEIGHT })})`,
    );
    process.stderr.write('完成\n');
    report.ok = outcome.ok;
    report.stage = outcome.stage;
    report.error = outcome.error;
    report.shaderLog = report.shaderLog ?? null;
    report.programs = outcome.programs;
    report.renderer = await window.webContents.executeJavaScript(
      `(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); if (!gl) return null; const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`,
    );
    report.results = outcome.results;
  } catch (error) {
    report.error = String(error && error.stack || error);
  }
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}
