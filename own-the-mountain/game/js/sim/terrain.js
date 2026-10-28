// terrain.js — real Hogsback terrain for the sim: baked DEM (Int16 metres) + OSM
// features + plot anchors. PURE module: no fetch, no fs, no DOM. The browser decodes
// the .bin via DataView and calls setTerrain(); node tests read it with fs and call
// loadTerrain() + setTerrain(). With no terrain set, the sim keeps its procedural
// world (attachTerrain is simply never called).
// Owner: builder.

/** Slope sampling step in DEM pixels. 2px ~= 32m horizontal — matches the baked DEM
 *  resolution without being swamped by single-pixel terrarium noise. */
const GRAD_STEP = 2;

let ACTIVE = null; // module-global terrain (node tests / integration)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Normalize any plausible DEM input into an Int16Array of metres decoded as
 * Int16BE (the baked format): ArrayBuffer, Buffer/Uint8Array, or an Int16Array.
 * An Int16Array is accepted as-is when its values look like real elevations
 * (0..9000m); otherwise it is re-decoded big-endian from its backing buffer —
 * `new Int16Array(buf)` on a little-endian host byte-swaps the BE data, and
 * byte-swapped Hogsback elevations (713..1936m) always read negative.
 */
function toInt16BE(dem) {
  if (dem instanceof Int16Array) {
    let plausible = true;
    for (let i = 0; i < dem.length; i++) { const v = dem[i]; if (v < 0 || v > 9000) { plausible = false; break; } }
    if (plausible) return dem;
    const out = new Int16Array(dem.length);
    const dv = new DataView(dem.buffer, dem.byteOffset, dem.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, false);
    return out;
  }
  if (dem instanceof Uint8Array || dem instanceof ArrayBuffer) {
    const dv = dem instanceof ArrayBuffer ? new DataView(dem) : new DataView(dem.buffer, dem.byteOffset, dem.byteLength);
    const out = new Int16Array(dv.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, false);
    return out;
  }
  if (Array.isArray(dem)) return Int16Array.from(dem);
  return null;
}

/** Build the terrain object. demInt16: Int16 metres, row-major, width*height
 *  (ArrayBuffer/Buffer/Uint8Array accepted too — always decoded Int16BE). */
export function loadTerrain(demInt16, meta, mapJson) {
  const m = { ...(mapJson && mapJson.meta ? mapJson.meta : {}), ...(meta || {}) };
  return {
    meta: m,
    dem: toInt16BE(demInt16),
    osm: ((mapJson && mapJson.osm) || []).map((o) => ({ ...o })),
    plots: ((mapJson && mapJson.plots) || []).map((p) => ({ ...p })),
  };
}

/** Node-side (and integration) hook: install the terrain newGame() will attach. */
export function setTerrain(terrain) { ACTIVE = terrain || null; return ACTIVE; }
export function getTerrain() { return ACTIVE; }

/** Metres at (x,y) DEM pixels, bilinear, edges clamped. */
export function heightAt(t, x, y) {
  if (!t || !t.dem) return 0;
  const w = t.meta.width, h = t.meta.height, dem = t.dem;
  const cx = clamp(x, 0, w - 1), cy = clamp(y, 0, h - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = cx - x0, fy = cy - y0;
  const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
  const top = dem[i00] * (1 - fx) + dem[i10] * fx;
  const bot = dem[i01] * (1 - fx) + dem[i11] * fx;
  return top * (1 - fy) + bot * fy;
}

/** % grade at (x,y) via central difference over GRAD_STEP px each side. */
export function gradientAt(t, x, y) {
  if (!t || !t.dem) return 0;
  const mpp = t.meta.mPerPx || 16.1;
  const w = t.meta.width, h = t.meta.height, s = GRAD_STEP;
  const x0 = clamp(x - s, 0, w - 1), x1 = clamp(x + s, 0, w - 1);
  const y0 = clamp(y - s, 0, h - 1), y1 = clamp(y + s, 0, h - 1);
  // fall back to a 1px step at the edges so the difference never degenerates
  const dx = (x1 - x0) * mpp || mpp, dy = (y1 - y0) * mpp || mpp;
  const dzdx = (heightAt(t, x1, y) - heightAt(t, x0, y)) / dx;
  const dzdy = (heightAt(t, x, y1) - heightAt(t, x, y0)) / dy;
  return Math.sqrt(dzdx * dzdx + dzdy * dzdy) * 100;
}

/** Average % grade along the straight path a->b (sampled every ~GRAD_STEP px). */
export function pathGrade(t, ax, ay, bx, by) {
  if (!t || !t.dem) return 0;
  const mpp = t.meta.mPerPx || 16.1;
  const dx = bx - ax, dy = by - ay;
  const lenPx = Math.hypot(dx, dy);
  if (lenPx < 1e-6) return gradientAt(t, ax, ay);
  const steps = Math.max(1, Math.ceil(lenPx / GRAD_STEP));
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const x0 = ax + dx * t0, y0 = ay + dy * t0;
    const x1 = ax + dx * t1, y1 = ay + dy * t1;
    const run = Math.hypot(x1 - x0, y0 === y1 ? 0 : y1 - y0) * mpp;
    const rise = heightAt(t, x1, y1) - heightAt(t, x0, y0);
    sum += Math.abs(rise) / (run || mpp) * 100; // grade ignores direction
  }
  return sum / steps;
}

export function terrainBounds(t) {
  return {
    width: t.meta.width, height: t.meta.height,
    mPerPx: t.meta.mPerPx, elevMin: t.meta.elevMin, elevMax: t.meta.elevMax,
  };
}

/**
 * Attach real terrain to a live state: plot anchors get real x/y (DEM pixels),
 * elev (metres) and slope (% grade). Ids/names/biomes/forest/ownership/deeds stay.
 */
export function attachTerrain(state, terrain) {
  if (!state || !terrain) return state;
  // Reference the terrain for convenience, but NOT as part of the game state:
  // enumerable it stringifies to ~98 MB (the whole 13 MB DEM), which breaks any
  // save, snapshot or port. Use state.snapshot(g) for anything serialisable.
  Object.defineProperty(state, 'terrain', {
    value: terrain, enumerable: false, configurable: true, writable: true,
  });
  for (const p of state.plots) {
    const a = terrain.plots.find((q) => q.id === p.id);
    if (!a) continue; // keep procedural coords for anchors the bake didn't cover
    p.x = a.x; p.y = a.y;
    if (a.lat != null) p.lat = a.lat;
    if (a.lon != null) p.lon = a.lon;
    p.elev = Math.round(heightAt(terrain, a.x, a.y));
    p.slope = Math.round(gradientAt(terrain, a.x, a.y) * 10) / 10;
  }
  return state;
}
