import { Injectable, NgZone, signal } from '@angular/core';
import {
  Bot, BOT_NAMES, CHIPS, CURRENCIES, HistoryEntry, ORDER, Phase, WHEEL, payout
} from './roulette.models';
import { RouletteAudioService } from '../services/roulette.audio.service';

const BET_SECONDS = 15;
const RESULT_MS = 4500;
const r2 = (n: number) => Math.round(n * 100) / 100;

@Injectable({ providedIn: 'root' })
export class RouletteService {
  /* ---------------- reactive state ---------------- */
  balance = signal(1000);
  chip = signal(1);
  bets = signal<Record<string, number>>({});
  phase = signal<Phase>('bet');
  locked = signal(false);
  countdown = signal(BET_SECONDS);
  rotation = signal(0);
  lastNumbers = signal<number[]>([]);
  winningNumber = signal<number | null>(null);
  bots = signal<Bot[]>([]);
  message = signal('');
  history = signal<HistoryEntry[]>([]);
  playerName = signal('Indigo Zany …');
  winAmount = signal(0);

  private stack: Array<{ key: string; v: number }> = [];
  private lastBets: Record<string, number> = {};
  private round = 0;

  constructor(private zone: NgZone, private audio: RouletteAudioService) {
    this.load();
    this.newBots();
    this.loop();
  }

  /* ---------------- derived ---------------- */
  total(): number {
    return r2(Object.values(this.bets()).reduce((a, b) => a + b, 0));
  }
  potTotal(): number {
    return r2(this.bots().reduce((a, b) => a + b.amt, 0) + this.total());
  }
  chipColor(v: number): string {
    let best = CHIPS[0];
    for (const c of CHIPS) if (c.v <= v) best = c;
    return best.c;
  }
  canBet(): boolean {
    return this.phase() === 'bet' && !this.locked();
  }

  /* ---------------- betting ---------------- */
  placeChip(key: string): void {
    if (!this.canBet()) { this.message.set('Betting is closed for this round.'); return; }
    const v = this.chip();
    if (v > this.balance()) { this.message.set('Not enough balance.'); return; }
    this.balance.update(b => r2(b - v));
    this.bets.update(b => ({ ...b, [key]: r2((b[key] || 0) + v) }));
    this.stack.push({ key, v });
    this.message.set('');
    this.audio.playChip();
    this.save();
  }

  undo(): void {
    if (!this.canBet() || !this.stack.length) return;
    const l = this.stack.pop()!;
    this.bets.update(b => {
      const n = { ...b };
      n[l.key] = r2((n[l.key] || 0) - l.v);
      if (n[l.key] <= 0.001) delete n[l.key];
      return n;
    });
    this.balance.update(b => r2(b + l.v));
    this.audio.playChip();
    this.save();
  }

  clear(refund = true): void {
    if (this.locked() && refund) return;
    if (refund) this.balance.update(b => r2(b + this.total()));
    this.bets.set({});
    this.stack = [];
    this.save();
  }

  repeat(): void {
    if (!this.canBet()) return;
    const t = r2(Object.values(this.lastBets).reduce((a, b) => a + b, 0));
    if (!t) { this.message.set('No previous bets to repeat.'); return; }
    if (t > this.balance() + this.total()) { this.message.set('Not enough balance to repeat.'); return; }
    this.clear(true);
    this.bets.set({ ...this.lastBets });
    this.stack = Object.entries(this.lastBets).map(([key, v]) => ({ key, v }));
    this.balance.update(b => r2(b - t));
    this.audio.playChip();
    this.save();
  }

  confirm(): void {
    if (!this.canBet() || this.total() <= 0) return;
    this.locked.set(true);
    this.message.set('Bets placed — good luck!');
    this.audio.playBetPlace();
  }

  resetBalance(): void {
    this.clear(false);
    this.balance.set(1000);
    this.history.set([]);
    this.lastNumbers.set([]);
    this.save();
  }

  setChip(v: number): void { this.chip.set(v); }

  /* ---------------- round loop ---------------- */
  private async loop(): Promise<void> {
    // make sure spin.mp3 is decoded so its duration is known
    await this.audio.whenReady();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      /* --- betting phase --- */
      this.phase.set('bet');
      this.locked.set(false);
      this.winningNumber.set(null);
      this.winAmount.set(0); 
      this.clear(true);
      this.newBots();
      this.round++;

      for (let t = BET_SECONDS; t > 0; t--) {
        this.countdown.set(t);
        this.growBots((BET_SECONDS - t + 1) / BET_SECONDS);
        await this.wait(1000);
      }

      /* --- spin --- */
      // timer ended with bets not confirmed -> they get locked automatically
      if (!this.locked() && this.total() > 0) this.audio.playBetPlace();
      this.locked.set(true);
      this.phase.set('spin');
      const staked = this.total();
      if (staked > 0) this.lastBets = { ...this.bets() };
      const num = ORDER[Math.floor(Math.random() * 37)];
      await this.spinTo(num);

      /* --- result --- */
      this.phase.set('result');
      this.winningNumber.set(num);
      let ret = 0;
      for (const [k, amt] of Object.entries(this.bets())) ret += amt * payout(k, num);
      ret = r2(ret);
      this.winAmount.set(ret);
      if (ret > 0) { this.balance.update(b => r2(b + ret)); this.audio.playWin(); }
      this.lastNumbers.update(h => [num, ...h].slice(0, 6));
      if (staked > 0) {
        this.history.update(h => [{
          round: this.round, number: num, staked, returned: ret,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }, ...h].slice(0, 30));
        this.message.set(ret > 0
          ? `You won $ ${ret.toFixed(2)} (profit $ ${(ret - staked).toFixed(2)})`
          : `No win this round — $ ${staked.toFixed(2)} lost`);
      } else {
        this.message.set('');
      }
      this.save();
      await this.wait(RESULT_MS);
    }
  }

  /**
   * Spin lasts exactly as long as spin.mp3. Fast at the start, slowly
   * decelerating at the end (matches the "slowing down" part of the sound),
   * and parks the chosen pocket exactly under the pointer.
   */
  /**
   * Spin lasts exactly as long as spin.mp3 (e.g. 4s).
   * Real-wheel feel: starts at moderate speed, then decelerates gently
   * the whole way and creeps to a stop right at the end (no sudden halt).
   */
  /**
 * Real-wheel spin, no ball.
 * 1) quick spin-up (wheel gets pushed)
 * 2) friction deceleration (smooth, long slow-down)
 * 3) creeps to a stop exactly when spin.mp3 ends
 */
  private spinTo(num: number): Promise<void> {
    const dur = this.audio.spinDuration();            // ms, = spin.mp3 length
    const idx = ORDER.indexOf(num);
    const target = -idx * WHEEL.step;
    const start = ((this.rotation() % 360) + 360) % 360;
    const norm = ((target % 360) + 360) % 360;

    // total turns: 4s -> 3 turns (slow & natural)
    const turns = Math.max(2, Math.round((dur / 1000) * 0.75));
    const totalTurn = 360 * turns + (((norm - start) % 360) + 360) % 360;

    // speed profile: quick ramp-up, then friction decay (exponential)
    const RAMP = 0.08;     // first 8% of time = spin-up
    const K = 4;           // friction (bigger = slows earlier, longer creep)

    // speed(p) shape
    const speed = (p: number) => {
      const up = Math.min(1, p / RAMP);
      const ramp = up * up * (3 - 2 * up);            // smoothstep 0 -> 1
      return ramp * Math.exp(-K * p);
    };

    // numeric integral of speed -> normalised position 0..1
    const N = 400;
    const cum: number[] = [0];
    for (let i = 1; i <= N; i++) {
      cum[i] = cum[i - 1] + (speed((i - 0.5) / N) / N);
    }
    const total = cum[N];
    const pos = (p: number) => {
      const x = Math.min(1, Math.max(0, p)) * N;
      const i = Math.min(N - 1, Math.floor(x));
      const f = x - i;
      return (cum[i] + (cum[i + 1] - cum[i]) * f) / total;
    };

    this.audio.playSpin();
    const t0 = performance.now();

    return new Promise<void>(resolve => {
      this.zone.runOutsideAngular(() => {
        const frame = (t: number) => {
          const p = Math.min(1, (t - t0) / dur);
          this.zone.run(() => this.rotation.set(start + totalTurn * pos(p)));
          if (p < 1) requestAnimationFrame(frame);
          else this.zone.run(() => {
            this.rotation.set(start + totalTurn);
            this.audio.stopSpin();
            resolve();
          });
        };
        requestAnimationFrame(frame);
      });
    });
  }

  /* ---------------- bots ---------------- */
  private newBots(): void {
    const count = 6 + Math.floor(Math.random() * 4);
    const pool = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, count);
    this.bots.set(pool.map(name => ({
      name,
      cur: CURRENCIES[Math.floor(Math.random() * CURRENCIES.length)],
      amt: 0,
      target: r2(Math.pow(10, 0.6 + Math.random() * 2.2))
    })));
  }
  private growBots(p: number): void {
    this.bots.update(list => list.map(b => ({ ...b, amt: r2(b.target * Math.min(1, p) * (0.6 + Math.random() * 0.4)) })));
  }

  /* ---------------- helpers ---------------- */
  private wait(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

  private save(): void {
    try {
      localStorage.setItem('rl.state', JSON.stringify({
        bal: this.balance(), hist: this.history(), last: this.lastNumbers()
      }));
    } catch { /* storage unavailable */ }
  }
  private load(): void {
    try {
      const raw = localStorage.getItem('rl.state');
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.bal === 'number') this.balance.set(s.bal);
      if (Array.isArray(s.hist)) this.history.set(s.hist);
      if (Array.isArray(s.last)) this.lastNumbers.set(s.last);
    } catch { /* ignore */ }
  }
}