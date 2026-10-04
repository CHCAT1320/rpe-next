import { SceneRuntime } from '../core/scene.mjs';
import { prepareCanvas, NOTE_COLORS } from './timeline.mjs';
import { DEFAULT_LINE_WIDTH, DEFAULT_LINE_HEIGHT, HIT_DURATION, hitFrame } from '../core/visual-constants.mjs';
import { previewViewport, simultaneousNotes, hitParticles } from '../core/editor-display.mjs';
import { renderPasses } from '../core/game-ui.mjs';
import { drawGameUi } from './game-ui.mjs';
import { recentHits } from '../core/hit-effects.mjs';
import { lineGuides, mergeGuides, pickGuide, formatLineNumbers } from '../core/preview-guides.mjs';
import { ShaderRuntime } from '../core/shader.mjs';
import { ShaderPipeline } from './shader-pipeline.mjs';

const clamp = value => Math.max(0, Math.min(1, value));

export class Preview {
  constructor(canvas) {
    this.canvas = canvas; this.scene = new SceneRuntime(); this.shaderRuntime = new ShaderRuntime(() => this.invalidate?.()); this.shaderPipeline = new ShaderPipeline(() => this.invalidate?.());
    this.allLines = true; this.visible = false; this.noteSize = 175; this.lineScale = 1.5; this.backgroundAlpha = 0.35; this.backgroundBlur = 0; this.effectsSince = Infinity; this.applyShaders = true;
    if (typeof document === 'undefined') { this.overlayCanvas = null; this.shaderCanvas = null; return; }
    this.overlayCanvas = document.createElement('canvas'); this.shaderCanvas = document.createElement('canvas');
    for (const [layer, canvasLayer] of [['shader', this.shaderCanvas], ['overlay', this.overlayCanvas]]) {
      canvasLayer.className = `preview-${layer}-layer`; canvasLayer.setAttribute('aria-hidden', 'true'); canvasLayer.style.position = 'absolute'; canvasLayer.style.inset = '0'; canvasLayer.style.width = '100%'; canvasLayer.style.height = '100%'; canvasLayer.style.pointerEvents = 'none'; canvasLayer.style.visibility = 'hidden'; canvasLayer.style.zIndex = layer === 'shader' ? '1' : '2';
      canvas.parentElement?.insertBefore(canvasLayer, canvas.nextSibling);
    }
  }

  draw(chart, tempo, seconds, selectedLine) {
    if (!this.visible) return;
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
    const background = this.images?.background;
    if (background) {
      const ratio = Math.max(1350 / background.naturalWidth, 900 / background.naturalHeight) * scale;
      context.globalAlpha = this.backgroundAlpha;
      context.filter = this.backgroundBlur > 0 ? `blur(${this.backgroundBlur}px)` : 'none';
      context.drawImage(background, (width - background.naturalWidth * ratio) / 2, (height - background.naturalHeight * ratio) / 2, background.naturalWidth * ratio, background.naturalHeight * ratio);
      context.filter = 'none';
      context.globalAlpha = 1;
    }
    const states = this.scene.sample(seconds);
    const order = this.allLines ? this.scene.order : [selectedLine];
    this.viewport = viewport; this.selectedLine = selectedLine;
    this.guides = lineGuides(states, chart.judgeLineList, order, width, height, scale);
    const visibleNotes = new Map(order.map(index => [index, this.scene.lines[index]?.visibleNotes(seconds, states[index], 1600 * divisor + Math.hypot(states[index]?.x ?? 0, states[index]?.y ?? 0)) ?? []]));
    for (const pass of this.passes) for (const index of pass.kind === 'line' ? [pass.index] : order) {
      if (pass.kind === 'line' && (!order.includes(index) || chart.judgeLineList[index].attachUI)) continue;
      const runtime = this.scene.lines[index];
      const state = states[index];
      if (!runtime) continue;
      context.save();
      context.translate(width / 2 + state.x * scale, height / 2 - state.y * scale);
      context.rotate(state.rotation * Math.PI / 180);
      if (pass.kind === 'line') this.drawLine(context, runtime.line, this.lineTint && index === selectedLine ? { ...state, color: [0, 200, 0] } : state, scale);
      else for (const entry of visibleNotes.get(index)) {
        const note = entry.note;
        if ((note.type === 2) !== (pass.kind === 'hold')) continue;
        const position = runtime.noteState(entry, state, seconds);
        const noteWidth = this.noteSize * scale * position.size;
        const horizontal = position.x * scale;
        context.save();
        context.globalAlpha = clamp(position.alpha);
        context.fillStyle = Array.isArray(note.color) ? `rgb(${note.color.join(',')})` : NOTE_COLORS[note.type];
        let drawnHold = false;
        const highlight = this.highlight !== false && this.simultaneous.has(note);
        if (note.type === 2) drawnHold = this.skin?.hold(context, horizontal, -position.y * scale, -position.tail * scale, noteWidth, highlight, position.showHead);
        if (note.type === 2 && !drawnHold) {
          context.globalAlpha *= 0.55;
          context.fillRect(horizontal - noteWidth / 2, -position.tail * scale, noteWidth, (position.tail - position.y) * scale);
          context.globalAlpha = clamp(position.alpha);
        }
        if (position.showHead && !drawnHold) {
          context.translate(horizontal, -position.y * scale);
          context.transform(1, 0, Math.tan(position.skew * Math.PI / 180), 1, 0, 0);
          if (!this.skin?.head(context, note.type, 0, 0, noteWidth, highlight)) context.fillRect(-noteWidth / 2, -2, noteWidth, 4);
        }
        context.restore();
      }
      context.restore();
    }
    const hitStates = new Map();
    for (const index of order) {
      const runtime = this.scene.lines[index];
      if (!runtime) continue;
      for (const hit of recentHits(runtime, seconds, this.effectsSince, Math.max(HIT_DURATION, 2 / 3))) {
        const { entry, time, seed } = hit;
        const frame = hitFrame(seconds - time);
        const picture = this.skin?.tinted(`img-${frame}`, entry.note.tintHitEffects ?? [255, 236, 160]);
        if (!hitStates.has(time)) hitStates.set(time, this.scene.sample(time));
        const state = hitStates.get(time)[index];
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
    if (this.canvas.style) this.canvas.style.opacity = shaderRendered ? '0' : '1';
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
        const text = formatLineNumbers(group.indices);
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
      const texture = defaultLine ? this.skin?.tinted('line', state.color) : this.images?.images.get(line.Texture);
      if (defaultLine) {
        if (texture) context.drawImage(texture, -DEFAULT_LINE_WIDTH * scale / 2, -DEFAULT_LINE_HEIGHT * scale / 2, DEFAULT_LINE_WIDTH * scale, DEFAULT_LINE_HEIGHT * scale);
        else context.fillRect(-DEFAULT_LINE_WIDTH * scale / 2, -DEFAULT_LINE_HEIGHT * scale / 2, DEFAULT_LINE_WIDTH * scale, DEFAULT_LINE_HEIGHT * scale);
      } else if (texture) {
        const anchor = line.anchor ?? [0.5, 0.5];
        context.drawImage(texture, -texture.naturalWidth * anchor[0] * scale, -texture.naturalHeight * (1 - anchor[1]) * scale, texture.naturalWidth * scale, texture.naturalHeight * scale);
      }
    }
    context.restore();
  }
}
