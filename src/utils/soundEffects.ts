// Procedural Web Audio API sound effects (zero external audio file dependencies)

class SoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;
  private lastPlayed: Record<string, number> = {};

  private shouldPlay(key: string, cooldownMs = 180): boolean {
    const now = Date.now();
    const prev = this.lastPlayed[key] ?? 0;
    if (now - prev < cooldownMs) return false;
    this.lastPlayed[key] = now;
    return true;
  }

  private getContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  // Danger / Block sound: urgent two-pulse descending sawtooth/triangle alert
  playDangerSound() {
    if (!this.shouldPlay('danger')) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const pulses = [
      { start: 0, freqStart: 540, freqEnd: 290, dur: 0.16 },
      { start: 0.19, freqStart: 480, freqEnd: 220, dur: 0.22 },
    ];

    for (const p of pulses) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(p.freqStart, now + p.start);
      osc.frequency.exponentialRampToValueAtTime(p.freqEnd, now + p.start + p.dur);

      gain.gain.setValueAtTime(0.001, now + p.start);
      gain.gain.linearRampToValueAtTime(0.11, now + p.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + p.start + p.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + p.start);
      osc.stop(now + p.start + p.dur + 0.02);
    }
  }

  // Warning / Escalation sound (ASK_CUSTOMER / 3 AM approval prompt)
  playWarningSound() {
    if (!this.shouldPlay('warning')) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [
      { start: 0, freq: 660, dur: 0.12 },
      { start: 0.15, freq: 880, dur: 0.14 },
      { start: 0.32, freq: 660, dur: 0.18 },
    ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      gain.gain.setValueAtTime(0.001, now + n.start);
      gain.gain.linearRampToValueAtTime(0.12, now + n.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
  }

  // Approve / Verified sound: crisp ascending harmonic triad chime
  playApproveSound() {
    if (!this.shouldPlay('approve')) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const chord = [
      { start: 0, freq: 523.25, dur: 0.14 }, // C5
      { start: 0.08, freq: 659.25, dur: 0.16 }, // E5
      { start: 0.16, freq: 783.99, dur: 0.2 }, // G5
      { start: 0.24, freq: 1046.5, dur: 0.34 }, // C6
    ];

    for (const n of chord) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      gain.gain.setValueAtTime(0.001, now + n.start);
      gain.gain.linearRampToValueAtTime(0.12, now + n.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
    }
  }

  // Instant Revoke lock-down sound
  playRevokeSound() {
    if (!this.shouldPlay('revoke')) return;
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(420, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.22);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  }
}

export const soundEngine = new SoundEngine();
