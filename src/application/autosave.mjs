export class AutoSaveClock {
  constructor(save, reportError) { this.save = save; this.reportError = reportError; this.last = 0; this.pending = false; }
  reset(now) { this.last = now; }
  async tick(now, enabled, seconds, dirty) {
    if (!enabled || !dirty || this.pending || now - this.last < seconds * 1000) return;
    this.last = now; this.pending = true;
    try { await this.save(); } catch (error) { this.reportError(error); }
    finally { this.pending = false; }
  }
}
