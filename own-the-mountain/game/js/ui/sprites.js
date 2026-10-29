// sprites.js — the sprite registry for the isometric plot view.
//
// Every sprite is a pure draw function `(ctx, s, o)` where s scales the design size
// (1 = design px) and o is optional per-instance state (age, hover, seed). The anchor
// is always the sprite's BASE CENTRE: the caller translates the context to the tile
// position and the sprite grows upward from there.
//
// ATLAS BEHAVIOUR (ISO-PLAN: "sprites are drawn once into the atlas, then blitted"):
// drawSprite renders each (sprite, scale-bucket, variant, state) ONCE into an
// offscreen canvas and blits it thereafter — one drawImage per instance per frame
// instead of the full vector path. In the browser this is the live atlas; the same
// registry is what tools/atlas.html bakes to PNG + manifest, which is the Godot
// Sprite2D import artifact. In node (the gate) there is no canvas factory, so
// drawSprite falls back to the direct vector path — same shapes, same numbers.
//
// VARIATION: per-instance jitter is quantised into VARIANT buckets (same hash as
// before, snapped to a ladder), so forests still read as varied land rather than
// stamped clones while staying finite — the atlas needs N tiles, not one per tree.
//
// PALETTE: every colour lives in the PALETTE export. Art tunes one table; the
// ground/backdrop tables are the ones iso-render.js consumes too.
//
// Elevation is shading-only for now (owner call in ISO-PLAN.md): light comes from the
// north-west, shadows fall south-east, and every sprite draws its own ground shadow.
//
// READABILITY BUDGET (art night, 10-20): the game opens fitted, so a pine is ~12×20
// device px and a cottage ~17×14. Every line that carries the read is therefore
// ≥3 design px; the sub-pixel stuff (mullions, hive landing board, ladder rungs) is
// there for the zoomed view and for the Godot atlas, and is designed not to muddy the
// fitted silhouette.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---- the Mistbelt hand-painted trees (owner GO 21-10; verdict: style approved) ----
   pine / wattle / blackwood draw from Mistbelt cutouts (game/data/mistbelt/*.png,
   embedded as data URIs by tools/make-sprite-assets.py so the page needs no http and
   node never decodes). Until an image decodes — and always in node — the vector tree
   below draws: same anchor, same registry, same gate. Mirroring half the variants
   gives the forest left/right variety; the wobble adds the adult size spread. */
import { SPRITE_IMAGE_SPECS } from './sprite-images.js';
// The tile geometry the bed's crop rows are laid out in. iso-math.js is the single
// authority for TW/TH and the port contract says a Godot build must reproduce its numbers
// exactly, so a bed that invented its own tile size would bake rows that do not lie on the
// ground the renderer draws. iso-math imports nothing, so this cannot cycle.
import { TW, TH } from './iso-math.js';

const imageEls = {};
const imageState = {};   // name -> loading | ready | failed
const SEASON_TINT = {
  winter: 'rgba(178,196,210,0.22)',   // evergreen in the cold: grey, not bare
  autumn: 'rgba(198,150,72,0.12)',    // a warm cast before winter
  spring: 'rgba(168,216,138,0.10)',   // new growth
  summer: null,
};
let IMAGE_BACKED = new Set();
if (typeof Image !== 'undefined') {
  IMAGE_BACKED = new Set(Object.keys(SPRITE_IMAGE_SPECS));
  for (const [name, spec] of Object.entries(SPRITE_IMAGE_SPECS)) {
    imageState[name] = 'loading';
    const im = new Image();
    im.onload = () => { imageState[name] = 'ready'; clearSpriteAtlas(); };
    im.onerror = () => { imageState[name] = 'failed'; };
    im.src = spec.src;
    imageEls[name] = im;
  }
}
/** name -> 'loading' | 'ready' | 'failed' for every embedded cutout. Exported because
 *  spriteImagesReady() resolves on a 6 s TIMEOUT as well as on success, so "I awaited it"
 *  is not proof the images decoded. tools/atlas.html needs the difference: a bake that
 *  falls through to the vector art still reports ATLAS OK, and that artifact is the port
 *  contract. */
export function spriteImageStatus() { return { ...imageState }; }
/** Resolves once the Mistbelt cutouts are decoded (or failed) — probes await it. */
export function spriteImagesReady() {
  const pending = Object.keys(imageState).filter((n) => imageState[n] === 'loading');
  if (!pending.length) return Promise.resolve();
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => (!pending.some((n) => imageState[n] === 'loading') || Date.now() - t0 > 6000)
      ? res() : setTimeout(tick, 40);
    tick();
  });
}
/** The painted tree: base centre at the origin, mirror half the variants, wobble
    carries the adult size spread the owner asked for. */
function drawImageSprite(ctx, name, s, v) {
  const spec = SPRITE_IMAGE_SPECS[name];
  const hs = 0.94 + v * 0.12, ws = 1.04 - v * 0.08;
  const dw = spec.w * s * ws, dh = spec.h * s * hs;
  ctx.save();
  if (v < 0.5) { ctx.scale(-1, 1); ctx.drawImage(imageEls[name], -dw / 2, -dh, dw, dh); }
  else ctx.drawImage(imageEls[name], -dw / 2, -dh, dw, dh);
  ctx.restore();
}
const TAU = Math.PI * 2;
const rgb = (r, g, b) => `rgb(${clamp(Math.round(r), 0, 255)},${clamp(Math.round(g), 0, 255)},${clamp(Math.round(b), 0, 255)})`;
/** Multiply a colour triple by k — one flat shade step, no gradients. */
const tone = (c, k) => rgb(c[0] * k, c[1] * k, c[2] * k);
/** One flat shade step on a #rrggbb string (the wall tones are hex in the palette). */
const shade = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) * k, ((n >> 8) & 255) * k, (n & 255) * k);
};

/** Deterministic per-instance variation so forests are not stamped clones. */
function jitter(x, y, salt = 0) {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* -------------------------------------------------------------- palette */

export const PALETTE = {
  // HOGSBACK PALETTE COMMIT (night 3, owner-GO'd consensus): the game no longer reads
  // as "nowhere". Three terrain bands + one accent carry every ground kind, and the
  // tree tones are tuned to silhouette against all three bands. Do not re-tune these
  // hexes per-sprite — the bands ARE the art direction.
  bands: {
    grass: [90, 122, 82],    // #5a7a52  cold highland grass
    earth: [138, 111, 74],   // #8a6f4a  ochre earth
    // #706a58  lichen sandstone. Retuned 10-23 from [125,122,114] (#7d7a72, sat 11).
    // NOTE FOR THE NEXT PERSON: this is the UNTINTED FALLBACK only. iso-render builds
    // its ground table as `(tint && tint[k]) || GROUND[k]`, so while a season tint
    // exists - which it always does, seasonTint() never returns null - the four
    // PALETTE.seasons.rock triples below are what actually paints. Changing only this
    // value moves the rendered rock by 2 luminance points and nothing else, which is
    // exactly the dead fix this seat made first. Fix all five together.
    rock: [112, 106, 88],
  },
  accent: {
    aloe: [181, 71, 46],     // #b5472e  flowering aloes, painted roofs
  },
  // ground kinds — RGB triplets, consumed by the ground bake (iso-render GROUND).
  // Each kind is one of the three bands or a mix between two of them.
  ground: {
    // VIS-04 (playtest 10-25: "three saturation worlds on one screen… trees read as
    // frosted against the grass"): the grass was the loudest chroma in the frame at
    // sat 33%, against painted cutouts at 22-28%. Pulled to sat 29% and a shade deeper
    // so the pale mistbelt trees sit IN the field instead of on top of it.
    grass: [92, 116, 82],    // = bands.grass
    scrub: [112, 124, 72],   // dying grass: the grass value, pulled yellow
    rock: [112, 106, 88],    // = bands.rock (kept equal by hand; move both together)
    mud: [103, 82, 55],      // wet ochre: earth × 0.75
    bank: [139, 121, 80],    // earth-grass mix at the stream edge
    water: [58, 98, 106],    // cold mountain stream — VIS-01/04 (playtest 10-25: "hard
                            // cyan, the most saturated object on screen"). Was 47,104,122
                            // (sat 62%); the stream now sits at sat 45% so it belongs to
                            // the same grey-green family as the grass and the painted
                            // trees instead of reading as canal water.
    // MADE surfaces (owner 10-22: "the dirt driveways need work"). A laid drive or road
    // replaces the ground under it, so it needs its own palette entries - until now the
    // bake built the track and mud sets and never read them, and a drive on kloof-crest
    // stayed grey flagstone because that is what the tile already was.
    track: [150, 137, 117],   // dry dirt drive: the earth band, drained hard toward grey.
                            // Two cuts read as rust - [151,124,86] then [154,134,108] - because
                            // the dirt watercolour over an ochre base pushes red through
    gravel: [152, 148, 140],  // crushed stone: the rock band, pale and dry
  },
  // Seasonal overrides of the six ground kinds, South African calendar
  // (summer = Dec/Jan/Feb). Renderer wiring is the lead's (see seasonTint below);
  // winter.bareWattle is a render hint: wattles stand bare in winter.
  // FIRST-SCREEN FIX 10-23, and this is where it actually lived. These four triples are
  // what paint the ground, because iso-render reads `(tint && tint[k]) || GROUND[k]` and
  // seasonTint() always returns a tint. Every rock triple here was near-NEUTRAL - sat
  // 11/12/8/12 against grass at 32-46 in the growing seasons (winter grass is itself
  // sat 8, which is why winter rock is allowed to stay cool) - so the kloof's 8.1% rock
  // outcrops rendered at rgb(97,101,85), 11% brighter than grass and with a third of its
  // chroma, and 49% of their pixels read as concrete. Stone keeps its own colour all
  // year, so the season variation here is wetness and light, not hue: kept a warm lichen
  // sandstone, sat 20-42. Measured in tools/asset-review.html frame 12.
  seasons: {
    summer: { grass: [88, 112, 76], scrub: [110, 122, 70], rock: [124, 114, 86], mud: [100, 80, 54], bank: [136, 118, 78], water: [56, 96, 104] },
    autumn: { grass: [108, 108, 70], scrub: [124, 118, 66], rock: [126, 115, 84], mud: [104, 82, 54], bank: [142, 116, 72], water: [60, 94, 100] },
    // winter is the one season where grass itself goes near-neutral (sat 8), so rock may
    // stay cool here - it is no longer the only grey thing to compare against.
    winter: { grass: [112, 116, 110], scrub: [120, 122, 100], rock: [114, 110, 94], mud: [96, 82, 66], bank: [130, 118, 98], water: [64, 92, 96], bareWattle: true },
    spring: { grass: [98, 120, 82], scrub: [110, 124, 72], rock: [124, 116, 88], mud: [102, 82, 54], bank: [136, 120, 78], water: [54, 100, 108] },
  },
  // page backdrop behind the plot diamond, top → bottom
  backdrop: ['#20301f', '#182819', '#0f1a12'],
  tree: {
    trunk: '#3b2918',
    trunkLit: 'rgba(126,96,56,.55)',
    pineHover: ['#1f4d30', '#2b633d', '#3d7a4e'],
    leafHover: '#3f7944',
    wattleHover: '#aeb865',
    blackwoodHover: '#4f7040',
    rim: 'rgba(186,212,132,0.62)',
    // seasonal snow: three flat steps, the same rule as every other material here —
    // lit cap, body, and the dark line that keeps it from reading as a white blob
    snow: '#e7eef0',
    snowShade: '#adbdc2',
    snowFoot: 'rgba(20,30,34,.32)',
  },
  soil: {
    bed: '#6b4f2f', bedEdge: '#3a2b17', bedLit: '#8d6c44',
    rowReady: '#9ed162', rowGrowing: '#4d7a35',
  },
  wood: {
    hive: '#d8a94a', hiveBand: '#6b4a1a', hiveDark: '#2c1f0e', hiveTop: '#e6bf62',
    toilet: '#a5805f', toiletTrim: '#7c5c40', door: '#2c2015',
    gatePost: '#8a6a3c', gateRail: '#e8b45a',
    cottageWall: '#c9a06a', cottageWallDark: '#b58a54',
    cottageRoofLit: '#8d6a3e', cottageRoofShade: '#5c4326',
    // roof furniture (scale pass): the ridge cap and eave board are what make two flat
    // slopes read as one roof; the rib tone is the corrugation, not a gradient.
    roofRidge: '#b08c58', roofEdge: '#33240f', roofRib: 'rgba(24,14,4,.16)',
    cottageDoor: '#4a3320', cottageWindow: '#31424d', stone: '#8d8578',
    stoneLit: '#a9a294', stoneDark: '#615c52', smoke: 'rgba(214,218,208,.30)',
  },
  // ground props (scale pass): cut logs, field stones and flowers. These carry the
  // "inhabited" read the reference has — hue variation, never a gradient.
  prop: {
    bark: '#5a3f26', barkLit: '#8a6a3f', barkDark: '#33240f',
    cutFace: '#c9a874', cutRing: '#9c7a4c', cutCore: '#7d5c34',
    stone: '#6f6c65', stoneLit: '#939085', stoneDark: '#4e4c47',
    moss: '#6d8452',
    bladeDark: '#3d5c33', bladeMid: '#5a7a48', bladeLit: '#8aa364',
    flowerA: '#c9552f', flowerB: '#e8dcb4', flowerC: '#d9b64a',
  },
  metal: {
    tankBody: '#9fb3c8', tankShade: '#7d92a9', tankTop: '#b7c7d8',
    tankRim: '#cbd8e6', tankEdge: '#5d7186',
  },
};

/**
 * Ground-tone override for a calendar month (1 = January, 12 = December; South African
 * seasons: summer = Dec–Feb, autumn = Mar–May, winter = Jun–Aug, spring = Sep–Nov).
 * Returns `{ season, grass, scrub, rock, mud, bank, water }` — the six ground triplets
 * to spread over PALETTE.ground before a ground bake — plus `bareWattle: true` in
 * winter as a render hint (wattles stand bare). Out-of-range months wrap.
 */
const SEASON_BY_MONTH = [
  'summer', 'summer',             // Jan, Feb
  'autumn', 'autumn', 'autumn',   // Mar–May
  'winter', 'winter', 'winter',   // Jun–Aug
  'spring', 'spring', 'spring',   // Sep–Nov
  'summer',                       // Dec
];
export function seasonTint(month) {
  const m = (((Math.floor(month) - 1) % 12) + 12) % 12;
  const season = SEASON_BY_MONTH[m];
  return { season, ...PALETTE.seasons[season] };
}

/* ------------------------------------------------- seasonal foliage ramp */

/**
 * Per-season foliage ramp, keyed exactly like PALETTE.seasons so a renderer that already
 * has `seasonTint(month).season` can pass that string straight through as `o.season`.
 *
 * Every tree in this file derives all of its tones from one `base` triple, so the ramp
 * is applied THERE and reaches body, lit, shaded, branch and rim passes at once — no
 * shape is touched, and with no `o.season` every draw is bit-identical to before.
 *
 *   lift    brightness multiplier on the base triple
 *   desat   pull toward the triple's own grey (0 = today's colour)
 *   tint    colour mixed in by `warm`, for the autumn leaf-litter and winter dead-leaf
 *           shifts; null means no hue move at all
 *   warm    mix weight toward `tint`
 *   snow    1 = snow foot at the base and a snow lip on the lit edges
 *
 * The two alien deciduous trees (wattle, blackwood) do not use a ramp value to thin:
 * they drop the crown entirely in winter and draw a twig fan instead.
 */
const SEASON_RAMP = {
  summer: { lift: 1.00, desat: 0.10, tint: null, warm: 0.00, snow: 0 },
  autumn: { lift: 0.97, desat: 0.14, tint: [168, 138, 66], warm: 0.18, snow: 0 },
  winter: { lift: 1.00, desat: 0.42, tint: [128, 116, 94], warm: 0.22, snow: 1 },
  spring: { lift: 1.06, desat: 0.02, tint: null, warm: 0.00, snow: 0 },
};

/** The ramp for this draw, or null when no season was asked for (the default look). */
function seasonRamp(o) {
  return (o && SEASON_RAMP[o.season]) || null;
}

/**
 * Apply a ramp to a base tone triple. `k` scales the shift per family: conifers stay
 * green through winter, the feather-leaf wattles go right through to grey-brown.
 */
function seasonBase(c, r, k = 1) {
  if (!r) return c;
  const g = c[0] * 0.30 + c[1] * 0.59 + c[2] * 0.11;
  const d = clamp(r.desat * k, 0, 1);
  const w = r.tint ? clamp(r.warm * k, 0, 1) : 0;
  const out = [c[0] + (g - c[0]) * d, c[1] + (g - c[1]) * d, c[2] + (g - c[2]) * d];
  if (w) for (let i = 0; i < 3; i++) out[i] += (r.tint[i] - out[i]) * w;
  return [out[0] * r.lift, out[1] * r.lift, out[2] * r.lift];
}

/**
 * Frost at the foot: a low drift over the root flare, grey-bodied with a thin lit crest —
 * the ground is only tinted in winter, not snow-covered, so a white bank would read as
 * an artifact. Three flat steps, the same rule as the trees.
 */
function snowFoot(ctx, w, hgt) {
  const T = PALETTE.tree;
  ctx.fillStyle = T.snowFoot;
  ctx.beginPath();
  ctx.ellipse(w * 0.12, hgt * 0.010, w * 0.36, hgt * 0.018, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = T.snowShade;
  ctx.beginPath();
  ctx.ellipse(w * 0.02, -hgt * 0.004, w * 0.30, hgt * 0.012, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = T.snow;
  ctx.beginPath();
  ctx.ellipse(-w * 0.04, -hgt * 0.009, w * 0.18, hgt * 0.006, 0, 0, TAU);
  ctx.fill();
}

/**
 * One ground shadow per sprite, always SE of the base: a wide soft ring plus a denser
 * core. Two flat ellipses read as a soft edge without a gradient.
 * @param {number} rx half-width in design px
 * @param {number} ry half-height in design px
 */
function shadow(ctx, rx, ry, dx = 0.42, dy = 0.26, a = 0.32) {
  const cx = dx * rx, cy = dy * ry;
  ctx.fillStyle = `rgba(0,0,0,${(a * 0.45).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.70, ry * 0.64, 0, 0, TAU);
  ctx.fill();
}

/* ---------------------------------------------------------------- trees */

/**
 * Pine: four stacked branch tiers over a trunk that flares into the ground. Each tier is
 * a jagged cone — an uneven slope with branch bumps and a sawtooth skirt — split into a
 * lit NW face, a body mid-tone and a shaded SE face, with a dark branch line under the
 * skirt. Stray sprays break the silhouette on the lower tiers so no two trees are cones.
 * Tone varies per instance (v), top tier lightest.
 */
function drawPine(ctx, s, o = {}) {
  const v = o.v ?? 0.5;
  const T = PALETTE.tree;
  // the Mistbelt cutout, once decoded
  if (imageState.pine === 'ready') { drawImageSprite(ctx, 'pine', s, v); return; }
  // variant carries both tone and build: tall-and-slender ↔ short-and-broad, so a
  // forest of four variants does not read as one stamped tree repeated
  const hs = 0.92 + v * 0.20;
  const ws = 1.04 - v * 0.10;
  const w = 62 * s * ws, hgt = 120 * s * hs;
  const hov = !!o.hover;
  const lean = (v - 0.5) * w * 0.05;

  // dark spruce → lighter olive spruce across the variant ladder; the whole ladder is
  // darker + cooler than the tuned-generic green it replaced so the pine reads as a
  // silhouette against all three Hogsback bands (grass, ochre earth, rock grey)
  // scale pass: at 120 px the old near-black ladder read as one flat mass; the body
  // now sits a clear step under the grass band so it still silhouettes, but keeps
  // enough mid-tone for the lit/shaded split to read as a tree, not a cone.
  const ramp = seasonRamp(o);
  const base = [30 + v * 28, 72 + v * 34, 46 + v * 18];

  shadow(ctx, w * 0.50, hgt * 0.048, 0.40, 0.30, 0.34);

  /* ---- trunk: tapered, flared at the root, clear under the lowest skirt ---- */
  const twT = w * 0.058;                  // half-width under the canopy
  const twB = w * 0.120;                  // half-width at the root flare
  const trunkTop = -hgt * 0.42;
  ctx.beginPath();
  ctx.moveTo(-twB, 0);
  ctx.lineTo(-twB * 0.58 + lean, -hgt * 0.03);
  ctx.lineTo(-twT + lean, trunkTop);
  ctx.lineTo(twT + lean, trunkTop);
  ctx.lineTo(twB * 0.58 + lean, -hgt * 0.03);
  ctx.lineTo(twB, 0);
  ctx.closePath();
  ctx.fillStyle = T.trunk;
  ctx.fill();
  // lit NW edge of the trunk — the same light direction as the cones
  ctx.beginPath();
  ctx.moveTo(-twB, 0);
  ctx.lineTo(-twB * 0.58 + lean, -hgt * 0.03);
  ctx.lineTo(-twT + lean, trunkTop);
  ctx.lineTo(-twT * 0.10 + lean, trunkTop);
  ctx.lineTo(-twB * 0.24 + lean, -hgt * 0.03);
  ctx.lineTo(-twB * 0.42, 0);
  ctx.closePath();
  ctx.fillStyle = T.trunkLit;
  ctx.fill();
  // root flare: a small buttress each side, so the tree is planted, not stuck in
  ctx.fillStyle = T.trunk;
  ctx.beginPath();
  ctx.moveTo(-twB * 0.95, 0);
  ctx.lineTo(-twB * 1.85, hgt * 0.002);
  ctx.lineTo(-twB * 0.55, -hgt * 0.038);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(twB * 0.95, 0);
  ctx.lineTo(twB * 1.65, hgt * 0.002);
  ctx.lineTo(twB * 0.55, -hgt * 0.032);
  ctx.closePath();
  ctx.fill();

  /* ---- tiers: apex → concave slope → drooping branch skirt → mirrored back up ---- */
  const tiers = [
    { ay: -0.54, by: -0.17, half: 0.520, k: 0.86 },
    { ay: -0.73, by: -0.38, half: 0.410, k: 0.98 },
    { ay: -0.87, by: -0.58, half: 0.292, k: 1.09 },
    { ay: -1.00, by: -0.78, half: 0.172, k: 1.21 },
  ];
  // 15 skirt points, right → left; the depth of each tooth is jittered per tier and per
  // variant, so the underside is ragged rather than a scalloped doily
  const skirtX = [0.98, 0.88, 0.76, 0.63, 0.50, 0.36, 0.20, 0.02, -0.16, -0.31, -0.46, -0.60, -0.74, -0.87, -0.98];

  for (let ti = 0; ti < tiers.length; ti++) {
    const t = tiers[ti];
    const ay = t.ay * hgt, by = t.by * hgt, half = t.half * w;
    const skirt = hgt * 0.017;
    const mid = (f) => ay + (by - ay) * f;
    // each tier sits a little off-centre, alternating: a stack of perfectly centred
    // cones is the thing that reads as "clip art" in the reference's absence
    const skew = (v - 0.5) * w * 0.06 * (ti % 2 ? 1 : -0.65);
    // season: one ramp pass, but the exposure scales up the tree — snow and desaturation
    // land on the exposed top tiers, the skirt keeps more of its green
    const c = seasonBase(base.map((n) => n * t.k), ramp, 0.72 + ti / (tiers.length - 1) * 0.34);
    const bodyC = hov ? T.pineHover[1] : tone(c, 1);
    const litC = hov ? T.pineHover[2] : tone(c, 1.42);
    const darkC = hov ? T.pineHover[0] : tone(c, 0.62);

    // concave slope: branch layers spread wider as they drop
    const slope = [];
    for (let i = 0; i < 4; i++) {
      const f = 0.18 + i * 0.20;
      slope.push([half * Math.pow(f, 0.84) * (1 + 0.06 * Math.sin(i * 2.3 + v * 5.1)), mid(f)]);
      const f2 = Math.min(0.98, f + 0.10);
      slope.push([half * Math.pow(f2, 0.84) * 0.96, mid(f2)]);
    }

    ctx.beginPath();
    ctx.moveTo(skew, ay);
    for (const [x, y] of slope) ctx.lineTo(skew + x, y);
    ctx.lineTo(skew + half, by);
    for (let i = 0; i < skirtX.length; i++) {
      const d = 0.30 + 1.25 * jitter(ti * 31 + i, Math.round(v * 97), 17);
      const dip = hgt * 0.016 * (1 - skirtX[i] * skirtX[i]);
      ctx.lineTo(skew + skirtX[i] * half, by + d * skirt + dip);
    }
    ctx.lineTo(skew - half, by);
    for (let i = slope.length - 1; i >= 0; i--) {
      ctx.lineTo(skew - slope[i][0] * 0.97, slope[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = bodyC;
    ctx.fill();

    // shaded SE face — a band inside the right edge, not half the cone
    ctx.beginPath();
    ctx.moveTo(skew, ay);
    ctx.lineTo(skew + half * 0.97, by);
    ctx.lineTo(skew + half * 0.62, by + skirt * 0.3);
    ctx.lineTo(skew + half * 0.09, mid(0.46));
    ctx.closePath();
    ctx.fillStyle = darkC;
    ctx.fill();

    // lit NW edge — a band down the left slope, tapering to nothing at the apex
    ctx.beginPath();
    ctx.moveTo(skew, ay);
    ctx.lineTo(skew - half * 0.97, by);
    ctx.lineTo(skew - half * 0.60, by + skirt * 0.2);
    ctx.lineTo(skew - half * 0.06, mid(0.42));
    ctx.closePath();
    ctx.fillStyle = litC;
    ctx.fill();

    // branch rows inside the tier: two shallow sagging lines with a lit edge above
    // each — the "visible branch structure" the reference pines carry, and the thing
    // that stops a tier reading as one smooth folded cone
    for (const f of [0.34, 0.64]) {
      const y = mid(f);
      const xl = -half * Math.pow(f, 0.84) * 0.94;
      const xr = half * Math.pow(f, 0.84) * 0.30;
      ctx.strokeStyle = tone(c, 0.64);
      ctx.lineWidth = Math.max(0.6, 1.0 * s);
      ctx.beginPath();
      ctx.moveTo(skew + xl, y);
      ctx.quadraticCurveTo(skew + (xl + xr) * 0.5, y + hgt * 0.013, skew + xr, y + hgt * 0.005);
      ctx.stroke();
      ctx.strokeStyle = tone(c, 1.36);
      ctx.lineWidth = Math.max(0.5, 0.8 * s);
      ctx.beginPath();
      ctx.moveTo(skew + xl, y - hgt * 0.007);
      ctx.quadraticCurveTo(skew + (xl + xr) * 0.5, y + hgt * 0.005, skew + xr, y - hgt * 0.003);
      ctx.stroke();
    }

    // rim light along the NW slope and a dark contour along the SE slope: the two
    // strokes are what separate a lit needle edge from a shaded one at any zoom.
    // In winter the upper tiers' rim becomes the snow lip — same path, pale tone.
    const snowLip = !!(ramp && ramp.snow && ti >= 1);
    ctx.strokeStyle = snowLip ? PALETTE.tree.snow : (hov ? T.pineHover[2] : tone(c, 1.92));
    ctx.lineWidth = Math.max(0.9, (snowLip ? 2.1 : 1.8) * s);
    ctx.beginPath();
    ctx.moveTo(skew, ay);
    for (const [x, y] of slope) ctx.lineTo(skew - x, y);
    ctx.lineTo(skew - half, by);
    ctx.stroke();

    ctx.strokeStyle = hov ? T.pineHover[0] : tone(c, 0.34);
    ctx.lineWidth = Math.max(0.7, 1.3 * s);
    ctx.beginPath();
    ctx.moveTo(skew, ay);
    for (const [x, y] of slope) ctx.lineTo(skew + x, y);
    ctx.lineTo(skew + half, by);
    ctx.stroke();

    // stray sprays breaking the silhouette — the ragged old branches the reference pine
    // carries below the cone line
    if (ti <= 2) {
      const sprays = ti === 0
        ? [[1, 0.86, 0.17, 0.30], [-1, 0.56, 0.13, 0.24]]
        : [[1, 0.74, 0.14, 0.26]];
      for (const [dir, f, len, drop] of sprays) {
        const bx = skew + dir * half * f, byy = by + skirt * 0.6;
        const L = len * w;
        ctx.beginPath();
        ctx.moveTo(bx, byy);
        ctx.lineTo(bx + dir * L, byy + L * drop);
        ctx.lineTo(bx + dir * L * 0.70, byy + L * (drop + 0.22));
        ctx.closePath();
        ctx.fillStyle = bodyC;
        ctx.fill();
        // underside of the spray in the shade tone: the branch has thickness
        ctx.beginPath();
        ctx.moveTo(bx, byy);
        ctx.lineTo(bx + dir * L, byy + L * drop);
        ctx.lineTo(bx + dir * L * 0.92, byy + L * (drop + 0.07));
        ctx.closePath();
        ctx.fillStyle = darkC;
        ctx.fill();
      }
    }

    // branch line under the skirt: the tier break, traced along the ragged underside
    ctx.strokeStyle = 'rgba(6,14,9,.46)';
    ctx.lineWidth = Math.max(0.7, 1.05 * s);
    ctx.beginPath();
    ctx.moveTo(skew - half, by);
    for (let i = 0; i < skirtX.length; i++) {
      const d = 0.30 + 1.25 * jitter(ti * 31 + i, Math.round(v * 97), 17);
      const dip = hgt * 0.016 * (1 - skirtX[i] * skirtX[i]);
      ctx.lineTo(skew + skirtX[i] * half, by + d * skirt + dip);
    }
    ctx.lineTo(skew + half, by);
    ctx.stroke();
  }

  // tip glint — a soft point at the apex at fit zoom, a lit needle-tip when zoomed
  ctx.fillStyle = T.rim;
  ctx.beginPath();
  ctx.ellipse(-w * 0.02, -hgt * 0.988, w * 0.026, hgt * 0.010, 0, 0, TAU);
  ctx.fill();

  if (ramp && ramp.snow) snowFoot(ctx, w, hgt);
}

/**
 * Indigenous (yellowwood / stinkwood read): an irregular six-lobe canopy over a forked
 * trunk. Dark under-canopy pools SE, a lit cluster sits on the NW shoulder, and two dark
 * dapple gaps stop the mass reading as one flat disc.
 */
function drawIndigenous(ctx, s, o = {}) {
  const v = o.v ?? 0.5;
  // The Mistbelt FOREST PACK (Assets-2026-09-23) holds BOTH natives, and each carries
  // its OWN sapling/young art — a yellowwood sapling is never an ironwood sapling
  // (owner: "keep track of the right trees"). Since lead L1 the sim names the tree
  // (`t.species`), so the species is READ, not guessed: the old line was
  // `v < 0.5 ? 'yellowwood' : 'ironwood'`, which meant a tree's identity was an artefact
  // of the atlas variant bucket and could not agree with anything downstream. The hash
  // stays as the fallback for node, the gate and any caller with no species.
  // Stage comes from the tree's age (o.stage); mature is the default.
  const species = (o.species === 'yellowwood' || o.species === 'ironwood')
    ? o.species : (v < 0.5 ? 'yellowwood' : 'ironwood');
  const stageName = o.stage ? `${species}_${o.stage}` : (species === 'yellowwood' ? 'indigenous' : 'ironwood');
  if (imageState[stageName] === 'ready') { drawImageSprite(ctx, stageName, s, v); return; }
  const T = PALETTE.tree;
  // same idea as the pine: the variant changes the canopy's build as well as its tone
  const ws = 0.95 + v * 0.10;
  const hs = 1.04 - v * 0.08;
  const w = 78 * s * ws, hgt = 80 * s * hs;
  const hov = !!o.hover;

  // SEASON: none. Hogsback's indigenous forest is evergreen — green yellowwoods in
  // winter are correct, so this sprite takes no ramp and no snow load (lead, 10-21).
  // Do not add o.season here; the atlas does not bake a season state for it either.
  // The two natives are not the same green: Outeniqua yellowwood is a brighter, slightly
  // yellow-green canopy; ironwood (Olea capensis) is darker and greyer. Both have
  // cutouts now, but this is the path node and the gate draw, so the fallback must not
  // render them identical or the species fix is untested where the gate runs.
  const specShift = species === 'ironwood' ? [-6, -10, -2] : [0, 0, 0];
  const base = [34 + v * 24 + specShift[0], 90 + v * 34 + specShift[1], 44 + v * 16 + specShift[2]];

  shadow(ctx, w * 0.46, hgt * 0.065, 0.40, 0.28, 0.34);

  // trunk + two forks: a canopy needs something to stand on. Wider at the root so a
  // mature yellowwood sits in the ground rather than on it.
  const tw = w * 0.070;
  ctx.beginPath();
  ctx.moveTo(-tw * 0.95, 0);
  ctx.lineTo(-tw * 0.34, -hgt * 0.32);
  ctx.lineTo(tw * 0.34, -hgt * 0.32);
  ctx.lineTo(tw * 0.95, 0);
  ctx.closePath();
  ctx.fillStyle = T.trunk;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-tw * 0.95, 0);
  ctx.lineTo(-tw * 0.34, -hgt * 0.32);
  ctx.lineTo(-tw * 0.04, -hgt * 0.32);
  ctx.lineTo(-tw * 0.40, 0);
  ctx.closePath();
  ctx.fillStyle = T.trunkLit;
  ctx.fill();
  ctx.strokeStyle = T.trunk;
  ctx.lineWidth = Math.max(0.8, 1.7 * s);
  ctx.beginPath();
  ctx.moveTo(0, -hgt * 0.20);
  ctx.lineTo(-w * 0.17, -hgt * 0.46);
  ctx.moveTo(0, -hgt * 0.24);
  ctx.lineTo(w * 0.15, -hgt * 0.48);
  ctx.stroke();

  // canopy: uneven lobes around a ring — the bumps are what keep it from reading as a
  // disc, and the uneven radii keep the top edge from being an arc. The small outer
  // lobes are the ragged tips that break the silhouette.
  const lobes = [
    [0.02, -0.58, 0.30, 0.26],
    [-0.22, -0.50, 0.24, 0.22],
    [0.24, -0.52, 0.21, 0.19],
    [-0.27, -0.68, 0.18, 0.17],
    [0.28, -0.66, 0.17, 0.16],
    [-0.11, -0.80, 0.22, 0.19],
    [0.13, -0.78, 0.19, 0.17],
    [0.02, -0.38, 0.26, 0.16],
    [-0.36, -0.42, 0.10, 0.09],
    [0.38, -0.40, 0.09, 0.08],
  ];
  // under-canopy first: the same lobes shifted SE in a dark tone, so the body pass
  // leaves a shaded crescent along the lit mass's bottom-right. A dark ellipse drawn on
  // top would read as a spot; a shifted under-pass reads as form.
  ctx.fillStyle = hov ? T.pineHover[0] : tone(base, 0.66);
  for (const [dx, dy, rx, ry] of lobes) {
    ctx.beginPath();
    ctx.ellipse((dx + 0.045) * w, (dy + 0.035) * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = hov ? T.leafHover : tone(base, 1);
  for (const [dx, dy, rx, ry] of lobes) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }

  // lit cap on the NW shoulder: the upper lobes re-stated a step lighter and slightly
  // up-left, which gives the ball some form instead of a flat disc
  ctx.fillStyle = hov ? T.leafHover : tone(base, 1.30);
  for (const [dx, dy, rx, ry] of [[-0.11, -0.82, 0.17, 0.10], [-0.25, -0.72, 0.13, 0.09],
    [0.10, -0.80, 0.11, 0.07], [-0.20, -0.56, 0.10, 0.07], [-0.30, -0.62, 0.08, 0.06]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }

  // sun flecks on the NW shoulder — a few small dots, scattered, not a string of beads
  ctx.fillStyle = 'rgba(158,190,104,0.50)';
  for (const [dx, dy, r] of [[-0.22, -0.75, 0.030], [-0.09, -0.86, 0.024], [-0.31, -0.62, 0.022]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, r * w, r * hgt * 1.2, 0, 0, TAU);
    ctx.fill();
  }

  // leaf clumps breaking the lower silhouette, lit a step above the body
  ctx.fillStyle = hov ? T.leafHover : tone(base, 1.16);
  for (const [dx, dy, rx] of [[-0.33, -0.36, 0.075], [0.35, -0.38, 0.065], [0.18, -0.28, 0.06]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, rx * w, rx * hgt * 0.85, 0, 0, TAU);
    ctx.fill();
  }

  // no snow foot under the indigenous canopy: the crown shelters the root flare, and a
  // pale band under a full canopy reads as a separate object.
}

/**
 * Wattle (the weed, per the timber sim: a firewood tree): sickly yellow-green (#9aa84f
 * read — lighter than the grass band, distinctly "not pine"), SHORTER and scruffier
 * than pine — the mid-height band between bed and pine — and always MULTI-STEM: 2–3
 * thin trunks fanning from the base, never a clean single leader (coppiced regrowth).
 * Feathery bipinnate crown from many small leaf clusters, never one solid mass.
 * The variant ladder swings tone and build HARD per instance: wattle seeds in clusters,
 * so several stand adjacent — per-instance spread is what makes a stand read as one
 * ragged mass with individual variation. A few pale bloom dots are the ID marker.
 * Must read as a WEED at 20 px.
 */
function drawWattle(ctx, s, o = {}) {
  const v = o.v ?? 0.5;
  const T = PALETTE.tree;
  // the Mistbelt black-wattle cutout, once decoded
  if (imageState.wattle === 'ready') { drawImageSprite(ctx, 'wattle', s, v); return; }
  const lean = (v - 0.5) * 0.34;
  const hs = 0.90 + v * 0.24;
  const ws = 1.02 + v * 0.16;
  const w = 68 * s * ws, hgt = 81 * s * hs;
  const hov = !!o.hover;

  // wide per-instance tone ladder — cluster-raggedness lives here. Winter pushes the
  // whole ladder toward grey-brown (the sim's bareWattle hint) and thins the crown.
  const ramp = seasonRamp(o);
  const base = seasonBase([130 + v * 42, 148 + v * 34, 58 + v * 24], ramp, 1.15);

  shadow(ctx, w * 0.44, hgt * 0.058, 0.44, 0.30, 0.26);

  // multi-stem: 2–3 thin trunks fanning from the base, each curving into the crown
  const tw = Math.max(1.3, w * 0.038);
  const stems = v < 0.45
    ? [[-0.18, -0.50], [0.10, -0.58]]
    : [[-0.20, -0.46], [0.02, -0.56], [0.22, -0.50]];
  ctx.lineCap = 'round';
  for (const [sx, tip] of stems) {
    ctx.strokeStyle = T.trunk;
    ctx.lineWidth = tw;
    ctx.beginPath();
    ctx.moveTo(sx * w, 0);
    ctx.quadraticCurveTo(sx * w * 0.5 + lean * w * 0.3, tip * hgt * 0.5, sx * w * 0.6 + lean * w * 0.5, tip * hgt);
    ctx.stroke();
    ctx.strokeStyle = T.trunkLit;
    ctx.lineWidth = tw * 0.4;
    ctx.beginPath();
    ctx.moveTo(sx * w - tw * 0.25, 0);
    ctx.quadraticCurveTo(sx * w * 0.5 + lean * w * 0.3 - tw * 0.25, tip * hgt * 0.5, sx * w * 0.6 + lean * w * 0.5 - tw * 0.25, tip * hgt);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';

  // BARE IN WINTER — the sim's bareWattle hint, taken literally: drop the crown and let
  // the stems carry a twig fan. A thinned green mass still reads as foliage, so the
  // honest read for a leafless wattle is no leaf at all.
  if (ramp && ramp.snow) {
    ctx.strokeStyle = T.trunk;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.7, tw * 0.62);
    ctx.beginPath();
    for (const [sx, tip] of stems) {
      const bx = sx * w * 0.6 + lean * w * 0.5;
      const byy = tip * hgt;
      for (const [fx, fy] of [[-0.26, -0.26], [-0.10, -0.34], [0.08, -0.32], [0.24, -0.22]]) {
        const tx = bx + (fx + sx * 0.4) * w * 0.6, ty = byy + fy * hgt;
        ctx.moveTo(bx, byy);
        ctx.lineTo(tx, ty);
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + (fx > 0 ? 0.05 : -0.05) * w, ty - hgt * 0.07);
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    snowFoot(ctx, w, hgt);
    return;
  }

  // feathery crown: small overlapping clusters, gaps left between them. A dark
  // SE-biased under-pass then the body pass gives depth without a gradient.
  // No alpha thinning here: winter wattle went bare above and returned, so every
  // season that reaches this point wants a full crown.
  const blobs = [
    [-0.30, -0.56, 0.13], [-0.12, -0.68, 0.15], [0.10, -0.60, 0.14],
    [0.28, -0.52, 0.12], [-0.36, -0.40, 0.11], [0.34, -0.38, 0.10],
    [-0.18, -0.46, 0.14], [0.06, -0.44, 0.15], [0.22, -0.70, 0.10],
    [-0.28, -0.74, 0.10], [0.00, -0.78, 0.11], [-0.06, -0.88, 0.09],
    [0.16, -0.82, 0.08], [-0.40, -0.62, 0.07],
  ];
  ctx.fillStyle = hov ? T.wattleHover : tone(base, 0.70);
  for (const [dx, dy, r] of blobs) {
    ctx.beginPath();
    ctx.ellipse(dx * w + w * 0.045, dy * hgt + hgt * 0.05, r * w * 0.9, r * hgt * 0.72, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = hov ? T.wattleHover : tone(base, 1);
  for (const [dx, dy, r] of blobs) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, r * w, r * hgt * 0.8, 0, 0, TAU);
    ctx.fill();
  }

  // lit clusters NW, then the bloom dots — the yellow flowers say "wattle"
  ctx.fillStyle = hov ? T.wattleHover : tone(base, 1.22);
  for (const [dx, dy, r] of [[-0.20, -0.72, 0.06], [-0.05, -0.84, 0.05], [0.12, -0.66, 0.05], [-0.30, -0.50, 0.05]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, r * w, r * hgt * 0.7, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(232,214,96,.75)';
  for (const [dx, dy, r] of [[-0.14, -0.76, 0.028], [0.08, -0.86, 0.024], [-0.26, -0.60, 0.022], [0.20, -0.58, 0.020]]) {
    ctx.beginPath();
    ctx.arc(dx * w, dy * hgt, Math.max(0.7, r * w), 0, TAU);
    ctx.fill();
  }
}

/**
 * Blackwood: the wattle's straighter, darker cousin — same feathery cluster foliage,
 * but a single upright trunk, clear to half height, under a taller, narrower, more
 * even columnar crown. Dark enough to hold the pine-family silhouette against all
 * three terrain bands; its timber is the prize, its regrowth the nuisance.
 */
function drawBlackwood(ctx, s, o = {}) {
  const v = o.v ?? 0.5;
  const T = PALETTE.tree;
  // the Mistbelt blackwood cutout, once decoded
  if (imageState.blackwood === 'ready') { drawImageSprite(ctx, 'blackwood', s, v); return; }
  const hs = 0.94 + v * 0.16;
  const ws = 0.94 + v * 0.10;
  const w = 55 * s * ws, hgt = 100 * s * hs;
  const hov = !!o.hover;

  const ramp = seasonRamp(o);
  const base = seasonBase([50 + v * 20, 74 + v * 24, 44 + v * 14], ramp, 1.10);

  shadow(ctx, w * 0.42, hgt * 0.05, 0.44, 0.30, 0.28);

  // straight trunk with a lit NW edge, clear to half the height
  const tw = Math.max(1.8, w * 0.075);
  ctx.fillStyle = T.trunk;
  ctx.fillRect(-tw * 0.5, -hgt * 0.52, tw, hgt * 0.52);
  ctx.fillStyle = T.trunkLit;
  ctx.fillRect(-tw * 0.5, -hgt * 0.52, tw * 0.40, hgt * 0.52);

  // two upright limbs
  ctx.strokeStyle = T.trunk;
  ctx.lineWidth = Math.max(1, tw * 0.5);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -hgt * 0.40);
  ctx.lineTo(-w * 0.14, -hgt * 0.66);
  ctx.moveTo(0, -hgt * 0.46);
  ctx.lineTo(w * 0.13, -hgt * 0.68);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // BARE IN WINTER — the other alien deciduous, same read as the wattle: the crown is
  // dropped and the trunk top carries a twig fan. A thinned green mass still reads as
  // foliage, so no leaf at all is the honest winter state.
  if (ramp && ramp.snow) {
    const ty0 = -hgt * 0.52;
    ctx.strokeStyle = T.trunk;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.7, tw * 0.40);
    ctx.beginPath();
    // main fan off the trunk top, bowed outward so it reads as a tree, not a whisk.
    // Offsets are from ty0, like the wattle's twigs — absolute fy values put the whole
    // fan below the fork, hanging down the trunk.
    for (const [fx, fy, bow] of [[-0.26, -0.20, -0.04], [-0.19, -0.31, -0.03], [-0.10, -0.38, -0.02],
      [0.02, -0.42, 0.01], [0.13, -0.37, 0.02], [0.21, -0.29, 0.03], [0.27, -0.17, 0.04]]) {
      const ex = fx * w, ey = ty0 + fy * hgt;
      ctx.moveTo(0, ty0);
      ctx.quadraticCurveTo((ex + bow * w) * 0.55, (ty0 + ey) * 0.5, ex, ey);
      // one fork at the tip, always angled up and out
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + (fx >= 0 ? 0.045 : -0.045) * w, ey - hgt * 0.075);
    }
    // two short side branches on the clear trunk, so the bare tree is not a pole
    ctx.moveTo(0, -hgt * 0.34); ctx.lineTo(-w * 0.11, -hgt * 0.42);
    ctx.moveTo(0, -hgt * 0.43); ctx.lineTo(w * 0.09, -hgt * 0.50);
    ctx.stroke();
    ctx.lineCap = 'butt';
    snowFoot(ctx, w, hgt);
    return;
  }

  // feathery crown: same small-cluster read as the wattle, tighter and more columnar.
  // No alpha thinning: winter blackwood goes bare above and returns.
  const blobs = [
    [-0.16, -0.62, 0.13], [0.08, -0.66, 0.13], [-0.04, -0.74, 0.13],
    [0.16, -0.58, 0.11], [-0.24, -0.54, 0.10], [0.02, -0.86, 0.10],
    [-0.14, -0.82, 0.09], [0.12, -0.78, 0.09], [-0.06, -0.94, 0.07],
    [0.06, -0.52, 0.10],
  ];
  ctx.fillStyle = hov ? T.blackwoodHover : tone(base, 0.62);
  for (const [dx, dy, r] of blobs) {
    ctx.beginPath();
    ctx.ellipse(dx * w + w * 0.04, dy * hgt + hgt * 0.04, r * w * 0.9, r * hgt * 0.72, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = hov ? T.blackwoodHover : tone(base, 1);
  for (const [dx, dy, r] of blobs) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, r * w, r * hgt * 0.8, 0, 0, TAU);
    ctx.fill();
  }

  // lit clusters NW
  ctx.fillStyle = hov ? T.blackwoodHover : tone(base, 1.24);
  for (const [dx, dy, r] of [[-0.10, -0.80, 0.055], [0.04, -0.90, 0.045], [-0.18, -0.66, 0.045], [0.10, -0.62, 0.040]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, r * w, r * hgt * 0.7, 0, 0, TAU);
    ctx.fill();
  }
}

/**
 * Oak — the alien ornamental (owner 21-10: "Good ornamental but technically alien").
 * The one tree on the plot whose crown is WIDER THAN IT IS HIGH: a short clear bole
 * that forks into heavy spreading limbs under a flat lobed canopy. That silhouette is
 * the whole read — at 20 px it is the only tree that is not a cone (pine), a ball on a
 * pole (indigenous), or a ragged vertical mass (wattle / blackwood), so a planted
 * garden oak is identifiable without colour.
 *
 * Tone: dark cool green, a clear step below the wattle's sickly yellow and under the
 * yellowwood's mid-green — it must read as an EXOTIC in a stand of Hogsback natives.
 *
 * Stages come from the tree's age (o.stage) exactly like the indigenous giants: the art
 * carries the size, not an age multiplier. Sapling is a whip with a small round head,
 * young is a narrow dome, mature is the full spread.
 *
 * DECIDUOUS. Winter drops the crown to a limb fan (same read as wattle/blackwood) —
 * this is a northern-hemisphere ornamental, and the sim's review bonus is for the
 * standing tree, not for its leaves. Flagged to the owner as a look call.
 */
function drawOak(ctx, s, o = {}) {
  const v = o.v ?? 0.5;
  const T = PALETTE.tree;
  // the Mistbelt-style cutouts (owner 2026-10-22: "needs art in the same style as the
  // others, ie Mistbelt"), generated through tools/make-sprite-assets.py: one per growth
  // stage, plus a separate BARE cutout for winter — a painted tree cannot drop its crown
  // the way the vector fallback below does, so the leafless state is its own asset.
  const img = o.season === 'winter' ? 'oak_bare'
    : o.stage === 'sapling' ? 'oak_sapling'
      : o.stage === 'young' ? 'oak_young' : 'oak';
  if (imageState[img] === 'ready') { drawImageSprite(ctx, img, s, v); return; }
  const hov = !!o.hover;
  const ramp = seasonRamp(o);
  const base = seasonBase([34 + v * 18, 62 + v * 22, 40 + v * 12], ramp, 1.0);

  // stage → size, carried by the art: width leads (an oak spreads before it rises)
  const stW = o.stage === 'sapling' ? 0.36 : o.stage === 'young' ? 0.68 : 1;
  const stH = o.stage === 'sapling' ? 0.40 : o.stage === 'young' ? 0.66 : 1;
  const w = 110 * s * stW * (0.94 + v * 0.12);
  const hgt = 68 * s * stH * (0.96 + v * 0.08);

  shadow(ctx, w * 0.46, hgt * 0.055, 0.36, 0.28, 0.34);

  // bole: short and thick with a root flare — an oak is mostly crown
  const tw = Math.max(1.5, w * 0.085);
  const boleTop = -hgt * (0.34 + stH * 0.06);
  ctx.beginPath();
  ctx.moveTo(-tw * 1.10, 0);
  ctx.lineTo(-tw * 0.46, boleTop);
  ctx.lineTo(tw * 0.46, boleTop);
  ctx.lineTo(tw * 1.10, 0);
  ctx.closePath();
  ctx.fillStyle = T.trunk;
  ctx.fill();
  ctx.fillStyle = T.trunkLit;                       // lit NW face of the bole
  ctx.beginPath();
  ctx.moveTo(-tw * 1.10, 0);
  ctx.lineTo(-tw * 0.46, boleTop);
  ctx.lineTo(-tw * 0.08, boleTop);
  ctx.lineTo(-tw * 0.52, 0);
  ctx.closePath();
  ctx.fill();

  // spreading limbs: two heavy arms out to the canopy edge, one leader up. The fork is
  // what says "planted garden tree" rather than a self-sown stem.
  ctx.strokeStyle = T.trunk;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.1, tw * 0.60);
  ctx.beginPath();
  ctx.moveTo(0, boleTop + hgt * 0.02);
  ctx.quadraticCurveTo(-w * 0.20, -hgt * 0.50, -w * 0.38, -hgt * 0.60);
  ctx.moveTo(0, boleTop + hgt * 0.02);
  ctx.quadraticCurveTo(w * 0.20, -hgt * 0.50, w * 0.36, -hgt * 0.58);
  ctx.moveTo(0, boleTop);
  ctx.lineTo(-w * 0.03, -hgt * 0.74);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // WINTER: bare limbs. Same honest read as the other two deciduous exotics — a thinned
  // green mass still reads as foliage, so the crown is dropped entirely.
  if (ramp && ramp.snow) {
    ctx.strokeStyle = T.trunk;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.7, tw * 0.36);
    ctx.beginPath();
    for (const [fx, fy, bow] of [[-0.40, -0.44, -0.05], [-0.30, -0.56, -0.04],
      [-0.16, -0.64, -0.02], [0.00, -0.68, 0.00], [0.16, -0.63, 0.02],
      [0.30, -0.55, 0.04], [0.40, -0.42, 0.05]]) {
      const ex = fx * w, ey = fy * hgt;
      ctx.moveTo(0, boleTop);
      ctx.quadraticCurveTo((ex + bow * w) * 0.55, (boleTop + ey) * 0.5, ex, ey);
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + (fx >= 0 ? 0.05 : -0.05) * w, ey - hgt * 0.07);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    snowFoot(ctx, w, hgt);
    return;
  }

  // canopy: flat lobed masses in a wide low band. The bumps and the uneven radii are
  // what keep it from reading as one ellipse; the outer clumps break the silhouette.
  const lobes = [
    [-0.36, -0.58, 0.15, 0.13], [-0.18, -0.62, 0.18, 0.15], [0.02, -0.63, 0.19, 0.15],
    [0.22, -0.60, 0.17, 0.14], [0.38, -0.54, 0.13, 0.11],
    [-0.28, -0.72, 0.15, 0.12], [-0.08, -0.76, 0.17, 0.13], [0.12, -0.74, 0.15, 0.12],
    [0.30, -0.68, 0.12, 0.10], [-0.14, -0.86, 0.13, 0.10], [0.06, -0.85, 0.12, 0.09],
    [-0.46, -0.46, 0.10, 0.09], [0.47, -0.44, 0.09, 0.08],
  ];
  // under-canopy pass, shifted SE and dark: leaves a shaded crescent under the lit mass
  ctx.fillStyle = hov ? T.pineHover[0] : tone(base, 0.62);
  for (const [dx, dy, rx, ry] of lobes) {
    ctx.beginPath();
    ctx.ellipse((dx + 0.040) * w, (dy + 0.030) * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = hov ? T.leafHover : tone(base, 1);
  for (const [dx, dy, rx, ry] of lobes) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }

  // lit cap on the NW shoulder: upper lobes restated a step lighter and slightly up-left
  ctx.fillStyle = hov ? T.leafHover : tone(base, 1.30);
  for (const [dx, dy, rx, ry] of [[-0.26, -0.74, 0.12, 0.08], [-0.06, -0.78, 0.13, 0.08],
    [0.14, -0.75, 0.10, 0.07], [-0.36, -0.60, 0.09, 0.06], [0.03, -0.66, 0.10, 0.06]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }

  // sun flecks, scattered on the NW shoulder — dots, never a string of beads
  ctx.fillStyle = 'rgba(146,176,110,0.42)';
  for (const [dx, dy, r] of [[-0.22, -0.78, 0.026], [-0.10, -0.82, 0.021], [-0.32, -0.66, 0.019]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, r * w, r * hgt * 1.2, 0, 0, TAU);
    ctx.fill();
  }

  // dark leaf gaps: three small notches through the mass, so the crown reads as foliage
  // with depth rather than a solid painted shape
  ctx.fillStyle = tone(base, 0.44);
  for (const [dx, dy, rx, ry] of [[-0.02, -0.58, 0.05, 0.030], [0.20, -0.66, 0.040, 0.026],
    [-0.28, -0.52, 0.035, 0.022]]) {
    ctx.beginPath();
    ctx.ellipse(dx * w, dy * hgt, rx * w, ry * hgt, 0, 0, TAU);
    ctx.fill();
  }
}

/* -------------------------------------------------------------- buildings */

/**
 * The crop in a bed, for one of FARMING-SPEC's four growth stages.
 *
 * Drawn in the bed's OWN ground plane. A tile's grid point (gx, gy) in [0,1] maps to
 *   x = (gx - gy) * TW/2,   y = (gx + gy - 1) * TH/2
 * times the scale, measured from the CENTRE of the footprint diamond. That is the same
 * iso-math the bake and the tile corners use, and TW/TH are IMPORTED from iso-math.js
 * rather than retyped here.
 *
 * It replaces the old furrows, which were drawn as VERTICAL SCREEN LINES -
 * `moveTo(i*w*0.22, -ext)` to `lineTo(i*w*0.22, ext)` - and a vertical line lies on no
 * 2:1 ground plane. That is part of why a vector bed looked pasted onto its tile rather
 * than dug into it.
 *
 * Three rows at grid x 0.28 / 0.50 / 0.72, running along decreasing grid y - the
 * direction of the furrows painted into the bed cutout - spanning y 0.16..0.84 so the
 * crop stays inside the soil and never crosses the rim.
 *
 * Every width and radius has a floor in device px. At the game's fit zoom a bed is ~30 px
 * across (s ~ 0.47), so an unfloored 1 px line is half a pixel and simply is not drawn -
 * which is most of why the old two-state bed read as "nothing happens for twenty days".
 *
 * Deterministic by construction: the marks sit at fixed fractions along each row, not a
 * random draw, so the same stage bakes the same tile every time.
 */
const BED_ROWS = [0.28, 0.50, 0.72];
const BED_SPAN = [0.16, 0.84];
const bedPt = (gx, gy, s) => [(gx - gy) * (TW / 2) * s, (gx + gy - 1) * (TH / 2) * s];

/**
 * The three crops FARMING-SPEC Part 2 landed, as art.
 *
 * A bed's PLANT PATTERN is per-crop at every differentiated stage, not its size: the
 * count and spacing are fixed per crop and the stage only scales and re-colours them.
 * That is deliberate. At fit zoom a bed is ~30 px across, so the thing the eye can
 * actually resolve is "six medium clumps" vs "nine fine spikes" vs "three wide hills" -
 * density and silhouette. Colour alone would have been lost, and a per-stage plant COUNT
 * would have made the crop unreadable while telling you the stage you could already see.
 *
 * `potato.ripe` is the one that is not a shade of green. Potato haulm dies back when the
 * tubers are ready, so its harvest cue is tan while greens and herbs stay green. That is
 * free legibility: the crop with the longest wait (32 days) gets the one ready-signal no
 * other crop can be mistaken for.
 *
 * `BED_DEFAULT_CROP` mirrors homestead.DEFAULT_CROP rather than importing it: the art
 * layer must not depend on the sim (the port contract - see RUT_SOFT above iso-render's
 * surfOf). The drift that creates is gated, not commented: tools/atlas.html fails the
 * bake if any crop `CROPS` offers has no entry here, or if the two defaults disagree.
 */
export const BED_DEFAULT_CROP = 'greens';
export const CROP_ART = {
  greens: {
    // leafy, dense, low and round - what the old generic speckle always stood for
    plants: 6, shape: 'clump',
    row: '#4d7a35', stem: '#3f6b2c', leaf: '#6fae4a',
    ripe: '#8fc95f', ripeTop: 'rgba(214,246,168,.92)',
  },
  herbs: {
    // drilled in fine and stands up: many thin verticals in sage blue-green, and it
    // flowers, so the ready tips are the only violet on the plot
    plants: 9, shape: 'spike',
    row: '#5c7a62', stem: '#41604a', leaf: '#7fa385',
    ripe: '#9db8a0', ripeTop: 'rgba(198,170,226,.95)',
  },
  potato: {
    // hilled: few, wide, dark blue-green mounds, then a tan die-back when it is in
    plants: 3, shape: 'hill',
    row: '#2f5c33', stem: '#26492a', leaf: '#3f7441',
    ripe: '#c2a75c', ripeTop: 'rgba(228,199,112,.95)',
  },
};

/** How big a plant is at each stage, and which colours it wears. */
const STAGE_SCALE = [0, 0.42, 0.74, 1];

function bedCrop(ctx, s, stageRaw, cropRaw) {
  // Normalised at the door. The renderer passes an integer 0..3 and a crop name; tools
  // that reach this through a URL parameter or an old save can hand over '2', 1.9, '' or
  // no crop at all. Clamping here means one definition of the states rather than one per
  // caller - and note `'2' === 2` is false, so a string stage would otherwise take the
  // `stage >= 1` branch and then fall through every `stage === n` test.
  const stage = Math.max(0, Math.min(3, Math.round(Number(stageRaw) || 0)));
  const crop = CROP_ART[cropRaw] ? cropRaw : BED_DEFAULT_CROP;
  if (!(stage >= 1)) return;              // stage 0 = bare worked soil, the furrows you dug
  const A = CROP_ART[crop];
  const line = (k) => Math.max(1.0, k * s);
  const dot = (k) => Math.max(1.0, k * s);
  const g = STAGE_SCALE[stage];
  const ripe = stage >= 3;
  const bodyCol = ripe ? A.ripe : A.leaf;
  const topCol = ripe ? A.ripeTop : A.leaf;
  // where the plants sit along the row - fixed per crop, so the PATTERN is the identifier
  const step = 1 / A.plants;
  const marks = Array.from({ length: A.plants }, (_, i) => step * (i + 0.5));

  for (const gx of BED_ROWS) {
    const [ax, ay] = bedPt(gx, BED_SPAN[0], s);
    const [bx, by] = bedPt(gx, BED_SPAN[1], s);
    ctx.strokeStyle = A.row;
    ctx.lineWidth = line(stage === 1 ? 1.1 : stage === 2 ? 2.0 : 2.4);
    ctx.globalAlpha = stage === 1 ? 0.85 : 1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.globalAlpha = 1;
    for (const m of marks) {
      const gy = BED_SPAN[0] + (BED_SPAN[1] - BED_SPAN[0]) * m;
      const [px, py] = bedPt(gx, gy, s);
      if (A.shape === 'spike') {
        // a thin upright: narrow, tall, and the flower tip only at harvest
        ctx.fillStyle = A.stem;
        ctx.beginPath();
        ctx.ellipse(px, py - dot(1.1 * g), dot(0.34 * g + 0.3), dot(1.9 * g + 0.5), 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = topCol;
        ctx.beginPath(); ctx.arc(px, py - dot(2.5 * g + 0.4), dot(0.55 * g + 0.35), 0, TAU); ctx.fill();
      } else if (A.shape === 'hill') {
        // a wide low mound, the broadest thing any bed can draw
        ctx.fillStyle = A.stem;
        ctx.beginPath();
        ctx.ellipse(px, py + dot(0.3), dot(2.5 * g + 0.6), dot(1.25 * g + 0.4), 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = bodyCol;
        ctx.beginPath();
        ctx.ellipse(px, py - dot(0.5 * g), dot(2.0 * g + 0.5), dot(1.15 * g + 0.4), 0, 0, TAU);
        ctx.fill();
        if (ripe) {
          // die-back: a lit tan crown over the dark mound, not a green highlight
          ctx.fillStyle = topCol;
          ctx.beginPath(); ctx.arc(px, py - dot(1.15 * g), dot(0.95 * g + 0.35), 0, TAU); ctx.fill();
        }
      } else {
        // clump: a dark under-leaf and a lit round top
        ctx.fillStyle = A.stem;
        ctx.beginPath();
        ctx.ellipse(px, py + dot(0.5 * g), dot(1.0 * g + 0.4), dot(1.7 * g + 0.4), 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = bodyCol;
        ctx.beginPath(); ctx.arc(px, py - dot(0.9 * g), dot(1.15 * g + 0.35), 0, TAU); ctx.fill();
        if (ripe) {
          ctx.fillStyle = topCol;
          ctx.beginPath(); ctx.arc(px, py - dot(1.2 * g), dot(0.7 * g + 0.3), 0, TAU); ctx.fill();
        }
      }
    }
  }
}

/**
 * Bed: a timber-edged soil diamond, three furrows, lit NW rim / shaded SE rim.
 * The crop is `bedCrop`, driven by FARMING-SPEC's four integer stages and, since Part 3,
 * its three crops. iso-render derives `ready` as `stage === 3`; both are accepted here so
 * an older caller passing only `{ready: true}` still gets a ready bed rather than a bare
 * one, and a bed from before the crop table falls back to the default crop's look.
 */
function drawBed(ctx, s, o = {}) {
  const w = 46 * s, h = 24 * s;
  const S = PALETTE.soil;
  const stage = o.stage != null ? o.stage : (o.ready ? 3 : 0);

  ctx.fillStyle = 'rgba(0,0,0,.26)';
  ctx.beginPath();
  ctx.ellipse(2.2 * s, 2.0 * s, w * 0.48, h * 0.30, 0, 0, TAU);
  ctx.fill();

  const diamond = (grow) => {
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.5 - grow);
    ctx.lineTo(w * 0.5 + grow * 2, 0);
    ctx.lineTo(0, h * 0.5 + grow);
    ctx.lineTo(-w * 0.5 - grow * 2, 0);
    ctx.closePath();
  };

  // timber edging the soil sits in, then the soil
  diamond(1.7 * s);
  ctx.fillStyle = S.bedEdge;
  ctx.fill();
  diamond(0);
  ctx.fillStyle = S.bed;
  ctx.fill();

  // NW rim catches the light, SE rim sits in its own shade
  ctx.lineWidth = Math.max(0.9, 1.5 * s);
  ctx.strokeStyle = S.bedLit;
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, 0);
  ctx.lineTo(0, -h * 0.5);
  ctx.lineTo(w * 0.5, 0);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(18,11,5,.55)';
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 0);
  ctx.lineTo(0, h * 0.5);
  ctx.lineTo(-w * 0.5, 0);
  ctx.stroke();

  // The three dug furrows, in the ground plane. Soil tones, NOT green: "dug" and
  // "planted" are different facts, and the old line used the crop's own colour for the
  // trench, so an empty bed looked half-grown and a grown bed had nothing to sit on.
  // The vector bed's diamond is centred on the anchor, which is what bedPt assumes.
  for (const gx of BED_ROWS) {
    const [ax, ay] = bedPt(gx, BED_SPAN[0], s);
    const [bx, by] = bedPt(gx, BED_SPAN[1], s);
    ctx.lineWidth = Math.max(1.1, 2.6 * s);
    ctx.strokeStyle = S.bedEdge;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.lineWidth = Math.max(0.9, 1.2 * s);
    ctx.strokeStyle = S.bedLit;
    // the lit lip sits up-slope of the trench, i.e. toward the NW on screen
    ctx.beginPath(); ctx.moveTo(ax - 0.8 * s, ay - 0.8 * s); ctx.lineTo(bx - 0.8 * s, by - 0.8 * s); ctx.stroke();
  }

  // the crop itself, whatever stage this bed is at (stage 0 draws nothing, and an
  // unknown or missing crop falls back to the default inside bedCrop)
  bedCrop(ctx, s, stage, o.crop);

  if (!(stage >= 1)) {
    // a couple of clod shadows so worked soil is not a flat card
    ctx.fillStyle = 'rgba(24,16,8,.30)';
    ctx.beginPath();
    ctx.ellipse(-w * 0.12, h * 0.10, w * 0.06, h * 0.06, 0, 0, TAU);
    ctx.ellipse(w * 0.20, -h * 0.08, w * 0.05, h * 0.05, 0, 0, TAU);
    ctx.fill();
  }
}

/** Hive: banded box, lipped roof cap, landing board and a shaded SE face. */
function drawHive(ctx, s, o = {}) {
  const w = 31 * s, h = 36 * s;
  const W = PALETTE.wood;

  shadow(ctx, w * 0.62, h * 0.09, 0.34, 0.30, 0.28);

  ctx.fillStyle = W.hive;
  ctx.fillRect(-w * 0.5, -h * 0.92, w, h * 0.92);
  ctx.fillStyle = 'rgba(60,36,10,.22)';
  ctx.fillRect(w * 0.14, -h * 0.92, w * 0.36, h * 0.92);

  // super bands with a dark seam under each
  for (const t of [0.30, 0.52, 0.74]) {
    ctx.fillStyle = W.hiveBand;
    ctx.fillRect(-w * 0.5, -h * t, w, h * 0.055);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(-w * 0.5, -h * t + h * 0.055, w, h * 0.018);
  }

  // roof cap with a lip on both sides
  ctx.fillStyle = W.hiveTop;
  ctx.fillRect(-w * 0.56, -h * 0.99, w * 1.12, h * 0.10);
  ctx.fillStyle = W.hiveBand;
  ctx.fillRect(-w * 0.56, -h * 0.895, w * 1.12, h * 0.032);

  // landing board + entrance
  ctx.fillStyle = W.hiveTop;
  ctx.fillRect(-w * 0.58, -h * 0.27, w * 1.16, h * 0.07);
  ctx.fillStyle = 'rgba(0,0,0,.32)';
  ctx.fillRect(-w * 0.58, -h * 0.20, w * 1.16, h * 0.032);
  ctx.fillStyle = W.hiveDark;
  ctx.fillRect(-w * 0.10, -h * 0.19, w * 0.20, h * 0.11);

  // base board
  ctx.fillStyle = 'rgba(40,26,10,.38)';
  ctx.fillRect(-w * 0.54, -h * 0.04, w * 1.08, h * 0.04);
}

/** Water tank: rim + lid + cap, NW highlight strip, SE shade, ladder, stand pipe. */
function drawTank(ctx, s, o = {}) {
  const w = 38 * s, h = 54 * s;
  const M = PALETTE.metal;

  shadow(ctx, w * 0.60, h * 0.10, 0.34, 0.30, 0.30);

  ctx.fillStyle = M.tankBody;
  ctx.fillRect(-w * 0.5, -h, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.17)';
  ctx.fillRect(-w * 0.46, -h, w * 0.14, h);
  ctx.fillStyle = M.tankShade;
  ctx.fillRect(w * 0.06, -h, w * 0.44, h);

  ctx.strokeStyle = M.tankEdge;
  ctx.lineWidth = Math.max(0.7, s);
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, -h); ctx.lineTo(-w * 0.5, 0);
  ctx.moveTo(w * 0.5, -h); ctx.lineTo(w * 0.5, 0);
  ctx.stroke();

  // base plinth
  ctx.fillStyle = M.tankEdge;
  ctx.fillRect(-w * 0.54, -h * 0.05, w * 1.08, h * 0.05);

  // ladder on the NW face
  ctx.strokeStyle = M.tankEdge;
  ctx.lineWidth = Math.max(0.8, 1.2 * s);
  ctx.beginPath();
  ctx.moveTo(-w * 0.36, -h * 0.94); ctx.lineTo(-w * 0.36, -h * 0.10);
  ctx.moveTo(-w * 0.22, -h * 0.94); ctx.lineTo(-w * 0.22, -h * 0.10);
  for (let i = 0; i < 4; i++) {
    const y = -h * (0.20 + i * 0.19);
    ctx.moveTo(-w * 0.36, y); ctx.lineTo(-w * 0.22, y);
  }
  ctx.stroke();

  // top: outer rim, lid, cap
  ctx.beginPath();
  ctx.ellipse(0, -h, w * 0.5, h * 0.13, 0, 0, TAU);
  ctx.fillStyle = M.tankTop;
  ctx.fill();
  ctx.strokeStyle = M.tankEdge;
  ctx.lineWidth = Math.max(0.7, 1.1 * s);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -h, w * 0.34, h * 0.085, 0, 0, TAU);
  ctx.fillStyle = M.tankRim;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, -h, w * 0.10, h * 0.03, 0, 0, TAU);
  ctx.fillStyle = M.tankEdge;
  ctx.fill();

  // inlet stand pipe
  ctx.fillStyle = M.tankEdge;
  ctx.fillRect(w * 0.28, -h - h * 0.16, Math.max(1.4, 2.4 * s), h * 0.16);
  ctx.fillStyle = M.tankRim;
  ctx.fillRect(w * 0.28, -h - h * 0.16, Math.max(0.7, 1.1 * s), h * 0.16);
}

/** Toilet: board walls, hip roof split lit/shaded, framed door with a handle, vent. */
function drawToilet(ctx, s, o = {}) {
  const w = 34 * s, h = 39 * s;
  const W = PALETTE.wood;

  shadow(ctx, w * 0.60, h * 0.10, 0.34, 0.30, 0.28);

  ctx.fillStyle = 'rgba(30,20,10,.38)';
  ctx.fillRect(-w * 0.54, -h * 0.04, w * 1.08, h * 0.04);

  ctx.fillStyle = W.toilet;
  ctx.fillRect(-w * 0.5, -h * 0.78, w, h * 0.78);
  ctx.fillStyle = 'rgba(50,34,18,.24)';
  ctx.fillRect(w * 0.10, -h * 0.78, w * 0.40, h * 0.78);

  // board seams
  ctx.strokeStyle = 'rgba(58,38,18,.28)';
  ctx.lineWidth = Math.max(0.6, 0.9 * s);
  ctx.beginPath();
  ctx.moveTo(-w * 0.16, -h * 0.78); ctx.lineTo(-w * 0.16, 0);
  ctx.moveTo(w * 0.12, -h * 0.78); ctx.lineTo(w * 0.12, 0);
  ctx.stroke();

  // door: frame, panel, handle
  ctx.fillStyle = W.door;
  ctx.fillRect(-w * 0.11, -h * 0.47, w * 0.22, h * 0.34);
  ctx.strokeStyle = W.toiletTrim;
  ctx.lineWidth = Math.max(0.7, 1.1 * s);
  ctx.strokeRect(-w * 0.11, -h * 0.47, w * 0.22, h * 0.34);
  ctx.fillStyle = '#d8b45a';
  ctx.fillRect(w * 0.05, -h * 0.31, Math.max(0.8, w * 0.035), Math.max(0.8, h * 0.035));

  // hip roof: NW slope lit, SE slope shaded, eave line dark
  const apex = [0, -h];
  const eaveL = [-w * 0.58, -h * 0.72];
  const eaveF = [0, -h * 0.60];
  const eaveR = [w * 0.58, -h * 0.72];
  ctx.fillStyle = W.cottageRoofLit;
  ctx.beginPath();
  ctx.moveTo(apex[0], apex[1]); ctx.lineTo(eaveL[0], eaveL[1]); ctx.lineTo(eaveF[0], eaveF[1]);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = W.cottageRoofShade;
  ctx.beginPath();
  ctx.moveTo(apex[0], apex[1]); ctx.lineTo(eaveF[0], eaveF[1]); ctx.lineTo(eaveR[0], eaveR[1]);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(30,20,10,.45)';
  ctx.lineWidth = Math.max(0.7, 1.1 * s);
  ctx.beginPath();
  ctx.moveTo(eaveL[0], eaveL[1]); ctx.lineTo(eaveF[0], eaveF[1]); ctx.lineTo(eaveR[0], eaveR[1]);
  ctx.stroke();

  // vent pipe on the SE slope
  ctx.fillStyle = W.toiletTrim;
  ctx.fillRect(w * 0.16, -h * 0.92, Math.max(1, w * 0.05), h * 0.16);
}

/**
 * The ablution block, vector path (VIS-02). Same family as drawToilet — timber, a rusted
 * iron roof, a slab — but WIDE: two cubicles and the water tank on its stand, because it
 * serves twelve campers and costs ten compost toilets. This is the pre-decode fallback and
 * the node path; the painted cutout (v7) is what the player normally sees.
 *
 * Footprint 2x1, so the base is a 96 x 48 diamond and the sprite is drawn with its FRONT
 * VERTEX at the origin (the renderer anchors a multi-tile building on its front corner).
 */
function drawAblution(ctx, s, o = {}) {
  const w = 66 * s, h = 34 * s;      // the box, not the slab
  const W = PALETTE.wood;
  const thin = Math.max(0.6, 0.9 * s);

  // the apron: a 2:1 diamond, 96 x 48 design px at s = 1
  const pw = 48 * s, ph = 24 * s;
  ctx.fillStyle = W.slab || 'rgba(150,140,120,.95)';
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(pw, -ph / 2); ctx.lineTo(0, -ph); ctx.lineTo(-pw, -ph / 2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(60,50,36,.45)';
  ctx.lineWidth = thin;
  ctx.stroke();

  const by = -ph * 0.42;             // the slab's centre line is where the box stands

  // the block: front (SW) face flat to camera, side (SE) face sheared back at 2:1
  ctx.fillStyle = W.toilet;
  ctx.fillRect(-w * 0.52, by - h, w * 0.78, h);
  ctx.fillStyle = 'rgba(50,34,18,.24)';
  ctx.beginPath();
  ctx.moveTo(w * 0.26, by - h); ctx.lineTo(w * 0.62, by - h - h * 0.30);
  ctx.lineTo(w * 0.62, by - h * 0.30); ctx.lineTo(w * 0.26, by);
  ctx.closePath(); ctx.fill();

  // two cubicle doors with iron latches
  for (const dx of [-0.44, -0.05]) {
    ctx.fillStyle = W.door;
    ctx.fillRect(w * dx, by - h * 0.80, w * 0.30, h * 0.78);
    ctx.strokeStyle = W.toiletTrim;
    ctx.lineWidth = Math.max(0.7, 1.1 * s);
    ctx.strokeRect(w * dx, by - h * 0.80, w * 0.30, h * 0.78);
    ctx.fillStyle = '#d8b45a';
    ctx.fillRect(w * (dx + 0.23), by - h * 0.46, Math.max(0.8, w * 0.03), Math.max(0.8, h * 0.05));
  }

  // corrugated roof: two slopes, eave line dark
  ctx.fillStyle = W.cottageRoofLit;
  ctx.beginPath();
  ctx.moveTo(-w * 0.62, by - h * 0.98);
  ctx.lineTo(0, by - h * 1.22);
  ctx.lineTo(0, by - h * 1.02);
  ctx.lineTo(-w * 0.62, by - h * 0.80);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = W.cottageRoofShade;
  ctx.beginPath();
  ctx.moveTo(0, by - h * 1.22);
  ctx.lineTo(w * 0.68, by - h * 0.96);
  ctx.lineTo(w * 0.68, by - h * 0.76);
  ctx.lineTo(0, by - h * 1.02);
  ctx.closePath(); ctx.fill();

  // the tank on its stand, at the right end
  const tx = w * 0.44, ty = by - h * 0.30;
  ctx.strokeStyle = W.toiletTrim;
  ctx.lineWidth = Math.max(0.8, 1.2 * s);
  ctx.beginPath();
  ctx.moveTo(tx - w * 0.05, ty); ctx.lineTo(tx - w * 0.05, ty - h * 0.34);
  ctx.moveTo(tx + w * 0.11, ty); ctx.lineTo(tx + w * 0.11, ty - h * 0.34);
  ctx.stroke();
  ctx.fillStyle = '#9aa0a2';
  ctx.fillRect(tx - w * 0.08, ty - h * 0.72, w * 0.22, h * 0.40);
  ctx.fillStyle = 'rgba(255,255,255,.22)';
  ctx.fillRect(tx - w * 0.08, ty - h * 0.72, w * 0.05, h * 0.40);
}

/**
 * side (SE) wall sheared back at 2:1 so the building has volume — that sheared face is
 * what stops the sprite reading as a cardboard cutout at fit zoom.
 *
 * Stone plinth on both faces, boarded or log-course walls, gable roof read as two flat
 * slopes split at a ridge cap (near slope lit + corrugation ribs, far slope shaded),
 * chimney with a smoke cap, framed door with a stone step, two framed windows.
 * `logs` turns it into the cabin (log courses + log ends at the corner).
 *
 * Flat-shaded throughout: the reference's richness comes from hue steps, never gradients.
 */
function drawCottage(ctx, s, o = {}) {
  const w = 60 * s, h = 48 * s;
  const W = PALETTE.wood;
  const wall = o.tint || W.cottageWall;
  const wallSide = shade(wall, 0.80);
  const bw = w * 0.42;             // front wall half-width
  const dx = w * 0.16, dy = -dx * 0.5;   // the side wall's 2:1 recession
  const wh = h * 0.58;             // wall height (eave line)
  const plinth = h * 0.065;

  const poly = (pts) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  };

  shadow(ctx, w * 0.56, h * 0.10, 0.30, 0.28, 0.32);

  /* ---- side wall + its plinth, drawn first so the front wall closes the corner ---- */
  ctx.fillStyle = W.stoneDark;
  poly([[bw, -plinth], [bw + dx, dy - plinth], [bw + dx, dy], [bw, 0]]);
  ctx.fillStyle = wallSide;
  poly([[bw, -wh], [bw + dx, dy - wh], [bw + dx, dy - plinth], [bw, -plinth]]);

  /* ---- front plinth: a course of blocks, lit top edge, shaded base ---- */
  ctx.fillStyle = W.stone;
  poly([[-bw, 0], [bw, 0], [bw, -plinth], [-bw, -plinth]]);
  ctx.fillStyle = W.stone;
  ctx.fillStyle = W.stoneLit;
  ctx.fillRect(-bw, -plinth, bw * 2, h * 0.013);
  ctx.fillStyle = 'rgba(30,26,20,.30)';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(-bw * 0.92 + i * bw * 0.48, -plinth + h * 0.017, bw * 0.28, h * 0.018);
  }
  ctx.fillStyle = 'rgba(20,16,10,.34)';
  ctx.fillRect(-bw, -h * 0.010, bw * 2, h * 0.010);

  /* ---- walls ---- */
  ctx.fillStyle = wall;
  ctx.fillRect(-bw, -wh, bw * 2, wh - plinth);
  // corner post: the vertical edge where the two faces meet
  ctx.fillStyle = 'rgba(40,24,10,.22)';
  ctx.fillRect(bw - bw * 0.055, -wh, bw * 0.055, wh - plinth);
  ctx.fillRect(-bw, -wh, bw * 0.05, wh - plinth);

  if (o.logs) {
    // log courses on both faces: a dark seam and a lit top edge under every log
    const courses = 6;
    for (let i = 1; i <= courses; i++) {
      const y = -wh + (wh - plinth) * (i / (courses + 1));
      ctx.fillStyle = 'rgba(28,18,8,.30)';
      ctx.fillRect(-bw, y, bw * 2, Math.max(0.7, 1.0 * s));
      ctx.fillStyle = 'rgba(238,206,158,.13)';
      ctx.fillRect(-bw, y - h * 0.019, bw * 2, Math.max(0.6, 0.9 * s));
      ctx.strokeStyle = 'rgba(28,18,8,.26)';
      ctx.lineWidth = Math.max(0.6, 0.9 * s);
      ctx.beginPath();
      ctx.moveTo(bw, y); ctx.lineTo(bw + dx, y + dy);
      ctx.stroke();
    }
    // log ends stacked at the corner — the detail that says "stacked timber"
    ctx.fillStyle = W.cottageWallDark;
    for (let i = 0; i < courses; i++) {
      const y = -wh + (wh - plinth) * ((i + 0.5) / courses);
      ctx.beginPath();
      ctx.ellipse(bw - bw * 0.02, y, bw * 0.045, h * 0.015, 0, 0, TAU);
      ctx.fill();
    }
  } else {
    // board-and-batten: thinner seams, no log ends
    ctx.strokeStyle = 'rgba(60,38,18,.22)';
    ctx.lineWidth = Math.max(0.5, 0.8 * s);
    ctx.beginPath();
    for (let i = 1; i < 5; i++) {
      const y = -wh + (wh - plinth) * (i / 5);
      ctx.moveTo(-bw, y); ctx.lineTo(bw, y);
    }
    ctx.stroke();
  }

  /* ---- side window: sheared onto the SE face ---- */
  const sideAt = (t, y) => [bw + dx * t, y + dy * t];
  const sWin = [sideAt(0.12, -h * 0.455), sideAt(0.88, -h * 0.455), sideAt(0.88, -h * 0.295), sideAt(0.12, -h * 0.295)];
  ctx.fillStyle = W.cottageWindow;
  poly(sWin);
  ctx.strokeStyle = 'rgba(236,214,172,.55)';
  ctx.lineWidth = Math.max(0.7, 1.1 * s);
  ctx.beginPath();
  ctx.moveTo(sWin[0][0], sWin[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(sWin[i][0], sWin[i][1]);
  ctx.closePath();
  ctx.stroke();
  const sm1 = sideAt(0.5, -h * 0.455), sm2 = sideAt(0.5, -h * 0.295);
  ctx.beginPath();
  ctx.moveTo(sm1[0], sm1[1]); ctx.lineTo(sm2[0], sm2[1]);
  ctx.stroke();

  /* ---- front window: framed, cross mullion, sill ---- */
  const fx = -bw * 0.78, fw = bw * 0.34, fy = -h * 0.47, fh = h * 0.16;
  ctx.fillStyle = W.cottageWindow;
  ctx.fillRect(fx, fy, fw, fh);
  ctx.fillStyle = 'rgba(196,214,206,.20)';
  ctx.fillRect(fx + fw * 0.10, fy + fh * 0.10, fw * 0.30, fh * 0.34);
  ctx.strokeStyle = 'rgba(236,214,172,.60)';
  ctx.lineWidth = Math.max(0.8, 1.2 * s);
  ctx.strokeRect(fx, fy, fw, fh);
  ctx.beginPath();
  ctx.moveTo(fx + fw * 0.5, fy); ctx.lineTo(fx + fw * 0.5, fy + fh);
  ctx.moveTo(fx, fy + fh * 0.48); ctx.lineTo(fx + fw, fy + fh * 0.48);
  ctx.stroke();
  ctx.fillStyle = W.stoneLit;
  ctx.fillRect(fx - fw * 0.10, fy + fh, fw * 1.20, h * 0.014);

  /* ---- door: frame, panels, handle, stone step ---- */
  const dw = bw * 0.38, dh = h * 0.26, dx0 = -bw * 0.20, doorTop = -h * 0.335;
  ctx.fillStyle = W.cottageDoor;
  ctx.fillRect(dx0, doorTop, dw, dh);
  ctx.strokeStyle = 'rgba(232,192,132,.45)';
  ctx.lineWidth = Math.max(0.8, 1.2 * s);
  ctx.strokeRect(dx0, doorTop, dw, dh);
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.fillRect(dx0 + dw * 0.14, doorTop + dh * 0.10, dw * 0.72, dh * 0.30);
  ctx.fillRect(dx0 + dw * 0.14, doorTop + dh * 0.52, dw * 0.72, dh * 0.30);
  ctx.fillStyle = '#d8b45a';
  ctx.fillRect(dx0 + dw * 0.80, doorTop + dh * 0.46, Math.max(0.9, w * 0.016), Math.max(0.9, w * 0.016));
  // step: a stone slab proud of the plinth, with its own cast shadow
  ctx.fillStyle = W.stoneLit;
  poly([[dx0 - dw * 0.22, -h * 0.012], [dx0 + dw * 1.22, -h * 0.012], [dx0 + dw * 1.22, -h * 0.042], [dx0 - dw * 0.22, -h * 0.042]]);
  ctx.fillStyle = 'rgba(20,16,10,.28)';
  ctx.fillRect(dx0 - dw * 0.22, -h * 0.012, dw * 1.44, h * 0.010);

  /* ---- roof: far slope above the ridge, near slope below it, both sheared on the right ---- */
  const rwN = w * 0.50, rwR = w * 0.40, rwF = w * 0.36;
  const yE = -h * 0.60, yR = -h * 0.845, yF = -h * 0.955;

  // far slope (shaded): the sliver of roof you see over the ridge
  ctx.fillStyle = W.cottageRoofShade;
  poly([[-rwR, yR], [rwR, yR], [rwR + dx, yR + dy], [rwF + dx, yF + dy], [rwF, yF], [-rwF, yF]]);
  ctx.fillStyle = 'rgba(16,10,4,.34)';
  poly([[rwR, yR], [rwR + dx, yR + dy], [rwF + dx, yF + dy], [rwF, yF]]);

  // near slope (lit), sheared along its right edge so the roof turns the corner
  ctx.fillStyle = W.cottageRoofLit;
  poly([[-rwR, yR], [rwR, yR], [rwR + dx, yR + dy], [rwN + dx, yE + dy], [rwN, yE], [-rwN, yE]]);

  // corrugation: ribs fanning from ridge to eave
  ctx.strokeStyle = W.roofRib;
  ctx.lineWidth = Math.max(0.6, 0.9 * s);
  ctx.beginPath();
  for (let i = -4; i <= 4; i++) {
    const xr = (i / 4) * rwR * 0.94, xe = (i / 4) * rwN * 0.95;
    ctx.moveTo(xr, yR + h * 0.008);
    ctx.lineTo(xe, yE - h * 0.004);
    if (i > 2) {
      ctx.moveTo(xr + dx, yR + h * 0.008 + dy);
      ctx.lineTo(xe + dx, yE - h * 0.004 + dy);
    }
  }
  ctx.stroke();

  // ridge cap: a lit bar over a dark seam — the two slopes must split at a line
  ctx.fillStyle = W.roofRidge;
  poly([[-rwR * 1.02, yR - h * 0.020], [rwR * 1.02, yR - h * 0.020],
    [rwR * 1.02 + dx, yR - h * 0.020 + dy], [-rwR * 1.02 + dx, yR - h * 0.020 + dy]]);
  ctx.fillStyle = W.roofEdge;
  ctx.fillRect(-rwR * 1.02, yR + h * 0.002, rwR * 2.04, Math.max(0.8, 1.1 * s));

  // gable end on the right: the roof's cut face, a shade under the near slope, with a
  // dark edge along the outer corner so the roof turns rather than stops
  ctx.fillStyle = shade(W.cottageRoofLit, 0.62);
  poly([[rwN, yE], [rwN + dx, yE + dy], [rwR + dx, yR + dy], [rwR, yR]]);
  ctx.strokeStyle = W.roofEdge;
  ctx.lineWidth = Math.max(0.8, 1.2 * s);
  ctx.beginPath();
  ctx.moveTo(rwN, yE); ctx.lineTo(rwN + dx, yE + dy); ctx.lineTo(rwR + dx, yR + dy);
  ctx.stroke();

  // eave board + the shadow it throws on the wall
  ctx.fillStyle = W.roofEdge;
  ctx.fillRect(-rwN, yE, rwN * 2, h * 0.017);
  ctx.fillStyle = 'rgba(16,10,4,.26)';
  ctx.fillRect(-bw, yE + h * 0.017, bw * 2, h * 0.05);

  /* ---- chimney: stone stack above the ridge, capped, with flat smoke ---- */
  const chx = rwR * 0.52, chw = w * 0.072, chTop = -h * 0.995;
  ctx.fillStyle = W.stone;
  ctx.fillRect(chx, chTop, chw, h * 0.23);
  ctx.fillStyle = W.stoneLit;
  ctx.fillRect(chx, chTop, chw * 0.32, h * 0.23);
  ctx.fillStyle = 'rgba(24,20,14,.35)';
  ctx.fillRect(chx, chTop + h * 0.072, chw, Math.max(0.6, 0.9 * s));
  ctx.fillRect(chx, chTop + h * 0.145, chw, Math.max(0.6, 0.9 * s));
  // smoke cap: a dark slab wider than the stack, so the chimney reads as capped
  ctx.fillStyle = W.roofEdge;
  poly([[chx - chw * 0.18, chTop], [chx + chw * 1.18, chTop],
    [chx + chw * 1.18 + chw * 0.35, chTop + chw * 0.18], [chx - chw * 0.18 + chw * 0.35, chTop + chw * 0.18]]);
  ctx.fillStyle = W.stoneDark;
  ctx.fillRect(chx - chw * 0.18, chTop + chw * 0.10, chw * 1.36, h * 0.016);
  // smoke: three flat puffs drifting SE
  ctx.fillStyle = W.smoke;
  for (const [px, py, r] of [[0.55, -0.045, 0.030], [0.86, -0.078, 0.024], [1.12, -0.104, 0.017]]) {
    ctx.beginPath();
    ctx.ellipse(chx + chw * px, chTop + h * py, w * r, w * r * 0.80, 0, 0, TAU);
    ctx.fill();
  }
}

/** Construction site: dashed survey diamond, stakes with a cast shadow each. */
function drawUnbuilt(ctx, s, o = {}) {
  const w = 52 * s, h = 26 * s;
  ctx.fillStyle = 'rgba(0,0,0,.16)';
  ctx.beginPath();
  ctx.ellipse(w * 0.10, h * 0.10, w * 0.46, h * 0.34, 0, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = 'rgba(235,205,142,.95)';
  ctx.lineWidth = Math.max(1, 1.6 * s);
  ctx.setLineDash([4 * s, 3 * s]);
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.5); ctx.lineTo(w * 0.5, 0); ctx.lineTo(0, h * 0.5); ctx.lineTo(-w * 0.5, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  for (const [dx, dy] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
    const x = dx * w, y = dy * h;
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    ctx.ellipse(x + 1.6 * s, y + 1.2 * s, 2.6 * s, 1.4 * s, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(199,166,108,.95)';
    ctx.beginPath();
    ctx.arc(x, y, 1.8 * s, 0, TAU);
    ctx.fill();
  }
}

/** Gate: two posts, two rails, a diagonal brace and a latch — the way in. */
function drawGate(ctx, s, o = {}) {
  const w = 59 * s, h = 35 * s;
  const W = PALETTE.wood;
  shadow(ctx, w * 0.5, h * 0.09, 0.24, 0.26, 0.24);

  ctx.fillStyle = W.gatePost;
  ctx.fillRect(-w * 0.42, -h, w * 0.12, h);
  ctx.fillRect(w * 0.30, -h, w * 0.12, h);
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  ctx.fillRect(-w * 0.42, -h, w * 0.04, h);
  ctx.fillRect(w * 0.30, -h, w * 0.04, h);

  ctx.fillStyle = W.gateRail;
  ctx.fillRect(-w * 0.46, -h * 0.80, w * 0.92, h * 0.15);
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.fillRect(-w * 0.46, -h * 0.65, w * 0.92, h * 0.05);
  ctx.fillStyle = W.gateRail;
  ctx.fillRect(-w * 0.46, -h * 0.46, w * 0.92, h * 0.13);

  // diagonal brace between the rails
  ctx.strokeStyle = 'rgba(120,86,40,.85)';
  ctx.lineWidth = Math.max(0.8, 1.6 * s);
  ctx.beginPath();
  ctx.moveTo(-w * 0.38, -h * 0.42);
  ctx.lineTo(w * 0.36, -h * 0.78);
  ctx.stroke();

  // latch
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fillRect(-w * 0.02, -h * 0.62, w * 0.10, h * 0.09);
}

/* -------------------------------------------------------------- props */

/**
 * Logs: a stack of three cut logs — bark body, lit top strip, pale ringed cut face at the
 * near end. Decoration only (no sim meaning); the renderer may sprinkle it on grass.
 */
function drawLogs(ctx, s, o = {}) {
  const P = PALETTE.prop;
  const W = 46 * s, H = 28 * s;

  shadow(ctx, W * 0.32, H * 0.10, 0.28, 0.30, 0.30);

  const log = (cx, cy, len, r) => {
    const x0 = cx - len * 0.5, x1 = cx + len * 0.5;
    ctx.fillStyle = P.bark;
    ctx.fillRect(x0, cy - r, len, r * 2);
    ctx.fillStyle = P.barkLit;
    ctx.fillRect(x0, cy - r, len, r * 0.42);
    ctx.fillStyle = P.barkDark;
    ctx.fillRect(x0, cy + r * 0.60, len, r * 0.40);
    // cut face on the near end: pale disc, one growth ring, dark core
    ctx.fillStyle = P.cutFace;
    ctx.beginPath();
    ctx.ellipse(x1, cy, r * 0.60, r, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = P.cutRing;
    ctx.lineWidth = Math.max(0.6, 0.9 * s);
    ctx.beginPath();
    ctx.ellipse(x1, cy, r * 0.30, r * 0.56, 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = P.cutCore;
    ctx.beginPath();
    ctx.ellipse(x1, cy, r * 0.10, r * 0.18, 0, 0, TAU);
    ctx.fill();
    // far end rounded so the log is a cylinder, not a plank
    ctx.fillStyle = P.bark;
    ctx.beginPath();
    ctx.ellipse(x0, cy, r * 0.46, r, 0, 0, TAU);
    ctx.fill();
  };

  const r = 4.5 * s;
  log(-W * 0.06, -r * 1.10, W * 0.74, r);
  log(W * 0.07, -r * 2.55, W * 0.66, r);
  log(-W * 0.01, -r * 3.95, W * 0.56, r);
}

/**
 * Rocks: a cluster of three field stones — each a flat-faceted lump with a lit NW face,
 * a shaded SE face and a moss speck. Decoration only.
 */
function drawRocks(ctx, s, o = {}) {
  const P = PALETTE.prop;
  const W = 34 * s;

  shadow(ctx, W * 0.36, W * 0.13, 0.26, 0.30, 0.28);

  const stone = (cx, cy, rx, ry) => {
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy + ry * 0.18);
    ctx.lineTo(cx - rx * 0.52, cy - ry * 0.86);
    ctx.lineTo(cx + rx * 0.26, cy - ry);
    ctx.lineTo(cx + rx, cy - ry * 0.22);
    ctx.lineTo(cx + rx * 0.68, cy + ry * 0.82);
    ctx.lineTo(cx - rx * 0.22, cy + ry);
    ctx.closePath();
    ctx.fillStyle = P.stone;
    ctx.fill();

    // lit NW facet
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy + ry * 0.18);
    ctx.lineTo(cx - rx * 0.52, cy - ry * 0.86);
    ctx.lineTo(cx + rx * 0.26, cy - ry);
    ctx.lineTo(cx + rx * 0.02, cy - ry * 0.10);
    ctx.closePath();
    ctx.fillStyle = P.stoneLit;
    ctx.fill();

    // shaded SE facet
    ctx.beginPath();
    ctx.moveTo(cx + rx, cy - ry * 0.22);
    ctx.lineTo(cx + rx * 0.68, cy + ry * 0.82);
    ctx.lineTo(cx - rx * 0.22, cy + ry);
    ctx.lineTo(cx + rx * 0.16, cy + ry * 0.08);
    ctx.closePath();
    ctx.fillStyle = P.stoneDark;
    ctx.fill();
  };

  stone(-W * 0.22, -W * 0.13, W * 0.16, W * 0.13);
  stone(W * 0.26, -W * 0.11, W * 0.12, W * 0.10);
  stone(W * 0.01, -W * 0.30, W * 0.25, W * 0.21);

  // moss on the big stone — one green speck is what keeps grey from reading as concrete
  ctx.fillStyle = P.moss;
  ctx.beginPath();
  ctx.ellipse(-W * 0.10, -W * 0.42, W * 0.045, W * 0.022, 0, 0, TAU);
  ctx.fill();
}

/** Flowers: a leafy clump with small blooms clustered at the stem tips. Decoration only. */
function drawFlowerPatch(ctx, s, o = {}) {
  const P = PALETTE.prop;
  const W = 28 * s;

  // leaf bed: overlapping lobes, the front ones a step darker
  ctx.fillStyle = P.bladeMid;
  for (const [dx, dy, rx, ry] of [[-0.18, -0.07, 0.19, 0.070], [-0.02, -0.10, 0.21, 0.078], [0.16, -0.07, 0.17, 0.062]]) {
    ctx.beginPath();
    ctx.ellipse(dx * W, dy * W, rx * W, ry * W, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = P.bladeDark;
  for (const [dx, dy, rx, ry] of [[0.04, -0.03, 0.22, 0.055], [-0.16, -0.02, 0.13, 0.045]]) {
    ctx.beginPath();
    ctx.ellipse(dx * W, dy * W, rx * W, ry * W, 0, 0, TAU);
    ctx.fill();
  }

  // stems fanning out of the clump
  const stems = [[-0.26, -0.34, -0.34], [-0.10, -0.13, -0.46], [0.04, 0.03, -0.40],
    [0.18, 0.24, -0.34], [0.30, 0.38, -0.26]];
  ctx.strokeStyle = P.bladeDark;
  ctx.lineWidth = Math.max(0.55, 0.75 * s);
  ctx.beginPath();
  for (const [bx, tx, ty] of stems) {
    ctx.moveTo(bx * W, -W * 0.06);
    ctx.lineTo(tx * W, ty * W);
  }
  ctx.stroke();

  // blooms: two or three small dots per head — a single big dot per stem reads as a
  // lollipop, a cluster reads as a flower
  const cols = [P.flowerA, P.flowerC, P.flowerB];
  stems.forEach(([, tx, ty], i) => {
    ctx.fillStyle = cols[i % 3];
    for (const [ox, oy, r] of [[0, 0, 0.030], [-0.036, 0.016, 0.021], [0.031, 0.013, 0.019]]) {
      ctx.beginPath();
      ctx.arc((tx + ox) * W, (ty + oy) * W, Math.max(0.7, r * W), 0, TAU);
      ctx.fill();
    }
  });
}

/** Grass tuft: a clump of thin blades rising from one root, dark at the base, lit at the tip. */
function drawGrassTuft(ctx, s, o = {}) {
  const P = PALETTE.prop;
  const W = 20 * s;
  const blades = [
    [-0.30, -0.56, -0.56], [-0.16, -0.30, -0.82], [-0.04, -0.06, -0.96],
    [0.12, 0.22, -0.86], [0.26, 0.48, -0.60], [0.36, 0.60, -0.36],
    [-0.08, -0.16, -0.70], [0.06, 0.10, -0.72],
  ];

  ctx.fillStyle = P.bladeDark;
  ctx.beginPath();
  ctx.ellipse(0, -W * 0.03, W * 0.20, W * 0.05, 0, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = P.bladeDark;
  ctx.lineWidth = Math.max(0.6, 1.0 * s);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [bx, tx, ty] of blades) {
    ctx.moveTo(bx * W * 0.45, 0);
    ctx.quadraticCurveTo(bx * W * 0.85, ty * W * 0.50, tx * W, ty * W);
  }
  ctx.stroke();

  // lit tips: the upper half of the front blades, a step lighter
  ctx.strokeStyle = P.bladeLit;
  ctx.lineWidth = Math.max(0.5, 0.75 * s);
  ctx.beginPath();
  for (const [bx, tx, ty] of blades.slice(0, 5)) {
    ctx.moveTo((bx * 0.72 + tx * 0.28) * W, ty * W * 0.46);
    ctx.quadraticCurveTo(tx * W * 0.94, ty * W * 0.74, tx * W, ty * W);
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/* -------------------------------------------------------------- registry */

// bounds: [x0, x1, y0, y1] — actual content extent in design px relative to the
// base-centre origin (y negative = up), shadow included. Canopies and ground shadows
// reach past the registered w/h; the bake needs the real box or it clips. Measured from
// the draw functions, not guessed — the atlas manifest exports these as the tile rect.
//
// SCALE PASS (owner: "not near the promised 2D quality"): every object is sized against
// the 64×32 tile, per the reference screenshot — a mature pine is 120 px tall (1.9 tiles
// wide, ~4 tiles tall), a cabin is 150 px wide (2.3 tiles), props stay under a tile. The
// base anchor (ax/ay = base centre) is unchanged, so the renderer's placement still holds.
export const SPRITES = {
  pine: { w: 56, h: 112, draw: drawPine, salt: 5, variants: 4, bounds: [-30, 30, -114, 3] },
  indigenous: { w: 100, h: 130, draw: drawIndigenous, salt: 7, variants: 4, bounds: [-51, 51, -132, 4] },
  // --- T15 (10-23): the three things a guest is scored on that were still vector ------
  // These are NOT ACCOM kinds. `tank` and `toilet` are `p.buildings` entries (one tile
  // each, plotmap.js:914) and `bed` is `h.beds`, so the renderer draws them by tile, not
  // by footprint, and the pipeline declares their 1x1 rather than reading tourism.js.
  //
  // The item the brief asked for and that is deliberately NOT here is the ablution block.
  // FACILITY.ablution is a boolean on h.facilities: it costs H$12,000, it is what
  // ACCOM.camp.needs, and it charges PENALTY.ablution 2.0 stars when missing ("guests are
  // using the bush"), but it never puts anything on the map. There is no surface to paint
  // onto, and a sprite nothing draws is the dead-art defect this seat has now flagged
  // three times (wattle/blackwood, the oak winter cutout, the [2,1] caravan). Request filed.
  bed: {
    w: 64, h: 44,
    // The cutout is worked soil with three dry furrows and NO crop in it, because a
    // painted seedling would show a bed as further along than it is. So the crop is
    // always vector, drawn on top - and that is true for all four FARMING-SPEC stages,
    // not just `ready`. Without this branch the switch to a painted bed would flatten a
    // twenty-day countdown into two pictures.
    draw: (c, s, o) => {
      const stage = o.stage != null ? o.stage : (o.ready ? 3 : 0);
      if (imageState.bed === 'ready') {
        // ANCHOR. iso-render translates to `_at(x, y)`, the tile CENTRE, which is what
        // `drawBed` assumes (it centres its diamond on the origin). `drawImageSprite`
        // instead draws the bitmap from `-dh..0`, i.e. its BOTTOM at the origin - so
        // unpunctuated, the plate's front corner landed on the tile's CENTRE and the
        // whole bed sat half a tile north-west of the ground it claims.
        //
        // This was wrong since the bed was first painted (T15) and nothing caught it:
        // the geometry gate measures the bitmap, not its placement, and the crop overlay
        // was lifted by the same amount, so the two agreed WITH EACH OTHER and disagreed
        // with the tile. What finally exposed it was measuring a stage-0 (bare soil) bed
        // INSIDE its own footprint and finding it 68% green-dominant - grass, not soil.
        //
        // So: drop the bitmap by half a tile height to put its bottom on the front corner,
        // and draw the crop with NO offset, because bedPt is already centre-relative.
        c.save(); c.translate(0, (TH / 2) * s); drawImageSprite(c, 'bed', s, 0.5); c.restore();
        bedCrop(c, s, stage, o.crop);
        return;
      }
      drawBed(c, s, o);
    },
    bounds: [-27, 27, -16, 10],
  },
  hive: {
    w: 31, h: 36,
    // painted 10-29 (PLAYER-READINESS gate 3, owner: "hives still vector"): the Mistbelt
    // garden pack's obj_beehive, which was keyed at source, fitted to the SAME 36 design px
    // as the vector below so a hive does not change size on the tile the round it becomes a
    // cutout. drawHive stays the node and pre-decode path, and it is what every gate sees.
    draw: (c, s, o) => {
      if (imageState.hive === 'ready') { drawImageSprite(c, 'hive', s, 0.5); return; }
      drawHive(c, s, o);
    },
    bounds: [-27, 27, -38, 6],
  },
  tank: {
    w: 64, h: 64,
    draw: (c, s, o) => {
      if (imageState.tank === 'ready') { drawImageSprite(c, 'tank', s, 0.5); return; }
      drawTank(c, s, o);
    },
    bounds: [-23, 33, -64, 7],
  },
  toilet: {
    w: 64, h: 76,
    draw: (c, s, o) => {
      if (imageState.toilet === 'ready') { drawImageSprite(c, 'toilet', s, 0.5); return; }
      drawToilet(c, s, o);
    },
    bounds: [-22, 27, -40, 7],
  },
  // THE ABLUTION BLOCK (VIS-02, owner's ranked fix list 10-25). It was the one facility
  // with no sprite AND no surface — a boolean that gated the camp and cost H$12,000, and
  // put nothing on the map. Both halves are fixed: tourism.js FACILITY_SITE gives it two
  // tiles when it is bought, and this is what those tiles draw.
  // 2x1, so its apron is a (2+1)*32 = 96 px diamond, and the renderer anchors a
  // multi-tile plot building on its FRONT CORNER exactly as it does an accom unit.
  ablution: {
    w: 96, h: 60,
    draw: (c, s, o) => {
      if (imageState.ablution === 'ready') { drawImageSprite(c, 'ablution', s, 0.5); return; }
      drawAblution(c, s, o);
    },
    bounds: [-48, 48, -62, 6],
  },
  // THE SPRITE KEY IS THE SIM KIND IT SERVES (owner delegated the naming, 10-22).
  // iso-render.js draws `a.kind` straight off this registry, so there is no mapping
  // table left to drift. The old names meant three different things by "cottage" and
  // two by "cabin": cottage.png drew the player's HOME while cabin.png drew the H$240k
  // top rung as a small log hut, so the most expensive building on the property looked
  // like the cheapest. `house` is the home, `cabin` is the two-bed that beats it.
  house: {
    w: 132, h: 122,
    // the painted house once decoded (v 0.5 = no mirroring, buildings must not flip);
    // the vector cottage stays the node/fallback path.
    // No shadow() on the painted path: the cutout carries its own base plate, and now
    // that the plate is fitted to the footprint the ellipse only peeks out past its
    // lower-left edge as a dark blob. The vector box has no ground of its own, so it
    // still needs one.
    draw: (c, s, o) => {
      if (imageState.house === 'ready') { drawImageSprite(c, 'house', s, 0.5); return; }
      shadow(c, 60 * s, 20 * s, 0.10, 0.10, 0.30);
      drawCottage(c, s * 1.58, o);
    },
    bounds: [-68, 68, -139, 4],
  },
  cabin: {
    w: 132, h: 113,
    draw: (c, s, o) => {
      if (imageState.cabin === 'ready') { drawImageSprite(c, 'cabin', s, 0.5); return; }
      shadow(c, 58 * s, 19 * s, 0.10, 0.10, 0.30);
      drawCottage(c, s * 1.95, { ...o, tint: PALETTE.wood.cottageWallDark, logs: true });
    },
    bounds: [-72, 72, -140, 4],
  },
  // the caravan stand: one van, one gravel pad, two guests. ACCOM.caravan. The sim moved
  // it from [2,1] to [2,2] (lead 94c1cc2) because a real van does not fit 2x1 - the art
  // was always right, the footprint was not, and the pipeline now reads the size from
  // tourism.js rather than duplicating it, so that change needed no edit on the art side.
  caravan: {
    w: 128, h: 64,
    draw: (c, s, o) => {
      if (imageState.caravan === 'ready') { drawImageSprite(c, 'caravan', s, 0.5); return; }
      drawUnbuilt(c, s * 2.5, o);
    },
    bounds: [-68, 68, -66, 6],
  },
  // the camping site: two pitches, a braai, a standpipe. ACCOM.camp, footprint [4,3],
  // so its ground diamond is (4+3)*32 = 224 px wide - the first NON-SQUARE sprite in the
  // game, which is what lead L6's anchor correction was for. Painted ground and footprint
  // are the same diamond here, so the camp cannot spill past the twelve tiles it claims.
  // Needs the ablution block before it can be listed at all (tourism.ACCOM.camp.needs).
  camp: {
    w: 224, h: 106,
    draw: (c, s, o) => {
      if (imageState.camp === 'ready') { drawImageSprite(c, 'camp', s, 0.5); return; }
      drawUnbuilt(c, s * 4.2, o);
    },
    bounds: [-112, 112, -108, 6],
  },
  // the garden room: one bed, one tile (ACCOM.room, footprint [1,1] = a 64 px diamond)
  room: {
    w: 64, h: 60,
    draw: (c, s, o) => {
      if (imageState.room === 'ready') { drawImageSprite(c, 'room', s, 0.5); return; }
      shadow(c, 28 * s, 11 * s, 0.10, 0.10, 0.30);
      drawCottage(c, s * 0.85, o);
    },
    bounds: [-34, 34, -70, 4],
  },
  unbuilt: { w: 52, h: 26, draw: drawUnbuilt, bounds: [-28, 28, -15, 15] },
  // construction stages (owner 21-10): two painted stages shared by any 2x2 site —
  // early (pegs, foundation, timber stacked) and late (frame up, rafters, scaffold).
  // The renderer picks by days remaining; the vector 'unbuilt' stays the fallback.
  site_early: {
    w: 132, h: 115,
    draw: (c, s, o) => {
      if (imageState.site_early === 'ready') { drawImageSprite(c, 'site_early', s, 0.5); return; }
      drawUnbuilt(c, s * 2.5, o);
    },
    bounds: [-71, 71, -88, 4],
  },
  site_late: {
    w: 132, h: 125,
    draw: (c, s, o) => {
      if (imageState.site_late === 'ready') { drawImageSprite(c, 'site_late', s, 0.5); return; }
      drawUnbuilt(c, s * 2.5, o);
    },
    bounds: [-68, 68, -129, 4],
  },
  gate: {
    // v6 art (owner 10-25: the v5 cutout was diagonal — its ground contact sat at frame
    // x 0-16 against a bottom-centre anchor, so the gate landed half a tile off; and it
    // was PORTRAIT, 40x67, which no gate is). The v6 cutout is a proper gate: 40x20
    // design, wider than tall, post feet centred (contact x 2-77 of 80). The generator's
    // verify-anchor pass re-centres the contact band, so this can't regress silently.
    w: 40, h: 20,
    // painted since 10-22: two weathered posts, a five-bar gate on iron hinges, chain and
    // padlock. The vector gate below read as a bench laid across the road. No ground
    // plate on either path - the gate stands ON the surface the bake just laid, so a
    // plate would cover the drive the player paid for.
    draw: (c, s, o) => {
      if (imageState.gate === 'ready') { drawImageSprite(c, 'gate', s, 0.5); return; }
      drawGate(c, s, o);
    },
    bounds: [-24, 24, -24, 4],
  },
  // wattle + blackwood (night 3): registry-only — the sim's tree kinds (holding.js /
  // plotmap.js) still emit pine|indigenous; sim wiring is a separate GO.
  wattle: { w: 85, h: 86, draw: drawWattle, salt: 11, variants: 4, bounds: [-45, 45, -88, 4] },
  blackwood: { w: 76, h: 100, draw: drawBlackwood, salt: 13, variants: 4, bounds: [-40, 40, -102, 3] },
  // the alien ornamental (sim kind 'oak', plotmap.js). Wider than tall — the only
  // species here whose bounds are — and STAGED (sapling/young/mature), so the art
  // carries the size exactly like indigenous. Painted cutouts since 10-22 (oak /
  // oak_young / oak_sapling / oak_bare); the vector drawOak below stays the node and
  // pre-decode fallback. Bounds are the union of both paths.
  oak: { w: 132, h: 96, draw: drawOak, salt: 17, variants: 4, bounds: [-66, 66, -100, 5] },
  // ground props (scale pass): decoration with no sim meaning — the renderer may
  // sprinkle these on grass cells to make the ground feel inhabited.
  logs: {
    // painted 10-29 (PLAYER-READINESS gate 3, owner: "props need sprites"), and it earns its
    // keep twice: the same cutout is what felling should leave on the ground once the sim
    // grows p.stumps. Fit by WIDTH to the 46 design px the vector claimed, so the painted
    // pile occupies the same ground the flat one did; the height grew 28 -> 36 because the
    // painting has a third log, so `bounds` grew with it or the atlas bake would clip it.
    // The variant is derived from the cell seed the sprinkler already passes, so one pile in
    // six is mirrored - the same jitter drawSprite uses, not a second source of variation.
    w: 46, h: 36,
    draw: (c, s, o) => {
      if (imageState.logs === 'ready') {
        const v = (o && o.seedX !== undefined) ? jitter(o.seedX | 0, o.seedY | 0, 43) : 0.5;
        drawImageSprite(c, 'logs', s, v);
        return;
      }
      drawLogs(c, s, o);
    },
    bounds: [-25, 25, -38, 5],
  },
  rocks: { w: 34, h: 22, draw: drawRocks, bounds: [-19, 19, -23, 4] },
  flowerPatch: { w: 28, h: 16, draw: drawFlowerPatch, bounds: [-16, 16, -17, 2] },
  grassTuft: { w: 20, h: 14, draw: drawGrassTuft, bounds: [-12, 12, -15, 2] },
};

/* ------------------------------------------------- bounds vs the painted box
// `bounds` is the atlas bake box: bakeEntry sizes its canvas from it, so anything a
// draw paints outside is hard-clipped. It was measured by hand off the VECTOR draws and
// never revisited when the painted cutouts took over, and the two do not agree — the
// pipeline re-sizes a bitmap every regeneration (base-fit, side-slim, re-centre) while
// the hand-written box stayed put. Measured with tools/building-probe.py: 9 of the 17
// painted sprites were being cut, the buildings worst — the cottage lost 56 design px
// off the top (the whole brick flue and the roof ridge), the early site 29 x 39 px
// (both corner pegs and the string line). Re-painting the art could never fix that,
// which is why three regeneration rounds left the owner still unhappy.
// So the box is now DERIVED: for every image-backed sprite, the union of the vector
// bounds and the worst-case painted extent. Regenerating art can no longer clip itself.
// The blit offset comes out of the same box (ax/ay), so widening it moves nothing —
// it only stops the cut. */
const IMG_WS = 1.04;   // drawImageSprite width wobble, worst case (v = 0)
const IMG_HS = 1.06;   // ...and height wobble (v = 1)
for (const [name, spec] of Object.entries(SPRITE_IMAGE_SPECS)) {
  const sp = SPRITES[name];
  if (!sp) continue;               // stage sprites draw through their parent kind
  const halfW = (spec.w * IMG_WS) / 2, top = -spec.h * IMG_HS;
  sp.bounds = [
    Math.min(sp.bounds[0], -halfW),
    Math.max(sp.bounds[1], halfW),
    Math.min(sp.bounds[2], top),
    sp.bounds[3],
  ];
  // Same trap, same answer: the registry's design w/h were hand-typed too, and they are
  // what tools/atlas.html writes into the Godot manifest as `design`. A stale number
  // there does not break the browser (bounds drive the bake) but it ships a wrong tile
  // size into the port. Derived from the spec, so it cannot drift again.
  sp.w = spec.w;
  sp.h = spec.h;
}

/* ------------------------------------------------------- the kind -> sprite rule
// The registry key IS the sim kind, so the renderer has no mapping table to keep in
// step with tourism.js. Kinds with no sprite of their own yet (camp [4,3], caravan
// [2,1] - both blocked on the non-square anchor, see tools/make-sprite-assets.py) fall
// back to the house rather than drawing nothing: an invisible building is worse than a
// wrong one, because the player cannot tell they own it. `spare` has footprint [0,0] and
// is never placed, so it must NOT resolve to a sprite - the renderer skips it. */
export function accomSprite(kind) {
  return SPRITES[kind] ? kind : 'house';
}

/* --------------------------------------------------- the atlas (blit cache) */

// Scale buckets: a geometric ladder matching the wheel's 1.12 zoom step, so blits
// land at 0.89–1.0 of the baked bitmap — near 1:1, which is where drawImage is
// cheapest and the resample error smallest. In Godot the same tiles are Sprite2D
// textures scaled natively; the bake tool (tools/atlas.html) fixes scale 1.
const BUCKET_RATIO = 1.12;
const BUCKET_BASE = 0.2;     // below fit zoom on the largest plot (s ≈ 0.23–0.37 per tree)
const BUCKET_MAX = 8;        // ceiling for the bake scale (zoom 3.2 × dpr 2 × 1.14 ≈ 7.3)
const CACHE_MAX = 512;       // entries; evict-oldest
// At the fitted view a bucket is 0.2–0.5, so the baked bitmap is SMALLER than the
// design and would be a soft upscale. Bake those buckets at 2× and let drawImage
// downscale: 4 texels per output pixel is what turns stair-stepped pine edges into a
// clean AA silhouette. Large buckets are already ≥1 device px per design px — no
// supersample, no memory blow-up.
const SUPERSAMPLE_BELOW = 1.0;

const atlas = new Map();     // key -> { cv, ax, ay, s }  (ax/ay = origin inside the bitmap)
let canvasFactory = typeof document !== 'undefined' && document.createElement
  ? () => document.createElement('canvas')
  : null;

/** Test/atlas hook: supply a canvas factory (or null to force direct vector draws). */
export function setSpriteCanvasFactory(fn) { canvasFactory = fn; if (!fn) atlas.clear(); }
export function clearSpriteAtlas() { atlas.clear(); }
export function atlasStats() { return { entries: atlas.size, ratio: BUCKET_RATIO }; }

function bucketOf(s) {
  const idx = Math.max(0, Math.ceil(Math.log(Math.min(s, BUCKET_MAX) / BUCKET_BASE) / Math.log(BUCKET_RATIO)));
  return Math.min(BUCKET_MAX, BUCKET_BASE * Math.pow(BUCKET_RATIO, idx));
}

function bakeEntry(sp, name, s, o) {
  const ss = s < SUPERSAMPLE_BELOW ? 2 : 1;   // supersample the small buckets
  const bs = s * ss;
  const cv = canvasFactory();
  const [x0, x1, y0, y1] = sp.bounds;
  const m = 2;                       // stroke/dash margin
  const cw = Math.ceil((x1 - x0) * bs) + m * 2;
  const ch = Math.ceil((y1 - y0) * bs) + m * 2;
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext('2d');
  g.translate(-x0 * bs + m, -y0 * bs + m);
  sp.draw(g, bs, o);
  /* ---- season tint, image-backed sprites only: the painted cutouts carry their own
     summer colours and cannot read o.season, so the atlas entry is tinted once, after
     the draw. All five painted species are EVERGREEN (patula pine, black wattle,
     blackwood, yellowwood, ironwood — the sim's bareWattle hint is botanically off),
     so winter is a cool grey wash, never bare branches. Vector sprites handle season
     inside their own draw fns (seasonRamp) and must not be double-tinted. ---- */
  if (IMAGE_BACKED.has(name) && o.season && SEASON_TINT[o.season]) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = SEASON_TINT[o.season];
    g.fillRect(0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-over';
  }
  return { cv, ax: -x0 * bs + m, ay: -y0 * bs + m, s: bs };
}

function stateKey(o) {
  // season, growth stage, crop AND species are part of the key: same sprite, same
  // variant, but a different bitmap per season, per stage, per crop and per species.
  // Without `species` a
  // yellowwood and an ironwood that happened to land in the same variant bucket would
  // share one atlas entry, and the species fix would be invisible in the browser while
  // looking correct in node - the classic cache-hides-a-rendering-bug.
  //
  // `stage` is tested for PRESENCE, not truthiness. The bed's stages are the integers
  // 0..3 (FARMING-SPEC Part 1), and `o.stage || ''` folds 0 into the unstaged key - so
  // "just planted" and "caller passed nothing" would share one tile. Today they happen to
  // look the same, which is exactly how a cache bug stays invisible until the day they do
  // not. Trees pass '' for mature, and that still means unstaged.
  const st = (o.stage === undefined || o.stage === null || o.stage === '') ? '' : 'S' + o.stage;
  //
  // `crop` is the same shape, for the same reason (FARMING-SPEC Part 3): presence-tested
  // and PREFIXED. Presence, because `${o.crop || ''}` would give a bed that carries a
  // crop nothing at all; prefixed, because this key is a concatenation with no separators
  // - a bare 'greens' running into the next field is ambiguous, and 'C' marks the boundary
  // the way 'S' does for stage. A crop name is never falsy, so unlike `0` there is no
  // value here that truthiness would fold into "unset"; the prefix is what stops
  // crop 'greens' and no-crop sharing a tile.
  const cr = (o.crop === undefined || o.crop === null || o.crop === '') ? '' : 'C' + o.crop;
  return `${o.hover ? 'h' : ''}${o.ready ? 'r' : ''}${o.tint || ''}${o.season || ''}${st}${cr}${o.species || ''}`;
}

/**
 * Draw a registered sprite with its base centre at the current transform origin.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} name key of SPRITES
 * @param {number} s scale (1 = design px)
 * @param {object} [o] per-instance options passed through to the draw fn
 */
export function drawSprite(ctx, name, s, o = {}) {
  const sp = SPRITES[name];
  if (!sp) return;
  // variant: same hash the old continuous path used, snapped to a bucket ladder.
  // An explicit o.v wins — the atlas bake uses it to guarantee every variant is baked,
  // where hashing the tool's synthetic seeds would collide three-in-four.
  let v = 0.5;
  if (Number.isFinite(o.v)) {
    v = clamp(o.v, 0, 1);
  } else if (sp.variants > 1 && o.seedX !== undefined) {
    const raw = jitter(o.seedX | 0, o.seedY | 0, sp.salt);
    v = (Math.min(sp.variants - 1, Math.floor(raw * sp.variants)) + 0.5) / sp.variants;
  }
  if (!canvasFactory || !Number.isFinite(s) || s <= 0) {
    ctx.save();
    sp.draw(ctx, s, { ...o, v });
    ctx.restore();
    return;
  }
  const bs = bucketOf(s);
  const key = `${name}|${bs.toFixed(3)}|${v}|${stateKey(o)}`;
  let e = atlas.get(key);
  if (!e) {
    e = bakeEntry(sp, name, bs, { ...o, v });
    atlas.set(key, e);
    if (atlas.size > CACHE_MAX) {
      const oldest = atlas.keys().next().value;
      atlas.delete(oldest);
    }
  }
  const k = s / e.s;
  ctx.drawImage(e.cv, -e.ax * k, -e.ay * k, e.cv.width * k, e.cv.height * k);
}
