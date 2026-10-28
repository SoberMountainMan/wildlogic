// holding.js — buying the land next door.
//
// The first plot is what you could afford. The second is what you can afford later, and
// it should feel like the same place growing: the grid extends, the trees on the new
// ground are real trees you can fell, and everything you already built keeps working.
//
// Extending the grid eastward (not replacing it) means every existing bed, hive and
// building keeps its coordinates and stays valid.

import { plotPrice } from './plotmap.js';
import { CELL_M } from './plotmap.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

export const EXPANSION = {
  ha: 0.5,          // what you buy each time
  max: 2,           // two expansions, so a holding tops out at about +1 ha
  premium: 1.05,    // a neighbouring erf is worth a little more split off
};

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

export function initHolding(h) {
  h.holding = h.holding || { bought: 0 };
  return h;
}

export function expansionPrice(h) {
  initHolding(h);
  return Math.round(plotPrice({ ha: EXPANSION.ha, kmFromShop: h.plot.kmFromShop }) * EXPANSION.premium);
}

export function canExpand(h) {
  initHolding(h);
  return h.holding.bought < EXPANSION.max;
}

/**
 * Buy the next-door land: add columns to the grid, seed them with ground and trees.
 * The household's forest baseline grows with it, so clearing the new pines still shows.
 */
export function expand(h) {
  initHolding(h);
  if (!canExpand(h)) return err('there is no more land next door');
  const price = expansionPrice(h);
  if (h.cash < price) return err(`the land next door is ${money(price)} — you have ${money(Math.round(h.cash))}`);

  const p = h.plot;
  const cells = Math.round((EXPANSION.ha * 10000) / (CELL_M * CELL_M));
  const addCols = Math.max(4, Math.round(cells / p.h));
  const oldW = p.w;
  const newW = oldW + addCols;

  // rebuild the ground row by row so existing coordinates stay put
  const ground = new Array(newW * p.h);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < newW; x++) {
      ground[y * newW + x] = x < oldW ? p.ground[y * oldW + x] : 'grass';
    }
  }

  // a strip of the new ground is rougher — it has not been worked
  for (let y = 0; y < p.h; y++) {
    for (let x = oldW; x < newW; x++) {
      const n = ((x * 7 + y * 13 + p.seed) % 11) / 11;
      ground[y * newW + x] = n > 0.8 ? 'scrub' : n < 0.12 ? 'mud' : 'grass';
    }
  }

  p.ground = ground;
  p.w = newW;
  p.ha = Math.round(((newW * p.h * CELL_M * CELL_M) / 10000) * 100) / 100;

  // trees on the new land: same mix as the rest of the plot
  const kind = p.forest === 'pine' ? 'pine' : p.forest === 'indigenous' ? 'indigenous' : 'mixed';
  let added = 0;
  const want = Math.round(addCols * p.h * (p.forest ? 0.08 : 0.02));
  for (let i = 0; i < want * 6 && added < want; i++) {
    const x = oldW + 1 + ((p.seed + i * 37) % Math.max(1, addCols - 2));
    const y = 1 + ((p.seed * 3 + i * 17) % Math.max(1, p.h - 2));
    if (x >= newW - 1) continue;
    const g = p.ground[y * newW + x];
    if (g === 'mud' || g === 'water') continue;
    if (p.trees.some((t) => t.x === x && t.y === y)) continue;
    p.trees.push({
      id: 't' + p.trees.length,
      x, y,
      kind: kind === 'mixed' ? (i % 2 ? 'pine' : 'indigenous') : kind,
      age: 8 + ((p.seed + i * 11) % 28),
    });
    added += 1;
  }

  h.holding.bought += 1;
  h.cash -= price;
  // the baseline grows too, so forest health does not jump to 200%
  h.forestStart = (h.forestStart || 1) + added;
  if (h.forest != null) h.forest = Math.min(100, Math.round((100 * p.trees.length) / h.forestStart));

  h.log.push({
    day: h.day,
    text: `Bought the land next door — ${EXPANSION.ha} ha, ${added} more trees. −${money(price)}`,
  });
  return ok('expanded', { price, ha: p.ha, trees: added, w: p.w, bought: h.holding.bought });
}

export function holdingSummary(h) {
  initHolding(h);
  return {
    bought: h.holding.bought,
    max: EXPANSION.max,
    ha: h.plot.ha,
    price: expansionPrice(h),
    canExpand: canExpand(h),
    w: h.plot.w,
    h: h.plot.h,
  };
}
