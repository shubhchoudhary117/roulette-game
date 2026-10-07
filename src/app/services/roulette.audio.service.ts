import { Injectable, signal } from '@angular/core';

type Sfx = 'chip' | 'betPlace' | 'spin' | 'win';

const BASE = 'assets/audios/';
const FILES: Record<Sfx, string> = {
    chip: BASE + 'chip.mp3',
    betPlace: BASE + 'betPlace.mp3',
    spin: BASE + 'spin.mp3',
    win: BASE + 'win.mp3'
};
const BG_FILE = BASE + 'bgSound.mp3';

const SOUND_KEY = 'rl_sound_enabled';
const MUSIC_KEY = 'rl_music_enabled';
const DEFAULT_SPIN_MS = 4000; // used only if spin.mp3 failed to load

@Injectable({ providedIn: 'root' })
export class RouletteAudioService {
    sound = signal(true);
    music = signal(true);

    private ctx!: AudioContext;
    private buffers: Partial<Record<Sfx, AudioBuffer>> = {};
    private bg = new Audio();
    private unlocked = false;
    private spinSrc?: AudioBufferSourceNode;
    private ready: Promise<void>;

    constructor() {
        this.sound.set(this.read(SOUND_KEY, true));
        this.music.set(this.read(MUSIC_KEY, true));

        this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

        this.bg.src = BG_FILE;
        this.bg.loop = true;
        this.bg.volume = 0.25;
        this.bg.preload = 'auto';

        this.ready = this.loadAll();
        this.setupUnlock();
        this.setupVisibility();
    }

    /** Resolves when all sfx are decoded (spinDuration() is accurate after this). */
    whenReady(): Promise<void> { return this.ready; }

    /* ---------------------------------------------------------------- sfx */

    playChip(): void { this.play('chip', 0.9); }
    playBetPlace(): void { this.play('betPlace', 1); }
    playWin(): void { this.play('win', 1); }

    playSpin(): void {
        this.stopSpin();
        this.spinSrc = this.play('spin', 0.8) ?? undefined;
    }

    stopSpin(): void {
        try { this.spinSrc?.stop(); } catch { /* already stopped */ }
        this.spinSrc = undefined;
    }

    /** Exact length of spin.mp3 in ms. Wheel spins for exactly this long. */
    spinDuration(): number {
        const b = this.buffers.spin;
        return b ? Math.round(b.duration * 1000) : DEFAULT_SPIN_MS;
    }

    /* ---------------------------------------------------------------- toggles */

    toggleSound(): void {
        const on = !this.sound();
        this.sound.set(on);
        try { localStorage.setItem(SOUND_KEY, String(on)); } catch { /* ignore */ }
        if (!on) this.stopSpin();
    }

    toggleMusic(): void {
        const on = !this.music();
        this.music.set(on);
        try { localStorage.setItem(MUSIC_KEY, String(on)); } catch { /* ignore */ }
        this.unlocked = true;
        if (on) this.resumeCtx().then(() => this.startBg());
        else this.stopBg();
    }

    /* ---------------------------------------------------------------- bg music */

    private startBg(): void {
        if (!this.music() || !this.unlocked) return;
        this.bg.play().catch(() => { /* blocked until user interaction */ });
    }

    private stopBg(): void {
        this.bg.pause();
        this.bg.currentTime = 0;
    }

    /* ---------------------------------------------------------------- internals */

    private play(key: Sfx, volume: number): AudioBufferSourceNode | null {
        if (!this.sound()) return null;
        const buffer = this.buffers[key];
        if (!buffer) return null;
        try {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            const gain = this.ctx.createGain();
            gain.gain.value = volume;
            src.connect(gain);
            gain.connect(this.ctx.destination);
            src.start(0);
            return src;
        } catch {
            return null;
        }
    }

    private async loadAll(): Promise<void> {
        await Promise.all((Object.keys(FILES) as Sfx[]).map(k => this.load(k)));
    }

    private async load(key: Sfx): Promise<void> {
        try {
            const res = await fetch(FILES[key]);
            if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + FILES[key]);
            const data = await res.arrayBuffer();
            this.buffers[key] = await this.decode(data);
        } catch (e) {
            console.error('Roulette sound load failed:', key, e);
        }
    }

    /** Works with both promise and callback based decodeAudioData (old Safari). */
    private decode(data: ArrayBuffer): Promise<AudioBuffer> {
        return new Promise((resolve, reject) => {
            const p = this.ctx.decodeAudioData(data, resolve, reject);
            if (p && typeof (p as Promise<AudioBuffer>).then === 'function') {
                (p as Promise<AudioBuffer>).then(resolve, reject);
            }
        });
    }

    private async resumeCtx(): Promise<void> {
        try {
            if (this.ctx.state === 'suspended') await this.ctx.resume();
        } catch { /* ignore */ }
    }

    private setupUnlock(): void {
        const handler = async () => {
            this.unlocked = true;
            await this.resumeCtx();
            this.startBg();
            document.removeEventListener('click', handler);
            document.removeEventListener('touchstart', handler);
            document.removeEventListener('keydown', handler);
        };
        document.addEventListener('click', handler);
        document.addEventListener('touchstart', handler, { passive: true });
        document.addEventListener('keydown', handler);
    }

    private setupVisibility(): void {
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                await this.resumeCtx();
                this.startBg();
            } else {
                this.bg.pause();
            }
        });
    }

    private read(key: string, def: boolean): boolean {
        try {
            const v = localStorage.getItem(key);
            return v === null ? def : v !== 'false';
        } catch {
            return def;
        }
    }
}