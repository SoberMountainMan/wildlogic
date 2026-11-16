// valley-art.js — the real-Hogsback BACKDROP for the valley map (task #44, 11-15).
//
// WHAT THIS FIXES. The valley map already drew the truth: the DEM hillshaded, the OSM
// roads, the streams, the forest polygons, the named landmarks. But it drew the DEM as a
// COLOUR RAMP, so the mountain had no shape — Gaika's Kop was a pale patch, the Amathole
// escarpment was a smudge and the draws that cut the valley were invisible. A Hogsback
// local looks at that map and does not see their mountain. This module paints the ground
// itself, from the shipped DEM: the shoulder and the draws (topographic position), the
// escarpment band (the long fall, lip above / face below), the bare sandstone of the high
// ground, and the one warm place where people actually live.
//
// IT IS NOT A FICTIONAL MAP. Every stroke is computed from game/data/hogsback-v3.bin
// (the AWS terrarium DEM the sim already samples) and positioned by
// game/data/hogsback-v3.json (the OSM/landmark bake). Nothing is hand-placed and no place
// is invented. The escarpment detector is validated against the real edge: the strongest
// falls in the box are Gaika's Kop, the Hogs, The EDGE and Away With The Fairies — all of
// them on the cliff line, in that order (tools/valley-backdrop-scan.mjs prints it).
//
// WHERE IT LANDS IN THE STACK. MapRenderer bakes two full-map canvases at setTerrain():
// terrainCv (the hillshaded DEM, drawn first) and propsCv (OSM forest/water/roads, drawn
// over it). The backdrop is GROUND, so it composites into terrainCv — under the forest
// wash, under the roads, under the markers and the portfolio UI. That is also why the
// relief reads THROUGH the canopy the way it does on a real topo sheet: the forest wash is
// translucent (0.62), so 38% of the shading survives inside the Amandelboom blocks.
//
// HOW IT IS BLENDED, AND WHY THAT MATTERS. terrainCv is not just colour: _prerenderTerrain
// paints the 40 m contour lines INTO it as darker pixels (render.js:286-292, k=0.55 index
// / 0.74 intermediate). The first version of this module laid flat ink over the top of
// that bake, and at the strength the brief asked for the ink alpha clamped to 1 — so the
// contour lines and the hillshade were painted OUT, and the gaika pair showed a smooth
// pale blob where a local reads a kop. The art is therefore split into two layers and
// composited as MODULATION, not replacement: the shadow passes go down with
// globalCompositeOperation 'multiply' and the light passes with 'screen', and neither
// layer's alpha is allowed to reach 1 (CAP_DARK / CAP_LIGHT). A multiply or screen pass
// scales the pixel it lands on, so a contour line stays a contour line — the landform
// shading and the survey lines add up instead of overwriting each other.
//
// render.js is the ui seat's file and is NOT touched by this round; plot.html does not
// import either renderer path, so the plot page cannot be affected by this layer.
//
// COST. The analysis runs once per setTerrain on a 1/2-resolution grid (1538x1078 cells,
// 8.06 m per cell) — a few box blurs over 1.66M cells. Measured with
// tools/valley-backdrop-scan.mjs; it is a one-time bake, not a per-frame cost.
//
// QA RIG (this file, no page changes needed):
//   ?artcam=whole|village|peaks|gaika|spine|road|kloof   frames a named view of the real map
//   ?art=0                                               draws no backdrop (the A/B control)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ the look
   Every number here is a MEASUREMENT of the shipped DEM, not a taste value. The
   distributions are printed by tools/valley-backdrop-scan.mjs; if the bake changes,
   re-run the scan and re-read these. */
export const CFG = {
  G: 2,          // analysis downsample: 1 cell = 2 DEM px = 8.06 m
  RN: 12,        // near window, 97 m   — the shoulder the ground sits on
  RF: 60,        // far window, 484 m   — the regional surface it is compared with
  D: 60,         // the long fall is measured 484 m ahead / behind, along the descent
  RS: 4,         // paint smoothing, 4 cells = 32 m: the ink follows the landform, not the pixel
  // Paint thresholds are in METRES and sit on the measured distribution of the shipped
  // DEM (scan prints the percentiles): |position| p74 = 20 m, p97 = 70 m; band p82 = 30 m,
  // p96 = 110 m. Below MIN nothing paints at all, so flat ground keeps the baked colour
  // exactly — the art is meant to land on the shape, not to wash the box.
  POS_MIN: 20,   // m of |near - far| before a shoulder or a draw starts to paint
  POS_REF: 70,   // m; a full-strength shoulder / draw
  BAND_MIN: 30,  // m of the long fall before the escarpment starts to paint
  BAND_REF: 110, // m; a full-strength cliff face
  // colours. Each pass is assigned to a blend layer: DARK goes down with 'multiply'
  // (it scales the baked pixel), LIGHT with 'screen' (it lifts it). Nothing is painted
  // flat over the relief any more — see the header.
  CREST_RGB: [238, 221, 176],  // LIGHT · sun-warmed grass on the shoulder
  CREST_A: 0.17,
  DRAW_RGB: [28, 52, 60],      // DARK · wet, shaded, forested draw
  DRAW_A: 0.27,
  FACE_RGB: [16, 24, 28],      // DARK · the escarpment face, in shadow
  FACE_A: 0.30,
  LIP_RGB: [232, 214, 172],    // LIGHT · the pale top edge of the band
  LIP_A: 0.30,
  ROCK_RGB: [198, 190, 176],   // LIGHT · bare sandstone above the treeline
  ROCK_A: 0.26,
  ROCK_FROM: 1720,             // m; the high ground that is grass and rock, not forest
  ROCK_SPAN: 220,
  SETTLE_RGB: [214, 168, 96],  // LIGHT · the ground people cleared
  SETTLE_A: 0.20,
  // The hard ceiling on each layer's alpha. At CAP 1 a multiply pass with FACE_RGB is a
  // 94% cut and a screen pass is a full white-out; at these caps the strongest stroke
  // still leaves the baked contour line distinguishable from its neighbour, which is the
  // whole point of the layer split. Checked by the gaika pair: with the old source-over
  // bake the kop's contour lines disappear under the ink.
  CAP_DARK: 0.62,
  CAP_LIGHT: 0.46,
  // One multiplier over every pass. The first browser pair measured mean 4.6/255 over the
  // changed pixels at the village view — real, but not enough to answer "make it LOOK like
  // Hogsback" — so the strength is a single number that can be swept (?artgain=) and
  // judged on the picture, instead of six numbers tuned one at a time.
  // 1.7 is the value picked AFTER the blend was changed to multiply/screen, on the picture,
  // at two views (the sweep is in _shots/v44-gaika-on-m{1.2,1.7}.png):
  //   1.2  the escarpment reads at gaika zoom but is still timid across the 12 km box.
  //   1.7  the band and its lip carry the overview, the shoulder/draw pair carries the
  //        detail views, and the plateau stays green. Measured on the shipped pairs, inside
  //        the canvas box only (500,100..1255,950 of a 1600x1000 frame), changed px / mean
  //        delta / mean luminance shift: whole 44.6% 19.3 -5.5 | road 40.1% 19.8 -5.1 |
  //        gaika 79.4% 27.1 -11.3 | village 70.8% 9.1 -1.8. The village frame is the
  //        honest weak one: at 2.2 km the VIS-03 relief bake already carries the ground, so
  //        the art only sharpens it. The overview and the peak views are where it pays.
  //   2.6  this was the right number for the OLD source-over ink and is too much for a
  //        multiplicative shadow: the southern plateau goes muddy and the mean luminance
  //        of the gaika frame drops 16.5/255. The caps (below) are what stop it crushing.
  GAIN: 1.7,
};

/* ------------------------------------------------------------------ analysis */
/**
 * Read the shipped DEM into the analysis fields. Pure: no DOM, runs in node, so the
 * same maths the browser paints with is the maths the scan tool measures and a test
 * can assert on.
 * @param {Int16Array} dem  metres, row-major, meta.width x meta.height
 * @param {object} meta     the bake's meta (width/height/mPerPx)
 */
export function buildBackdropFields(dem, meta, cfg = CFG) {
  const G = cfg.G;
  const gw = Math.floor(meta.width / G), gh = Math.floor(meta.height / G);
  const elev = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let s = 0;
      for (let j = 0; j < G; j++) {
        const row = (y * G + j) * meta.width + x * G;
        for (let i = 0; i < G; i++) s += dem[row + i];
      }
      elev[y * gw + x] = s / (G * G);
    }
  }
  const near = boxBlur(elev, gw, gh, cfg.RN);
  const far = boxBlur(elev, gw, gh, cfg.RF);

  // topographic position: what the ground this cell sits on is worth against the
  // regional surface. Positive = shoulder / spine, negative = draw.
  const pos = new Float32Array(gw * gh);
  // the long fall, measured along the line of steepest descent of the smoothed surface
  const dn = new Float32Array(gw * gh);   // how much drops away ahead
  const up = new Float32Array(gw * gh);   // how much rose behind
  const band = new Float32Array(gw * gh); // min of the two: the cliff itself
  const place = new Float32Array(gw * gh);// +1 at the top edge, -1 at the foot
  const mpp = meta.mPerPx * G;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      pos[i] = near[i] - far[i];
      const gx = (near[i + 1] - near[i - 1]) / 2;
      const gy = (near[i + gw] - near[i - gw]) / 2;
      const m = Math.hypot(gx, gy);
      if (m < 1e-4) continue;                       // flat: no fall direction, no cliff
      const ux = -gx / m, uy = -gy / m;             // downhill
      const D = cfg.D;
      const ax = clamp(Math.round(x + ux * D), 0, gw - 1), ay = clamp(Math.round(y + uy * D), 0, gh - 1);
      const bx = clamp(Math.round(x - ux * D), 0, gw - 1), by = clamp(Math.round(y - uy * D), 0, gh - 1);
      const d = far[i] - far[ay * gw + ax];
      const u = far[by * gw + bx] - far[i];
      dn[i] = d > 0 ? d : 0;
      up[i] = u > 0 ? u : 0;
    }
  }
  // SMOOTH BEFORE THE BRUSH. At 8 m a cell, the raw measures are one-cell ragged: the
  // first paint pass came out as salt-and-pepper stipple instead of landform. The falls
  // are blurred, then the cliff band and its lip are re-derived from the blurred pair, so
  // a band is a BAND (a kilometre of face) and not a pixel. pos gets the same pass.
  const sDn = boxBlur(dn, gw, gh, cfg.RS), sUp = boxBlur(up, gw, gh, cfg.RS);
  for (let i = 0; i < gw * gh; i++) {
    band[i] = Math.min(sDn[i], sUp[i]);
    const tot = sDn[i] + sUp[i];
    place[i] = tot > 1 ? (sDn[i] - sUp[i]) / tot : 0;
  }
  const posS = boxBlur(pos, gw, gh, cfg.RS);
  pos.set(posS);
  // mPerPx is only needed for the report, but keep the cell size for the scan's labels
  return { gw, gh, G, mPerCell: mpp, elev, near, far, pos, dn, up, band, place, meta };
}

/** Separable box blur with running sums, edge-clamped. */
function boxBlur(src, gw, gh, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, gw - 1)];
    for (let x = 0; x < gw; x++) {
      tmp[row + x] = acc / win;
      acc += src[row + Math.min(gw - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < gw; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, gh - 1) * gw + x];
    for (let y = 0; y < gh; y++) {
      out[y * gw + x] = acc / win;
      acc += tmp[Math.min(gh - 1, y + r + 1) * gw + x] - tmp[Math.max(0, y - r) * gw + x];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ paint */
/**
 * Turn the fields into the two backdrop layers at analysis resolution.
 *
 * PURE again: no DOM, runs in node, so the same maths the browser paints with is the
 * maths the scan tool measures and a test can assert on.
 *
 * THREE outputs, one loop:
 *   dark   straight RGBA for a 'multiply' pass — shadow, draw, escarpment face
 *   light  straight RGBA for a 'screen'  pass — shoulder, cliff lip, sandstone, rock
 *   data   both passes as flat ink, source-over — a PREVIEW for the tuning sheet only.
 *          The page never composites `data`; judging it would judge the old blend.
 * Each layer's alpha is capped (CAP_DARK / CAP_LIGHT) so the baked hillshade and the
 * baked contour lines under it survive as modulation instead of being replaced.
 */
export function paintBackdropArt(f, cfg = CFG) {
  const { gw, gh, elev, pos, band, place } = f;
  const A = cfg.GAIN;
  const n = gw * gh;
  const dark = new Uint8ClampedArray(n * 4);
  const light = new Uint8ClampedArray(n * 4);
  const data = new Uint8ClampedArray(n * 4);
  const d = [0, 0, 0, 0], l = [0, 0, 0, 0], p = [0, 0, 0, 0];
  const st = {
    cells: n, posCells: 0, bandCells: 0, rockCells: 0, anyCells: 0,
    darkCells: 0, lightCells: 0, alphaSum: 0, alphaMax: 0,
    darkMax: 0, lightMax: 0, capHits: 0,
  };
  for (let i = 0; i < n; i++) {
    d[0] = d[1] = d[2] = d[3] = 0;
    l[0] = l[1] = l[2] = l[3] = 0;
    p[0] = p[1] = p[2] = p[3] = 0;
    // 1 · shoulder and draw (topographic position), in metres of relief
    const s = rampM(Math.abs(pos[i]), cfg.POS_MIN, cfg.POS_REF);
    if (s > 0) {
      if (pos[i] > 0) {
        over4(l, ...cfg.CREST_RGB, s * cfg.CREST_A * A); st.lightCells++;
      } else {
        over4(d, ...cfg.DRAW_RGB, s * cfg.DRAW_A * A); st.darkCells++;
      }
      over4(p, ...(pos[i] > 0 ? cfg.CREST_RGB : cfg.DRAW_RGB), s * (pos[i] > 0 ? cfg.CREST_A : cfg.DRAW_A) * A);
      st.posCells++;
    }
    // 2 · the escarpment: dark through the band, pale along its top edge
    const e = rampM(band[i], cfg.BAND_MIN, cfg.BAND_REF);
    if (e > 0) {
      const q = place[i];                                // +1 top, -1 foot
      const fa = e * cfg.FACE_A * A * (1 - Math.max(0, q) * 0.45);
      over4(d, ...cfg.FACE_RGB, fa);
      over4(p, ...cfg.FACE_RGB, fa);
      if (q > 0.15) {
        const la = e * cfg.LIP_A * A * clamp((q - 0.15) / 0.6, 0, 1);
        over4(l, ...cfg.LIP_RGB, la);
        over4(p, ...cfg.LIP_RGB, la);
      }
      st.bandCells++;
    }
    // 3 · bare sandstone where the mountain stops growing trees
    const hi = clamp((elev[i] - cfg.ROCK_FROM) / cfg.ROCK_SPAN, 0, 1);
    if (hi > 0) {
      const ra = hi * hi * cfg.ROCK_A * A;
      over4(l, ...cfg.ROCK_RGB, ra);
      over4(p, ...cfg.ROCK_RGB, ra);
      st.rockCells++;
    }
    const o = i * 4;
    // cap the modulation, per layer, and count how often the cap bit — a cell that wants
    // more than the cap is the picture telling you the gain is past the blend
    const da = Math.min(d[3], cfg.CAP_DARK), la2 = Math.min(l[3], cfg.CAP_LIGHT);
    if (d[3] > cfg.CAP_DARK + 1e-9 || l[3] > cfg.CAP_LIGHT + 1e-9) st.capHits++;
    dark[o] = d[0]; dark[o + 1] = d[1]; dark[o + 2] = d[2]; dark[o + 3] = Math.round(da * 255);
    light[o] = l[0]; light[o + 1] = l[1]; light[o + 2] = l[2]; light[o + 3] = Math.round(la2 * 255);
    data[o] = p[0]; data[o + 1] = p[1]; data[o + 2] = p[2]; data[o + 3] = Math.round(clamp(p[3], 0, 1) * 255);
    const a = Math.max(da, la2);
    if (a > 0) {
      st.anyCells++; st.alphaSum += a;
      if (a > st.alphaMax) st.alphaMax = a;
      if (da > st.darkMax) st.darkMax = da;
      if (la2 > st.lightMax) st.lightMax = la2;
    }
  }
  st.meanAlpha = st.anyCells ? st.alphaSum / st.cells : 0;   // over the whole map
  return { width: gw, height: gh, dark, light, data, stats: st };
}

/** Source-over of one stroke into a 4-slot [r,g,b,a] accumulator (straight alpha). */
function over4(acc, r, g, b, a) {
  if (a <= 0) return;
  const na = a + acc[3] * (1 - a);
  acc[0] = (r * a + acc[0] * acc[3] * (1 - a)) / na;
  acc[1] = (g * a + acc[1] * acc[3] * (1 - a)) / na;
  acc[2] = (b * a + acc[2] * acc[3] * (1 - a)) / na;
  acc[3] = na;
}


/** Linear ramp in source units: 0 at or below `lo`, 1 at or above `hi`. */
function rampM(v, lo, hi) { return clamp((v - lo) / Math.max(1e-6, hi - lo), 0, 1); }

/* ------------------------------------------------------------------ install */
/**
 * Bake the backdrop into the renderer's terrain layer and (QA) frame a named view.
 * Idempotent: a second call on the same renderer is a no-op unless `force` is set,
 * because compositing the art twice would double every alpha.
 * @param {object} renderer  a MapRenderer with terrainCv/meta/dem/mapJson set
 * @param {{force?:boolean, query?:string, quiet?:boolean}} [opts]
 * @returns {{baked:boolean, ms:number, view:string|null, reason:string}}
 */
export function installValleyArt(renderer, opts = {}) {
  const q = opts.query ?? (typeof location !== 'undefined' ? location.search : '');
  const view = viewOf(q);
  const disabled = /[?&]art=0\b/.test(q) && opts.query === undefined;
  const cfg = cfgWith(q, opts);
  const out = { baked: false, ms: 0, view: view || null, viewOk: null, reason: '', coverage: null, gain: cfg.GAIN };
  // The page's own console is not reachable from the headless shot rig, so the result
  // (including the coverage stats, which say whether the paint actually put ink down)
  // is published here for QA: window.__otmArt.
  if (typeof window !== 'undefined') window.__otmArt = out;
  if (view) queueView(renderer, view, out);
  if (disabled) { out.reason = 'art=0'; return out; }
  if (!renderer || !renderer.terrainCv || !renderer.dem || !renderer.meta) {
    out.reason = 'no terrain baked yet'; return out;
  }
  if (renderer._otmBackdrop && !opts.force) { out.reason = 'already baked'; return out; }
  const t0 = Date.now();
  try {
    const f = buildBackdropFields(renderer.dem, renderer.meta, cfg);
    const art = paintBackdropArt(f, cfg);
    compositeArt(renderer, art, f);
    paintSettlement(renderer, cfg);
    renderer._otmBackdrop = { ms: Date.now() - t0, cells: f.gw * f.gh, coverage: art.stats };
    out.baked = true;
    out.ms = Date.now() - t0;
    out.coverage = art.stats;
  } catch (e) {
    out.reason = 'bake failed: ' + (e && e.message ? e.message : String(e));
    if (!opts.quiet) console.warn('[valley-art]', out.reason);
  }
  if (!out.baked && !out.reason) out.reason = 'not baked';
  return out;
}

/** QA override: ?artgain=<n> scales every pass at once, so the strength is judged on the
 *  picture and the chosen value is then baked into CFG.GAIN. opts.gain does the same for
 *  a node caller. Neither changes what the shipped default is. */
function cfgWith(q, opts = {}) {
  const m = /[?&]artgain=([0-9.]+)/.exec(q || '');
  const g = opts.gain != null ? Number(opts.gain) : (m ? Number(m[1]) : CFG.GAIN);
  if (!isFinite(g) || g <= 0 || g === CFG.GAIN) return CFG;
  return { ...CFG, GAIN: g };
}

/**
 * Draw the two art layers (analysis resolution) up into terrainCv (baked at 2x map px),
 * shadow as 'multiply' and light as 'screen' so the baked hillshade and the baked
 * contour lines are modulated, not painted over. The composite operation is restored
 * before anything else can use this context.
 */
function compositeArt(renderer, art, f) {
  const cv = renderer.terrainCv;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const SS = renderer.terrainSS || 2;
  const k = f.G;                       // 1 analysis cell = G map px
  const w = art.width * k, h = art.height * k;
  ctx.save();
  ctx.setTransform(SS, 0, 0, SS, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const layer of [['dark', 'multiply'], ['light', 'screen']]) {
    const small = document.createElement('canvas');
    small.width = art.width; small.height = art.height;
    const sctx = small.getContext('2d');
    sctx.putImageData(new ImageData(art[layer[0]], art.width, art.height), 0, 0);
    ctx.globalCompositeOperation = layer[1];
    ctx.drawImage(small, 0, 0, w, h);
  }
  ctx.restore();
}

/** The village anchor: the one cleared warm patch on the shoulder, plus the two
 *  hamlets the bake names. Radius is the real ground, not a decoration — the village
 *  core is about 300 m across and that is what a local looks for first. */
function paintSettlement(renderer, cfg = CFG) {
  const cv = renderer.terrainCv;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const lms = (renderer.mapJson && renderer.mapJson.landmarks) || [];
  const SS = renderer.terrainSS || 2;
  const want = (c) => lms.filter((l) => l.cat === c);
  const spots = [].concat(want('village'), want('hamlet'));
  ctx.save();
  ctx.setTransform(SS, 0, 0, SS, 0, 0);
  ctx.globalCompositeOperation = 'screen';   // lifts the bake, never covers it
  for (const l of spots) {
    const rad = (l.cat === 'village' ? 380 : 200) / (renderer.meta.mPerPx || 4);
    const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, rad);
    const [r, gg, b] = cfg.SETTLE_RGB;
    const a0 = Math.min(cfg.SETTLE_A * cfg.GAIN, cfg.CAP_LIGHT);
    g.addColorStop(0, `rgba(${r},${gg},${b},${a0})`);
    g.addColorStop(0.6, `rgba(${r},${gg},${b},${(a0 * 0.45).toFixed(3)})`);
    g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(l.x, l.y, rad, 0, 7); ctx.fill();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ QA camera */
/* View centres are named from the bake (game/data/hogsback-v3.json landmarks), never in
   pixels. Names are matched on letters and digits, CASE-Sensitively, and punctuation is
   ignored: the bake writes OSM names with a typographic apostrophe (Gaika's Kop is
   U+2019 in the file, so the needle here is ASCII and the apostrophe is dropped by the
   matcher), and case is the only thing that tells the village 'Hogsback' (x=932) apart
   from the summit 'HOGSBACK' (x=2946) or 'The Edge' restaurant from 'The EDGE' guest
   house. A view whose name does not resolve returns false and records
   renderer._otmViewFail, so the rig fails loudly instead of quietly framing the box. */
const VIEWS = {
  whole: { spanKm: 12.4, at: null },
  village: { spanKm: 2.2, at: ['Hogsback'] },
  peaks: { spanKm: 6.5, at: ['Gaikas Kop', 'The Hogsback'] },
  gaika: { spanKm: 3.2, at: ['Gaikas Kop'] },
  spine: { spanKm: 4.5, at: ['Tor Doone', 'Hogsback'] },
  road: { spanKm: 9.5, at: ['Hogsback', 'The Hogsback'] },
  kloof: { spanKm: 3.6, at: ['Auckland Forest Nature Reserve'] },
};

const normName = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

function viewOf(q) {
  const m = /[?&]artcam=([a-z]+)/.exec(q || '');
  return m && VIEWS[m[1]] ? m[1] : null;
}

/** Compute the camera for a named view: centre on the bake's landmarks (never hard-coded
 *  px) and show `spanKm` across the canvas. Returns null when a name does not resolve. */
function viewCamera(renderer, name) {
  const v = VIEWS[name];
  if (!v || !renderer || !renderer.meta || !renderer.cv) return null;
  const meta = renderer.meta;
  const lms = (renderer.mapJson && renderer.mapJson.landmarks) || [];
  let cx = meta.width / 2, cy = meta.height / 2;
  if (v.at) {
    const keys = v.at.map(normName);
    const hits = lms.filter((l) => keys.indexOf(normName(l.name)) >= 0);
    if (!hits.length) return null;
    cx = hits.reduce((a, l) => a + l.x, 0) / hits.length;
    cy = hits.reduce((a, l) => a + l.y, 0) / hits.length;
  }
  const pxPerKm = 1000 / (meta.mPerPx || 4);
  const z = (renderer.cv.width * 0.94) / (v.spanKm * pxPerKm);
  return { x: renderer.cv.width / 2 - cx * z, y: renderer.cv.height / 2 - cy * z, zoom: z };
}

/** Centre the map on a named view. */
export function setView(renderer, name) {
  const c = viewCamera(renderer, name);
  if (!c) return false;
  renderer.cam.zoom = c.zoom;
  renderer.cam.x = c.x;
  renderer.cam.y = c.y;
  if (renderer._clampCam) renderer._clampCam();
  return true;
}

/**
 * Hold a named view for the first FRAMES frames of drawing.
 *
 * WHY THIS EXISTS: setting the camera once is not enough on this page. valley.html frames
 * itself (`frameRoad()` during module evaluation, `fitToMap()` on resize) AFTER the art
 * module has run, so a single `artcam` set was silently overwritten and every A/B pair came
 * back at the default 12 km framing — the pair looked identical and the difference was only
 * visible in the pixel gauge. The wrapper re-asserts the view whenever the camera has been
 * moved away from it, counts how often it had to (that number is the rig's own health
 * report), and then lets go so a player can still pan and zoom.
 *
 * It is only installed when ?artcam= is present, and it wraps the INSTANCE, not
 * render.js's prototype, so the ui seat's file is untouched.
 */
const FRAMES = 240;                       // ~4 s at 60 fps: enough for load + one resize
function lockView(renderer, name, out) {
  if (!setView(renderer, name)) {
    renderer._otmViewFail = name;
    if (out) out.viewOk = false;
    return false;
  }
  const lock = { refits: 0, frames: 0, givenUp: false };
  renderer._otmViewLock = lock;
  if (out) {
    out.viewOk = true;
    out.viewCam = { x: renderer.cam.x, y: renderer.cam.y, zoom: renderer.cam.zoom };
  }
  if (typeof renderer.frame !== 'function') { lock.givenUp = 'no frame()'; return true; }
  const orig = renderer.frame.bind(renderer);
  renderer.frame = (dtMs, tSec) => {
    // Re-assert BEFORE the draw, not after. Setting it after means every captured frame is
    // drawn with whatever camera the page left behind, and the fix only shows up on the
    // NEXT frame — which is exactly what the headless rig screenshots. (Caught on the
    // first village pair: the terrain came back at fit zoom with the road overlay drawn at
    // the view zoom, i.e. one frame out of step.)
    const want = viewCamera(renderer, name);
    if (!want) { renderer.frame = orig; lock.givenUp = 'name lost'; orig(dtMs, tSec); return; }
    const c = renderer.cam;
    if (Math.abs(c.zoom - want.zoom) > 1e-6 || Math.abs(c.x - want.x) > 0.5
      || Math.abs(c.y - want.y) > 0.5) {
      lock.refits++;
      c.zoom = want.zoom; c.x = want.x; c.y = want.y;
      if (renderer._clampCam) renderer._clampCam();
    }
    orig(dtMs, tSec);
    lock.frames++;
    if (lock.frames > FRAMES) { renderer.frame = orig; lock.givenUp = 'released'; }
    if (out) {
      out.pageCam = { x: c.x, y: c.y, zoom: c.zoom };
      out.viewLock = lock;
    }
  };
  return true;
}

function queueView(renderer, name, out) {
  const go = () => { lockView(renderer, name, out); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
  else setTimeout(go, 0);
}

export const BACKDROP_VIEWS = Object.keys(VIEWS);
