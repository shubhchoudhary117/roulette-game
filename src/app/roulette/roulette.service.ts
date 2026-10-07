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
  private spinTo(num: number): Promise<void> {
    const dur = this.audio.spinDuration();           // ms, = spin.mp3 length
    const idx = ORDER.indexOf(num);
    const target = -idx * WHEEL.step;
    const start = ((this.rotation() % 360) + 360) % 360;
    const norm = ((target % 360) + 360) % 360;
    // more turns for longer sounds so the speed feels natural
    const turns = Math.max(4, Math.round((dur / 1000) * 1.3));
    const totalTurn = 360 * turns + (((norm - start) % 360) + 360) % 360;

    // start sound and animation together
    this.audio.playSpin();
    const t0 = performance.now();

    return new Promise<void>(resolve => {
      this.zone.runOutsideAngular(() => {
        const frame = (t: number) => {
          const p = Math.min(1, (t - t0) / dur);
          const e = 1 - Math.pow(1 - p, 3);            // ease-out: slow, smooth stop
          this.zone.run(() => this.rotation.set(start + totalTurn * e));
          if (p < 1) requestAnimationFrame(frame);
          else this.zone.run(() => { this.audio.stopSpin(); resolve(); });
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