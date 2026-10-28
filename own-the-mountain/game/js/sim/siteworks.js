// siteworks.js — tiles that connect: track, fence, and a bulldozer.
//
// PIVOT-PLAN §A4 (owner, 2026-10-21): "Fence your property for better security, gonna
// cost you. Inventory? fence tiles that connect? road tiles that connect? wanna flatten
// a peice of land, bulldozer gonna cost you rent and fuel."
//
// The plot carries the tiles (p.track, p.fence, p.flat) and the tile levels
// (p.level, from plotmap.makePlot — p.height is the derived metres); the household
// carries the money and the bulldozer's day (h.cash, h.bulldozerDay). Pure logic, no
// DOM, no RNG: laying a tile must never move a golden trace, so nothing here draws a
// number.
//
// The household argument is OPTIONAL and last. Without one the tile is still laid and the
// cost is returned but not charged — that keeps the geometry testable on a bare plot.

import { steep, flowLevels, waterTableOf, LEVEL_M } from './plotmap.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

export const COST = {
  track: 250,          // a dirt track: the odd culvert, the labour
  gravel: 400,         // a graded gravel road — more stone, more carting (owner call pending)
  mud: 120,            // the cheap muddy track (owner, 2026-10-21): it unlocks, and it bites
  fence: 180,          // a post, a wire, a strainer every so often
  flattenPerTile: 500, // a full 2.5 m of earth on a 2.5 m tile is serious earthworks
  dopPerTile: 500,     // dop costs the same earthworks — digging is grading, downwards
  bulldozer: 800,      // the hire, once per day — you do not rent it by the tile
};

/** Track crosses FLAT tiles and SLOPE tiles (the 45° ramp IS the pass) — steep ≤ 1.
 *  After the flow pass nothing is steeper than 1 anyway, but old saves can be. */
export const TRACK_MAX_STEEP = 1;

/** A building within this many tiles (Manhattan) of track pays no driveway surcharge. */
export const TRACK_REACH = 3;

const err = (msg) => ({ ok: false, msg });
const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const ADJ = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const inBounds = (p, x, y) => !!p && x >= 0 && y >= 0 && x < p.w && y < p.h;
const groundAt = (p, x, y) => p.ground[y * p.w + x];

/** Older saves and bare specs have no tile arrays or levels. Idempotent, no draws. */
export function initWorks(p) {
  if (!p) return p;
  if (!Array.isArray(p.track)) p.track = [];
  if (!Array.isArray(p.mud)) p.mud = [];
  if (!Array.isArray(p.fence)) p.fence = [];
  if (!Array.isArray(p.flat)) p.flat = [];
  // pre-terrain saves carried no levels: an all-zero field is flat ground, which is
  // exactly what their tiles always were. Everything here keeps working on it.
  if (p.w && p.h && !Array.isArray(p.level)) {
    p.level = new Array(p.w * p.h).fill(0);
    p.height = new Array(p.w * p.h).fill(0);
  }
  // the water table (TERRAIN-SPEC §7): plots made before it existed backfill from the
  // same derivation makePlot used — same id, same ground, same table.
  if (!Number.isInteger(p.waterTable)) p.waterTable = waterTableOf(p);
  if (!Array.isArray(p.damTiles)) p.damTiles = [];
  // track kind (owner GO 2026-10-22, L3): layTrack always computed `roadKind` and threw it
  // away, so gravel and dirt were indistinguishable on the map. Old saves backfill as
  // dirt — that is what every tile laid before today actually was.
  if (Array.isArray(p.track)) for (const t of p.track) if (!t.kind) t.kind = 'dirt';
  return p;
}

const at = (list, x, y) => Array.isArray(list) && list.some((t) => t.x === x && t.y === y);

export function trackAt(p, x, y) { return at(p && p.track, x, y); }
export function mudAt(p, x, y) { return at(p && p.mud, x, y); }
export function fenceAt(p, x, y) { return at(p && p.fence, x, y); }
export function isFlat(p, x, y) { return at(p && p.flat, x, y); }

/** The gate tile is the only place a line may begin. */
const isGate = (p, x, y) => !!p.gate && p.gate.x === x && p.gate.y === y;

/** True when (x, y) is one of the gate's four shoulders — the first tile of a run.
    "From the gate" means from the gate's edge, not only the one tile the gate stands on
    (owner verdict, 2026-10-21: the first fence was unplaceable from the map). */
function gateShoulder(p, x, y) {
  return !!p.gate && ADJ.some(([dx, dy]) => p.gate.x + dx === x && p.gate.y + dy === y);
}

/** Track connects to the gate (or its shoulders), to track, or to mud laid beside it —
    the gravel run may continue a mud run (and the upgrade follows the same line). */
export function trackConnects(p, x, y) {
  if (!p.gate) return true;
  if (isGate(p, x, y) || gateShoulder(p, x, y)) return true;
  return ADJ.some(([dx, dy]) => trackAt(p, x + dx, y + dy) || mudAt(p, x + dx, y + dy));
}

/** A fence connects to the gate (or its shoulders), to fence beside it, or to track or
    mud beside it. */
export function fenceConnects(p, x, y) {
  if (!p.gate) return true;
  if (isGate(p, x, y) || gateShoulder(p, x, y)) return true;
  return ADJ.some(([dx, dy]) => fenceAt(p, x + dx, y + dy) || trackAt(p, x + dx, y + dy)
    || mudAt(p, x + dx, y + dy));
}

/* ---- track: the driveway you lay yourself (PIVOT-PLAN §A4) --------------------
   The siteworks answer to plotmap's driveway surcharge: instead of paying H$120 a tile
   for a driveway the game cuts FOR you, you lay H$250 tiles yourself, from the gate out.
   More expensive per tile, but it is yours, it is visible, and a building beside it pays
   no surcharge at all (see buildAccom in tourism.js). */

/**
 * Lay one track tile. Laying over an existing MUD tile converts it — the mud is not
 * credited (the owner prices earthworks, not good intentions): the full H$250 is paid
 * again, and the muddy tile comes up under the gravel.
 * @param {object} p plot
 * @param {number} x
 * @param {number} y
 * @param {object} [h] household to bill (optional)
 */
export function layTrack(p, x, y, h, kind = 'dirt') {
  initWorks(p);
  const roadKind = kind === 'gravel' ? 'gravel' : 'dirt';
  if (!inBounds(p, x, y)) return err('off the plot');
  if (groundAt(p, x, y) === 'water') return err('you cannot lay track through water — a culvert is not in the budget');
  // TERRAIN-SPEC §6: track crosses flat ground and the 45° ramp (steep ≤ 1) — that is
  // the whole point of a slope tile. A wall (old saves) is refused.
  if (steep(p, x, y) > TRACK_MAX_STEEP) {
    return err('too steep for track there — a bakkie will not climb it; find another line or flatten one');
  }
  if (trackAt(p, x, y)) return err('there is already track on that tile');
  if (!trackConnects(p, x, y)) {
    return err('track has to start at the gate and run tile by tile — that tile does not touch the track');
  }
  const overMud = mudAt(p, x, y);
  const cost = COST.track;
  if (h && h.cash < cost) return err(`track costs ${money(cost)} a tile — you have ${money(Math.round(h.cash))}`);
  if (overMud) p.mud = p.mud.filter((t) => !(t.x === x && t.y === y));
  p.track.push({ x, y, kind: roadKind });
  if (h) {
    h.cash -= cost;
    h.log.push({
      day: h.day,
      text: overMud
        ? `Gravel over the mud (${p.track.length} tiles gravelled). The mud is not credited — ` +
          `earthworks cost what they cost. −${money(cost)}`
        : `Track laid (${p.track.length} tiles). −${money(cost)}`,
    });
  }
  return ok(overMud ? 'mud tile upgraded to track' : `track laid (${p.track.length} tiles)`,
    { cost, x, y, tiles: p.track.length, upgraded: overMud });
}

/**
 * Lay one MUD track tile (owner GO, 2026-10-21): "give them a cheap muddy track that
 * helps unlock and can be used but causes problems with guests gettin stuck and wanting
 * you to upgrade it. especially if you build one on a slope."
 * H$120 a tile, the same connectivity rule as track (gate, shoulders, or a laid tile
 * beside it), the same steep ≤ 1 gate. It IS a driveway: any rung that needs one is
 * listed and the surcharge is cancelled — and every rain day on it is a gamble.
 * Laying track over a mud tile converts it at full price (see layTrack).
 */
export function layMud(p, x, y, h) {
  initWorks(p);
  if (!inBounds(p, x, y)) return err('off the plot');
  if (groundAt(p, x, y) === 'water') return err('you cannot push mud through water — a culvert is not in the budget');
  if (steep(p, x, y) > TRACK_MAX_STEEP) {
    return err('too steep for even mud there — find another line or flatten one');
  }
  if (mudAt(p, x, y)) return err('there is already mud on that tile');
  if (trackAt(p, x, y)) return err('that tile is already gravelled');
  if (!trackConnects(p, x, y)) {
    return err('the mud has to start at the gate and run tile by tile — that tile does not touch the track');
  }
  const cost = COST.mud;
  if (h && h.cash < cost) return err(`mud track costs ${money(cost)} a tile — you have ${money(Math.round(h.cash))}`);
  p.mud.push({ x, y });
  if (h) {
    h.cash -= cost;
    h.log.push({ day: h.day, text: `Mud track laid (${p.mud.length} tiles). Cheap now — interesting after rain. −${money(cost)}` });
  }
  return ok(`mud laid (${p.mud.length} tiles)`, { cost, x, y, tiles: p.mud.length });
}

/**
 * Lay one fence tile. Same connectivity rule as track, except a fence may also start
 * off an existing track — you fence up to the road you already have.
 */
export function layFence(p, x, y, h) {
  initWorks(p);
  if (!inBounds(p, x, y)) return err('off the plot');
  if (groundAt(p, x, y) === 'water') return err('a fence in the stream is a fence the river takes');
  if (fenceAt(p, x, y)) return err('there is already a fence on that tile');
  if (!fenceConnects(p, x, y)) {
    return err('a fence has to run from the gate or from fence you have already set — that tile touches neither');
  }
  const cost = COST.fence;
  if (h && h.cash < cost) return err(`fence costs ${money(cost)} a tile — you have ${money(Math.round(h.cash))}`);
  p.fence.push({ x, y });
  if (h) {
    h.cash -= cost;
    h.log.push({ day: h.day, text: `Fence post set (${p.fence.length} tiles). −${money(cost)}` });
  }
  return ok(`fence set (${p.fence.length} tiles)`, { cost, x, y, tiles: p.fence.length });
}

/**
 * Share of the plot's boundary ring that carries fence. 0..1.
 * Honest and cheap: tonight this is a visible count, not a theft system.
 */
export function fencedShare(p) {
  if (!p || !p.w || !p.h) return 0;
  let ring = 0;
  let fenced = 0;
  for (let x = 0; x < p.w; x++) {
    for (let y = 0; y < p.h; y++) {
      if (x !== 0 && y !== 0 && x !== p.w - 1 && y !== p.h - 1) continue;
      ring++;
      if (fenceAt(p, x, y)) fenced++;
    }
  }
  return ring ? fenced / ring : 0;
}

/**
 * Flatten a w × h block. Every tile is cut/filled to its neighbours' MODAL level
 * (TERRAIN-SPEC §6 — the most common of the 4 orthogonal levels, ties prefer the
 * lower cut): a slope tile is pulled into the platform it leans on, and repeated
 * passes widen that platform — the step moves out, tile by tile, exactly like a TT
 * terraform. H$500 a tile (a full 2.5 m of earth is serious earthworks), plus the
 * bulldozer's H$800 for the day, charged once, on the first flatten of the day
 * (h.bulldozerDay). Targets are read from the pre-flatten levels, so a block's cost
 * does not depend on the order the blade crosses it.
 * Refuses water and standing trees: clear the tree first, or the blade is a bill and a
 * broken saw.
 * @param {object} p plot
 * @param {number} x @param {number} y top-left of the block
 * @param {number} w @param {number} hgt block size in tiles
 * @param {object} [h] household to bill (optional)
 */
export function flatten(p, x, y, w, hgt, h) {
  initWorks(p);
  const bw = Math.max(1, Math.round(w || 1));
  const bh = Math.max(1, Math.round(hgt || 1));
  if (!inBounds(p, x, y) || !inBounds(p, x + bw - 1, y + bh - 1)) return err('that block runs off the plot');

  const tiles = [];
  for (let j = y; j < y + bh; j++) {
    for (let i = x; i < x + bw; i++) {
      if (groundAt(p, i, j) === 'water') {
        return err('there is water in that block — you cannot flatten a stream');
      }
      if (p.trees.some((t) => t.x === i && t.y === j)) {
        return err('there is a tree standing in that block — fell it first');
      }
      if (!isFlat(p, i, j)) tiles.push({ x: i, y: j });
    }
  }
  if (!tiles.length) return ok('already flat', { cost: 0, tiles: 0, bulldozer: 0 });

  /** Modal level of a tile's in-bounds orthogonal neighbours; ties prefer the cut. */
  const mode = (tx, ty) => {
    const tally = new Map();
    for (const [dx, dy] of ADJ) {
      if (!inBounds(p, tx + dx, ty + dy)) continue;
      const lv = p.level[(ty + dy) * p.w + tx + dx];
      tally.set(lv, (tally.get(lv) || 0) + 1);
    }
    let best = null;
    for (const [lv, n] of tally) {
      if (best === null || n > tally.get(best) || (n === tally.get(best) && lv < best)) best = lv;
    }
    return best == null ? p.level[ty * p.w + tx] : best;
  };

  /** The MODAL level of a list of tiles — a block is graded to ONE plateau. */
  const blockMode = (list) => {
    const tally = new Map();
    for (const t of list) tally.set(p.level[t.y * p.w + t.x], (tally.get(p.level[t.y * p.w + t.x]) || 0) + 1);
    let best = null;
    for (const [lv, n] of tally) {
      if (best === null || n > tally.get(best) || (n === tally.get(best) && lv < best)) best = lv;
    }
    return best;
  };

  // A BLOCK is graded to one plateau at the block's modal level — that is how you cut a
  // building site across a step. A SINGLE tile grades to its neighbours' modal level
  // (§6): protrusions and potholes pull into the platform they lean on. A straight step
  // through a one-tile-wide cut cannot move — grade a block instead.
  const target = tiles.length === 1 ? mode(tiles[0].x, tiles[0].y) : blockMode(tiles);
  const targets = tiles.map((t) => {
    const cur = p.level[t.y * p.w + t.x];
    return { ...t, target, moved: target !== cur ? 1 : 0 };
  });
  const earthMoved = targets.reduce((a, t) => a + t.moved, 0);

  const dozer = !h || h.bulldozerDay !== h.day;
  const cost = tiles.length * COST.flattenPerTile + (dozer ? COST.bulldozer : 0);
  if (h && h.cash < cost) {
    return err(`flattening that block costs ${money(cost)}${dozer ? ' (including the bulldozer)' : ''} — you have ${money(Math.round(h.cash))}`);
  }

  for (const t of targets) {
    p.flat.push({ x: t.x, y: t.y });
    p.level[t.y * p.w + t.x] = t.target;
  }
  // grading can raise a rim against higher ground beyond it: re-flow so the terrain
  // still passes tile by tile, then re-derive the metres the renderer reads.
  flowLevels(p);
  for (let i = 0; i < p.level.length; i++) p.height[i] = p.level[i] * LEVEL_M;
  if (h) {
    h.cash -= cost;
    if (dozer) h.bulldozerDay = h.day;
    h.log.push({
      day: h.day,
      text: `Bulldozer in: ${tiles.length} tile${tiles.length === 1 ? '' : 's'} graded (${earthMoved} moved). −${money(cost)}`
        + (dozer ? ` (${money(COST.bulldozer)} of that is the hire)` : ''),
    });
  }
  return ok(`flattened ${tiles.length} tiles`, { cost, tiles: tiles.length, earthMoved, bulldozer: dozer ? COST.bulldozer : 0 });
}

/** Is a site within reach of laid track? Manhattan, same grid the driveway uses. */
export function trackWithin(p, x, y, reach = TRACK_REACH) {
  if (!p || !Array.isArray(p.track) || !p.track.length) return false;
  return p.track.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) <= reach);
}

/** Is a site within reach of ANY laid driveway — gravel or mud? Mud lists a rung
    exactly as track does (owner GO 2026-10-21: mud is the unlock, track the upgrade). */
export function driveWithin(p, x, y, reach = TRACK_REACH) {
  return trackWithin(p, x, y, reach)
    || (!!p && Array.isArray(p.mud) && p.mud.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) <= reach));
}

/* ---- the mud model (owner GO 2026-10-21) --------------------------------------
   Deterministic constants, no RNG here: tourism draws its own stream against
   stuckChance, so a save reloads to the same stuck nights. */

export const MUD = {
  base: 0.25,        // a wet night on an all-mud drive: one-in-four the car does not arrive
  trackBase: 0.08,   // gravel is not magic — a wet gravel drive can still glue a tyre
  slopeMud: 0.10,    // every SLOPE tile under mud adds this to the wet-night chance
  slopeTrack: 0.03,  // the upgrade tames it: gravel on a ramp barely slips
  cap: 0.9,          // never a certainty — the mountain does not promise anything
  wear: 2.5,         // mud wears the road ~2.5x faster than gravel (traffic term)
};

/**
 * The wet-night stuck chance for a driveway, pure and exposed so the sim, the HUD and
 * the tests read one formula.
 * @param {number} mudShare 0..1 — the share of the unit's laid driveway that is mud
 * @param {number} slopeCount how many SLOPE tiles (the 45° ramps) sit under the drive
 * @returns {number} 0..MUD.cap
 */
export function stuckChance(mudShare, slopeCount) {
  const s = Math.max(0, Math.min(1, Number(mudShare) || 0));
  const n = Math.max(0, Number(slopeCount) || 0);
  const base = s * MUD.base + (1 - s) * MUD.trackBase;
  const slope = n * (s * MUD.slopeMud + (1 - s) * MUD.slopeTrack);
  return Math.min(MUD.cap, base + slope);
}

/**
 * What the driveway near (x, y) is made of: counts of laid tiles within reach, with the
 * slope tiles under mud counted out — the inputs stuckChance wants.
 * @returns {{mud, track, mudSlope, tiles, share}} share is the mud fraction (0 when
 *   nothing is laid; mudSlope only counts slope tiles that carry MUD).
 */
export function driveAccess(p, x, y, reach = TRACK_REACH) {
  let mud = 0;
  let track = 0;
  let mudSlope = 0;
  if (p && Array.isArray(p.mud)) {
    for (const t of p.mud) {
      if (Math.abs(t.x - x) + Math.abs(t.y - y) <= reach) {
        mud++;
        if (steep(p, t.x, t.y) > 0) mudSlope++;
      }
    }
  }
  if (p && Array.isArray(p.track)) {
    for (const t of p.track) {
      if (Math.abs(t.x - x) + Math.abs(t.y - y) <= reach) track++;
    }
  }
  const tiles = mud + track;
  return { mud, track, mudSlope, tiles, share: tiles ? mud / tiles : 0 };
}

/**
 * Raise or lower one tile by ONE level (2.5 m — the 45° run), TT-style. The flow pass
 * runs afterwards, so the ground still passes tile by tile: raising a shelf can drag a
 * rim onto the neighbours, lowering one can pull the rim down with it — every tile the
 * blade actually moved is billed (COST.flattenPerTile each), plus the bulldozer's day
 * (COST.bulldozer, once per day, same h.bulldozerDay flag flatten uses). Refuses water
 * (a dam is dug, not graded) and standing trees (fell first, or the blade breaks).
 * @param {object} p plot
 * @param {number} x @param {number} y the tile
 * @param {number} delta +1 to raise, −1 to lower
 * @param {object} [h] household to bill (optional)
 */
export function grade(p, x, y, delta, h) {
  initWorks(p);
  if (!inBounds(p, x, y)) return err('off the plot');
  if (groundAt(p, x, y) === 'water') return err('you cannot grade the stream — dig a dam instead');
  if (p.trees.some((t) => t.x === x && t.y === y)) {
    return err('a tree stands there — fell it before the blade comes');
  }
  const d = delta >= 0 ? 1 : -1;
  const before = p.level.slice();
  p.level[y * p.w + x] += d;
  // re-flow so the ground still flows; the blade pays for every tile it moved,
  // including the rim tiles the flow pass pulled along
  flowLevels(p);
  let moved = 0;
  for (let i = 0; i < p.level.length; i++) {
    if (p.level[i] !== before[i]) moved++;
  }
  if (!moved) return err('the ground does not move — grade a neighbour instead');
  for (let i = 0; i < p.level.length; i++) p.height[i] = p.level[i] * LEVEL_M;
  const dozer = !h || h.bulldozerDay !== h.day;
  const cost = moved * COST.flattenPerTile + (dozer ? COST.bulldozer : 0);
  if (h && h.cash < cost) {
    // refuse BEFORE anything is billed or marked — the ground returns to what it was
    for (let i = 0; i < before.length; i++) { p.level[i] = before[i]; p.height[i] = before[i] * LEVEL_M; }
    return err(`grading costs ${money(cost)} (${moved} tile${moved === 1 ? '' : 's'} of earth${dozer ? ' + the bulldozer' : ''}) — you have ${money(Math.round(h.cash))}`);
  }
  if (d > 0 && p.level[y * p.w + x] === before[y * p.w + x] + d && steep(p, x, y) === 0
    && p.flat && !p.flat.some((t) => t.x === x && t.y === y)) {
    // the blade finished a plateau: the tile earns its flat marking like any graded yard
    p.flat.push({ x, y });
  }
  if (h) {
    h.cash -= cost;
    if (dozer) h.bulldozerDay = h.day;
    h.log.push({
      day: h.day,
      text: `Bulldozer: ground ${d > 0 ? 'raised' : 'lowered'} at ${x},${y} — ${moved} tile${moved === 1 ? '' : 's'} of earth moved. −${money(cost)}`
        + (dozer ? ` (${money(COST.bulldozer)} of that is the hire)` : ''),
    });
  }
  return ok(`ground ${d > 0 ? 'raised' : 'lowered'} (${moved} tiles moved)`,
    { cost, moved, bulldozer: dozer ? COST.bulldozer : 0, x, y });
}

/* ---- dop: the dam dig (TERRAIN-SPEC §7, owner 2026-10-21) ----------------------
   "would dopping to a certain level later fill a dam, or must it be a stream
   already?" — no stream needed: the plot carries a WATER TABLE (plotmap.waterTableOf),
   and the bulldozer lowering tiles below it strikes water that seeps the hole full
   over days. The mirror of flatten's rise-capable grading: dop only ever digs DOWN,
   one level per call, H$500 a tile plus the bulldozer's day. v1 keeps it simple:
   only FLAT tiles take the blade — dig the flat and the wall above does the holding
   (TT-style, the player builds the dam wall by raising); a slope tile refuses. */

/** Levels a day a dam seeps up toward the water table — a 4-level-deep dam takes 20
    days: visible progress, not instant. Pure constant, tests pin it. */
export const FILL_PER_DAY = 0.2;

/**
 * Whether the blade may take this tile (TERRAIN-SPEC §7, v1 rule): FLAT ground and
 * PIT FLOORS dig — a depression bottom is still level ground to stand on, and it is
 * how a dam gets deep (dig, the rim steps down with the flow, dig again). The blade
 * refuses the RAMP proper: a tile that rises toward higher ground on one side while
 * falling to lower on the other is the 45° wedge — the wall that holds the water.
 * Dig the flat beside it; the wall above does the holding. (A strict tileFlat gate
 * would strand the dam: the flow pass clamps every rim down to hole+1, the hole
 * reads as a slope after the first dig, and the table — 4 levels down on the kloof —
 * is unreachable. The wedge is the actual wall; that is what refuses.)
 * Exported: the renderer's popup copies this gate so the ghost and the sim agree.
 */
export function dopDiggable(p, x, y) {
  if (!p || !Array.isArray(p.level) || x < 0 || y < 0 || x >= p.w || y >= p.h) return false;
  const lv = p.level[y * p.w + x];
  let hi = false;
  let lo = false;
  for (const [dx, dy] of ADJ) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
    const d = p.level[ny * p.w + nx] - lv;
    if (d > 0) hi = true;
    if (d < 0) lo = true;
  }
  return !(hi && lo);
}

/**
 * Dop one tile — the single-tile form of dopBlock. A ramp tile refuses outright:
 * 'dig the flat ground — a slope wall is a wall, not a dam'.
 * @param {object} p plot
 * @param {number} x @param {number} y the tile
 * @param {object} [h] household to bill (optional)
 */
export function dop(p, x, y, h) {
  return dopBlock(p, x, y, 1, 1, h);
}

/**
 * Dop a w × hgt block one level DOWN. Every diggable, dry, treeless tile in the
 * block lowers one level (ramp tiles are left standing — a block straddling a step
 * digs the flat ground and the pit floors only; see dopDiggable); the flow pass
 * runs afterwards, so the ground still passes tile by tile: a hole is a depression,
 * not a cliff, and the rim terraces down with the dig. Any tile left BELOW
 * p.waterTable becomes a dam floor — it lands in p.damTiles and siteworks.tickWater
 * seeps it toward the table at FILL_PER_DAY levels a day. Cost: H$500 a tile dug
 * (COST.dopPerTile) plus the bulldozer's day (COST.bulldozer, once per day, the
 * same h.bulldozerDay flag flatten and grade use). Refuses water (the stream is
 * its own dam) and standing trees (fell first).
 * @param {object} p plot
 * @param {number} x @param {number} y top-left of the block
 * @param {number} w @param {number} hgt block size in tiles
 * @param {object} [h] household to bill (optional)
 */
export function dopBlock(p, x, y, w, hgt, h) {
  initWorks(p);
  const bw = Math.max(1, Math.round(w || 1));
  const bh = Math.max(1, Math.round(hgt || 1));
  if (!inBounds(p, x, y) || !inBounds(p, x + bw - 1, y + bh - 1)) return err('that block runs off the plot');

  const tiles = [];
  let skipped = 0;
  for (let j = y; j < y + bh; j++) {
    for (let i = x; i < x + bw; i++) {
      if (groundAt(p, i, j) === 'water') {
        return err('there is water in that block — the stream is its own dam');
      }
      // ground precedence: a tile the mountain will not let you dig (a ramp/wall)
      // refuses BEFORE whatever stands on it — felling a tree to dig a wall is
      // advice that leads nowhere. Only diggable tiles can refuse for trees.
      if (!dopDiggable(p, i, j)) { skipped++; continue; }
      if (p.trees.some((t) => t.x === i && t.y === j)) {
        return err('there is a tree standing in that block — fell it first');
      }
      tiles.push({ x: i, y: j });
    }
  }
  if (!tiles.length) {
    return err(skipped
      ? 'dig the flat ground — a slope wall is a wall, not a dam'
      : 'that ground will not dig');
  }

  const dozer = !h || h.bulldozerDay !== h.day;
  const cost = tiles.length * COST.dopPerTile + (dozer ? COST.bulldozer : 0);
  if (h && h.cash < cost) {
    return err(`dopping that block costs ${money(cost)}${dozer ? ' (including the bulldozer)' : ''} — you have ${money(Math.round(h.cash))}`);
  }

  for (const t of tiles) p.level[t.y * p.w + t.x] -= 1;
  // re-flow so the terrain still flows (the rim steps down with the dig — terraces,
  // never cliffs), then re-derive the metres the renderer reads
  flowLevels(p);
  for (let i = 0; i < p.level.length; i++) p.height[i] = p.level[i] * LEVEL_M;

  // below the table: a dam floor. It starts dry — the seep is tickWater's work.
  let struck = false;
  for (const t of tiles) {
    const i = t.y * p.w + t.x;
    if (p.level[i] < p.waterTable) {
      struck = true;
      if (!p.damTiles.some((d) => d.x === t.x && d.y === t.y)) p.damTiles.push({ x: t.x, y: t.y, depth: 0 });
    }
  }

  if (h) {
    h.cash -= cost;
    if (dozer) h.bulldozerDay = h.day;
    h.log.push({
      day: h.day,
      text: `Bulldozer: ${tiles.length} tile${tiles.length === 1 ? '' : 's'} dopped a level down`
        + (skipped ? ` (${skipped} slope tile${skipped === 1 ? '' : 's'} left standing)` : '')
        + (struck ? ' — the bottom is below the water table; it will seep' : '')
        + `. −${money(cost)}` + (dozer ? ` (${money(COST.bulldozer)} of that is the hire)` : ''),
    });
  }
  return ok(`dopped ${tiles.length} tile${tiles.length === 1 ? '' : 's'} a level down`,
    { cost, tiles: tiles.length, skipped, damTiles: p.damTiles.length, struck, bulldozer: dozer ? COST.bulldozer : 0 });
}

/**
 * What a dig WOULD do, without doing it — the number LD-12 asked for (lead 2026-10-23).
 *
 * The level seat measured the dam and found the game's silence was the trap: a dig
 * stops at the FIRST strike (one level under the table), so the cheapest wait is five
 * days — and the thirst clock kills an unwatered plot in three. The dop row priced the
 * earth and said nothing about the wait, so a first-timer could spend H$16,800 on a
 * hole and die of thirst on day 3 while it filled. This is the pure function the popup
 * and the ghost need: no mutation, no RNG, no draw, nothing charged.
 *
 * The `days` figure is not an estimate of the FILL — it is what `tickWater` will
 * actually do: the shallowest struck tile needs `target` levels of water and seeps
 * `FILL_PER_DAY` levels a day, so days = target / FILL_PER_DAY (0.2 -> five days a
 * level). The `reps` figure IS an estimate, because the rim terraces down with the dig
 * and the ground can change under a repeated block; the first dig is exact.
 *
 * The thirst window is NOT copied here on purpose: `WATER.deathDays` lives in
 * homestead.js, which imports this module, so importing it back would be a cycle — and
 * a duplicated constant is how a warning goes stale. Callers compare `days` against
 * the number the report already shows.
 *
 * @param {object} p plot
 * @param {number} x @param {number} y top-left of the block
 * @param {number} [w] @param {number} [hgt] block size in tiles (default 1x1)
 * @param {number} [reps] how many times the block would be dopped (default 1)
 * @param {object} [h] household, only to know whether the bulldozer is already paid today
 * @returns {object} { ok, tiles, blocked, skipped, cost, bulldozer, strikes, depthLevels,
 *                    days, digsToStrike, table, floor }
 */
export function damEstimate(p, x, y, w = 1, hgt = 1, reps = 1, h = null) {
  if (!p) return err('no plot to dig');
  initWorks(p);
  if (!Number.isInteger(p.waterTable)) return err('this ground has no water table');
  const bw = Math.max(1, Math.round(w || 1));
  const bh = Math.max(1, Math.round(hgt || 1));
  if (!inBounds(p, x, y) || !inBounds(p, x + bw - 1, y + bh - 1)) return err('that block runs off the plot');

  const levels = [];
  let skipped = 0;
  let blocked = null;
  for (let j = y; j < y + bh && !blocked; j++) {
    for (let i = x; i < x + bw && !blocked; i++) {
      if (groundAt(p, i, j) === 'water') blocked = 'there is water in that block — the stream is its own dam';
      else if (!dopDiggable(p, i, j)) skipped++;
      else if (p.trees.some((t) => t.x === i && t.y === j)) blocked = 'there is a tree standing in that block — fell it first';
      else levels.push(p.level[j * p.w + i]);
    }
  }
  if (blocked) return err(blocked);
  if (!levels.length) {
    return err(skipped ? 'dig the flat ground — a slope wall is a wall, not a dam' : 'that ground will not dig');
  }

  const n = Math.max(1, Math.round(reps || 1));
  const floors = levels.map((lv) => lv - n);
  const targets = floors.map((f) => p.waterTable - f).filter((t) => t > 0);
  const strikes = targets.length > 0;
  // the fewest digs that would put ANY tile of this block below the table
  const digsToStrike = Math.max(1, Math.min(...levels.map((lv) => lv - p.waterTable + 1)));
  const minTarget = strikes ? Math.min(...targets) : 0;
  const dozer = !h || h.bulldozerDay !== h.day;

  return ok(strikes
    ? `strikes water and needs ${Math.ceil(minTarget / FILL_PER_DAY)} day${Math.ceil(minTarget / FILL_PER_DAY) === 1 ? '' : 's'} to seep full`
    : `will not reach water at this depth — about ${digsToStrike} dig${digsToStrike === 1 ? '' : 's'} down from here`, {
    tiles: levels.length,
    skipped,
    cost: levels.length * COST.dopPerTile + (dozer ? COST.bulldozer : 0),
    bulldozer: dozer ? COST.bulldozer : 0,
    strikes,
    depthLevels: strikes ? minTarget : 0,
    days: strikes ? Math.ceil(minTarget / FILL_PER_DAY) : null,
    digsToStrike,
    table: p.waterTable,
    floor: Math.min(...floors),
  });
}

/**
 * The fill sim (TERRAIN-SPEC §7), called from homestead.endDay BEFORE the water
 * clock, so the night the dam fills is the night the countdown stops. Each dam tile
 * seeps toward the table at FILL_PER_DAY levels a day (t.depth in levels). The day
 * ANY dam tile reaches the table the plot HAS water: h.water.stream goes on — the
 * same signal the stream plots carry, so waterOk, the beds and the clock all read
 * one flag — the log notes it once ('The dam seeped full. You have water.'), and
 * the water clock stops biting. A dam tile raised back out of the table (the player
 * graded over it) dries and leaves the list. Pure bookkeeping: no RNG, log text is
 * not in snap(), so the golden traces cannot move.
 * @param {object} h household
 * @returns {string|null} the log line when the dam first filled, else null
 */
export function tickWater(h) {
  if (!h || !h.plot || !h.water) return null;
  const p = initWorks(h.plot);
  const dams = p.damTiles;
  if (!dams.length || !Number.isInteger(p.waterTable)) return null;
  let full = false;
  for (let d = dams.length - 1; d >= 0; d--) {
    const t = dams[d];
    const floor = p.level[t.y * p.w + t.x];
    if (floor >= p.waterTable) { dams.splice(d, 1); continue; }   // dug out or graded back in
    const target = p.waterTable - floor;
    if ((t.depth || 0) < target) t.depth = Math.min(target, (t.depth || 0) + FILL_PER_DAY);
    if (t.depth >= target - 1e-9) full = true;
  }
  if (full && !h.water.stream) {
    h.water.stream = true;
    h.water.thirst = 0;
    h.log.push({ day: h.day, text: 'The dam seeped full. You have water.' });
    return 'The dam seeped full. You have water.';
  }
  return null;
}

/** What the plot summary shows: the counts, and the one share that matters tonight. */
export function siteworksSummary(p) {
  initWorks(p);
  return {
    track: p.track.length,
    mud: p.mud.length,
    fence: p.fence.length,
    flat: p.flat.length,
    fencedShare: Math.round(fencedShare(p) * 1000) / 1000,
    costs: { ...COST },
  };
}
