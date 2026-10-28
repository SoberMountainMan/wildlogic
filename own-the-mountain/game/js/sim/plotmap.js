// plotmap.js — the plot you actually work, at its own scale.
//
// The valley bake is 4 m/px, so a 2 ha plot is only ~35 px wide there. This module
// generates the SAME plot at 2.5 m per cell, seeded from the plot id, using the
// attributes the purchase card promised (hectares, water, tree cover, slope, aspect).
// Pure logic: no DOM, no canvas — node tests import this directly.
//
// Owner: builder. One plot per game; the valley map is untouched by this file.
//
// LEVELS (TERRAIN-SPEC.md §6, owner 2026-10-21): the ground is TERRACED, Transport-
// Tycoon style. One LEVEL = 2.5 m — the 45° rise across one 2.5 m tile. A tile whose
// 4 orthogonal neighbours share its level is FLAT (buildable, plantable); a tile beside
// a level ±1 is a SLOPE tile (the ramp: trackable, never buildable, never plantable).
// Generation: sample the DEM at the anchor + tile offset → quantize level =
// round(metres / 2.5) → FLOW passes until every orthogonal pair differs by at most 1
// level (the higher tile is clamped DOWN — cut, never filled; monotone, so the passes
// always converge, and the kloof keeps its depth). With NO terrain loaded — old saves,
// tests without the .bin — the FALLBACK rebuilds the same shape from the spec's slope
// % and the plot's high side. Same plot id → same terraces, forever. p.height is the
// derived metres (level × 2.5), kept for the renderer and the saves.

import { getTerrain, heightAt } from './terrain.js';

// SCALE (PIVOT-PLAN §A1, owner 2026-10-21): 1 ha = 10 000 m², so a 2.5 m tile is
// 6.25 m² and 2.1 ha is 3 360 tiles. One tile is now one tree, one fence post, one
// lane of track. The plot is 65×64 for the homesteader, not 47×45: the bush has to
// be big enough to get lost in.

export const CELL_M = 2.5;          // metres per grid cell — one tree, one fence post
export const LEVEL_M = 2.5;         // metres per level — the 45° rise across one tile
const SQ_M_PER_HA = 10000;

/* ---- deterministic RNG (same generator the sim uses) ---- */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) {
    h ^= String(id).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ---- real prices, ZAR. Sources checked 2026-10-18:
   - Property24 Hogsback (22 listings): vacant land 1.66-2.78 ha at H$700k-H$850k, i.e. ~H$250k-H$470k/ha;
     houses H$1.35m-H$4.45m.  https://www.property24.com/for-sale/hogsback/eastern-cape/255
   - Cashbuild catalogue: 2 450 L LDPE tank H$2,449.95 · IBR 6.0 m sheet H$449.95 · corrugated 3.6 m
     H$162.95 · 38x114 6.0 m timber H$190.95 · 150 L geyser H$4,499.95.  https://www.cashbuild.co.za/
   Land is the dominant cost by an order of magnitude — that is the real tension, so it drives the
   starting balance. */
export const PRICES = {
  tank5000: 4600,          // 5 000 L, scaled off Cashbuild's 2 450 L at H$2,449.95
  tankDelivery: 800,       // delivered — you do not carry it
  toilet: 6000,            // compost / long-drop
  borehole: 45000,
  solar3kw: 65000,
  cabin: 280000,           // basic off-grid timber cabin, materials + labour
  hive: 2800,
  fencePer100m: 18000,
  bakkie: 85000,
  pothole: 800,
  pineTree: 450,           // standing value per m³, delivered to the mill
  fellCost: 20,            // chainsaw + labour per stem (a pole, not a sawlog)
  bedBuild: 150,           // a 10 m² vegetable bed
  tools: 3000,
};

/* Timber per stem, m³. The 2.5 m plot carries ~1 500 stems on 2.6 ha — a pole stand,
   not 180 sawlogs — so the stem is small: 0.085 m³ of pine. The point is that the
   PLOT still holds the same ~120 m³ it always did (the land did not get bigger), so
   the contract quota, the mill and the company offer keep their scale while a tree
   takes a tenth of the time to fell. Without this, eight times the stems would have
   been eight times the money. */
export const STEM_M3 = { pine: 0.085, indigenous: 0.05 };
export const stemM3 = (kind) => (kind === 'pine' ? STEM_M3.pine : STEM_M3.indigenous);

/* ---- the opening decision: buy outright, or take a bond for better land ---- */
export const MORTGAGE = {
  rate: 0.1175,        // SA prime-ish, to verify against a real bank quote
  years: 20,
  depositFrac: 0.20,
  fees: 35000,         // transfer duty + conveyancing + bond registration
};
/* LAND on the mountain (owner, 2026-10-21: "you want a better one you must mortgage it?
   maybe a deposit and rest mortgaged? like real life?"). A site off the main map is
   bought on its own terms: 15% down, the rest over 8 years at the SAME bank rate. No
   transfer duty line — on a H$14 000 plot the village's H$35 000 of fees would be more
   than the land. The instalment lands in h.bond, so Mrs Naidoo, the monthly bill and the
   three-missed-months rule all apply unchanged: there is no second credit system. */
export const LAND_MORTGAGE = {
  rate: 0.1175,
  years: 8,
  depositFrac: 0.15,
  fees: 0,
};
export const START_CASH = 750000;

/** Monthly repayment on a bond. */
export function bondPayment(principal, rate = MORTGAGE.rate, years = MORTGAGE.years) {
  const r = rate / 12, n = years * 12;
  if (principal <= 0) return 0;
  return Math.round((principal * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * What a starting plot actually costs you, cash or bonded.
 * A SITE (spec.landMortgage) is financed on the land terms: 15% deposit, 8 years, no
 * fees. The canonical three keep the village-house bond (20%, 20 years, H$35k fees) —
 * byte-identical to the golden traces.
 * @returns {{price, deposit, bond, monthly, upFront, cashLeft}}
 */
export function startPlan(spec, mode = 'cash', cash = START_CASH) {
  if (mode === 'family') {
    // You did not buy anything: a share of the family plot, inherited, and almost no
    // money. No bond, no deed, and obligations instead of rent. No house stands — the
    // first roof is yours to build (TERRAIN-SPEC §4).
    return { price: 0, deposit: 0, bond: 0, monthly: 0, upFront: 0, cashLeft: spec.cash ?? 40000 };
  }
  const price = plotPrice(spec);
  const terms = spec.landMortgage ? LAND_MORTGAGE : MORTGAGE;
  if (mode === 'cash') {
    return { price, deposit: price, bond: 0, monthly: 0, upFront: price, cashLeft: cash - price };
  }
  const deposit = Math.round(price * terms.depositFrac);
  const bond = price - deposit;
  const upFront = deposit + (spec.landMortgage ? 0 : MORTGAGE.fees);
  // `committed` is money already promised elsewhere (a builder, a bond shortfall) —
  // it is why the incomer does not walk away from a bond with more cash than anyone.
  return { price, deposit, bond, monthly: bondPayment(bond, terms.rate, terms.years), upFront, cashLeft: cash - upFront - (spec.committed || 0) };
}

/**
 * What THIS life can actually do with THIS ground (owner, 2026-10-21):
 *   cash     — it can pay the whole price today,
 *   mortgage — it can cover the deposit; the rest is the land bond,
 *   family   — a share of the ground, no purchase,
 *   none     — it cannot even cover the deposit. The picker must refuse it.
 * The richest option is tried first for a cash life; a bonded life (the incomer) always
 * mortgages, because that is who he is. Pure: no state, no RNG — the picker, plot.html
 * and the tests all read this one answer.
 * @param {object} spec a site spec (or a canonical plot's spec)
 * @param {string} mode 'cash'|'bond'|'family'
 * @param {number} [cash] the life's starting cash
 */
export function landPlan(spec, mode, cash = START_CASH) {
  if (mode === 'family') return { ...startPlan(spec, 'family', cash), mode: 'family' };
  if (mode !== 'bond') {
    const outright = startPlan(spec, 'cash', cash);
    if (outright.cashLeft >= 0) return { ...outright, mode: 'cash' };
  }
  const mortgaged = startPlan(spec, 'bond', cash);
  return { ...mortgaged, mode: mortgaged.cashLeft >= 0 ? 'mortgage' : 'none' };
}

/* Three lives, not three difficulties. What changes is what you DO, not how big the risk is. */
export const START_OPTIONS = [
  {
    key: 'homesteader',
    mark: 'H',
    name: 'The Homesteader',
    // What the map and the plot card call this ground. The plot `id` is the terrain SEED and must
    // never be prettified onto the screen: `the-arboretum` and `qhumusa-flats` are somebody's
    // property, and the owner ruled (10-22 23:35) that a plot may sit under a real landmark but
    // may not be named as one. These labels claim no landmark that does not exist.
    groundLabel: 'the far crest',
    role: 'Bought the cheap ground outright',
    mode: 'cash',
    situation: 'Cash in hand and nothing else. No water, no power, no debt.',
    firstProblem: 'There is no water on the plot, and everything you build is uphill.',
    verbs: ['haul', 'fell', 'build by hand'],
    plot: { id: 'kloof-crest', ha: 2.6, water: null, forest: 'pine', slope: 31, kmFromShop: 4.4,
            alienFrac: 0.15 },   // old cropland: the wattle came in thick (12-18% of trees)
  },
  {
    key: 'incomer',
    mark: 'I',
    name: 'The Incomer',
    groundLabel: 'the ground above the village',
    role: 'Took a bond on the plot by the village',
    mode: 'bond',
    situation: 'The best ground, the shortest walk to the shop, and H$7 012 due on the 1st. Half your money is already promised to a builder.',
    firstProblem: 'You owe money before you have earned any of it, and the build is not finished.',
    verbs: ['earn', 'host', 'borrow'],
    plot: { id: 'the-arboretum', ha: 2.4, water: 'stream', forest: 'indigenous', slope: 6, kmFromShop: 0.4, committed: 320000,
            alienFrac: 0.08 },
  },
  {
    key: 'stayed',
    mark: 'S',
    name: 'The One Who Stayed',
    groundLabel: 'the family ground',
    role: 'Your mother\u2019s plot, split with your brother',
    mode: 'family',
    cash: 40000,
    situation: 'A house already stands. You own a share, not the land, and there is almost no money.',
    firstProblem: 'The old house is a shell and your brother has opinions about the trees.',
    verbs: ['negotiate', 'share', 'improve'],
    plot: { id: 'qhumusa-flats', ha: 1.4, water: 'stream', forest: 'mixed', slope: 9, kmFromShop: 0.8,
            alienFrac: 0.08 },
  },
];

/* ---- plot price: real Hogsback land, adjusted for distance to the shop ----
   Measured comparables (2026-10-18): 2.78 ha at H$700k (H$252k/ha), 1.66 ha at H$780k (H$470k/ha),
   2.74 ha at H$850k (H$310k/ha). Base H$220k/ha is the cheap end; proximity adds the premium.
   A SITE carries its own BAKED price (sites.js): the good tier was priced by this same
   formula, the rough tier by what the ground can actually do. A fixed number, because the
   catalog is the market — it must not move between page loads or between the picker and
   the plot. */
export const LAND_BASE_PER_HA = 220000;
export function plotPrice({ ha, kmFromShop, price }) {
  if (price != null) return price;
  const near = 45000;                      // + per ha per km closer than 3
  const far = 18000;                       // - per ha per km further than 3
  const adj = kmFromShop < 3 ? (3 - kmFromShop) * near : -(kmFromShop - 3) * far;
  return Math.max(120000, Math.round(ha * (LAND_BASE_PER_HA + adj)));
}

const idx = (p, x, y) => y * p.w + x;
const inBounds = (p, x, y) => x >= 0 && y >= 0 && x < p.w && y < p.h;

/* ---- tile levels (TERRAIN-SPEC.md §6) ----------------------------------------- */

/**
 * Fill p.level (one integer per tile) and the derived p.height (level × 2.5 m).
 * Real DEM when terrain is loaded (bilinear at the anchor pixel + the tile's 2.5 m
 * offset, quantized level = round(metres / 2.5)); otherwise the FALLBACK model,
 * level = round(slope% × distance-from-highSide × 0.01 / 2.5). Both are then FLOWED:
 * passes clamp the higher tile of any pair straddling more than one level down to
 * lower+1, until nothing moves — so max |Δlevel| between neighbours is 1 BY
 * CONSTRUCTION. Deterministic both ways; NO rng is drawn here, so plot generation
 * stays byte-reproducible and the golden ids keep their world.
 */
function buildLevels(p, spec) {
  const slope = spec.slope || 12;
  const t = getTerrain();
  // A SITE (sites.js) carries its own anchor: it is not one of the baked plot anchors,
  // so it names the map pixel it was bought at and the DEM is sampled from there. The
  // canonical three keep the anchor lookup by id, byte for byte.
  const a = spec.anchor
    ? { x: spec.anchor.x, y: spec.anchor.y }
    : (t && t.dem && Array.isArray(t.plots) ? t.plots.find((q) => q.id === p.id) : null);
  if (a && t && t.dem) {
    const px = CELL_M / (t.meta.mPerPx || 4.03);   // DEM pixels per 2.5 m tile
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const m = heightAt(t, a.x + (x + 0.5) * px, a.y + (y + 0.5) * px);
        p.level[y * p.w + x] = Math.round(m / LEVEL_M);
      }
    }
    p.levelSource = 'dem';
  } else {
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const d = p.highSide === 'N' ? y
          : p.highSide === 'E' ? p.w - 1 - x
            : p.highSide === 'S' ? p.h - 1 - y
              : x;
        p.level[y * p.w + x] = Math.round(slope * d * 0.01 / LEVEL_M);
      }
    }
    p.levelSource = 'model';
  }
  flowLevels(p);
  for (let i = 0; i < p.level.length; i++) p.height[i] = p.level[i] * LEVEL_M;
}

/**
 * The FLOW pass (TERRAIN-SPEC §6): sweep the grid, and wherever an orthogonal pair
 * straddles more than one level, clamp the HIGHER tile of the pair DOWN to lower+1
 * (cut, never fill — valleys keep their depth, and the sum only ever falls, so the
 * sweeps provably terminate). Each tile is checked against its left and up neighbours
 * in BOTH directions — a ridge or a graded yard edge can face either way. Repeat
 * until a full sweep changes nothing: afterwards every orthogonal pair differs by at
 * most one level, which is the 45° ramp or less. Exported: siteworks.flatten runs it
 * after grading, so player terraform keeps the flow guarantee too.
 */
export function flowLevels(p) {
  for (let pass = 0; pass < 256; pass++) {
    let cut = false;
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const i = y * p.w + x;
        if (x > 0) {
          if (p.level[i] - p.level[i - 1] > 1) { p.level[i] = p.level[i - 1] + 1; cut = true; }
          else if (p.level[i - 1] - p.level[i] > 1) { p.level[i - 1] = p.level[i] + 1; cut = true; }
        }
        if (y > 0) {
          if (p.level[i] - p.level[i - p.w] > 1) { p.level[i] = p.level[i - p.w] + 1; cut = true; }
          else if (p.level[i - p.w] - p.level[i] > 1) { p.level[i - p.w] = p.level[i] + 1; cut = true; }
        }
      }
    }
    if (!cut) return;
  }
}

/**
 * How steep a tile is, in LEVELS of fall onto its worst orthogonal neighbour:
 * max |level − level(neighbour)| over the 4 orthogonal neighbours (edge tiles use the
 * neighbours they have). 0 is FLAT ground — buildable, plantable; 1 is the SLOPE tile,
 * the 45° ramp — trackable, never buildable. Flow guarantees it is never more than 1.
 * Pure and exported so the sim gates and the HUD ghost agree on one answer.
 */
export function steep(p, x, y) {
  if (!p || !p.level || !inBounds(p, x, y)) return 0;
  const lv = p.level[y * p.w + x];
  let worst = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(p, nx, ny)) continue;
    const d = Math.abs(lv - p.level[ny * p.w + nx]);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * The level of one grid CORNER (cx, cy in grid-line coordinates, 0..w/h): the MAXIMUM
 * level of the tiles that touch it (in-bounds ones; the plot edge contributes nothing).
 * With the flow guarantee (|Δ| ≤ 1 between orthogonal neighbours) the max rule gives
 * every shared corner ONE height that both tiles agree on — a ramp always meets the
 * next tile's seam, two perpendicular rises make a proper corner ramp, and a raised
 * corner always has an in-bounds tile standing exactly at it (a ramp cannot end in
 * air). The renderer mirrors this function for drawing (it imports no sim); THIS copy
 * is the pinned one — tests/34 asserts the invariants on every live plot.
 * Pure and exported so the sim's build rules and the level tooling share one answer.
 */
export function cornerLevel(p, cx, cy) {
  if (!p || !p.level) return 0;
  let mx = null;
  for (let y = cy - 1; y <= cy; y++) {
    for (let x = cx - 1; x <= cx; x++) {
      if (!inBounds(p, x, y)) continue;
      const l = p.level[y * p.w + x];
      if (mx === null || l > mx) mx = l;
    }
  }
  return mx == null ? 0 : mx;
}

/**
 * TRUE when a tile's whole surface sits at its own level — no touching tile (8
 * neighbours: corners count) stands higher. That is the TT "flat tile": buildable,
 * plantable. A tile with ANY raised corner is a slope (a ramp or a knoll edge) and
 * takes no buildings, no beds — the ground falls away inside the footprint. Stronger
 * than `steep() === 0`, which reads only orthogonal neighbours and misses a higher
 * diagonal (the inside-corner case that renders as a wedge under whatever you built).
 * Pure and exported: canPlaceAccom, the plant gate and the HUD ghost all ask this one.
 */
export function tileFlat(p, x, y) {
  if (!p || !p.level || !inBounds(p, x, y)) return false;
  const lv = p.level[y * p.w + x];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!inBounds(p, nx, ny)) continue;
      if (p.level[ny * p.w + nx] > lv) return false;
    }
  }
  return true;
}

/* The clearing's size: a 14 × 10 tile ellipse, i.e. 35 m × 25 m — a house, a yard
   and a place to turn a bakkie. PIVOT-PLAN §A3, "radius ~6-8 tiles, elliptical". */
export const CLEARING = { rx: 7, ry: 5 };

/** Is this cell inside the plot's clearing? */
export function inClearing(p, x, y) {
  if (!p || !p.clearing) return false;
  const dx = (x - p.clearing.x) / p.clearing.rx;
  const dy = (y - p.clearing.y) / p.clearing.ry;
  return dx * dx + dy * dy <= 1;
}

/* ---- the driveway (PIVOT-PLAN §A3) ------------------------------------------
   A site more than DRIVEWAY.free tiles from the gate needs a driveway cut out to
   it — gravel, a culvert, the odd stump pulled. Manhattan distance, because a
   driveway follows the grid. H$400 a tile (lead ruling 2026-10-21): at H$120 the
   surcharge was 1.6% of a H$95k build and nobody felt it; the owner's intent is
   that the good clearing is the expensive one. The first 4 tiles are the yard and
   are free — and laying your own track (siteworks.layTrack, H$250/tile) removes
   the surcharge entirely, which is the player's answer to it. */
export const DRIVEWAY = { free: 4, perTile: 400 };

/** Tiles from the gate to a site, Manhattan. */
export function drivewayTiles(p, x, y) {
  if (!p || !p.gate) return 0;
  return Math.abs(x - p.gate.x) + Math.abs(y - p.gate.y);
}

/** What the driveway out to (x, y) adds to a build. 0 within DRIVEWAY.free tiles. */
export function drivewaySurcharge(p, x, y) {
  return Math.max(0, drivewayTiles(p, x, y) - DRIVEWAY.free) * DRIVEWAY.perTile;
}

/* ---- the gate (sites.js) ------------------------------------------------------
   A canonical plot's gate sits mid-edge on the drawn side: that is the plot's own
   front door and it never moves. A SITE's gate goes where the ROAD is — roadSide,
   computed by the bake from the real OSM line — and along that edge it takes the
   FLATTEST RUN of tiles: the road comes in where the ground lets it, and a gate you
   cannot drive out of is not a gate. Score = flat tiles along the edge (5-tile
   window) plus the three tiles of drive inward; water inward is refused outright.
   Ties go to the tile nearest the middle, so the gate still reads centred. No rng:
   same site, same gate, forever. */
function gateOnEdge(p, side) {
  const horizontal = side === 'N' || side === 'S';
  const len = horizontal ? p.w : p.h;
  const fixed = side === 'N' ? 0 : side === 'S' ? p.h - 1 : side === 'E' ? p.w - 1 : 0;
  const inx = side === 'N' ? 0 : side === 'S' ? 0 : side === 'E' ? -1 : 1;
  const iny = side === 'N' ? 1 : side === 'S' ? -1 : 0;
  const mid = (len - 1) / 2;
  let best = null;
  for (let i = 1; i < len - 1; i++) {
    const x = horizontal ? i : fixed, y = horizontal ? fixed : i;
    if (p.ground[idx(p, x, y)] === 'water') continue;      // a gate in the stream is no gate
    let score = 0;
    for (let d = -2; d <= 2; d++) {
      const nx = horizontal ? i + d : x, ny = horizontal ? y : i + d;
      if (!inBounds(p, nx, ny)) continue;
      if (p.ground[idx(p, nx, ny)] !== 'water' && steep(p, nx, ny) === 0) score += 2;
    }
    for (let d = 1; d <= 3; d++) {
      const nx = x + inx * d, ny = y + iny * d;
      if (!inBounds(p, nx, ny)) { score -= 5; continue; }
      if (p.ground[idx(p, nx, ny)] === 'water') score -= 6;
      else if (steep(p, nx, ny) <= 1) score += 1;
    }
    if (!best || score > best.score || (score === best.score && Math.abs(i - mid) < Math.abs(best.i - mid))) {
      best = { i, score };
    }
  }
  const i = best ? best.i : Math.floor(len / 2);
  return horizontal ? { x: i, y: fixed, side } : { x: fixed, y: i, side };
}

/**
 * Generate one plot.
 * @param {object} spec { id, ha, water: 'stream'|'dam-site'|null, forest: 'pine'|'indigenous'|'mixed'|null,
 *                        slope: number (% grade), kmFromShop: number }
 * @param {number|null} [gameSeed] the NEW GAME's seed (owner, 2026-10-21: "terrain does not
 *   randomize... maybe amount of trees or kinds or stages of growth changes"). The TERRAIN
 *   never sees this seed — levels, stream, gate and clearing are byte-identical for every
 *   seed. The TREE LAYER does: density ±15%, cluster placement, oak count and growth
 *   stages all vary per new game. null (the default, and every probe/test that calls
 *   makePlot directly) reproduces today's fixed stand byte for byte.
 */
export function makePlot(spec, gameSeed = null) {
  const { id, ha = 2, water = null, forest = null, slope = 12, kmFromShop = 2 } = spec;
  const rng = mulberry32(seedOf(id));
  const areaM2 = ha * SQ_M_PER_HA;
  const side = Math.sqrt(areaM2);
  // Long side / short side. Tightened from 1.0-1.5 to 1.0-1.25 with the 2.5 m change:
  // at 65 tiles across a 1.5 ratio was a 79×53 strip, and a plot should read square
  // enough that the walk from the gate to the far corner is a walk, not a trek.
  const ratio = 1 + rng() * 0.25;
  let w = Math.max(8, Math.round(side / CELL_M * Math.sqrt(ratio)));
  let h = Math.max(8, Math.round(areaM2 / (w * CELL_M * CELL_M)));
  // A SITE's footprint is BAKED (sites.js `tiles`): the catalog measured that block of
  // ground, so the plot has to be exactly it. The ratio draw above still happens, so a
  // canonical plot and a site that shared an id would consume the same numbers.
  if (spec.w && spec.h) { w = spec.w; h = spec.h; }

  // --- gate side. A canonical plot draws it (S or W, the side nearest the shop by
  //     convention) and puts the gate mid-edge. A SITE declares it instead: the gate
  //     goes on the side the road actually comes in from (sites.js roadSide), on the
  //     flattest run of that edge. The DRAW still happens either way, so a site and a
  //     canonical plot with the same id consume the same numbers — only the side differs.
  //     Drawn HERE (it used to be drawn after the trees) because the clearing is defined
  //     from the gate and the forest has to grow around the clearing. It is the same
  //     single draw, moved earlier — no extra draws from the stream, but the draws that
  //     follow (slope, stream, then every tree) land on different numbers, so the
  //     forest is re-rolled once. Still byte-deterministic: one id, one plot, forever.
  const drawnGateSide = rng() > 0.5 ? 'S' : 'W';
  const gateSide = spec.gateSide || drawnGateSide;

  const p = {
    id, ha, w, h, cellM: CELL_M,
    water: water || null,
    forest: forest || null,
    slope,
    kmFromShop,
    price: plotPrice({ ha, kmFromShop }),
    seed: seedOf(id),
    ground: new Array(w * h).fill('grass'),
    // one LEVEL per tile (TERRAIN-SPEC §6): integers, 2.5 m each, flowed so no
    // neighbour pair straddles more than one level. p.height is the derived metres
    // (level × 2.5) for the renderer. Plain numbers: JSON save/load safe.
    level: new Array(w * h).fill(0),
    height: new Array(w * h).fill(0),
    levelSource: null,
    trees: [],
    stream: null,
    dam: null,
    damTiles: [],    // dopped dam floors (TERRAIN-SPEC §7): [{ x, y, depth }] — depth in
                     // levels of water stored, filled by siteworks.tickWater
    waterTable: null, // the LEVEL the ground water sits at, set at the end of makePlot
    gate: null,
    buildings: [],
    felled: 0,
    timber: 0,
    // siteworks (PIVOT-PLAN §A4): the tiles you lay yourself. Scenery, not snapshot state —
    // no draw is made here, so the golden traces cannot move.
    track: [],
    mud: [],       // the cheap muddy track (owner GO 2026-10-21) — sits beside the gravel
    fence: [],
    flat: [],
    // ---- what this plot IS, off the main map (sites.js) ----
    site: spec.site || null,              // the catalog id, null on the canonical three
    anchor: spec.anchor ? { x: spec.anchor.x, y: spec.anchor.y } : null,
    roadSide: spec.roadSide || null,      // the compass side the road comes in from
    entranceSide: spec.entranceSide || null,  // ['N'] or a corner pair ['N','E']
    gateBearing: spec.gateBearing == null ? null : spec.gateBearing,
    starterMud: 0,                        // the free driveway stub, tiles (see layStarter)
  };

  // --- slope direction: one side of the plot is high, the other low ---
  const dir = Math.floor(rng() * 4);                    // 0=N 1=E 2=S 3=W
  p.highSide = ['N', 'E', 'S', 'W'][dir];
  const steepness = slope / 100;

  // --- levels (TERRAIN-SPEC §6): real DEM quantized + flowed when it is loaded,
  //     fallback model when not. Drawn from dir/spec only — no rng — so nothing
  //     after this moves. ---
  buildLevels(p, spec);

  // --- ground: value noise, rock on the steep side, scrub patches ---
  const n = (x, y) => {
    let s = 0, amp = 1, f = 0.18;
    for (let o = 0; o < 3; o++) {
      s += amp * (Math.sin((x * f + p.seed % 97) * 1.7) * Math.cos((y * f + p.seed % 53) * 1.3) * 0.5 + 0.5);
      amp *= 0.5; f *= 2.1;
    }
    return s / 1.75;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = n(x, y);
      const onHigh = (dir === 0 && y < h * 0.3) || (dir === 2 && y > h * 0.7)
        || (dir === 1 && x > w * 0.7) || (dir === 3 && x < w * 0.3);
      let g = 'grass';
      if (t > 0.62) g = 'scrub';
      // rock only on genuinely steep ground: at 11% you get pasture, not cliffs
      if (onHigh && steepness > 0.20 && t > 0.60) g = 'rock';
      if (t < 0.16) g = 'mud';
      p.ground[idx(p, x, y)] = g;
    }
  }

  // --- water ---
  if (water === 'stream') {
    const vertical = rng() > 0.5;
    const at = Math.floor((vertical ? w : h) * (0.3 + rng() * 0.4));
    p.stream = { vertical, at, width: 1 };
    for (let i = 0; i < (vertical ? h : w); i++) {
      const wobble = Math.round(Math.sin(i * 0.35) * 1.2);
      const c = at + wobble;
      for (let d = -1; d <= 1; d++) {
        const x = vertical ? c + d : i, y = vertical ? i : c + d;
        if (inBounds(p, x, y)) p.ground[idx(p, x, y)] = d === 0 ? 'water' : 'bank';
      }
    }
  } else if (water === 'dam-site') {
    const cx = Math.floor(w * (0.25 + rng() * 0.5));
    const cy = Math.floor(h * (0.25 + rng() * 0.5));
    p.dam = { cx, cy, r: Math.max(2, Math.round(Math.min(w, h) * 0.12)) };
  }

  // --- the gate, now that the GROUND exists (levels AND water: a gate in the stream is
  //     no gate). Canonical plots keep the mid-edge gate they have always had
  //     (byte-identical goldens); a SITE puts it on the road side, at the flattest run
  //     of that edge — the road comes in where the ground lets it. ---
  p.gate = spec.gateSide
    ? gateOnEdge(p, gateSide)
    : (gateSide === 'S'
      ? { x: Math.floor(w / 2), y: h - 1, side: gateSide }
      : { x: 0, y: Math.floor(h / 2), side: gateSide });

  // --- the clearing (PIVOT-PLAN §A3, TERRAIN-SPEC §2) ---
  // One flat, open patch inside the gate: the obvious place to build. With real
  // heights the clearing is WHERE THE FLAT GROUND IS: the candidate window near the
  // gate whose ellipse holds the MOST tiles with steep === 0 (water does not count —
  // you do not build the yard in a stream). Window scan, no rng draw; ties go to the
  // candidate nearest the gate. On the fallback model it lands the same way.
  const cands = [];
  for (let inset = 9; inset <= 13; inset++) {
    for (const off of [-4, -2, 0, 2, 4]) {
      // inward from the gate, whichever of the four edges it stands on. 'S' and 'W'
      // are the canonical plots' sides and reproduce the old candidate list exactly.
      const c = gateSide === 'S' ? { x: p.gate.x + off, y: h - 1 - inset }
        : gateSide === 'N' ? { x: p.gate.x + off, y: inset }
          : gateSide === 'E' ? { x: w - 1 - inset, y: p.gate.y + off }
            : { x: inset, y: p.gate.y + off };
      cands.push({ ...c, inset });
    }
  }
  const ellipseCells = (c, rx, ry) => {
    const out = [];
    for (let y = Math.max(0, c.y - ry); y <= Math.min(h - 1, c.y + ry); y++) {
      for (let x = Math.max(0, c.x - rx); x <= Math.min(w - 1, c.x + rx); x++) {
        const dx = (x - c.x) / rx, dy = (y - c.y) / ry;
        if (dx * dx + dy * dy <= 1) out.push([x, y]);
      }
    }
    return out;
  };
  let best = null;
  for (const c of cands) {
    if (c.x - CLEARING.rx < 1 || c.x + CLEARING.rx > w - 2) continue;
    if (c.y - CLEARING.ry < 1 || c.y + CLEARING.ry > h - 2) continue;
    let flat = 0;
    for (const [x, y] of ellipseCells(c, CLEARING.rx, CLEARING.ry)) {
      if (steep(p, x, y) === 0 && p.ground[idx(p, x, y)] !== 'water') flat++;
    }
    if (!best || flat > best.flat) best = { ...c, flat };
  }
  if (best) {
    p.clearing = { x: best.x, y: best.y, r: CLEARING.rx, rx: CLEARING.rx, ry: CLEARING.ry };
    // it is cleared ground, not merely treeless ground: grass, cut and flattened.
    // Water and its bank survive — you do not fill a stream to make a lawn.
    for (const [x, y] of ellipseCells(best, CLEARING.rx, CLEARING.ry)) {
      const i = idx(p, x, y);
      if (p.ground[i] !== 'water' && p.ground[i] !== 'bank') p.ground[i] = 'grass';
    }
    // the yard is GRADED (TERRAIN-SPEC §6): a clearing that is all slope is not a
    // clearing — on the kloof the flat-densest window can still be 95% ramp. The whole
    // ellipse is cut to its modal level (ties prefer the lower cut), then the ground is
    // re-flowed: the yard reads as one buildable plateau, with the 45° ramps where the
    // land falls away beyond it. Deterministic — same id, same graded yard.
    const tally = new Map();
    for (const [x, y] of ellipseCells(best, CLEARING.rx, CLEARING.ry)) {
      const lv = p.level[idx(p, x, y)];
      tally.set(lv, (tally.get(lv) || 0) + 1);
    }
    let yard = null;
    for (const [lv, n] of tally) {
      if (yard === null || n > tally.get(yard) || (n === tally.get(yard) && lv < yard)) yard = lv;
    }
    for (const [x, y] of ellipseCells(best, CLEARING.rx, CLEARING.ry)) {
      const i = idx(p, x, y);
      if (p.ground[i] !== 'water' && p.ground[i] !== 'bank') p.level[i] = yard;
    }
    flowLevels(p);
    for (let i = 0; i < p.level.length; i++) p.height[i] = p.level[i] * LEVEL_M;
  } else {
    p.clearing = null;
  }

  // --- trees: density from the forest type, never on water, rock or the clearing ---
  // One tree per ~2.8 tiles on pine (PIVOT-PLAN §A2: the bush has to be hostile —
  // ~1 450 trees on the homesteader, not 180). Trees are tracked in a Set so the
  // rejection loop stays O(1) per draw at this size.
  // A SEEDED game draws its tree layer from its own stream (treeRng): density ±15%,
  // different placements, growth stages 8-25 years. Unseeded calls keep the fixed
  // stand — byte-identical to every plot generated before the game-seed landed.
  const seeded = gameSeed != null;
  const treeRng = seeded ? mulberry32((seedOf(id) ^ seedOf(String(gameSeed))) >>> 0) : rng;
  const R = seeded ? treeRng : rng;                    // the tree layer's draw source
  const densityJitter = seeded ? 0.85 + 0.3 * R() : 1; // ±15% on the target, seeded only
  const ageSpan = seeded ? 18 : 30;                    // seeded games start 8-25 years old
  const density = (forest === 'pine' ? 1 / 2.8
    : forest === 'indigenous' ? 1 / 3.2
      : forest === 'mixed' ? 1 / 3.0 : 1 / 16) * densityJitter;
  const target = Math.round(w * h * density);
  let placed = 0, guard = 0;
  const taken = new Set();
  while (placed < target && guard < target * 40) {
    guard++;
    const x = 1 + Math.floor(R() * (w - 2));
    const y = 1 + Math.floor(R() * (h - 2));
    const k = idx(p, x, y);
    if (taken.has(k)) continue;
    const g = p.ground[k];
    if (g === 'water' || g === 'bank' || g === 'rock') continue;
    if (inClearing(p, x, y)) continue;
    taken.add(k);
    const kind = forest === 'pine' ? 'pine'
      : forest === 'indigenous' ? 'indigenous'
        : forest === 'mixed' ? (R() > 0.5 ? 'pine' : 'indigenous')
          : 'indigenous';
    p.trees.push({ id: 't' + p.trees.length, x, y, kind, age: 8 + Math.floor(R() * ageSpan) });
    placed++;
  }

  // --- alien trees: wattle and blackwood seed themselves in disturbed ground ---
  // NARRATIVE-BIBLE §4: wattle is the exception to the theme — clearing it is
  // stewardship, and it burns. Seeded clusters, so the same plot id always produces
  // the same stand. The share is taken out of the standing pine/indigenous, never
  // beyond the band below.
  // TODO(regrow): RESERVED, not built — cleared wattle should re-seed near the stump;
  // the spread sim waits on an owner GO. Do not build it without one.
  const alienFrac = spec.alienFrac ?? 0.08;
  const share = alienFrac * (0.8 + 0.4 * R());          // 0.15 → 12-18%, 0.08 → 6.4-9.6%
  const alienTarget = Math.round(placed * share);
  let aliens = 0;
  const clusters = 1 + Math.floor(R() * 3);             // 1-3 seed patches per plot
  const markAlien = (t) => {
    const wattle = R() < 0.7;                           // wattle is the invader; blackwood tags along
    t.kind = wattle ? 'wattle' : 'blackwood';
    if (wattle) { t.regrow = true; t.planted = null; }  // it seeded itself
    aliens++;
  };
  for (let c = 0; c < clusters && aliens < alienTarget; c++) {
    let cx = 1 + Math.floor(R() * (w - 2));
    let cy = 1 + Math.floor(R() * (h - 2));
    // disturbed ground (scrub, mud) is where the seed lands first — prefer it, but
    // birds drop seed anywhere, so a cluster always starts somewhere
    for (let tries = 0; tries < 8; tries++) {
      const x = 1 + Math.floor(R() * (w - 2));
      const y = 1 + Math.floor(R() * (h - 2));
      cx = x; cy = y;
      const g = p.ground[idx(p, x, y)];
      if (g === 'scrub' || g === 'mud') break;
    }
    const r2 = (Math.max(4, Math.round(Math.min(w, h) * 0.11)) * (1 + R() * 0.8)) ** 2;
    // ^ a stand 7-13 cells across on a 63-tile plot — the clusters grow with the plot,
    //   so the wattle share stays the same without the stand becoming a postage stamp
    const near = p.trees
      .filter((t) => t.kind !== 'wattle' && t.kind !== 'blackwood')
      .map((t) => ({ t, d: (t.x - cx) ** 2 + (t.y - cy) ** 2 }))
      .filter((e) => e.d <= r2)
      .sort((a, b) => a.d - b.d);
    for (const { t } of near) {
      if (aliens >= alienTarget) break;
      markAlien(t);
    }
  }
  // fill the band exactly if the clusters landed thin — the wattle does not ask permission
  for (const t of p.trees) {
    if (aliens >= alienTarget) break;
    if (t.kind === 'wattle' || t.kind === 'blackwood') continue;
    markAlien(t);
  }

  // --- oak: the alien ornamental (owner, 2026-10-21: "Good ornamental but technically
  //     alien") --- rare, and it stands where people planted it: the village-garden plots
  //     (mixed, indigenous) carry 2-4 around the gate lawn; the wild pine kloof gets
  //     maybe one. Conversion of the nearest standing natives keeps every other draw
  //     untouched — no new placements, only kinds change.
  const oakTarget = (forest === 'mixed' || forest === 'indigenous')
    ? 2 + Math.floor(R() * 3)                    // a handful: 2-4
    : (R() < 0.5 ? 1 : 0);                       // the kloof: maybe one
  const oakCandidates = p.trees
    .filter((t) => t.kind === 'pine' || t.kind === 'indigenous')
    .map((t) => ({ t, d: Math.abs(t.x - p.gate.x) + Math.abs(t.y - p.gate.y) }))
    .sort((a, b) => a.d - b.d);                  // nearest the gate lawn first
  for (let i = 0; i < Math.min(oakTarget, oakCandidates.length); i++) {
    oakCandidates[i].t.kind = 'oak';
  }

  // --- species: which tree it actually is (art T3, board Request) ---------------------
  // `kind` stays the SIM contract — firewood yield, the mill, the forest penalty and the
  // native fine all read it. `species` is display-only: what the atlas draws. It is
  // assigned in ONE pass at the end rather than at each kind choice, because the alien and
  // oak passes both REWRITE kind after placement; a species written early would be left
  // describing a tree that is no longer that tree.
  // Deliberately NOT a new R() draw: one more draw here shifts every later placement and
  // re-rolls the entire bush. It is derived from the tree's own position and index, which
  // scatters it as well as a draw would. A tree with no species (an old save) keeps the
  // renderer's old variant-ladder behaviour, so a pre-T3 save looks exactly as it did.
  const SPECIES_OF = { pine: 'patula', oak: 'oak', wattle: 'wattle', blackwood: 'blackwood' };
  for (let i = 0; i < p.trees.length; i++) {
    const t = p.trees[i];
    if (SPECIES_OF[t.kind]) { t.species = SPECIES_OF[t.kind]; continue; }
    const hsh = (Math.imul(t.x, 73856093) ^ Math.imul(t.y, 19349663) ^ Math.imul(i, 83492791)) >>> 0;
    t.species = hsh % 2 ? 'ironwood' : 'yellowwood';
  }

  // --- gate: placed above, on the ground, before the clearing (the clearing is defined
  //     from it) ---

  // --- the house: the ARRIVERS (homesteader, incomer) start with NO house — where the
  //     first roof goes is the first real decision (TERRAIN-SPEC §4): find flat ground,
  //     run the driveway, or park the caravan while you build. The house itself is a
  //     build — tourism.ACCOM.house, a 2×2 footprint at H$45 000, flat ground only.
  //     THE EXCEPTION (lead ruling, arbitrated 2026-10-21): qhumusa-flats, the One Who
  //     Stayed, did not arrive — he never left, and START_OPTIONS line 159 says so:
  //     "A house already stands." The family house (a shell) sits on the graded clearing
  //     plateau, its footprint cleared of trees — his grandfather cut them. p.buildings
  //     is scenery, not snapshot state, so the traces never moved on this.
  p.buildings.length = 0;
  if (id === 'qhumusa-flats' && p.clearing) {
    const cx = p.clearing.x, cy = p.clearing.y;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = cx + dx, y = cy + dy;
      const t = p.trees.findIndex((tr) => tr.x === x && tr.y === y);
      if (t >= 0) p.trees.splice(t, 1);
    }
    p.buildings.push({ kind: 'house', x: cx, y: cy });
  }

  // --- the water table (TERRAIN-SPEC §7, owner 2026-10-21: "would dopping to a
  //     certain level later fill a dam, or must it be a stream already?" — no stream
  //     needed): one LEVEL per plot, deterministic per id, derived from the graded
  //     yard and the plot's own shape. No rng draw — nothing after this moves, so
  //     the golden world is untouched. siteworks.dop digs below it; tickWater seeps
  //     the hole full.
  p.waterTable = waterTableOf(p);

  // --- the starter stub (owner, 2026-10-21): "maybe we need to give them the first
  //     bit of the dirt track as a starter." Four tiles of mud from the gate inward,
  //     free. Laid LAST so nothing above it can see it: plot generation stays the
  //     ground it always was, and the stub is a gift on top of it.
  //     SITES ONLY. The canonical three are the back-compat default path and their
  //     golden traces are byte-frozen; a mud tile in the gate cell moves the wet-night
  //     rolls and the driveway reads (measured: all three traces diverged). The stub
  //     belongs to the plot you CHOOSE off the main map, which is the owner's ask. ---
  p.starterMud = spec.site ? layStarter(p) : 0;

  return p;
}

/* ---- the starter stub (owner, 2026-10-21) -------------------------------------
   Every new plot arrives with FOUR tiles of mud track from the gate inward — the farm
   road ends at your gate and the last few metres are yours. FREE: makePlot has no
   household, so no cash is touched, and this is the only infrastructure you are given.
   It is NOT a driveway. Four tiles reaches the near rim of the yard, not the yard: the
   caravan's `needs: ['driveway']` is still met only by the facility (FACILITY.driveway)
   or by a drive YOU lay (siteworks.driveWithin reaches 3 tiles, and nothing at the
   clearing's centre is within 3 of the gate). A start, not a road — pinned in tests/45.
   Water is skipped, never bridged: the run keeps going inward past a stream. Tiles
   carry `starter: true` so the HUD, the save and the tests can tell them from your
   own work. */
export const STARTER_TILES = 4;
export const STUB_NOTE = 'The farm road ends at your gate — four tiles of mud come with the ground.';

/** One step INWARD from an edge, as [dx, dy]. */
export function inwardStep(side) {
  return side === 'N' ? [0, 1] : side === 'S' ? [0, -1] : side === 'E' ? [-1, 0] : [1, 0];
}

/** Lay the free stub on a plot (idempotent enough: it only ever adds, and only on a
 *  plot whose mud list is still the one it made). Returns the number of tiles laid. */
export function layStarter(p) {
  if (!p || !p.gate || !Array.isArray(p.mud)) return 0;
  const [dx, dy] = inwardStep(p.gate.side);
  let laid = 0;
  for (let i = 0; i < STARTER_TILES * 3 && laid < STARTER_TILES; i++) {
    const x = p.gate.x + dx * i, y = p.gate.y + dy * i;
    if (!inBounds(p, x, y)) break;
    if (p.ground[idx(p, x, y)] === 'water') continue;
    if (p.mud.some((t) => t.x === x && t.y === y)) { laid++; continue; }
    p.mud.push({ x, y, starter: true });
    laid++;
  }
  return laid;
}

/**
 * The plot's water table, in LEVELS (TERRAIN-SPEC §7): the clearing's modal level
 * (the graded yard — the ground the player actually works and digs from) minus K,
 * where K comes from the plot's own shape:
 *   - a KLOOF collects water: steep, waterless ground (slope ≥ 20%, no stream) keeps
 *     the table close — K = 4 (10 m of digging: reachable with real money). This is
 *     the homesteader's kloof-crest, and the whole point of the dam.
 *   - stream plots never need the shovel, so their table runs deep as flavour — K = 6.
 *   - gentle waterless ground takes the middle — K = 5.
 * No clearing (a pathological spec), the whole plot's modal level stands in for the
 * yard. Pure: reads only p.water / p.slope / p.level / p.clearing, so an old save's
 * plot yields the same table its plot id always had. Exported: siteworks.initWorks
 * backfills old saves with it, and the tests pin the derivation per plot.
 */
export function waterTableOf(p) {
  if (!p || !Array.isArray(p.level) || !p.w || !p.h) return 0;
  const cells = [];
  if (p.clearing) {
    for (let y = Math.max(0, p.clearing.y - p.clearing.ry);
      y <= Math.min(p.h - 1, p.clearing.y + p.clearing.ry); y++) {
      for (let x = Math.max(0, p.clearing.x - p.clearing.rx);
        x <= Math.min(p.w - 1, p.clearing.x + p.clearing.rx); x++) {
        const dx = (x - p.clearing.x) / p.clearing.rx, dy = (y - p.clearing.y) / p.clearing.ry;
        if (dx * dx + dy * dy <= 1) cells.push(p.level[y * p.w + x]);
      }
    }
  }
  if (!cells.length) for (const lv of p.level) cells.push(lv);
  const tally = new Map();
  for (const lv of cells) tally.set(lv, (tally.get(lv) || 0) + 1);
  let modal = null;
  for (const [lv, n] of tally) {
    if (modal === null || n > tally.get(modal) || (n === tally.get(modal) && lv < modal)) modal = lv;
  }
  const K = p.water === 'stream' ? 6 : ((p.slope || 0) >= 20 ? 4 : 5);
  return modal - K;
}

/* ---------------- actions ---------------- */

/** Fell one tree. Returns { ok, timber, cash } or { ok:false, msg }. */
export function fellTree(p, treeId) {
  const i = p.trees.findIndex((t) => t.id === treeId);
  if (i < 0) return { ok: false, msg: 'no such tree' };
  const t = p.trees[i];
  p.trees.splice(i, 1);
  const m3 = stemM3(t.kind);
  p.timber += m3;
  p.felled += 1;
  const cash = Math.round(PRICES.pineTree * m3 - PRICES.fellCost);
  return { ok: true, kind: t.kind, m3, cash };
}

/** Build something on a cell. */
export function build(p, kind, x, y) {
  const cost = PRICES[kind];
  if (cost == null) return { ok: false, msg: 'unknown build ' + kind };
  if (!inBounds(p, x, y)) return { ok: false, msg: 'off the plot' };
  const g = p.ground[idx(p, x, y)];
  if (g === 'water') return { ok: false, msg: 'cannot build in water' };
  if (p.trees.some((t) => t.x === x && t.y === y)) return { ok: false, msg: 'clear the tree first' };
  p.buildings.push({ kind, x, y });
  return { ok: true, cost, msg: `built ${kind}` };
}

/** What a plot is worth to you, and what it will cost to make it liveable. */
export function setupCost(p) {
  const hasWater = p.water === 'stream';
  const items = [
    { key: 'tank5000', label: '5 000 L water tank', cost: PRICES.tank5000 },
    { key: 'tankDelivery', label: 'tank delivery', cost: PRICES.tankDelivery },
    { key: 'toilet', label: 'compost toilet', cost: PRICES.toilet },
    { key: 'tools', label: 'tools', cost: PRICES.tools },
  ];
  if (!hasWater) items.push({ key: 'borehole', label: 'borehole (no stream)', cost: PRICES.borehole });
  return { items, total: items.reduce((a, i) => a + i.cost, 0) };
}

/** Harvestable timber if you fell every tree on the plot. */
export function standingValue(p) {
  const m3 = p.trees.reduce((a, t) => a + stemM3(t.kind), 0);
  return { m3: Math.round(m3 * 10) / 10, cash: Math.round(m3 * PRICES.pineTree - p.trees.length * PRICES.fellCost) };
}
