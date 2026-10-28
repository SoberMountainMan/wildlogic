// iso-math.js — pure 2:1 isometric math for the plot view. No DOM, no canvas.
//
// This module is the port contract for Godot: every function here has a direct
// equivalent in Godot's isometric TileMap (project ≈ map_to_local, cellAt ≈ local_to_map,
// depthKey ≈ y_sort_enabled). A GDScript port must reproduce these numbers exactly,
// which is what tests/26-iso.test.js pins.
//
// Convention: tile (x, y) is a grid cell; z is elevation in pixels (0 = flat).
// Screen space at 1x: sx = (x − y) · TW/2, sy = (x + y) · TH/2 − z.
// A camera is optional and always applied the same way: screen = world · zoom + origin.

/** Tile width at 1x, px. */
export const TW = 64;
/** Tile height at 1x, px — a 2:1 diamond. */
export const TH = 32;
const HW = TW / 2, HH = TH / 2;

/** True if cam is usable ({ox, oy, zoom} with finite zoom > 0); otherwise identity. */
function normCam(cam) {
  if (!cam || !Number.isFinite(cam.zoom) || cam.zoom <= 0) return { ox: 0, oy: 0, zoom: 1 };
  return {
    ox: Number.isFinite(cam.ox) ? cam.ox : 0,
    oy: Number.isFinite(cam.oy) ? cam.oy : 0,
    zoom: cam.zoom,
  };
}

/**
 * Project tile coordinates to screen pixels at 1x or through a camera.
 * @param {number} x tile coordinate (fractional allowed — tile centres are x+0.5)
 * @param {number} y tile coordinate
 * @param {number} [z=0] elevation in screen px (raises the point without moving it in grid space)
 * @param {{ox:number,oy:number,zoom:number}} [cam=null]
 * @returns {[number, number]} screen x, y
 */
export function project(x, y, z = 0, cam = null) {
  const c = normCam(cam);
  const zz = Number.isFinite(z) ? z : 0;
  const wx = (x - y) * HW;
  const wy = (x + y) * HH - zz;
  return [wx * c.zoom + c.ox, wy * c.zoom + c.oy];
}

/**
 * Inverse of project for the ground plane (z = 0). Fractional result — floor it for cell picking.
 * @returns {[number, number]} fractional tile x, y
 */
export function unproject(sx, sy, cam = null) {
  const c = normCam(cam);
  const wx = (sx - c.ox) / c.zoom;
  const wy = (sy - c.oy) / c.zoom;
  return [(wx / HW + wy / HH) / 2, (wy / HH - wx / HW) / 2];
}

/**
 * Which grid cell a screen point lands on, as integers. Returns null off-plane is
 * NOT checked here — bounds are the caller's business — but non-finite input gives null.
 * @returns {[number, number]|null}
 */
export function cellAt(sx, sy, cam = null) {
  const [fx, fy] = unproject(sx, sy, cam);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  return [Math.floor(fx), Math.floor(fy)];
}

/**
 * Painter's-order key: sort ascending and draw in that order for correct 2:1 occlusion
 * of objects anchored at their tile base. Monotonic in screen-y for integer cells,
 * which is exactly the invariant y_sort_enabled relies on in Godot.
 */
export function depthKey(x, y) { return x + y; }

/**
 * Screen-space bounding box of a w×h tile diamond at 1x (before camera).
 * The four corners of the grid: (0,0) top, (w,0) right, (0,h) left, (w,h) bottom.
 * @returns {{minX:number,maxX:number,minY:number,maxY:number,width:number,height:number}}
 */
export function gridBounds(w, h) {
  const minX = -h * HW, maxX = w * HW;
  const minY = 0, maxY = (w + h) * HH;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * A camera that fits a w×h tile grid into a viewW×viewH viewport with padding,
 * centred on the diamond. Pure, so the fit is testable in node.
 * @returns {{ox:number,oy:number,zoom:number}}
 */
export function fitCamera(w, h, viewW, viewH, pad = 24) {
  const b = gridBounds(w, h);
  const availW = Math.max(1, viewW - pad * 2);
  const availH = Math.max(1, viewH - pad * 2);
  const zoom = Math.min(availW / b.width, availH / b.height);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { ox: viewW / 2 - cx * zoom, oy: viewH / 2 - cy * zoom, zoom };
}
