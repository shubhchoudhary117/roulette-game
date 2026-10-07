import { Component, ElementRef, HostListener, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouletteService } from './roulette.service';
import {
  Bot, Cell, CHIPS, Geo, Pocket, WHEEL_D, WHEEL_M, betLabel, buildCells, buildPockets, colorOf
} from './roulette.models';
import { RouletteAudioService } from '../services/roulette.audio.service';

type Modal = null | 'how' | 'fair' | 'rules' | 'bets';

@Component({
  selector: 'app-roulette',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './roulette.component.html',
  styleUrl: './roulette.component.scss'
})
export class RouletteComponent {
  readonly pocketsD: Pocket[] = buildPockets(WHEEL_D);
  readonly pocketsM: Pocket[] = buildPockets(WHEEL_M);
  readonly cells: Cell[] = buildCells();
  readonly chips = CHIPS;
  readonly colorOf = colorOf;
  readonly betLabel = betLabel;

  /** true when viewport <= 900px — must match the `$mobile` breakpoint in the SCSS. */
  mobile = signal(false);
  menuOpen = false;
  histOpen = false;
  modal: Modal = null;

  @ViewChild('chipTrack') chipTrack?: ElementRef<HTMLDivElement>;

  constructor(public s: RouletteService, public audio: RouletteAudioService) {
    const mq = window.matchMedia('(max-width: 900px)');
    this.mobile.set(mq.matches);
    mq.addEventListener('change', e => this.mobile.set(e.matches));
  }

  /** Keeps existing sidebar rows untouched when a new player is added on top. */
  trackBot = (_: number, b: Bot) => b.name;

  /** Active wheel geometry / pockets (desktop = bottom arc, mobile = full circle). */
  get geo(): Geo { return this.mobile() ? WHEEL_M : WHEEL_D; }
  get pockets(): Pocket[] { return this.mobile() ? this.pocketsM : this.pocketsD; }

  /** Pointer triangle, base sits just inside the ring, tip dips into the pockets. */
  get pointer(): string {
    const g = this.geo;
    const y0 = g.cy + g.rIn - g.ph * 0.55;
    return `${g.cx - g.pw},${y0} ${g.cx + g.pw},${y0} ${g.cx},${y0 + g.ph}`;
  }

  /** Status line shown over the wheel. */
  get statusTitle(): string {
    switch (this.s.phase()) {
      case 'bet': return 'Game starts in:';
      case 'spin': return '';
      default: return 'Winning number';
    }
  }

  /** Mobile: the full-width history strip replaces the 3 cards while rolling / on result, or when opened. */
  get stripOpen(): boolean {
    return this.histOpen || this.s.phase() !== 'bet';
  }

  /** Desktop shows the last 5 numbers (reference), mobile strip shows 6. */
  get deskHistory(): number[] {
    return this.s.lastNumbers().slice(0, 5);
  }

  toggleHist(): void {
    if (this.s.phase() === 'bet') this.histOpen = !this.histOpen;
  }

  /** "1 000 000" style money, like the reference. */
  money(n: number): string {
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 }).replace(/,/g, ' ');
  }

  chipOn(key: string): number | null {
    return this.s.bets()[key] ?? null;
  }

  chipText(v: number): string {
    return String(Math.round(v * 100) / 100);
  }

  isWinningCell(key: string): boolean {
    const w = this.s.winningNumber();
    return w !== null && key === 'n' + w;
  }

  scrollChips(dir: number): void {
    this.chipTrack?.nativeElement.scrollBy({ left: dir * 180, behavior: 'smooth' });
  }

  toggleFullscreen(): void {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  openModal(m: Modal): void { this.modal = m; this.menuOpen = false; }

  /** Close the dropdown when clicking anywhere outside it (the hamburger toggles it itself). */
  @HostListener('document:click', ['$event'])
  onDocClick(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (!t?.closest) return;
    if (!t.closest('.menu') && !t.closest('.topbar .icon')) this.menuOpen = false;
  }

  seedHash(): string {
    // cosmetic provably-fair style display for the demo
    return Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  }
  readonly clientSeed = this.seedHash().slice(0, 16);
  readonly serverHash = this.seedHash() + this.seedHash();
}