import { mediaType } from './files.ts';

export class AudioTransport {
  constructor(contextFactory = () => new AudioContext()) {
    this.contextFactory = contextFactory;
    this.context = null;
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.position = 0;
    this.rate = 1;
    this.volume = 0.75;
    this.anchor = 0;
    this.loadRevision = 0;
    this.playRevision = 0;
    this.preservePitch = true;
    this.media = null;
    this.mediaStart = null;
  }

  ensureContext() {
    if (!this.context) {
      this.context = this.contextFactory();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }

  async load(bytes, name = 'music.mp3') {
    const revision = ++this.loadRevision;
    this.pause();
    const context = this.ensureContext();
    let decoded;
    if (typeof Audio !== 'undefined') {
      const media = new Audio(); media.preload = 'auto';
      const url = URL.createObjectURL(new Blob([bytes], { type: mediaType(name) }));
      try {
        await new Promise((resolve, reject) => {
          const finish = error => {
            clearTimeout(timeout); media.onloadedmetadata = null; media.onerror = null;
            if (error) reject(error); else resolve();
          };
          const timeout = setTimeout(() => finish(new Error(`读取音乐 ${name} 超时，请检查文件或重新导入`)), 15000);
          media.onloadedmetadata = () => finish();
          media.onerror = () => finish(new Error(`无法解码音乐 ${name}；请检查文件完整性或转为 WAV/FLAC/MP3/OGG`));
          media.src = url;
        });
        if (typeof context.decodeAudioData === 'function') {
          try { decoded = await context.decodeAudioData(bytes.slice(0)); } catch { decoded = null; }
        }
        if (revision !== this.loadRevision) { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); return false; }
        this.releaseMedia(); this.media = media; this.mediaUrl = url;
        this.mediaSource = context.createMediaElementSource(media); this.mediaSource.connect(this.gain);
        media.playbackRate = this.rate; media.preservesPitch = this.preservePitch;
        this.buffer = decoded ?? null; this.position = 0; return true;
      } catch (error) { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url); if (revision === this.loadRevision) throw error; return false; }
    }
    decoded = await context.decodeAudioData(bytes.slice(0));
    if (revision !== this.loadRevision) return false;
    this.buffer = decoded;
    this.position = 0;
    return true;
  }

  releaseMedia() { if (this.media) { this.media.pause(); this.media.removeAttribute('src'); this.media.load(); this.mediaSource?.disconnect(); URL.revokeObjectURL(this.mediaUrl); this.media = null; } }
  clear() { this.loadRevision++; this.pause(); this.releaseMedia(); this.buffer = null; this.position = 0; }
  get duration() { return this.buffer?.duration || this.media?.duration || 600; }
  get usesMedia() { return Boolean(this.media && (!this.buffer || this.preservePitch && this.rate !== 1)); }
  get clockReady() {
    return this.playing && (!this.usesMedia || this.position < 0 || !this.mediaStart && !this.media.seeking && this.media.paused !== true && (this.media.readyState === undefined || this.media.readyState >= 2));
  }
  get scheduleHorizon() { return this.usesMedia && this.position < 0 ? 0 : Infinity; }
  get time() {
    if (!this.playing) return this.position;
    if (this.usesMedia && this.position >= 0) return this.mediaStart || this.media.seeking ? this.position : this.media.currentTime;
    return this.position + (this.context.currentTime - this.anchor) * this.rate;
  }

  async startMedia() {
    const media = this.media; const revision = this.playRevision;
    const start = { media, revision }; this.mediaStart = start;
    try {
      if (media.seeking) await new Promise((resolve, reject) => {
        const finish = error => {
          media.removeEventListener('seeked', seeked); media.removeEventListener('error', failed);
          start.cancel = null;
          if (error) reject(error); else resolve();
        };
        const seeked = () => { if (!media.seeking) finish(); };
        const failed = () => finish(new Error('音乐定位失败，请重新载入音频'));
        start.cancel = () => finish();
        media.addEventListener('seeked', seeked); media.addEventListener('error', failed);
        seeked();
      });
      if (revision !== this.playRevision || media !== this.media || !this.playing) return;
      await media.play();
      if (this.mediaStart === start && revision === this.playRevision && media === this.media && this.playing) this.mediaStart = null;
      if (revision !== this.playRevision && (!this.playing || media !== this.media)) media.pause();
    } catch (error) {
      if (revision === this.playRevision && media === this.media) { this.pause(); if (error.name !== 'AbortError') throw error; }
    }
  }

  async play() {
    if (this.playing) return;
    const revision = ++this.playRevision;
    await this.ensureContext().resume();
    if (revision !== this.playRevision || this.playing) return;
    if (this.position >= this.duration) this.position = 0;
    this.anchor = this.context.currentTime;
    this.playing = true;
    this.startSource();
    if (this.usesMedia && this.position >= 0) await this.startMedia();
  }

  startSource() {
    if (this.usesMedia) {
      const target = Math.max(0, this.position);
      if (Math.abs(this.media.currentTime - target) > 1e-7) this.media.currentTime = target;
      return;
    }
    if (!this.buffer || this.position >= this.duration) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.gain);
    source.start(this.context.currentTime + Math.max(0, -this.position) / this.rate, Math.max(0, this.position));
    this.source = source;
  }

  update() {
    if (!this.playing || !this.usesMedia || this.position >= 0 || this.time < 0) return;
    this.position = this.time; this.anchor = this.context.currentTime;
    this.playRevision++; this.startSource();
    this.startMedia().catch(error => { this.lastError = error; });
  }

  pause() {
    this.playRevision++;
    this.position = Math.min(this.time, this.duration);
    this.playing = false;
    this.stopSource();
  }

  stopSource() {
    this.mediaStart?.cancel?.();
    this.mediaStart = null;
    this.media?.pause();
    if (this.source) { this.source.stop(); this.source.disconnect(); this.source = null; }
  }

  seek(seconds) {
    if (!Number.isFinite(seconds)) throw new Error('非法播放位置');
    this.playRevision++;
    this.stopSource();
    this.position = Math.min(seconds, this.duration);
    if (this.position >= this.duration) this.playing = false;
    if (this.playing) {
      this.anchor = this.context.currentTime; this.startSource();
      if (this.usesMedia && this.position >= 0) {
        this.startMedia().catch(error => { this.lastError = error; });
      }
    } else if (this.usesMedia && Math.abs(this.media.currentTime - Math.max(0, this.position)) > 1e-7) this.media.currentTime = Math.max(0, this.position);
  }

  setRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('倍速必须大于零');
    const position = this.time;
    const wasMedia = this.usesMedia;
    this.rate = rate;
    if (this.media) this.media.playbackRate = rate;
    if (wasMedia && this.usesMedia) {
      this.position = position; this.anchor = this.context?.currentTime ?? 0;
      this.media.playbackRate = rate;
      if (!this.mediaStart) this.playRevision++;
    } else this.seek(position);
  }

  setVolume(volume) {
    if (!Number.isFinite(volume)) throw new Error('音量必须为有限数字');
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  setPreservePitch(enabled) {
    const position = this.time; const wasMedia = this.usesMedia;
    this.preservePitch = Boolean(enabled);
    if (this.media) this.media.preservesPitch = this.preservePitch;
    if (wasMedia !== this.usesMedia) this.seek(position);
  }
}
