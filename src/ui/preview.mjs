import { SceneRuntime } from '../core/scene.mjs';
import { blockScreen, blockState, blockTransform, blockShowCoverage } from '../core/block-area.mjs';
import { BlockPipeline } from './block-pipeline.mjs';
import { prepareCanvas, NOTE_COLORS } from './timeline.mjs';
import { DEFAULT_LINE_WIDTH, DEFAULT_LINE_HEIGHT, HIT_DURATION, hitFrame } from '../core/visual-constants.mjs';
import { previewViewport, simultaneousNotes, hitParticles } from '../core/editor-display.mjs';
import { renderPasses } from '../core/game-ui.mjs';
import { drawGameUi } from './game-ui.mjs';
import { recentHits } from '../core/hit-effects.mjs';
import { lineGuides, mergeGuides, pickGuide, formatLineNumbers } from '../core/preview-guides.mjs';
import { ShaderRuntime } from '../core/shader.mjs';
import { ShaderPipeline } from './shader-pipeline.mjs';
import { PreviewBackground, textureInViewport } from './preview-background.mjs';

const clamp = value => Math.max(0, Math.min(1, value));

export class Preview {
  constructor(canvas) {
    this.canvas = canvas; this.scene = new SceneRuntime(); this.shaderRuntime = new ShaderRuntime(() => this.invalidate?.()); this.shaderPipeline = new ShaderPipeline(() => this.invalidate?.());
    this.backgroundFrame = new PreviewBackground();
    this.allLines = true; this.visible = false; this.noteSize = 175; this.lineScale = 1.5; this.backgroundAlpha = 0.35; this.backgroundBlur = 10.5; this.effectsSince = Infinity; this.applyShaders = true; this.opacity = 1; this.showHitEffects = true; this.showBlocks = true;
    // Default to the ported pipeline. Starting on 'canvas' meant any settings save that happened
    // before `applyPreferences` ran would persist `blockPipeline: false` and pin the editor to the
    // approximation forever.
    this.blockRenderer = 'block'; this.blockSceneEffects = true; this.blockError = null; this.onBlockError = null;
    if (typeof document === 'undefined') { this.overlayCanvas = null; this.shaderCanvas = null; return; }
    this.overlayCanvas = document.createElement('canvas'); this.shaderCanvas = document.createElement('canvas');
    for (const [layer, canvasLayer] of [['shader', this.shaderCanvas], ['overlay', this.overlayCanvas]]) {
      canvasLayer.className = `preview-${layer}-layer`; canvasLayer.setAttribute('aria-hidden', 'true'); canvasLayer.style.position = 'absolute'; canvasLayer.style.inset = '0'; canvasLayer.style.width = '100%'; canvasLayer.style.height = '100%'; canvasLayer.style.pointerEvents = 'none'; canvasLayer.style.visibility = 'hidden'; canvasLayer.style.zIndex = layer === 'shader' ? '1' : '2';
      canvas.parentElement?.insertBefore(canvasLayer, canvas.nextSibling);
    }
  }

  draw(chart, tempo, seconds, selectedLine) {
    if (!this.visible) return;
    this.chart = chart;
    if (this.scene.chart !== chart || this.scene.tempo !== tempo) {
      this.scene.compile(chart, tempo); this.simultaneous = simultaneousNotes(chart, tempo);
      this.completionTimes = this.scene.lines.flatMap(runtime => runtime.notes.filter(entry => !entry.note.isFake).map(entry => entry.note.type === 2 ? entry.end : entry.start)).sort((left, right) => left - right);
      this.passes = renderPasses(chart.judgeLineList, this.scene.order);
      this.shaderRuntime.compile(chart, tempo);
    }
    const { context, width, height } = prepareCanvas(this.canvas);
    const viewport = previewViewport(width, height, this.aspectRatio ?? 1.5);
    const divisor = this.viewDivisor ?? 1;
    const scale = viewport.scale / divisor;
    context.save(); context.beginPath(); context.rect(viewport.left, viewport.top, viewport.width, viewport.height); context.clip();
    if (this.applyShaders) { context.fillStyle = '#111'; context.fillRect(viewport.left, viewport.top, viewport.width, viewport.height); }
    let background = this.images?.background;
    if (background && this.images.texture) background = this.images.texture(this.images.backgroundName, Math.max(1350 / background.naturalWidth, 900 / background.naturalHeight) * scale * (devicePixelRatio || 1)) ?? background;
    if (background) {
      context.globalAlpha = this.backgroundAlpha;
      this.backgroundFrame.draw(context, background, width, height, scale, this.backgroundBlur, devicePixelRatio || 1, this.images.backgroundAnimated);
      context.globalAlpha = 1;
    } else this.backgroundFrame.clear();
    const states = this.scene.sample(seconds);
    const order = this.allLines ? this.scene.order : [selectedLine];
    this.viewport = viewport; this.selectedLine = selectedLine;
    this.guides = lineGuides(states, chart.judgeLineList, order, width, height, scale);
    const visibleNotes = new Map(order.map(index => [index, this.scene.lines[index]?.visibleNotes(seconds, states[index], 1600 * divisor + Math.hypot(states[index]?.x ?? 0, states[index]?.y ?? 0)) ?? []]));
    for (const pass of this.passes) for (const index of pass.kind === 'line' ? [pass.index] : order) {
      if (pass.kind === 'line' && ((!this.allLines && index !== selectedLine) || chart.judgeLineList[index].attachUI || states[index].alpha <= 0 || states[index].scaleX === 0 || states[index].scaleY === 0)) continue;
      const runtime = this.scene.lines[index];
      const state = states[index];
      if (!runtime) continue;
      if (pass.kind === 'line' && !runtime.line.extended?.textEvents?.length) {
        const texture = runtime.line.Texture && runtime.line.Texture !== 'line.png'
          ? this.images?.describe?.(runtime.line.Texture) ?? this.images?.images.get(runtime.line.Texture)
          : { naturalWidth: DEFAULT_LINE_WIDTH, naturalHeight: DEFAULT_LINE_HEIGHT };
        if (!texture || texture.naturalWidth && !textureInViewport(texture, runtime.line, state, width, height, scale, viewport)) continue;
      }
      context.save();
      context.translate(width / 2 + state.x * scale, height / 2 - state.y * scale);
      context.rotate(state.rotation * Math.PI / 180);
      if (pass.kind === 'line') this.drawLine(context, runtime.line, this.lineTint && index === selectedLine ? { ...state, color: [0, 200, 0] } : state, scale);
      else for (const entry of visibleNotes.get(index)) {
        const note = entry.note;
        if ((note.type === 2) !== (pass.kind === 'hold')) continue;
        const position = runtime.noteState(entry, state, seconds);
        if (position.alpha <= 0 || position.size === 0) continue;
        const noteWidth = this.noteSize * scale * position.size;
        const horizontal = position.x * scale;
        context.save();
        context.globalAlpha = clamp(position.alpha);
        const tint = note.tint ?? note.color;
        context.fillStyle = Array.isArray(tint) ? `rgb(${tint.join(',')})` : NOTE_COLORS[note.type];
        let drawnHold = false;
        const highlight = this.highlight !== false && this.simultaneous.has(note);
        if (note.type === 2) drawnHold = this.skin?.hold(context, horizontal, -position.y * scale, -position.tail * scale, noteWidth, highlight, position.showHead, tint);
        if (note.type === 2 && !drawnHold) {
          context.globalAlpha *= 0.55;
          context.fillRect(horizontal - noteWidth / 2, -position.tail * scale, noteWidth, (position.tail - position.y) * scale);
          context.globalAlpha = clamp(position.alpha);
        }
        if (position.showHead && !drawnHold) {
          context.translate(horizontal, -position.y * scale);
          context.transform(1, 0, Math.tan(position.skew * Math.PI / 180), 1, 0, 0);
          if (!this.skin?.head(context, note.type, 0, 0, noteWidth, highlight, tint)) context.fillRect(-noteWidth / 2, -2, noteWidth, 4);
        }
        context.restore();
      }
      context.restore();
    }
    if (this.showHitEffects) {
      const hitStates = new Map();
      for (const index of order) {
        const runtime = this.scene.lines[index];
        if (!runtime) continue;
        for (const hit of recentHits(runtime, seconds, this.effectsSince, Math.max(HIT_DURATION, 2 / 3))) {
          const { entry, time, seed } = hit;
          const frame = hitFrame(seconds - time);
          const picture = frame === null ? null : this.skin?.tinted(`img-${frame}`, entry.note.tintHitEffects ?? [255, 236, 160]);
          if (!hitStates.has(time)) hitStates.set(time, this.scene.sampler(time));
          const state = hitStates.get(time)(index);
          const position = runtime.noteState(entry, state, time);
          const angle = state.rotation * Math.PI / 180;
          const horizontal = width / 2 + (state.x + position.x * Math.cos(angle) + position.y * Math.sin(angle)) * scale;
          const vertical = height / 2 + (-state.y + position.x * Math.sin(angle) - position.y * Math.cos(angle)) * scale;
          const size = this.noteSize * 1.4 * scale;
          if (picture) context.drawImage(picture, horizontal - size / 2, vertical - size / 2, size, size);
          context.fillStyle = `rgb(${(entry.note.tintHitEffects ?? [255, 236, 160]).join(',')})`;
          for (const particle of hitParticles(seconds - time, index * 65537 + seed, this.noteSize * scale)) {
            context.globalAlpha = particle.alpha;
            context.fillRect(horizontal + particle.x - particle.radius, vertical + particle.y - particle.radius, particle.radius * 2, particle.radius * 2);
          }
          context.globalAlpha = 1;
        }
      }
    }
    // BlockArea composites *over* the play field, not under it: the game's final step blits
    // ActiveBlock onto CameraTarget after the main camera has already drawn the background, the
    // judge lines and the notes, and it is semi-transparent, so the notes read through it.
    if (this.showBlocks) this.drawBlocks(context, seconds, viewport);
    const shaderEffects = this.applyShaders ? this.shaderRuntime.active(seconds) : [];
    const globalShader = shaderEffects.some(effect => effect.global);
    if (!shaderEffects.length && this.showGameUI) drawGameUi(context, chart, states, this.completionTimes, seconds, selectedLine, viewport, scale, this.skin, this.duration ?? 600);
    if (!shaderEffects.length) this.drawGuides(context, scale, selectedLine);
    if (globalShader) {
      if (this.showGameUI) drawGameUi(context, chart, states, this.completionTimes, seconds, selectedLine, viewport, scale, this.skin, this.duration ?? 600);
      this.drawGuides(context, scale, selectedLine);
    }
    context.restore();
    let shaderRendered = false;
    if (shaderEffects.length) {
      shaderRendered = this.shaderPipeline.render(this.canvas, this.shaderCanvas, shaderEffects, seconds, effect => this.shaderRuntime.source(effect.shader, effect.sourceName), viewport);
      if (this.shaderCanvas) this.shaderCanvas.style.visibility = shaderRendered ? 'visible' : 'hidden';
    } else if (this.shaderCanvas) this.shaderCanvas.style.visibility = 'hidden';
    if (this.canvas.style) this.canvas.style.opacity = shaderRendered ? '0' : String(clamp(this.opacity));
    for (const layer of [this.shaderCanvas, this.overlayCanvas]) if (layer) layer.style.opacity = String(clamp(this.opacity));
    if (!shaderRendered && shaderEffects.length && !globalShader) {
      context.save(); context.beginPath(); context.rect(viewport.left, viewport.top, viewport.width, viewport.height); context.clip();
      if (this.showGameUI) drawGameUi(context, chart, states, this.completionTimes, seconds, selectedLine, viewport, scale, this.skin, this.duration ?? 600);
      this.drawGuides(context, scale, selectedLine); context.restore();
    }
    if (shaderRendered && !globalShader && this.overlayCanvas) {
      const overlay = prepareCanvas(this.overlayCanvas); const overlayContext = overlay.context; overlayContext.clearRect(0, 0, overlay.width, overlay.height);
      if (this.showGameUI) drawGameUi(overlayContext, chart, states, this.completionTimes, seconds, selectedLine, viewport, scale, this.skin, this.duration ?? 600);
      this.drawGuides(overlayContext, scale, selectedLine);
      this.overlayCanvas.style.visibility = 'visible';
    } else if (this.overlayCanvas) this.overlayCanvas.style.visibility = 'hidden';
    this.images?.trim?.();
  }

  // BlockArea lives in its own screen space: blocks are anchored to screen percentages, not to any
  // judge line, so they must not inherit a line's translate/rotate. Drawn after the notes because
  // the game composites them on top of the finished scene.
  drawBlocks(context, seconds, viewport) {
    const blocks = this.chart?.blockAreas;
    if (!blocks?.length) return;
    if (this.blockRenderer === 'block' && this.drawBlocksPipeline(context, seconds, viewport)) return;
    if (this.blockRenderer === 'block') this.requestBlockPipeline();
    // Match the viewport's own aspect so world -> pixel stays uniform and rotation is not skewed.
    const aspect = viewport.width / viewport.height;
    const screen = blockScreen(aspect);
    const toX = (world) => viewport.left + (world / screen.x + 0.5) * viewport.width;
    const toY = (world) => viewport.top + (0.5 - world / screen.y) * viewport.height;
    const pixelPerWorldX = viewport.width / screen.x;
    const pixelPerWorldY = viewport.height / screen.y;
    for (const block of blocks) {
      const state = blockState(block, seconds);
      if (!state) continue;
      const { center, size, rotation } = blockTransform(block, seconds, aspect);
      const width = Math.abs(size.x) * pixelPerWorldX;
      const height = Math.abs(size.y) * pixelPerWorldY;
      if (!(width > 0) || !(height > 0)) continue;
      context.save();
      context.translate(toX(center.x), toY(center.y));
      // World space is y-up with counter-clockwise angles; the canvas is y-down, so negate.
      context.rotate(-rotation * Math.PI / 180);
      this.drawBlockBody(context, block, state, width, height, viewport.height, seconds);
      context.restore();
    }
  }

  drawBlockBody(context, block, state, width, height, viewportHeight, seconds) {
    const left = -width / 2;
    const top = -height / 2;
    // The game folds this into `renderer.color.a`; subtract blocks are near invisible in play and
    // rely on a scene-colour post-process this preview does not reproduce.
    const tint = block.isSubtract ? 0.1 : 1;
    const coverage = blockShowCoverage(block, seconds);
    context.save();
    if (state.active) {
      // Interior uses plain alpha. The game blends premultiplied (`One, OneMinusSrcAlpha`) while its
      // shader does not premultiply — the two cannot both hold, so this is the documented
      // compromise; the ring and halo below stay additive.
      context.globalAlpha = tint;
      context.fillStyle = 'rgba(182,60,60,0.667)';
      context.fillRect(left, top, width, height);
      context.globalCompositeOperation = 'lighter';
      // Ring: one effect texel outward (effectRT is a quarter of the screen height).
      const ring = Math.max(1, 0.0037 * viewportHeight);
      const ringLeft = left - ring / 2;
      const ringTop = top - ring / 2;
      const ringWidth = width + ring;
      const ringHeight = height + ring;
      context.strokeStyle = 'rgba(255,84,84,0.8)';
      context.lineWidth = ring;
      context.strokeRect(ringLeft, ringTop, ringWidth, ringHeight);
      // Halo: the same ring blurred, reaching roughly 1.85% of the screen height.
      context.shadowColor = 'rgba(255,46,46,0.8)';
      context.shadowBlur = 0.0185 * viewportHeight;
      context.strokeRect(ringLeft, ringTop, ringWidth, ringHeight);
    } else {
      // Disabled look: flat additive dark red, no edge, no glow. `coverage` reproduces the 0.5 s
      // colour fade that starts at appearTime. (Subtract blocks also fade magenta -> white over
      // that window; not modelled, as it runs at alpha 0.1.)
      context.globalCompositeOperation = 'lighter';
      context.globalAlpha = tint * coverage;
      context.fillStyle = 'rgba(127,35,35,0.4)';
      context.fillRect(left, top, width, height);
      if (state.ready) {
        // Ready adds a breathing overlay: 37.9 rad/s => ~6.03 Hz, multiplier range 0.5..1.5.
        // The game drives it from `_Time.y`; the playhead is used here so the preview is
        // deterministic and scrubbing shows the state at that instant.
        const pulse = Math.sin(seconds * 37.9) * 0.5 + 1;
        context.fillStyle = `rgba(255,255,255,${(0.12 * pulse).toFixed(4)})`;
        context.fillRect(left, top, width, height);
      }
    }
    context.restore();
    // Editor affordance rather than game behaviour: at alpha 0.1 a subtract block would otherwise
    // be almost impossible to see or reason about.
    if (block.isSubtract) {
      context.save();
      context.setLineDash([4, 3]);
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(255,120,255,0.85)';
      context.strokeRect(left, top, width, height);
      context.restore();
    }
  }

  /** Kick off the one-time load of the vendored shaders and textures. */
  requestBlockPipeline() {
    // A failure must not be retried every frame: each attempt allocates another canvas and another
    // WebGL context, which is how the earlier compile failure produced "Too many active WebGL
    // contexts" instead of one clear message. `setBlockRenderer` clears the flag for a manual retry.
    if (this.blockPipeline || this.blockPipelinePending || this.blockPipelineFailed || typeof document === 'undefined') return;
    this.blockPipelinePending = true;
    this.ensureBlockPipeline()
      .then(() => { this.blockPipelinePending = false; this.invalidate?.(); })
      .catch((error) => {
        this.blockPipelinePending = false;
        this.blockPipelineFailed = true;
        // Swallowing this used to make a dead pipeline indistinguishable from "the shaders were
        // never applied", with nothing to go on. Surface it instead: which program failed to
        // compile is the whole diagnosis.
        this.blockError = String((error && error.message) || error);
        this.onBlockError?.(this.blockError);
        if (typeof console !== 'undefined') console.error('块管线不可用，已回退 Canvas2D：', this.blockError);
      });
  }

  async ensureBlockPipeline() {
    if (this.blockPipeline) return this.blockPipeline;
    const base = `${import.meta.env?.BASE_URL ?? '/'}assets/rpe/block/`;
    const [shaders, materials] = await Promise.all([
      fetch(`${base}shaders.json`).then((response) => response.json()),
      fetch(`${base}materials.json`).then((response) => response.json()),
    ]);
    const canvas = document.createElement('canvas');
    const pipeline = new BlockPipeline();
    if (!pipeline.ensure(canvas, shaders, materials)) throw new Error(pipeline.lastError || '块管线不可用');
    await pipeline.loadImages(base);
    this.blockCanvas = canvas;
    this.blockPipeline = pipeline;
    return pipeline;
  }

  /**
   * Render the block layer with the ported GL pipeline and composite it into the 2D preview.
   *
   * The GL canvas stays off-DOM and is blitted with `drawImage`, which preserves the "blocks sit
   * under the notes" ordering that a separate DOM layer would lose. Premultiplied output makes
   * `drawImage` apply the same `src + dst·(1 − srcA)` blend the game's `ActiveBlock` uses.
   */
  drawBlocksPipeline(context, seconds, viewport) {
    const pipeline = this.blockPipeline;
    if (!pipeline || pipeline.disabled) return false;
    pipeline.sceneEffects = this.blockSceneEffects !== false;
    // `prepareCanvas` sets a devicePixelRatio transform on the 2D context, so `viewport` is in CSS
    // pixels while `canvas.width/height` are device pixels. The GL layer is sized in device pixels to
    // match the screen the game would render on, and blitted into the viewport's CSS rectangle — a
    // mismatch here scales and offsets every block by the device pixel ratio.
    const ratio = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(viewport.width * ratio));
    const height = Math.max(1, Math.round(viewport.height * ratio));
    try {
      const rendered = pipeline.render({
        blocks: this.chart?.blockAreas ?? [], now: seconds,
        aspect: viewport.width / viewport.height,
        width, height,
        // `blocks` draws after the background pass and before the notes, so the canvas at this point
        // is exactly the "camera target ahead of the block composite" that the game copies into
        // sceneColorRT. `ActiveBlock` samples it inside its spark/hue term, not as a blit.
        scene: this.canvas,
        // Crop the viewport out of the device-pixel canvas rather than squashing the whole scene.
        sceneView: { left: viewport.left * ratio, top: viewport.top * ratio, width, height },
      });
      if (!rendered) return false;
    } catch { return false; }
    this.lastBlockSeconds = seconds;
    this.lastBlockViewport = viewport;
    // Expose a readback diagnostic rather than making anyone describe a blank frame: the first
    // question is always whether the mask targets were written at all.
    if (typeof window !== 'undefined' && !window.__rpeBlockDiagnose) {
      window.__rpeBlockDiagnose = () => this.blockPipeline.diagnose(this.lastBlockSeconds, this.chart?.blockAreas ?? [], this.lastBlockViewport);
    }
    context.drawImage(this.blockCanvas, 0, 0, width, height,
      viewport.left, viewport.top, viewport.width, viewport.height);
    return true;
  }

  pick(clientX, clientY) {
    if (!this.visible || !this.pickPreviewLines || !this.viewport) return null;
    const rectangle = this.canvas.getBoundingClientRect();
    const point = { x: clientX - rectangle.left, y: clientY - rectangle.top };
    const view = this.viewport;
    if (point.x < view.left || point.x > view.left + view.width || point.y < view.top || point.y > view.top + view.height) return null;
    return pickGuide(this.guides ?? [], point, this.selectedLine);
  }

  drawGuides(context, scale, selectedLine) {
    if (!this.lineNumbers && !this.lineArrows) return;
    for (const group of mergeGuides(this.guides, scale, this.mergeLineNumbers)) {
      context.save(); context.translate(group.x, group.y); context.rotate(group.rotation * Math.PI / 180);
      const selected = group.indices.includes(selectedLine);
      context.fillStyle = selected ? '#00c800' : '#fff';
      if (this.lineNumbers) {
        context.font = `${30 * scale}px RPEGame, sans-serif`; context.textAlign = 'center'; context.textBaseline = 'top';
        const text = formatLineNumbers(group.indices, this.chart.judgeLineList);
        context.fillText(text, 0, 4 * scale);
      }
      if (this.lineArrows && selected) {
        const arrow = this.skin?.images.get('Arrow2');
        if (arrow) {
          context.save(); context.rotate(Math.PI); context.drawImage(arrow, -25 * scale, -25 * scale, 50 * scale, 50 * scale); context.restore();
        } else {
          context.beginPath(); context.moveTo(0, -24 * scale); context.lineTo(-12 * scale, -8 * scale); context.lineTo(12 * scale, -8 * scale); context.closePath(); context.fill();
        }
      }
      context.restore();
    }
  }

  drawLine(context, line, state, scale) {
    context.save();
    context.scale(state.scaleX, state.scaleY);
    context.globalAlpha = clamp(state.alpha / 255);
    context.fillStyle = `rgb(${state.color.map(value => Math.round(Math.max(0, Math.min(255, value)))).join(',')})`;
    if (line.extended?.textEvents?.length) {
      context.font = `${52 * scale}px RPE, sans-serif`;
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(state.text, 0, 0);
    } else {
      const defaultLine = !line.Texture || line.Texture === 'line.png';
      const descriptor = !defaultLine ? this.images?.describe?.(line.Texture) : null;
      const stateScale = scale * Math.max(Math.abs(state.scaleX), Math.abs(state.scaleY)) * (devicePixelRatio || 1);
      const maxViewportScale = descriptor?.naturalWidth && descriptor?.naturalHeight
        ? Math.min(2700 / descriptor.naturalWidth, 1800 / descriptor.naturalHeight)
        : Infinity;
      const decodeCap = Number.isFinite(maxViewportScale) && maxViewportScale < 1
        ? 2 ** Math.floor(Math.log2(Math.max(1 / 64, maxViewportScale)))
        : 1;
      const viewportScale = Math.min(stateScale, decodeCap);
      const rawTexture = defaultLine ? null : this.images?.texture ? this.images.texture(line.Texture, viewportScale) : this.images?.images.get(line.Texture);
      const source = rawTexture?.source ?? rawTexture;
      const texture = defaultLine ? this.skin?.tinted('line', state.color) : this.skin?.tintedSource(`line:${line.Texture}`, source, state.color);
      if (defaultLine) {
        if (texture) context.drawImage(texture, -DEFAULT_LINE_WIDTH * scale / 2, -DEFAULT_LINE_HEIGHT * scale / 2, DEFAULT_LINE_WIDTH * scale, DEFAULT_LINE_HEIGHT * scale);
        else context.fillRect(-DEFAULT_LINE_WIDTH * scale / 2, -DEFAULT_LINE_HEIGHT * scale / 2, DEFAULT_LINE_WIDTH * scale, DEFAULT_LINE_HEIGHT * scale);
      } else if (texture && rawTexture) {
        const anchor = line.anchor ?? [0.5, 0.5];
        const width = rawTexture.naturalWidth ?? rawTexture.width; const height = rawTexture.naturalHeight ?? rawTexture.height;
        context.drawImage(texture, -width * anchor[0] * scale, -height * (1 - anchor[1]) * scale, width * scale, height * scale);
      }
    }
    context.restore();
  }
}
