import { wheelSeconds } from '../core/edit-grid.mjs';

export class EditorPlayback {
  constructor(audio, sounds, onSeek) { this.audio = audio; this.sounds = sounds; this.onSeek = onSeek; this.request = 0; this.pending = false; this.lastWheel = -Infinity; this.burstStart = 0; }
  pause() { this.request++; this.pending = false; this.audio.pause(); this.sounds.stop(); }
  seek(seconds, pause = true) {
    if (pause) this.pause();
    this.audio.seek(seconds);
    this.sounds.stop(); this.onSeek();
  }
  async toggle(chart) {
    if (this.audio.playing || this.pending) { this.pause(); return; }
    const request = ++this.request; this.pending = true;
    try {
      this.sounds.chart = chart; await this.sounds.prepare();
      if (this.request === request) await this.audio.play();
    } finally { if (this.request === request) this.pending = false; }
  }
  wheel(event, settings, now) {
    if (now - this.lastWheel > 0.2) this.burstStart = now;
    this.lastWheel = now;
    const delta = wheelSeconds(event.deltaY, this.audio.duration, settings.scrollSpeed, this.audio.rate, settings.scrollAcceleration, now - this.burstStart, event.altKey);
    this.seek(this.audio.time + delta);
  }
}
