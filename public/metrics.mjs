// Clocks use performance.now() within a page and wall time only across reloads.
export class ResponseMetrics {
  constructor(prior = null, { monotonic = () => performance.now(), wall = () => Date.now(), visible = true } = {}) {
    this.monotonic = monotonic; this.wall = wall; this.visible = visible;
    this.last = monotonic(); this.loadedAt = this.last; this.playing = false; this.waiting = false; this.frozen = false;
    this.state = {
      metricsVersion: 2, openedAt: wall(), firstAt: null, requestedAt: null,
      activeMs: 0, viewingMs: 0, plays: 0, hiddenMs: 0, hiddenCount: 0,
      pauses: 0, reloads: 0, bufferingMs: 0, bufferingCount: 0,
      timeToPlayMs: null, firstFrameDelayMs: null, loadMs: null, timingSource: 'not-played',
      ...prior
    };
    if (prior) {
      this.state.reloads = (prior.reloads || 0) + 1;
      if (prior.metricsVersion !== 2 && prior.firstAt != null) this.state.timingSource = 'legacy-playing';
    }
    this.state.metricsVersion = 2;
  }
  tick() {
    const time = this.monotonic(), delta = Math.max(0, time - this.last); this.last = time;
    if (this.frozen) return;
    if (this.visible) {
      if (this.state.firstAt != null) this.state.activeMs += delta;
      if (this.playing && !this.waiting && this.state.firstAt != null) this.state.viewingMs += delta;
      if (this.waiting) this.state.bufferingMs += delta;
    } else if (this.state.firstAt != null) this.state.hiddenMs += delta;
  }
  ready() {
    this.tick();
    if (this.state.loadMs == null) this.state.loadMs = Math.max(0, this.monotonic() - this.loadedAt);
  }
  requestPlay() {
    this.tick();
    if (this.state.requestedAt == null) {
      this.state.requestedAt = this.wall();
      this.state.timeToPlayMs = Math.max(0, this.wall() - this.state.openedAt);
    }
  }
  playback(playing, newRun = false) {
    this.tick(); this.playing = playing; this.waiting = false;
    if (playing && newRun && !this.frozen) this.state.plays++;
  }
  firstFrame(source) {
    this.tick();
    if (this.frozen || !this.visible) return;
    if (this.state.firstAt == null) {
      this.state.firstAt = this.wall(); this.state.timingSource = source;
      this.state.firstFrameDelayMs = this.state.requestedAt == null ? null : Math.max(0, this.wall() - this.state.requestedAt);
    }
  }
  manualPause() { this.tick(); if (!this.frozen) this.state.pauses++; this.playback(false); }
  buffer() { this.tick(); if (this.playing && !this.waiting && !this.frozen) { this.state.bufferingCount++; this.waiting = true; } }
  visibility(visible) {
    this.tick();
    if (this.visible && !visible && this.state.firstAt != null && !this.frozen) this.state.hiddenCount++;
    this.visible = visible;
  }
  snapshot() { this.tick(); return { ...this.state }; }
  freeze() { this.tick(); this.frozen = true; }
  answerPayload({ answerInput = 'unknown', viewportWidth, viewportHeight, videoWidth }) {
    this.freeze(); const s = this.state;
    const clamp = (value, limit = 3_600_000) => Math.max(0, Math.min(limit, Math.round(value)));
    const optional = value => value == null ? null : clamp(value, 86_400_000);
    return {
      activeMs: clamp(s.activeMs), elapsedMs: s.firstAt == null ? 0 : clamp(this.wall() - s.firstAt, 86_400_000),
      viewingMs: clamp(s.viewingMs), replays: clamp(Math.max(0, s.plays - 1), 1000),
      metrics: {
        version: 2, responseMs: s.firstAt == null ? null : clamp(s.activeMs),
        taskMs: clamp(this.wall() - s.openedAt, 86_400_000), timeToPlayMs: optional(s.timeToPlayMs),
        firstFrameDelayMs: optional(s.firstFrameDelayMs), loadMs: optional(s.loadMs),
        hiddenMs: clamp(s.hiddenMs, 86_400_000), hiddenCount: clamp(s.hiddenCount, 10000),
        pauses: clamp(s.pauses, 10000), reloads: clamp(s.reloads, 10000),
        bufferingMs: clamp(s.bufferingMs, 86_400_000), bufferingCount: clamp(s.bufferingCount, 10000),
        timingSource: s.timingSource, answerInput, viewportWidth, viewportHeight, videoWidth,
        capped: s.activeMs > 3_600_000 || s.viewingMs > 3_600_000 || this.wall() - s.openedAt > 86_400_000
      }
    };
  }
}
