// ============================================================
// Free Player — motor de audio
// Web Audio + SoundTouchJS (PitchShifter) para controlar
// VELOCIDAD (tempo) y TONO (pitch) de forma independiente.
// ============================================================

import { PitchShifter } from './soundtouch.js';
import { decodeAudio } from './decoder.js';

const BUFFER_SIZE = 4096;

const EQ_PRESETS = {
  flat:   { label: 'Plano',  low: 0, mid: 0,  high: 0 },
  bass:   { label: 'Grave',  low: 9, mid: 1,  high: -2 },
  vocal:  { label: 'Vocal',  low: -2, mid: 6, high: 1 },
  treble: { label: 'Agudo',  low: -3, mid: 1, high: 9 },
  loud:   { label: 'Loud',   low: 5, mid: 4,  high: 5 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.chain = null;
    this.current = null;      // { id, shifter, gain, buffer }
    this.speed = 1;
    this.pitch = 0;           // semitonos
    this.eq = 'flat';
    this.volume = 1;
    this.boost = 1;          // sound boost (1 = 100 %, 1.2 = 120 %)
    this.paused = false;
    this.crossfadeSec = 0;
    this._xfadeActive = false;
    this.el = null;           // <audio> del modo streaming
    this.elSrc = null;        // MediaElementSource (una sola vez)
    this._streamId = null;
    this._listeners = { end: [], error: [] };
  }

  // ---------- eventos ----------
  on(evt, fn) { (this._listeners[evt] || []).push(fn); }
  emit(evt, ...args) { (this._listeners[evt] || []).forEach((f) => f(...args)); }

  // ---------- contexto ----------
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    // Cadena: input -> low -> mid -> high -> master -> salida
    this.inputGain = this.ctx.createGain();
    this.low = this.ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 320;
    this.mid = this.ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.9;
    this.high = this.ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 3200;
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume * this.boost;

    // Limitador: transparente con el volumen normal y solo actúa cuando el
    // boost empuja los picos por encima de 0 dBFS (evita que sature/chille).
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -0.5;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.inputGain.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.applyEq(this.eq);
    return this.ctx;
  }

  async resume() {
    this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // ---------- carga de archivo ----------
  // Acepta Blob | File | ArrayBuffer. Prueba primero el decodificador
  // nativo del navegador y, si no puede, convierte con ffmpeg.wasm.
  // opts: { name, ext, onProgress }
  async decode(input, opts = {}) {
    this.init();
    return await decodeAudio(this.ctx, input, opts);
  }

  // ---------- reproducción ----------
  /**
   * MODO STREAMING (el normal): reproduce el archivo directamente con un
   * elemento <audio> (content:// del teléfono a través del servidor local
   * del APK, o blob:// de los importados). NO lee la canción entera ni la
   * decodifica: arranca al instante, ocupa unos KB de RAM y no procesa
   * audio en JavaScript. Antes se decodificaba cada canción (100–200 MB de
   * RAM por tema) y se pasaba por SoundTouch a 60 ciclos por segundo: eso
   * era lo que trababa el sonido y retrasaba el cambio de canción.
   *
   * El sonido sigue pasando por la cadena Web Audio (volumen, boost, EQ).
   */
  canStream() { return this.pitch === 0; }

  isStreaming() {
    return !!(this.current && this.current.stream);
  }

  async playStream(url, id) {
    this.init();
    await this.resume();
    this.stop();

    if (!this.el) {
      const el = new Audio();
      el.preload = 'auto';
      el.addEventListener('ended', () => {
        if (this.current && this.current.stream && this.current.id === this._streamId) {
          this.emit('end', this._streamId);
        }
      });
      el.addEventListener('error', () => {
        if (this.current && this.current.stream) {
          this.emit('error', new Error('No se pudo abrir el audio'));
        }
      });
      this.el = el;
      this.elSrc = this.ctx.createMediaElementSource(el);
      this.elSrc.connect(this.inputGain);
    }

    this.el.src = url;
    this.el.playbackRate = this.speed;
    try { this.el.preservesPitch = true; this.el.mozPreservesPitch = true; } catch {}
    this.el.volume = 1;      // el volumen real lo aplica la cadena Web Audio
    this.current = { id, stream: true };
    this._streamId = id;
    this.paused = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    await this.el.play();
    return true;
  }

  async play(buffer, id, { offset = 0 } = {}) {
    this.init();
    await this.resume();
    this.stop();

    const shifter = new PitchShifter(this.ctx, buffer, BUFFER_SIZE, () => {
      this.emit('end', id);
    });
    this.applySpeedPitch(shifter);

    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    shifter.connect(gain);
    gain.connect(this.inputGain);

    this.current = { id, shifter, gain, buffer };
    this.paused = false;

    if (offset > 0) this.seek(offset / buffer.duration);

    // Media Session (controles en la pantalla de bloqueo / audífonos)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    return true;
  }

  stop() {
    if (this.el) {
      try { this.el.pause(); } catch {}
    }
    if (this.current) {
      try { this.current.shifter?.disconnect(); } catch {}
      try { this.current.gain?.disconnect(); } catch {}
      this.current = null;
    }
    this._streamId = null;
    this._xfadeActive = false;
    this._pendingId = null;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  /**
   * Pausa. En modo streaming se pausa el elemento; en el modo decodificado
   * se suspende el AudioContext (no perder la posición ni SoundTouch).
   */
  async pause() {
    if (!this.current) return;
    if (this.current.stream) {
      try { this.el.pause(); } catch {}
      this.paused = true;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      return;
    }
    if (this.ctx.state !== 'running') return;
    await this.ctx.suspend();
    this.paused = true;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  }

  async resumePlayback() {
    if (!this.current) return;
    if (this.current.stream) {
      await this.el.play();
      this.paused = false;
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      return;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.paused = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }

  // ---------- posición / progreso ----------
  get duration() {
    if (!this.current) return 0;
    if (this.current.stream) {
      const d = this.el && this.el.duration;
      return Number.isFinite(d) && d > 0 ? d : 0;
    }
    return this.current.buffer.duration;
  }

  get position() {
    if (!this.current) return 0;
    if (this.current.stream) return Math.max(0, this.el.currentTime || 0);
    return Math.max(0, this.current.shifter.timePlayed || 0);
  }

  seek(fraction) {
    if (!this.current) return;
    const p = Math.min(1, Math.max(0, fraction));
    if (this.current.stream) {
      const d = this.el.duration;
      if (Number.isFinite(d) && d > 0) this.el.currentTime = p * d;
      return;
    }
    this.current.shifter.percentagePlayed = p;
  }

  // ---------- velocidad y tono (independientes) ----------
  applySpeedPitch(shifter = this.current?.shifter) {
    if (!shifter) return;
    // tempo = velocidad sin alterar el tono
    shifter.tempo = this.speed;
    // pitch = tono sin alterar la velocidad
    shifter.pitchSemitones = this.pitch;
  }

  setSpeed(v) {
    this.speed = v;
    if (this.current && this.current.stream) {
      try { this.el.playbackRate = v; this.el.preservesPitch = true; } catch {}
      return;
    }
    this.applySpeedPitch();
  }

  setPitch(semitones) {
    this.pitch = semitones;
    this.applySpeedPitch();
  }

  resetSpeedPitch() {
    this.setSpeed(1);
    this.setPitch(0);
  }

  // ---------- ecualizador ----------
  applyEq(name) {
    const p = EQ_PRESETS[name] || EQ_PRESETS.flat;
    this.eq = name;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.low.gain.setTargetAtTime(p.low, t, 0.05);
    this.mid.gain.setTargetAtTime(p.mid, t, 0.05);
    this.high.gain.setTargetAtTime(p.high, t, 0.05);
  }

  setVolume(v) {
    this.volume = v;
    this._applyMaster();
  }

  /** Sound boost: 1 = 100 % … 2 = 200 %. */
  setBoost(v) {
    this.boost = Math.min(2, Math.max(1, v));
    this._applyMaster();
  }

  _applyMaster() {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(
      this.volume * this.boost, this.ctx.currentTime, 0.03
    );
  }

  // ---------- crossfade ----------
  /**
   * Inicia el crossfade hacia `nextBuffer`. Devuelve una promesa que
   * resuelve cuando el cambio se ha completado.
   */
  crossfadeTo(nextBuffer, nextId) {
    if (!this.current || this.crossfadeSec <= 0) {
      return this.play(nextBuffer, nextId);
    }
    const cf = Math.min(this.crossfadeSec, this.duration);
    const now = this.ctx.currentTime;

    const shifter = new PitchShifter(this.ctx, nextBuffer, BUFFER_SIZE, () => {
      this.emit('end', nextId);
    });
    this.applySpeedPitch(shifter);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + cf);
    shifter.connect(gain);
    gain.connect(this.inputGain);

    const old = this.current;
    old.gain.gain.setValueAtTime(1, now);
    old.gain.gain.linearRampToValueAtTime(0, now + cf);

    this._xfadeActive = true;
    const result = new Promise((resolve) => {
      setTimeout(() => {
        try { old.shifter.disconnect(); old.gain.disconnect(); } catch {}
        this.current = { id: nextId, shifter, gain, buffer: nextBuffer };
        this._xfadeActive = false;
        this._pausedAt = 0;
        this._pendingId = null;
        resolve(true);
      }, cf * 1000 + 40);
    });

    // Mostramos la próxima pista inmediatamente
    this._pendingId = nextId;
    return result;
  }

  get pendingId() { return this._pendingId; }

  static get presets() { return EQ_PRESETS; }
}
