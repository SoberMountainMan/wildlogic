// audio.js — every sound in this game is synthesised at runtime.
//
// No files, no licences, no network, no bytes. One module, one master gain, one mute.
// Design rule from SOUND-PLAN-v1 §1: audio reads state and makes noise; it never writes
// the household, never imports a sim module, never touches a sim RNG stream.
//
// Node-safe by construction: nothing at module scope touches window/AudioContext, and every
// public function swallows its own failures. Under node (the gate) or a browser without
// WebAudio every call is a silent no-op — same discipline as sprites.js.
//
// API: initAudio() · setMuted(bool) · isMuted() · world(snapshot) · ambience(weather, season)
//      sfx(name[, delay]) · birdCall(name) · seasonCue(season) · review(score) · arrival(road)
// Probe-only: _synth (builds voices into any BaseAudioContext, incl. OfflineAudioContext).

const MASTER_LEVEL = 0.35;   // default master; ambience sits under sfx
const AMB_LEVEL = 0.5;       // 0.5 of master
const SFX_LEVEL = 1.0;       // 1.0 of master
const CROSSFADE = 2.0;       // seconds — weather beds never cut, they cross-fade

// --- Tier 2 layer levels (SOUND-PLAN-v1 §4). All LOW: these are things heard from the
// plot, not things happening to you. The generator is the loudest of the three because
// the whole point is that you hear the power before the review score tells you.
const GEN_LEVEL = 0.055;     // the hum. A TOLD day plays 45% of this; an untold night is
                             // full, because this game has no clock (A6, SOUND-PLAN-v2 §2)
const SAW_LEVEL = 0.075;     // one distant saw, panned and filtered
const SAW = { min: 8, max: 55 };   // seconds between saws, at full and at almost-no cutting

let ctx = null;
let ambBus = null;
let sfxBus = null;
let muted = false;
let current = null;          // { key, out, nodes, spec }
let want = null;             // { weather, season } — replayed once the context exists
let wantSnap = null;         // the full world snapshot, replayed on unlock
let worldState = null;       // latest { weather, season, night, power, stance, road }
let birdTimer = 0;
let gen = null;              // { out, gain, nodes } — the generator hum, when it runs
let sputterTimer = 0;
let sawTimer = 0;
const masters = [];          // every master gain made (live + probe renders) — mute reaches all

/* Probe-only: a bounded ring of every audible DECISION this module made, with whether it
   could actually be heard at that moment. "Fired but silent" and "silent because it never
   fired" are different bugs, and a graph alone cannot tell them apart: the offline probe
   proves a recipe sounds right, only the session probe (tools/audio-session-probe.mjs) can
   prove a player would hear it. Read through the module singleton, never through the DOM.
   Names are prefixed by which path made them — sfx: / bed: / gen: / bird: / cue: /
   review: / arrival: — so a table falls out of the log instead of out of a guess. */
const CUE_LOG_MAX = 400;
const cueLog = [];
function note(name, o) {
  const heard = !!ctx && !muted;
  cueLog.push({
    name,
    t: ctx ? now(ctx) : 0,
    delay: (o && o.delay) || 0,
    heard,
    v: o && o.value != null ? o.value : null,
    why: heard ? null : (ctx ? 'muted' : 'no-context'),
  });
  if (cueLog.length > CUE_LOG_MAX) cueLog.shift();
}

/* ---------------------------------------------------------------- helpers */

// Own RNG (mulberry32 discipline, as voices.js). Never the sim's streams.
let seed = 0x9e3779b9;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const now = (c) => (c.currentTime || 0);
const osc = (c, type, freq) => { const o = c.createOscillator(); o.type = type; o.frequency.value = freq; return o; };
const filt = (c, type, freq, q) => {
  const f = c.createBiquadFilter();
  f.type = type; f.frequency.value = freq;
  if (q != null) f.Q.value = q;
  return f;
};

/** Percussive envelope: near-instant attack, exponential decay to silence. */
function env(gain, at, attack, peak, decay) {
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
}

const noiseCache = new WeakMap();
/** A loopable noise buffer with a touch of pink tilt — rain hiss, wind, thuds.
 *  Owner verdict 4 (2026-10-21): "one annoying sound file on loop." The old buffer was
 *  3 s with a raw seam, so every bed repeated recognisably every 3 seconds. It is now
 *  6 s and the tail is cross-faded into the head, so a looping bed never clicks and
 *  never repeats on a length you can tap your foot to. */
function noise(c, seconds = 6) {
  const cached = noiseCache.get(c);
  if (cached) return cached;
  const n = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  let low = 0;
  for (let i = 0; i < n; i++) {
    const white = rnd() * 2 - 1;
    low = low * 0.985 + white * 0.015;
    d[i] = (white * 0.75 + low * 4) * 0.6;
  }
  // loop seam: equal-power crossfade of the last F samples into the head, so the
  // end flows into the beginning with no step and no double-amplitude bump
  const F = Math.min(4096, n >> 2);
  for (let i = 0; i < F; i++) {
    const t = i / F;
    const head = d[i];
    const tail = d[n - F + i];
    d[n - F + i] = tail * Math.sqrt(1 - t) + head * Math.sqrt(t);
  }
  noiseCache.set(c, buf);
  return buf;
}

/** A one-shot noise player; the caller stops it when the envelope is done. */
function noiseSrc(c) {
  const s = c.createBufferSource();
  s.buffer = noise(c);
  s.loop = false;
  return s;
}

/** Stereo placement for the distance cues. Absent in some headless contexts — a mono
 *  render must still work, so a missing panner returns the signal untouched. */
function pan(c, v) {
  if (typeof c.createStereoPanner !== 'function') return null;
  const p = c.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, v));
  return p;
}

/* ------------------------------------------------------------------ buses */

/** Master + the two child buses. The single mute node is the master. */
function buses(c) {
  const master = c.createGain();
  master.gain.value = muted ? 0 : MASTER_LEVEL;
  master.connect(c.destination);

  const amb = c.createGain();
  amb.gain.value = AMB_LEVEL;
  amb.connect(master);

  const sfx = c.createGain();
  sfx.gain.value = SFX_LEVEL;
  sfx.connect(master);

  masters.push(master);
  if (masters.length > 8) masters.shift();   // probe renders churn contexts; keep it bounded
  return { master, amb, sfx };
}

/* -------------------------------------------------------------------- sfx */

/**
 * Build one named one-shot into `dest`. Exported (via _synth) so the probe can render
 * it offline; the game only ever reaches it through sfx().
 */
function buildSfx(c, dest, name, when) {
  const t = Math.max(0, when || 0);

  if (name === 'axe') {
    // thunk: a band of noise where the steel meets the trunk, plus the body under it
    const n = noiseSrc(c);
    const bp = filt(c, 'bandpass', 780, 1.1);
    const ng = c.createGain(); env(ng, t, 0.002, 0.9, 0.09);
    n.connect(bp); bp.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.3);

    const body = osc(c, 'sine', 92);
    const bg = c.createGain(); env(bg, t, 0.003, 0.7, 0.14);
    body.connect(bg); bg.connect(dest);
    body.start(t); body.stop(t + 0.2);

    // crack: the wood giving, a beat later and brighter
    const cn = noiseSrc(c);
    const hp = filt(c, 'highpass', 2200, 0.8);
    const cg = c.createGain(); env(cg, t + 0.055, 0.002, 0.34, 0.05);
    cn.connect(hp); hp.connect(cg); cg.connect(dest);
    cn.start(t + 0.055); cn.stop(t + 0.16);
    return;
  }

  if (name === 'chainsaw') {
    // two detuned saws through a lowpass, chopped by a fast tremolo — 0.8 s
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.26, t + 0.04);
    g.gain.setValueAtTime(0.26, t + 0.62);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    g.connect(dest);

    const lp = filt(c, 'lowpass', 1600, 4);
    const trem = c.createGain(); trem.gain.value = 0.55;
    lp.connect(trem); trem.connect(g);

    const a = osc(c, 'sawtooth', 118);
    const b = osc(c, 'sawtooth', 121.5);
    a.connect(lp); b.connect(lp);

    const lfo = osc(c, 'sine', 26);
    const lg = c.createGain(); lg.gain.value = 0.45;
    lfo.connect(lg); lg.connect(trem.gain);

    a.start(t); b.start(t); lfo.start(t);
    a.stop(t + 0.82); b.stop(t + 0.82); lfo.stop(t + 0.82);
    return;
  }

  if (name === 'fell') {
    // creak of the hinge, then the canopy arriving
    const creak = osc(c, 'sawtooth', 58);
    creak.frequency.setValueAtTime(58, t);
    creak.frequency.linearRampToValueAtTime(44, t + 0.5);
    const wob = osc(c, 'sine', 7);
    const wg = c.createGain(); wg.gain.value = 6;
    wob.connect(wg); wg.connect(creak.frequency);
    const clp = filt(c, 'lowpass', 420, 1.2);
    const cg = c.createGain(); env(cg, t, 0.05, 0.13, 0.5);
    creak.connect(clp); clp.connect(cg); cg.connect(dest);
    creak.start(t); wob.start(t); creak.stop(t + 0.6); wob.stop(t + 0.6);

    const crash = noiseSrc(c);
    const lp = filt(c, 'lowpass', 1400, 0.9);
    lp.frequency.setValueAtTime(1400, t + 0.55);
    lp.frequency.exponentialRampToValueAtTime(320, t + 1.3);
    const rg = c.createGain(); env(rg, t + 0.55, 0.01, 0.5, 0.75);
    crash.connect(lp); lp.connect(rg); rg.connect(dest);
    crash.start(t + 0.55); crash.stop(t + 1.4);

    const thud = osc(c, 'sine', 48);
    const tg = c.createGain(); env(tg, t + 0.58, 0.005, 0.45, 0.35);
    thud.connect(tg); tg.connect(dest);
    thud.start(t + 0.58); thud.stop(t + 1.0);
    return;
  }

  if (name === 'plant') {
    const body = osc(c, 'sine', 130);
    body.frequency.setValueAtTime(130, t);
    body.frequency.exponentialRampToValueAtTime(70, t + 0.1);
    const bg = c.createGain(); env(bg, t, 0.004, 0.28, 0.11);
    body.connect(bg); bg.connect(dest);
    body.start(t); body.stop(t + 0.16);

    const n = noiseSrc(c);
    const lp = filt(c, 'lowpass', 500, 0.7);
    const ng = c.createGain(); env(ng, t, 0.003, 0.12, 0.07);
    n.connect(lp); lp.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.1);
    return;
  }

  if (name === 'water') {
    // pouring: a band of noise whose centre climbs as the tank fills
    const n = noiseSrc(c);
    const bp = filt(c, 'bandpass', 900, 0.8);
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.linearRampToValueAtTime(1800, t + 0.6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.05);
    g.gain.setValueAtTime(0.3, t + 0.42);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    n.connect(bp); bp.connect(g); g.connect(dest);
    n.start(t); n.stop(t + 0.75);
    return;
  }

  if (name === 'coins') {
    const ping = (freq, at) => {
      const o = osc(c, 'triangle', freq);
      const g = c.createGain(); env(g, at, 0.004, 0.16, 0.1);
      o.connect(g); g.connect(dest);
      o.start(at); o.stop(at + 0.14);
    };
    ping(1318.5, t);
    ping(1760, t + 0.085);
    return;
  }

  if (name === 'gate') {
    const o = osc(c, 'sawtooth', 130);
    const wob = osc(c, 'sine', 9);
    const wg = c.createGain(); wg.gain.value = 14;
    wob.connect(wg); wg.connect(o.frequency);
    const lp = filt(c, 'lowpass', 900, 1.4);
    const g = c.createGain(); env(g, t, 0.06, 0.14, 0.4);
    o.connect(lp); lp.connect(g); g.connect(dest);
    o.start(t); wob.start(t); o.stop(t + 0.5); wob.stop(t + 0.5);
    return;
  }

  if (name === 'build') {
    // Putting a unit up (A11: `accom` had no sound of its own and fell through to `ui`).
    // Two knocks on the frame -- a hammer, not a band -- and the plank settling as the
    // structure takes its own weight. Under half a second, no rising shape: the reward for
    // a room is the room, and a fanfare here would be the jingle the plan forbids.
    const knock = (at, f, dur) => {
      const n = noiseSrc(c);
      const bp = filt(c, 'bandpass', f, 1.2);
      const g = c.createGain(); env(g, at, 0.002, 0.4, dur);
      n.connect(bp); bp.connect(g); g.connect(dest);
      n.start(at); n.stop(at + dur + 0.05);
      const body = osc(c, 'sine', f / 6);
      const bg = c.createGain(); env(bg, at, 0.004, 0.3, dur * 1.4);
      body.connect(bg); bg.connect(dest);
      body.start(at); body.stop(at + dur + 0.08);
    };
    knock(t, 780, 0.07);
    knock(t + 0.1, 620, 0.06);
    const plank = noiseSrc(c);
    const pl = filt(c, 'lowpass', 1400, 0.8);
    const pg = c.createGain(); env(pg, t + 0.19, 0.02, 0.12, 0.16);
    plank.connect(pl); pl.connect(pg); pg.connect(dest);
    plank.start(t + 0.19); plank.stop(t + 0.42);
    return;
  }

  if (name === 'ui') {
    const n = noiseSrc(c);
    const hp = filt(c, 'highpass', 3000, 0.7);
    const ng = c.createGain(); env(ng, t, 0.001, 0.1, 0.025);
    n.connect(hp); hp.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.04);

    const o = osc(c, 'sine', 900);
    const og = c.createGain(); env(og, t, 0.002, 0.05, 0.03);
    o.connect(og); og.connect(dest);
    o.start(t); o.stop(t + 0.05);
    return;
  }

  if (name === 'error') {
    const thud = (freq, at) => {
      const o = osc(c, 'sine', freq);
      o.frequency.setValueAtTime(freq, at);
      o.frequency.exponentialRampToValueAtTime(freq * 0.82, at + 0.12);
      const g = c.createGain(); env(g, at, 0.006, 0.3, 0.13);
      o.connect(g); g.connect(dest);
      o.start(at); o.stop(at + 0.2);
    };
    thud(110, t);
    thud(92, t + 0.16);
    return;
  }

  if (name === 'report-up') {
    // the morning report in two soft notes — a good day, stated, nothing jolly
    const ping = (freq, at) => {
      const o = osc(c, 'sine', freq);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.11, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      o.connect(g); g.connect(dest);
      o.start(at); o.stop(at + 0.38);
    };
    ping(523.25, t);
    ping(659.25, t + 0.14);
    return;
  }

  if (name === 'report-down') {
    // one low note, short — a bad day is stated, not mourned
    const o = osc(c, 'sine', 174.6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + 0.34);
    return;
  }

  if (name === 'post') {
    // a fence post going in: one wooden knock
    const o = osc(c, 'sine', 190);
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(95, t + 0.07);
    const g = c.createGain(); env(g, t, 0.003, 0.4, 0.09);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + 0.14);
    const n = noiseSrc(c);
    const bp = filt(c, 'bandpass', 900, 1.0);
    const ng = c.createGain(); env(ng, t, 0.002, 0.22, 0.045);
    n.connect(bp); bp.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.09);
    return;
  }

  if (name === 'gravel') {
    // track laid: a short scrape of stones
    const n = noiseSrc(c);
    const bp = filt(c, 'bandpass', 500, 0.8);
    bp.frequency.setValueAtTime(380, t);
    bp.frequency.linearRampToValueAtTime(700, t + 0.22);
    const g = c.createGain(); env(g, t, 0.02, 0.18, 0.2);
    n.connect(bp); bp.connect(g); g.connect(dest);
    n.start(t); n.stop(t + 0.28);
    return;
  }

  if (name === 'dozer') {
    // flatten: a low working rumble, under a second — the earth moved
    const o = osc(c, 'sawtooth', 52);
    const lp = filt(c, 'lowpass', 240, 1.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.12);
    g.gain.setValueAtTime(0.16, t + 0.62);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    o.connect(lp); lp.connect(g); g.connect(dest);
    const lfo = osc(c, 'sine', 18);
    const lg = c.createGain(); lg.gain.value = 0.05;
    lfo.connect(lg); lg.connect(g.gain);
    o.start(t); o.stop(t + 1.0); lfo.start(t); lfo.stop(t + 1.0);
    return;
  }

  /* ---- Tier 2 — the world, heard from the plot -------------------------
     These three are the audible form of numbers the HUD already prints. Rule from the
     plan: if a sound cannot name the state that triggers it, it does not ship. Each one
     names it in the comment above it. */

  if (name === 'saw-far') {
    // A working forest, not a loop (SEAT A2). One saw, one bearing, gone again.
    // Trigger: h.company.relation → the cutting rate. Frequency is the scheduler's job
    // (sawWait); this recipe is only the single event.
    const dur = 1.4 + rnd() * 1.1;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(SAW_LEVEL, t + 0.35);
    out.gain.setValueAtTime(SAW_LEVEL, t + dur - 0.45);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = pan(c, (rnd() * 2 - 1) * 0.85);
    if (p) { out.connect(p); p.connect(dest); } else out.connect(dest);

    const lp = filt(c, 'lowpass', 1000 + rnd() * 500, 2.5);   // the air between us and it
    const trem = c.createGain(); trem.gain.value = 0.6;
    lp.connect(trem); trem.connect(out);

    const a = osc(c, 'sawtooth', 96 + rnd() * 10);
    const b = osc(c, 'sawtooth', a.frequency.value * 1.03);
    a.connect(lp); b.connect(lp);

    const lfo = osc(c, 'sine', 22 + rnd() * 8);
    const lg = c.createGain(); lg.gain.value = 0.35;
    lfo.connect(lg); lg.connect(trem.gain);

    a.start(t); b.start(t); lfo.start(t);
    a.stop(t + dur + 0.05); b.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    return;
  }

  if (name === 'bakkie' || name === 'bakkie-bad') {
    // A bakkie up the drive. Trigger: a guest arrives. The `-bad` variant is the audible
    // form of road condition (SOUND-PLAN §13): the complaint text already exists, this is
    // the same fact as a pothole the car drops into. `arrival(road)` picks the variant.
    const dur = 2.4;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.9, t + 0.6);
    out.gain.setValueAtTime(0.9, t + 1.7);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = pan(c, -0.25);
    if (p) { out.connect(p); p.connect(dest); } else out.connect(dest);

    // diesel putter: 52 → 41 Hz as it pulls in and stops
    const lp = filt(c, 'lowpass', 240, 1.1);
    const eg = c.createGain(); eg.gain.value = 0.16;
    lp.connect(eg); eg.connect(out);
    const a = osc(c, 'sawtooth', 52);
    a.frequency.setValueAtTime(52, t);
    a.frequency.linearRampToValueAtTime(41, t + dur);
    a.connect(lp);
    const putter = osc(c, 'sine', 11);
    const pg = c.createGain(); pg.gain.value = 0.06;
    putter.connect(pg); pg.connect(eg.gain);

    // gravel under the tyres
    const n = noiseSrc(c);
    const bp = filt(c, 'bandpass', 1400, 0.7);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.13, t + 0.7);
    ng.gain.linearRampToValueAtTime(0.0001, t + 2.1);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + 2.2);

    if (name === 'bakkie-bad') {
      const at = t + 1.15;
      const thud = osc(c, 'sine', 62);
      thud.frequency.setValueAtTime(62, at);
      thud.frequency.exponentialRampToValueAtTime(38, at + 0.16);
      const tg = c.createGain(); env(tg, at, 0.004, 0.42, 0.22);
      thud.connect(tg); tg.connect(out);
      thud.start(at); thud.stop(at + 0.3);

      const cl = noiseSrc(c);
      const clp = filt(c, 'lowpass', 900, 1.0);
      const cg = c.createGain(); env(cg, at, 0.002, 0.2, 0.09);
      cl.connect(clp); clp.connect(cg); cg.connect(out);
      cl.start(at); cl.stop(at + 0.14);
    }

    a.start(t); putter.start(t);
    a.stop(t + dur + 0.1); putter.stop(t + dur + 0.1);
    return;
  }

  /* ---- §15.6 — the wildlife cues, agreed with the narrative seat -------
     One event name per state event: the quote and its cue key to the same string, so
     they can never drift. Landed here ahead of the strings, which have not shipped yet
     (SEAT A3: land the recipes now, wire when their strings land). */

  if (name === 'baboon-raid') {
    // the serious one: three barks, then something comes down through the canopy
    const out = c.createGain(); out.gain.value = 0.5; out.connect(dest);
    const bp = filt(c, 'bandpass', 520, 1.6);
    bp.connect(out);

    [[0, 420], [0.22, 400], [0.42, 360]].forEach(([off, f]) => {
      const at = t + off;
      const o = osc(c, 'sawtooth', f);
      o.frequency.setValueAtTime(f, at);
      o.frequency.linearRampToValueAtTime(f * 0.86, at + 0.11);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.5, at + 0.012);
      g.gain.setValueAtTime(0.5, at + 0.07);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      o.connect(g); g.connect(bp);
      o.start(at); o.stop(at + 0.18);
    });

    const crash = noiseSrc(c);
    const lp = filt(c, 'lowpass', 1500, 0.9);
    lp.frequency.setValueAtTime(1500, t + 0.5);
    lp.frequency.exponentialRampToValueAtTime(420, t + 1.3);
    const cg = c.createGain(); env(cg, t + 0.5, 0.02, 0.4, 0.85);
    crash.connect(lp); lp.connect(cg); cg.connect(out);
    crash.start(t + 0.5); crash.stop(t + 1.45);
    return;
  }

  if (name === 'samango-raid') {
    // the lighter one: leaves moving, and nothing dies loudly. No bark, no crash.
    const out = c.createGain(); out.gain.value = 0.3; out.connect(dest);
    [[0, 0.5], [0.34, 0.35]].forEach(([off, peak]) => {
      const at = t + off;
      const n = noiseSrc(c);
      const bp = filt(c, 'bandpass', 2600, 0.8);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.09);
      g.gain.linearRampToValueAtTime(0.0001, at + 0.42);
      n.connect(bp); bp.connect(g); g.connect(out);
      n.start(at); n.stop(at + 0.46);
    });
    return;
  }

  if (name === 'snake-scare') {
    // SILENCE IS THE CUE. One held breath, then nothing — no sting, no rattle, no
    // stinger. The probe measures it: quiet, short, and dull (peak low, dominant low).
    const n = noiseSrc(c);
    const lp = filt(c, 'lowpass', 620, 0.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.22);
    g.gain.setValueAtTime(0.045, t + 0.34);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.78);
    n.connect(lp); lp.connect(g); g.connect(dest);
    n.start(t); n.stop(t + 0.8);
    return;
  }

  if (name === 'toad') {
    // wetland only, never a jingle: the conservation choice is not rewarded with a
    // fanfare. Two flat croaks that resolve nowhere.
    const out = c.createGain(); out.gain.value = 0.22; out.connect(dest);
    [0, 0.42].forEach((off) => {
      const at = t + off;
      const o = osc(c, 'sine', 128);
      o.frequency.setValueAtTime(132, at);
      o.frequency.linearRampToValueAtTime(118, at + 0.13);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.45, at + 0.02);
      g.gain.setValueAtTime(0.45, at + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      const am = osc(c, 'sine', 31);
      const ag = c.createGain(); ag.gain.value = 0.35;
      am.connect(ag); ag.connect(g.gain);
      o.connect(g); g.connect(out);
      o.start(at); o.stop(at + 0.24); am.start(at); am.stop(at + 0.24);
    });
    return;
  }

  if (name === 'loerie') {
    // the go-away bird: three descending nasal syllables, raucous and unmusical.
    // Rides the praise pool — it is the sound of someone being pleased in this village.
    const out = c.createGain(); out.gain.value = 0.34; out.connect(dest);
    const bp = filt(c, 'bandpass', 1150, 1.5);
    const pk = filt(c, 'peaking', 2400, 2.0); pk.gain.value = 6;
    bp.connect(pk); pk.connect(out);

    [[0, 1000, 1], [0.26, 880, 0.85], [0.5, 720, 0.7]].forEach(([off, f, lvl]) => {
      const at = t + off;
      const o = osc(c, 'sawtooth', f);
      o.frequency.setValueAtTime(f, at);
      o.frequency.linearRampToValueAtTime(f * 0.78, at + 0.2);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.42 * lvl, at + 0.03);
      g.gain.setValueAtTime(0.42 * lvl, at + 0.14);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
      o.connect(g); g.connect(bp);
      o.start(at); o.stop(at + 0.28);
    });
    return;
  }

  /* ---- review cues (SEAT A4) — keyed to the same factor as the quote ---- */

  if (name === 'review-good') {
    // a fourth up, soft, over in half a second. No sparkle, no jingle.
    const ping = (f, at) => {
      const o = osc(c, 'triangle', f);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.085, at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      o.connect(g); g.connect(dest);
      o.start(at); o.stop(at + 0.55);
    };
    ping(392, t);           // G4
    ping(587.33, t + 0.13); // D5
    return;
  }

  if (name === 'review-bad') {
    // a door closing, not a buzzer: wood, a latch, then the quiet.
    const n = noiseSrc(c);
    const lp = filt(c, 'lowpass', 700, 0.9);
    const ng = c.createGain(); env(ng, t, 0.004, 0.22, 0.16);
    n.connect(lp); lp.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.2);

    const o = osc(c, 'sine', 74);
    o.frequency.setValueAtTime(74, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.14);
    const og = c.createGain(); env(og, t, 0.005, 0.28, 0.2);
    o.connect(og); og.connect(dest);
    o.start(t); o.stop(t + 0.28);

    const latch = noiseSrc(c);
    const hp = filt(c, 'highpass', 2600, 0.8);
    const lh = c.createGain(); env(lh, t + 0.11, 0.001, 0.09, 0.03);
    latch.connect(hp); hp.connect(lh); lh.connect(dest);
    latch.start(t + 0.11); latch.stop(t + 0.16);
    return;
  }
}

/* ---------------------------------------------------------------- birdsong */

// The Eastern Cape keeps time by ear. The piet-my-vrou arrives with the spring, the
// nightjar churrs through midsummer, the hadeda complains in every season and gets
// louder about it in the rain. Four recipes, all synthesised, same rules as the rest.
//
// Distance is a gain and a filter, not a reverb preset: a far bird is quiet and dull,
// a close one is loud and nasal.

function buildBirdCall(c, dest, name, when) {
  const t = Math.max(0, when || 0);

  if (name === 'pietmyvrou') {
    // red-chested cuckoo — three falling whistles, 700 ms apart, over the next ridge
    const lp = filt(c, 'lowpass', 2000, 0.7);   // air and leaves between us
    const out = c.createGain();
    out.gain.value = 0.12;                      // far away: quiet by design
    lp.connect(out); out.connect(dest);

    [1100, 850, 700].forEach((f, i) => {
      const at = t + i * 0.7;
      const o = osc(c, 'sine', f);
      o.frequency.setValueAtTime(f, at);
      o.frequency.linearRampToValueAtTime(f * 0.94, at + 0.18);  // each whistle droops
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(1, at + 0.05);         // soft attack
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.19);
      o.connect(g); g.connect(lp);
      o.start(at); o.stop(at + 0.22);
    });
    return;
  }

  if (name === 'trogon') {
    // Narina trogon — two hollow hoots, barely there, and the forest answers twice
    const out = c.createGain();
    out.gain.value = 0.045;                     // very low gain
    out.connect(dest);

    const inp = c.createGain();                 // dry + two soft taps = slight reverb
    inp.gain.value = 1;
    const lp = filt(c, 'lowpass', 1100, 0.9);
    inp.connect(lp); lp.connect(out);
    [[0.10, 0.28], [0.21, 0.14]].forEach(([d, g]) => {
      const dl = c.createDelay(0.6);
      dl.delayTime.value = d;
      const dg = c.createGain(); dg.gain.value = g;
      inp.connect(dl); dl.connect(dg); dg.connect(lp);
    });

    [[420, 0], [470, 0.34]].forEach(([f, off]) => {
      const at = t + off;
      const o = osc(c, 'sine', f);
      o.frequency.setValueAtTime(f * 0.99, at);
      o.frequency.linearRampToValueAtTime(f, at + 0.06);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(1, at + 0.035);
      g.gain.setValueAtTime(1, at + 0.13);      // held 250 ms, then gone
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
      o.connect(g); g.connect(inp);
      o.start(at); o.stop(at + 0.28);
    });
    return;
  }

  if (name === 'hadeda') {
    // hadeda ibis — 3–4 nasal sawtooth pulses climbing 600 → 900 Hz, close and rude
    const out = c.createGain();
    out.gain.value = 0.30;                      // the opposite of the cuckoo
    out.connect(dest);

    const bp = filt(c, 'bandpass', 850, 1.4);   // nasal
    const pk = filt(c, 'peaking', 1700, 2.5);
    pk.gain.value = 7;
    bp.connect(pk); pk.connect(out);

    const pulses = 3 + Math.floor(rnd() * 2);
    const vib = osc(c, 'sine', 27);             // fast, ugly vibrato
    const vg = c.createGain(); vg.gain.value = 26;
    vib.connect(vg);
    vib.start(t); vib.stop(t + 0.17 * pulses + 0.3);

    for (let i = 0; i < pulses; i++) {
      const at = t + i * 0.17;
      const f = 600 + (300 * i) / Math.max(1, pulses - 1);
      const o = osc(c, 'sawtooth', f);
      o.frequency.setValueAtTime(f, at);
      o.frequency.linearRampToValueAtTime(f * 1.06, at + 0.11);
      vg.connect(o.frequency);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(1, at + 0.012);
      g.gain.setValueAtTime(1, at + 0.07);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      o.connect(g); g.connect(bp);
      o.start(at); o.stop(at + 0.16);
    }
    return;
  }

  if (name === 'nightjar') {
    // nightjar — a dry churr: 1.8 s of noise at 2 kHz, chopped by a 24 Hz gate
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.08, t + 0.25);      // very quiet
    out.gain.setValueAtTime(0.08, t + 1.55);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    out.connect(dest);

    const bp = filt(c, 'bandpass', 2000, 1.2);
    bp.connect(out);

    const n = noiseSrc(c);
    const ng = c.createGain();
    ng.gain.value = 0.5;
    n.connect(ng); ng.connect(bp);

    const am = osc(c, 'sine', 24);
    const ag = c.createGain(); ag.gain.value = 0.45;
    am.connect(ag); ag.connect(ng.gain);

    n.start(t); n.stop(t + 1.82);
    am.start(t); am.stop(t + 1.82);
  }
}

/** Which bird answers which season. Autumn and winter keep their own counsel. */
function buildSeasonCue(c, dest, season, when) {
  const s = String(season);
  if (s === 'spring') buildBirdCall(c, dest, 'pietmyvrou', when);
  else if (s === 'summer') buildBirdCall(c, dest, 'nightjar', when);
  // autumn / winter: silent — the cue is the absence
}

/* --------------------------------------------------------------- ambience */

// The bed matrix. One row per weather kind; birds vary by season (index order below).
// Hogsback, not Hollywood: mist eats sound, snow is the loudest silence in the game.
// Gains sit LOW and the wobble rates are SLOW (owner verdict 4: the old storm bed
// pumped its amplitude at 0.85 Hz — a siren, not weather). Movement now comes from
// the wobble plus a slow filter drift in buildBed, not from a fast LFO.
const BEDS = {
  clear: { noise: 0.045, lp: 1200, hp: 120, wobble: 0.05, rumble: 0, birds: [1.7, 1.1, 0.25, 1.5] },
  mist:  { noise: 0.028, lp: 460,  hp: 90,  wobble: 0.04, rumble: 0, birds: [0.35, 0.30, 0.10, 0.30] },
  rain:  { noise: 0.095, lp: 3200, hp: 320, wobble: 0.08, rumble: 0, birds: [0, 0, 0, 0] },
  storm: { noise: 0.160, lp: 2600, hp: 260, wobble: 0.12, rumble: 0.11, birds: [0, 0, 0, 0] },
  cold:  { noise: 0.062, lp: 700,  hp: 110, wobble: 0.06, rumble: 0, birds: [0.05, 0.05, 0, 0.05] },
  snow:  { noise: 0.024, lp: 380,  hp: 70,  wobble: 0.035, rumble: 0, birds: [0, 0, 0, 0] },
};
const SEASON_ORDER = { summer: 0, autumn: 1, winter: 2, spring: 3 };
const SEASON_NOISE = { summer: 1.0, autumn: 0.92, winter: 0.85, spring: 0.95 };

// --- the bird calendar -------------------------------------------------------
// Hogsback's seasons as months: spring Sep–Nov, summer Dec–Feb, autumn Mar–May,
// winter Jun–Aug. Each species has a window; the gate is the intersection of that
// window with the season, minus whatever the weather drowns out.
const SEASON_MONTHS = {
  spring: [9, 10, 11],
  summer: [12, 1, 2],
  autumn: [3, 4, 5],
  winter: [6, 7, 8],
};
const BIRD_WINDOW = {
  pietmyvrou: [9, 10, 11, 12, 1, 2],   // Sep–Feb: the spring/summer cuckoo
  trogon: [9, 10, 11],                 // Sep–Nov only
  hadeda: null,                        // year-round, rain or shine
  nightjar: [12, 1, 2],                // Dec–Feb only
};

/**
 * Species allowed right now, with a pick weight. Rules, in one place:
 *  · pietmyvrou Sep–Feb, trogon Sep–Nov, nightjar Dec–Feb, hadeda all year
 *  · rain or storm silences the two far forest calls entirely (pietmyvrou, trogon)
 *  · rain makes the hadeda three times as likely to be the one you hear
 *  · snow keeps the bed's deliberate silence
 */
function birdGate(weather, season) {
  if (weather === 'snow') return [];
  const months = SEASON_MONTHS[season] || SEASON_MONTHS.summer;
  const wet = weather === 'rain' || weather === 'storm';
  const gate = [];
  for (const name of ['pietmyvrou', 'trogon', 'hadeda', 'nightjar']) {
    const win = BIRD_WINDOW[name];
    if (win && !months.some((m) => win.includes(m))) continue;
    if (wet && (name === 'pietmyvrou' || name === 'trogon')) continue;
    gate.push({ name, weight: wet && name === 'hadeda' ? 3 : 1 });
  }
  return gate;
}

function bedSpec(weather, season) {
  const base = BEDS[weather] || BEDS.clear;
  const si = SEASON_ORDER[season] != null ? SEASON_ORDER[season] : 0;
  let lp = base.lp;
  // a wet winter day is a colder, duller sound than a wet summer one
  if (season === 'winter' && (weather === 'rain' || weather === 'storm')) lp *= 0.72;
  const birds = birdGate(weather, season);
  let birdRate = base.birds[si] || 0;
  // rain and storm have no bed birds by design, but the hadeda still calls through them
  if (birds.length && birdRate <= 0 && weather !== 'snow') birdRate = 0.5;
  if (!birds.length) birdRate = 0;
  return {
    noise: base.noise * (SEASON_NOISE[season] || 1),
    lp, hp: base.hp,
    wobble: base.wobble,
    rumble: base.rumble,
    wet: weather === 'rain' || weather === 'storm',
    birds,
    birdRate,
  };
}

/** Build a full bed (filtered noise + wind breathing + optional rumble) into `dest`. */
function buildBed(c, dest, spec, when, fadeIn) {
  const t = Math.max(0, when || 0);
  const out = c.createGain();
  if (fadeIn > 0) {
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(1, t + fadeIn);
  } else {
    out.gain.value = 1;
  }
  out.connect(dest);

  const src = c.createBufferSource();
  src.buffer = noise(c);
  src.loop = true;

  const hp = filt(c, 'highpass', spec.hp, 0.7);
  const lp = filt(c, 'lowpass', spec.lp, 0.6);
  const ng = c.createGain();
  ng.gain.value = spec.noise;
  src.connect(hp); hp.connect(lp); lp.connect(ng); ng.connect(out);

  // wind breathing — slow amplitude wobble, the difference between hiss and weather
  const lfo = osc(c, 'sine', spec.wobble);
  const lg = c.createGain();
  lg.gain.value = spec.noise * 0.35;
  lfo.connect(lg); lg.connect(ng.gain);

  // slow drift on the filter, 14–33 s a cycle: the bed never sits on one timbre, so
  // nothing about it loops recognisably (owner verdict 4). Not synced to the buffer.
  const flfo = osc(c, 'sine', 0.03 + rnd() * 0.04);
  const flg = c.createGain();
  flg.gain.value = spec.lp * 0.18;
  flfo.connect(flg); flg.connect(lp.frequency);

  const nodes = [src, lfo, flfo];
  let rumble = null;
  if (spec.rumble > 0) {
    rumble = osc(c, 'sine', 42);
    const rg = c.createGain();
    rg.gain.value = spec.rumble;
    const rl = osc(c, 'sine', 0.13);
    const rlg = c.createGain();
    rlg.gain.value = spec.rumble * 0.6;
    rl.connect(rlg); rlg.connect(rg.gain);
    rumble.connect(rg); rg.connect(out);
    nodes.push(rumble, rl);
    rumble.start(t); rl.start(t);
  }

  src.start(t); lfo.start(t); flfo.start(t);
  return { out, nodes, spec };
}

/**
 * Sparse bird calls over the bed. Own timer, own RNG, cancellable.
 * One call per tick, so two species never overlap; the gap is never shorter than
 * 20 s and never longer than 40 s. Rain pulls the hadeda in to 20–30 s, a thin
 * winter bed pushes everything out to 30–40 s.
 */
function birdWait(spec) {
  if (spec.wet) return 20 + rnd() * 10;
  if (!(spec.birdRate >= 0.5)) return 30 + rnd() * 10;
  return 20 + rnd() * 20;
}

function pickBird(gate) {
  let total = 0;
  for (const b of gate) total += b.weight;
  let r = rnd() * total;
  for (const b of gate) {
    r -= b.weight;
    if (r <= 0) return b.name;
  }
  return gate.length ? gate[gate.length - 1].name : null;
}

function scheduleBirds(spec, key) {
  clearTimeout(birdTimer);
  if (!ctx || muted || !(spec.birdRate > 0) || !spec.birds || !spec.birds.length) return;
  const wait = birdWait(spec);
  birdTimer = setTimeout(() => {
    if (!ctx || muted || !current || current.key !== key) return;
    const name = pickBird(spec.birds);
    if (name) birdCall(name);
    scheduleBirds(spec, key);
  }, wait * 1000);
}

/* ------------------------------------------------- Tier 2: the world layers */

// Three things heard from the plot, each one the audible form of a number already on
// screen. They are layers, not beds: the weather bed cross-fades on its own key and
// these start, stop and sputter independently, so a storm never restarts the generator.
//
// All three read a snapshot the UI hands over. Absent fields mean "not told" — the layer
// stays silent, so an old call site that only passes weather/season sounds exactly as it
// did before this file grew.

/** Stance → how much the mountain is being cut. Same numbers as COMPANY.cuttingRate. */
const SAW_STANCE = { supplier: 1.0, neutral: 0.7, opposed: 0.3, left: 0.15, owner: 0 };

/**
 * What the generator sounds like, from state alone. Null when there is no generator or
 * solar is carrying the house (the sim already says solar never makes a sound).
 * `sputter` is the mean seconds between trips, and it is only ever non-zero in the two
 * weathers `powerNight()` actually trips in — the sound cannot outrun the sim.
 */
function genSpec(power, weather) {
  if (power !== 'generator') return null;
  const bad = weather === 'storm' || weather === 'snow';
  return { hum: GEN_LEVEL, sputter: bad ? 11 : 0 };
}

/**
 * Seconds between distant saws, from the company stance. Infinity means silent — the
 * owner's mountain and a departed company both stop the saws, which is the one place
 * this game lets silence carry a decision.
 */
function sawWait(stance) {
  const cut = SAW_STANCE[stance];
  if (cut == null || cut <= 0) return Infinity;
  return SAW.max - (SAW.max - SAW.min) * cut;
}

/** The hum: two detuned saws through a lowpass, the exhaust above them, a slow wobble.
 *  Returns the nodes so a sputter can dip the running gain without stopping the machine. */
function buildGenerator(c, dest, when, fadeIn) {
  const t = Math.max(0, when || 0);
  const out = c.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.linearRampToValueAtTime(1, t + (fadeIn || 1.5));
  out.connect(dest);

  const g = c.createGain();
  g.gain.value = GEN_LEVEL;
  g.connect(out);

  const lp = filt(c, 'lowpass', 260, 0.9);
  lp.connect(g);
  const a = osc(c, 'sawtooth', 49);
  const b = osc(c, 'sawtooth', 50.6);
  const ah = c.createGain(); ah.gain.value = 0.5;
  a.connect(ah); ah.connect(lp);
  b.connect(lp);

  // the exhaust, a whisper above the hum
  const n = c.createBufferSource();
  n.buffer = noise(c); n.loop = true;
  const nbp = filt(c, 'bandpass', 380, 0.9);
  const ng = c.createGain(); ng.gain.value = 0.09;
  n.connect(nbp); nbp.connect(ng); ng.connect(g);

  // a machine idling, not a note: 0.7 Hz, ±6%
  const wob = osc(c, 'sine', 0.7);
  const wg = c.createGain(); wg.gain.value = GEN_LEVEL * 0.06;
  wob.connect(wg); wg.connect(g.gain);

  a.start(t); b.start(t); n.start(t); wob.start(t);
  return { out, gain: g, nodes: [a, b, n, wob] };
}

/** One trip: the hum sags, catches, comes back. No click of a switch — a machine. */
function sputterNow() {
  if (!ctx || !gen || muted) return;
  note('gen:sputter');
  const t = now(ctx) + 0.02;
  const lvl = genLevel();
  const p = gen.gain.gain;
  p.cancelScheduledValues(t);
  p.setValueAtTime(lvl, t);
  p.linearRampToValueAtTime(lvl * 0.12, t + 0.05);
  p.setValueAtTime(lvl * 0.12, t + 0.22 + rnd() * 0.3);
  p.linearRampToValueAtTime(lvl, t + 0.6 + rnd() * 0.5);

  const n = noiseSrc(ctx);
  const lp = filt(ctx, 'lowpass', 700, 0.9);
  const g = ctx.createGain(); env(g, t, 0.002, 0.09, 0.06);
  n.connect(lp); lp.connect(g); g.connect(gen.out);
  n.start(t); n.stop(t + 0.1);
}

/** The hum's level. `night` is a hint, not a requirement: this game has no clock, so an
 *  untold night plays the machine at full and an explicit daytime halves it. */
const genLevel = () => GEN_LEVEL * (worldState && worldState.night === false ? 0.45 : 1);

function scheduleSputter() {
  clearTimeout(sputterTimer);
  if (!ctx || muted || !gen || !worldState) return;
  const spec = genSpec(worldState.power, worldState.weather);
  if (!spec || !spec.sputter) return;
  const wait = spec.sputter * (0.7 + rnd() * 0.6);
  sputterTimer = setTimeout(() => {
    if (!ctx || muted || !gen) return;
    sputterNow();
    scheduleSputter();
  }, wait * 1000);
}

/** Start, stop, or re-level the hum for the current snapshot. */
function syncGenerator() {
  if (!ctx || muted) return;
  const spec = genSpec(worldState && worldState.power, worldState && worldState.weather);
  if (!spec) {
    if (gen) {
      note('gen:off');
      const t = now(ctx);
      const old = gen;
      old.out.gain.cancelScheduledValues(t);
      old.out.gain.setValueAtTime(old.out.gain.value, t);
      old.out.gain.linearRampToValueAtTime(0.0001, t + 1.2);
      for (const n of old.nodes) { try { n.stop(t + 1.4); } catch { /* already stopped */ } }
      gen = null;
      clearTimeout(sputterTimer);
    }
    return;
  }
  if (!gen) { gen = buildGenerator(ctx, ambBus, now(ctx), 1.5); note('gen:on'); }
  const t = now(ctx);
  gen.gain.gain.cancelScheduledValues(t);
  gen.gain.gain.setValueAtTime(genLevel(), t);
  scheduleSputter();
}

/** One distant saw now, then the next one scheduled by the stance. */
function scheduleSaws() {
  clearTimeout(sawTimer);
  if (!ctx || muted || !worldState) return;
  const wait = sawWait(worldState.stance);
  if (!isFinite(wait)) return;
  const gap = wait * (0.65 + rnd() * 0.7);
  sawTimer = setTimeout(() => {
    if (!ctx || muted || !worldState) return;
    if (sawWait(worldState.stance) !== Infinity) sfx('saw-far');
    scheduleSaws();
  }, gap * 1000);
}

/** Tear the world layers AND the bed down. Muting is not only zeroing the master: a
 *  running bed is two looping noise buffers, three filters and two LFOs, and the ambience
 *  is the heaviest graph in the game. `current = null` is what forces the unmute to build
 *  the bed for the weather that is true NOW, not the one that was true when the player
 *  pressed mute. Same reason `syncGenerator()` refuses to run while muted. */
function stopLayers() {
  clearTimeout(sputterTimer);
  clearTimeout(sawTimer);
  clearTimeout(birdTimer);
  if (!ctx) return;
  const t = now(ctx);
  if (gen) {
    for (const n of gen.nodes) { try { n.stop(t + 0.2); } catch { /* already stopped */ } }
    gen = null;
  }
  if (current) {
    for (const n of current.nodes) { try { n.stop(t + 0.2); } catch { /* already stopped */ } }
    current = null;
  }
}

/* --------------------------------------------------------------- public API */

/** Create the context on the first user gesture (browsers block autoplay). Idempotent. */
export function initAudio() {
  try {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    ctx = new AC();
    const b = buses(ctx);
    ambBus = b.amb;
    sfxBus = b.sfx;
    if (ctx.state === 'suspended') ctx.resume();
    if (wantSnap) { const s = wantSnap; wantSnap = null; want = null; world(s); }
    else if (want) { const w = want; want = null; ambience(w.weather, w.season); }
    return ctx;
  } catch { return null; }
}

/** One switch, one node: everything the game makes goes through these masters. */
export function setMuted(v) {
  muted = !!v;
  note('mute:' + (muted ? 'on' : 'off'));
  try {
    const t = ctx ? now(ctx) : 0;
    for (const m of masters) {
      m.gain.cancelScheduledValues(t);
      m.gain.setValueAtTime(muted ? 0 : MASTER_LEVEL, t);
    }
  } catch { /* headless */ }
  if (muted) {
    stopLayers();          // bed, hum, saws and birds: nothing runs behind a silent master
  } else if (ctx && worldState) {
    // One rebuild, from the snapshot: the bed for the weather that is true NOW (stopLayers
    // dropped `current`, so bedFor cannot early-return on a stale key), the hum, the saws.
    world(worldState);
  }
}

export function isMuted() { return muted; }

/**
 * The whole world in one call: weather, season, and the three Tier 2 layers.
 * `{ weather, season, night, power, stance, road }` — every field but weather/season is
 * optional, and an absent field means "not told". For the three layers that means silence:
 * the module will not guess whether you have a generator or who you are to the company.
 * `night` is the exception and the other way round (A6): this game has no clock, so an
 * untold night plays the hum at FULL and only an explicit `night: false` dims it.
 * Existing call sites that only pass weather and season keep their exact sound.
 */
export function world(snapshot) {
  try {
    const s = snapshot || {};
    const w = BEDS[s.weather] ? String(s.weather) : 'clear';
    const se = SEASON_ORDER[s.season] != null ? String(s.season) : 'summer';
    worldState = {
      weather: w,
      season: se,
      night: s.night === true ? true : s.night === false ? false : null,
      power: s.power === 'generator' || s.power === 'solar' ? s.power : 'none',
      stance: SAW_STANCE[s.stance] != null ? String(s.stance) : null,
      road: Number.isFinite(s.road) ? Math.max(0, Math.min(100, s.road)) : 100,
    };
    if (!ctx) {
      want = { weather: w, season: se };
      wantSnap = Object.assign({}, worldState);
      return;
    }
    bedFor(w, se);
    syncGenerator();
    scheduleSaws();
  } catch { /* never throw into the game loop */ }
}

/** The weather bed alone — the original entry point, kept so every old call site works. */
export function ambience(weather, season) {
  world(Object.assign({}, worldState || {}, { weather, season }));
}

/** The bed for a weather+season pair, cross-faded. Same key twice = no-op.
 *  While muted nothing is built at all: `stopLayers()` already took the bed down, and a
 *  weather change during a mute should not wake two noise loops to feed a silent bus. The
 *  unmute rebuilds from the snapshot, so the bed the player hears is the weather they have. */
function bedFor(w, se) {
  const key = w + '|' + se;
  if (current && current.key === key) return;
  if (muted) { note('bed:' + key, { value: 'held' }); return; }
  const spec = bedSpec(w, se);
  const next = buildBed(ctx, ambBus, spec, now(ctx), CROSSFADE);
  const old = current;
  current = { key, out: next.out, nodes: next.nodes, spec };
  if (old) {
    const t = now(ctx);
    old.out.gain.cancelScheduledValues(t);
    old.out.gain.setValueAtTime(old.out.gain.value, t);
    old.out.gain.linearRampToValueAtTime(0.0001, t + CROSSFADE);
    for (const n of old.nodes) { try { n.stop(t + CROSSFADE + 0.1); } catch { /* already stopped */ } }
  }
  note('bed:' + key, { value: spec.noise });
  scheduleBirds(spec, key);
}

/** A short synthesised one-shot. Unknown names are ignored. `delay` shifts the
 *  onset in seconds (default 10 ms) so two cues can be sequenced without timers. */
export function sfx(name, delay) {
  try {
    note('sfx:' + name, { delay });
    if (!ctx || muted || !sfxBus) return;
    buildSfx(ctx, sfxBus, name, now(ctx) + (delay == null ? 0.01 : Math.max(0, delay)));
  } catch { /* never throw into the game loop */ }
}

/**
 * One named bird, once. 'pietmyvrou' | 'trogon' | 'hadeda' | 'nightjar'.
 * Rides the ambience bus, so it sits under the mix and obeys mute like everything else.
 */
export function birdCall(name) {
  try {
    note('bird:' + name);
    if (!ctx || muted || !ambBus) return;
    buildBirdCall(ctx, ambBus, name, now(ctx) + 0.02);
  } catch { /* never throw into the game loop */ }
}

/** The seasonal earcon: spring speaks, summer churrs, autumn and winter say nothing. */
export function seasonCue(season) {
  try {
    note('cue:' + season);
    if (!ctx || muted || !ambBus) return;
    buildSeasonCue(ctx, ambBus, season, now(ctx) + 0.02);
  } catch { /* never throw into the game loop */ }
}

/**
 * A guest's verdict, keyed to the same number as their quote: 4★ and up gets the warm
 * cue, under 3.5 gets the door closing. The middle band says nothing — a 3.8 night is
 * not an event, and a cue on every night would be a jingle by repetition.
 */
export function review(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return;
  if (s >= 4) sfx('review-good');
  else if (s < 3.5) sfx('review-bad');
  // The middle band is the cue: no sound on a 3.8 night. Logged anyway, because "the
  // silence was chosen" and "nothing arrived" look identical from the speaker.
  else note('review:quiet', { value: s });
}

/**
 * A guest arrives: the gate, then the bakkie up the drive, and the pothole if the road has
 * gone. Trigger is the arrival, not the booking -- one cue per arrival burst (A10 says why
 * `h.lastNights` is not that event yet, and what field would make it one).
 *
 * The gate is part of this call, not its own event (A11). `p.gate` is a PLACE in the sim --
 * fixed per plot, never opened, never bought, only where the fence must start from -- so the
 * one moment a gate does anything audible is a vehicle passing through it. Folding it in here
 * gives the recipe a real trigger and keeps the manifest honest: there is no gate verb to
 * wire it to, and inventing one to spend a sound would be the tail wagging the dog.
 */
export function arrival(road) {
  const r = Number.isFinite(road) ? road : 100;
  note('arrival:' + (r < 40 ? 'bakkie-bad' : 'bakkie'), { value: r });
  sfx('gate');
  sfx(r < 40 ? 'bakkie-bad' : 'bakkie', 0.32);
}

/* Probe-only: build the same voices into any BaseAudioContext (OfflineAudioContext for
   evidence in tools/audio-probe.html). Not used by the game. */
export const _synth = {
  buses,
  sfx: buildSfx,
  bird: buildBirdCall,
  cue: buildSeasonCue,
  bed: (c, dest, weather, season, when, fadeIn) =>
    buildBed(c, dest, bedSpec(weather, season), when, fadeIn),
  spec: bedSpec,
  gen: buildGenerator,
  genSpec,
  // The hum's level for the snapshot being held right now. `night` is a hint, not a
  // requirement: an untold night plays the machine at full and only an explicit day
  // (night === false) dims it. Probed so nobody can quietly re-dim the hum for pages
  // that never mention the time of day — which is every page in this game.
  genLevel,
  GEN_LEVEL,
  sawWait,
  // what ambience()/world() is holding RIGHT NOW — the probe asserts the bed tracks the
  // latest weather the game handed over, never a stale first-load one (verdict 4), and
  // that the generator graph only exists when it should (muted = no graph)
  state: () => ({
    current: current && current.key,
    want: want && want.weather,
    world: worldState,
    genLive: !!gen,
    bedLive: !!current,
    muted: !!muted,
  }),
  // Every audible decision since the page opened (or the last clear), newest last, capped
  // at CUE_LOG_MAX. The session probe reads this through the module singleton: ES modules
  // are per-URL singletons, so `await import('/game/js/ui/audio.js')` in the page hands
  // back the SAME instance the page imported -- no window global, no DOM, no page change.
  cues: () => cueLog.map((c) => Object.assign({}, c)),
  clearCues: () => { cueLog.length = 0; },
};
