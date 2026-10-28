// iso-render.js — the plot in 2:1 isometric. Drop-in twin of PlotRenderer:
// same constructor opts, same public surface (setPlot/setHomestead/mode/buildKind/
// frame/resize), so plot.html can switch views without touching its logic.
//
// Structure mirrors Godot so the port is mechanical (see ISO-PLAN.md):
//   ground layer — every tile diamond, baked ONCE per camera zoom into an offscreen
//                  canvas (Godot: a TileMap node)
//   object layer — trees/beds/hives/buildings drawn per frame in ascending depthKey
//                  order, each sprite anchored at its tile base (Godot: Node2D +
//                  y_sort_enabled, Sprite2D anchored at the tile position)
//   sprites.js   — the draw functions that become Sprite2D textures / the atlas
//
// Elevation is GEOMETRY now (TERRAIN-SPEC §3, owner 2026-10-21): every tile draws as a
// quad raised to its height (plotmap p.height, half-metre grid), and where the ground
// falls to a lower neighbour the exposed face draws as a bare-earth SKIRT — the
// classic TT wall. Quads + skirts are STATIC ground (they only move when the terrain
// is terraformed), so they bake once per zoom step / height hash into an offscreen
// canvas, exactly like the old pixel bake; everything that stands ON the ground
// (trees, beds, hives, buildings, fences, badges) anchors at its tile's raised base.

import { project, unproject, depthKey, fitCamera, TW, TH, gridBounds } from './iso-math.js';
import { drawSprite, SPRITES, PALETTE, seasonTint, accomSprite } from './sprites.js';
import { GROUND_TEX } from './ground-images.js';

// Colours come from the art seat's one table (TEAM-BOARD Request, technical-artist):
// art tunes PALETTE; the renderer never carries its own colour constants.
const GROUND = PALETTE.ground;
const BACKDROP = PALETTE.backdrop;

/* ---- generated ground textures (owner: "the green cant be flat green we need
   texture"; "the dirt tracks still need to exist"). The six watercolour textures
   are embedded as JPEG data URIs, decoded once, and painted as CanvasPatterns whose
   matrix IS the iso projection — the texture follows the ground plane continuously
   across tiles. Composited in 'overlay' over the flat base colour, so the palette's
   green hue stays and only painted detail comes in (the brown-carpet trap). ---- */
const groundTex = {};
let groundTexState = 'loading';
if (typeof Image !== 'undefined') {
  const names = Object.keys(GROUND_TEX);
  let left = names.length;
  for (const name of names) {
    const im = new Image();
    im.onload = () => { groundTex[name] = im; if (--left === 0) groundTexState = 'ready'; };
    im.onerror = () => { if (--left === 0) groundTexState = 'ready'; };
    im.src = GROUND_TEX[name];
  }
}
/** Resolves once the ground textures are decoded (probes await it). */
export function groundTexturesReady() {
  if (groundTexState === 'ready' || typeof Image === 'undefined') return Promise.resolve();
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => (groundTexState === 'ready' || Date.now() - t0 > 8000) ? res() : setTimeout(tick, 40);
    tick();
  });
}

// which texture dresses which ground kind, how strongly, and at what detail scale
// (texture px per grid tile — smaller number = bigger painted detail)
const GROUND_TEX_KIND = { grass: 'grass', scrub: 'scrub', rock: 'rock', mud: 'dirt', bank: 'grass', water: 'water', track: 'dirt', gravel: 'gravel' };
const GROUND_TEX_ALPHA = { grass: 0.5, scrub: 0.55, rock: 0.62, mud: 0.7, bank: 0.45, water: 0.55, track: 0.30, gravel: 0.52 };
/* How readily each made surface rutters, 0..1 — an ART ordering, not a sim constant:
   crushed stone drains and holds its shape, dry dirt tracks up, mud remembers every
   axle. The renderer imports no sim modules by design (the port contract), so this does
   NOT read siteworks.MUD_WEAR; it is the look, chosen here. */
const RUT_SOFT = { gravel: 0.25, track: 0.55, mud: 1.0 };
const GROUND_TEX_TILE_PX = { grass: 96, scrub: 110, rock: 150, dirt: 100, water: 120, gravel: 88 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* Vertical scale of elevation (TERRAIN-SPEC §1): heights are metres on the half-metre
   grid; Z_PX_PER_M is world px of rise per metre at 1x. TT-style exaggeration: a 45°
   tile (2.5 m) steps 10 world px against a 32 px tile depth — a readable terrace,
   and the kloof's ~40 m of fall is ~160 px at 1x. Heights are ABSOLUTE (the DEM's
   metres, 736–1,968 across Hogsback), so everything renders relative to the plot's
   own minimum: the low corner sits on the flat plane, z = 0. */
const Z_PX_PER_M = 4;

/* Levels (TERRAIN-SPEC §6, owner 2026-10-21): the terrain is now integer LEVELS,
   one level = 2.5 m — the 45° rise across one tile — with a flow guarantee: every
   adjacent pair differs by at most one level. A tile is FLAT (all 4 neighbours at
   its level) or SLOPE (the 45° ramp). The renderer draws ramps as true TT ramps:
   two corners at the tile's level, two at the lower level, rising toward the
   higher side — not a flat quad plus a skirt. LEVEL_M mirrors plotmap.LEVEL_M
   (the renderer imports no sim modules); p.height is the derived metres. */
const LEVEL_M = 2.5;

/**
 * The fence, in design px at 1x, measured from the seam it stands on.
 *
 * OWNER 10-26 (via the lead): "the gate is 16 px tall against 38 px posts, so a fence line
 * reads as a 1.25 m gate next to a 3 m fence." Measured, not argued - `tools/asset-review.html`
 * frame 15 - and the answer is that the FENCE was the wrong sprite, but only half of what
 * ships is right now, because the gate needs its own pass (below).
 *
 * THE SCALE, because there are two in this file and picking the wrong one changes the answer
 * by 3x. Terrain relief uses `Z_PX_PER_M = 4` (a deliberate TT exaggeration of the LAND).
 * Standing OBJECTS do not: the gate's width is not an art choice, it is drawn at the projected
 * x-extent of one tile edge (TW/2 = 32 px) and one edge is `plotmap.CELL_M` = 2.5 m, so the
 * object scale is 32 / 2.5 = **12.8 px per metre**. The renderer imports no sim module (the
 * Godot rule), so CELL_M is not imported here; `tools/building-probe.py` reads both sides and
 * asserts the metres, which is the only way this number cannot silently drift.
 *
 * The heights, in metres, and what they are:
 *   post  1.80 m  a Hogsback boundary fence that the game's own story asks of it -
 *                 NARRATIVE-BIBLE 15.1 is a fence built against baboons ("Baboons spent
 *                 twenty minutes insulting the fence"). 1.2 m does not stop one.
 *   rails 0.55 / 1.25 m   the two planks, bottom clear of the grass, top just under the wire
 *   wire  1.65 m  the barb line, sitting essentially on the post top (1.9 px below it)
 * The old numbers were post 38 px (2.97 m - a wall), rails 14/26 (1.09/2.03), wire 36 (2.81).
 *
 * WHY NOT 1.5 m, which is the "obvious" plank-fence answer and the one the lead offered:
 * at the game's fit zoom (zoom 0.469) the three horizontal lines have to stay at least 2
 * device px apart or they merge into one band. 1.8 m gives 2.4 px. 1.5 m gives 1.8 px and
 * measured as a smudge; 1.25 m gives 1.2 px. So the honest height and the readable height
 * agree on 1.8 m, and the fence stays a LINE rather than a brown blur at the zoom the owner
 * actually plays at.
 *
 * AND THE GATE, measured rather than assumed, because the registry lies by 3 px: `gate.png`
 * has a transparent margin, so its drawn ink is 16.4 px = 1.28 m at its own posts (a MEDIAN
 * column reads 13 px, which is the mid-span between the bars, not the gate). That clears the
 * 16 px top rail by 0.4 px, so this height needs no art re-roll - and `building-probe.py` P2
 * is a HARD check that it stays that way: a future cutout that drops the gate under its own
 * rail, or a fence re-tallened over the gate, fails the gate rather than shipping.
 */
export const FENCE_PX = { rails: [7, 16], wire: 21, post: 23 };

/* Dam freeboard (TERRAIN-SPEC §7): the water sheet draws 2.5 world px (at 1x)
   ABOVE its surface level — the slight lip every TT water body shows. Without it
   a full dam sits flush with the surrounding table ground and its own front rim
   occludes it at the default camera: the owner digs a dam and never sees water. */
const DAM_FREEBOARD = 2.5;

/* The public road (owner 2026-10-21): the potholed main road runs along the plot's
   gate edge, OUTSIDE the boundary — a 2-tile band just beyond the fence line. The
   gate is the entrance; the strip is the one place the player sees how bad the road
   is. Potholes grow with wear: ROAD_POT_R is the base radius in world px at 1x,
   scaled 0.5×→1.4× as condition 100→0. */
const ROAD_W = 2;
const ROAD_POT_R = 8;

/* Point in a convex screen quad (the raised tile). Even-odd crossing test. */
function pip(px, py, poly) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* Badge overlay colours — UI chrome like the hover/boundary strokes below, not
   sprite colours, so they live here and PALETTE stays the art seat's table. */
const BADGE = { water: '#3d9bd6', harvest: '#54a84f', road: '#e0862c', money: '#d24a3a' };

/* Drag-build path (owner, 2026-10-21: "i need to be able to drag a road or fence to
   build multiple tiles"). Transport Tycoon's gesture: press on a tile, drag, release —
   the run follows the dominant axis first, then turns once. Pure and exported so the
   path can be asserted without a canvas (tools/drag-probe.html). Includes both ends. */
export function dragPath(x0, y0, x1, y1) {
  const out = [];
  const dx = x1 - x0, dy = y1 - y0;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax >= ay) {                    // the long leg first: the run, then the turn
    for (let i = 0; i <= ax; i++) out.push([x0 + i * sx, y0]);
    for (let j = 1; j <= ay; j++) out.push([x1, y0 + j * sy]);
  } else {
    for (let j = 0; j <= ay; j++) out.push([x0, y0 + j * sy]);
    for (let i = 1; i <= ax; i++) out.push([x0 + i * sx, y1]);
  }
  return out;
}
// "tank below 20%" in litres — mirrors WATER.capL (5000) in sim/homestead.js; the
// renderer imports no sim modules, so the threshold travels as this one constant.
const TANK_LOW_L = 1000;

/** The two GRID VERTICES of one edge of tile (x, y) — the fence and the gate are drawn
 *  between vertices, not through tile centres, so that they land on the seams and on the
 *  survey line (owner 10-25: "gate and fences still dont sit on tile seams"). */
function edgeVerts(x, y, e) {
  return e === 'S' ? [[x, y + 1], [x + 1, y + 1]]
    : e === 'N' ? [[x, y], [x + 1, y]]
      : e === 'W' ? [[x, y], [x, y + 1]]
        : [[x + 1, y], [x + 1, y + 1]];
}

/* U4 · the drag-rectangle verbs: press, drag a RECTANGLE, release. The block form of
   the road gesture — a terraform site is an area, not a line. The sim call takes the
   whole block in one go (siteworks.flatten), so the dozer's day is billed once no
   matter how big the rectangle. */
const RECT_KINDS = new Set(['flatten']);

/** A block from two corner cells, in either drag direction. */
function dragRect(x0, y0, x1, y1) {
  return {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1,
  };
}

/* On-map action popup + painted backdrop. UI chrome, like BADGE: the art seat's PALETTE
   table is for sprites and ground, and these are interface surfaces. */
const UI = {
  popBg: 'rgba(14,22,18,.96)',
  popEdge: '#3b5142',
  popText: '#e9e6db',
  popMuted: '#8f9d8c',
  popHead: '#7f8d7b',
  popRowHover: '#22382a',
  selWhite: { stroke: 'rgba(255,255,255,.55)', fill: 'rgba(255,255,255,.06)' },
  selGreen: { stroke: 'rgba(150,220,160,.62)', fill: 'rgba(150,220,160,.06)' },
  selRed: { stroke: 'rgba(232,116,88,.75)', fill: 'rgba(232,116,88,.07)' },
};
/* Hogsback behind the plot: cold blue-grey ridges, a mist band between them and a sky
   that only exists at the very top. Scenery — no sim meaning, drawn once per resize. */
const ART = {
  sky: ['#152630', '#2c4550', '#57707a'],
  far: 'rgba(146,170,183,0.62)',
  mid: 'rgba(78,102,112,0.90)',
  near: 'rgba(36,54,58,1)',
  mist: 'rgba(228,238,241,0.16)',
  fade: ['rgba(24,38,30,0.0)', 'rgba(18,29,22,0.92)'],
};

/* Costs the popup prints when the host passes no live table. plot.html always passes
   the sim's own numbers (opts.tileState) — these are the standalone-probe fallbacks.
   `bed` is the DEFAULT crop's price (greens, H$120): with no page there is no crop table
   to read, so a probe gets one generic row. A page passes `costs.crops` and gets three. */
const DEFAULT_COSTS = { bed: 120, hive: 2800, unit: 95000, cabin: 240000, pineTree: 450, fellCost: 20,
  track: 250, mud: 120, fence: 180, flatten: 500, grade: 500, dop: 500,
  m3Pine: 0.085, m3Other: 0.05 };

/* The build menu (owner verdict 5, 2026-10-21): a visible list of things to place,
   each at its true footprint, with a ghost preview on the map before money moves.
   Footprints and labels come from the sim via tileState (ACCOM); what is typed here is
   the display ORDER plus the standalone-probe fallbacks. Both were once the only source,
   and both went stale: the caravan moved to a 2x2 stand and the label changed under a
   hand-typed "Caravan park". Read the sim; keep a literal only so a probe with no page
   still prints something. */
const BUILD_ITEMS = [
  { kind: 'house', label: 'The house' },      // terrain pass: the roof is now a build, not scenery
  { kind: 'camp', label: 'Camping site', needs: 'ablution' },
  { kind: 'caravan', label: 'Caravan stand', needs: 'driveway' },
  { kind: 'room', label: 'Letting unit' },
  { kind: 'cabin', label: 'Cabin' },
];
const DEFAULT_FPS = { house: [2, 2], camp: [4, 3], caravan: [2, 2], room: [1, 1], spare: [0, 0], cabin: [2, 2] };
const GHOST = {
  ok: { fill: 'rgba(150,220,160,0.30)', edge: 'rgba(150,220,160,0.85)' },
  bad: { fill: 'rgba(232,116,88,0.32)', edge: 'rgba(232,116,88,0.9)' },
};

/* Fit targets, in CSS px per tile (owner, 21-10): the plot used to open at ~19 px a
   tile, where the ground read as texture and no tile looked clickable. A desktop tile
   is now ≥30 px and a phone tile ≥26 px; the camera pans, so the plot runs off the
   canvas and the clamp below stops it ever running away. */
const TILE_PX_DESKTOP = 30;
const TILE_PX_PHONE = 26;
const PHONE_MAX_W = 620;       // CSS px of canvas width at or below which the phone target applies
const ZOOM_MIN = 0.35;         // shared with the wheel and pinch clamps (tools/touch-probe.html)
const ZOOM_MAX = 3.2;
const ZOOM_FIT_MAX = 1.15;     // no initial fit tighter than this: one cell filling the canvas is unreadable
/** Content height of the tallest sprite above its base (the pine, 146 px) — the camera
    keeps this much sky above the plot's far edge so crowns never clip. */
const TREE_CONTENT_H = 150;

const money = (n) => 'H$' + Math.round(n).toLocaleString('en-ZA');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The bake zoom ladder (technical-artist Request): re-baking the ground ImageData on
    every 1.12 wheel tick was the hot path. The bake happens only when the camera crosses
    one of these steps; between steps the bake is blit-scaled, a transient softness that
    costs nothing and sharpens on the next step. */
const ZOOM_STEPS = [0.35, 0.44, 0.55, 0.7, 0.9, 1.1, 1.4, 1.8, 2.2, 2.8, 3.2];
function bakeStep(zoom) {
  let best = ZOOM_STEPS[0];
  for (const s of ZOOM_STEPS) {
    if (Math.abs(s - zoom) < Math.abs(best - zoom)) best = s;
  }
  return Math.min(Math.max(best, 0.3), 3.4);
}
function jitter(x, y, salt = 0) {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise — neighbours correlate, so variation reads as land, not static. */

export class IsoPlotRenderer {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    // ground textures decode async — repaint once they land so the first frame
    // (flat palette) is replaced by the textured bake without user input
    if (typeof window !== 'undefined') {
      groundTexturesReady().then(() => {
        this._bdKey = '';
        // VIS-10: the repaint is the half that used to drop the panel; the re-read is the
        // half that keeps it honest if a rule turned out to depend on decoded art.
        this._refreshPopup();
        if (this.p) this._draw();
      });
    }
    this.p = null;
    this.h = null;
    this.hover = null;
    this.mode = 'inspect';
    this.buildKind = null;
    this.ghost = null;              // { kind, x, y, fp, ok } — the placement preview
    this.overlay = null;            // 'build' — the buildability ground map (key G)
    this.dpr = 1;
    this.cam = { ox: 0, oy: 0, zoom: 1 };
    this._userCam = false;          // once the player drags/zooms, resize stops re-fitting
    this._groundKey = '';
    this.groundCv = null;
    this._zBase = 0;                // the plot's lowest height (metres) — z = 0 there
    this._zMax = 0;                 // the plot's highest height (metres)
    this._baseLvl = 0;              // the plot's lowest level (integers, 1 = 2.5 m)
    this._drag = null;
    this.dragKind = null;           // 'track'|'mud'|'gravel'|'fence' — the drag-build tool
    this._paint = null;             // { kind, x0, y0, path } — a drag-build in progress
    this.badgeCount = 0;
    this.sel = null;                // the tile the popup is about
    this._popup = null;             // { x, y, items } — the on-map action list
    this._pp = null;                // its DOM node, created lazily
    this._bdCv = null;              // painted backdrop, baked per canvas size
    this._bdKey = '';
    this.resize();
    this._bind();
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      this._ro = new ResizeObserver(() => {
        clearTimeout(this._rt);
        this._rt = setTimeout(() => this.resize(), 60);
      });
      this._ro.observe(canvas.parentElement);
    }
  }

  setPlot(p) {
    this.p = p;
    // elevation range (TERRAIN-SPEC §6): levels are the truth, p.height the derived
    // metres (level × 2.5). z = 0 at the plot's lowest level; everything else rises
    // from there. Missing levels (old saves) derive from whatever height says.
    this._baseLvl = 0;
    this._zBase = 0;
    this._zMax = 0;
    if (p && Array.isArray(p.level) && p.level.length) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < p.level.length; i++) {
        const v = p.level[i] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._baseLvl = mn;
      this._zBase = mn * LEVEL_M;
      this._zMax = mx * LEVEL_M;
    } else if (p && Array.isArray(p.height) && p.height.length) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < p.height.length; i++) {
        const v = p.height[i] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._baseLvl = Math.round(mn / LEVEL_M);
      this._zBase = mn;
      this._zMax = mx;
    }
    this._userCam = false;
    this._groundKey = '';
    this.resize();
    // resize() early-returns when the canvas already has its final size, so the fit
    // has to be asked for explicitly — otherwise a plot set after layout keeps zoom 1
    if (!this._userCam) this._fit();
    // VIS-10: a plot handed over late (terrain, a save) can change what this cell offers.
    // Re-read the tile the panel is on rather than leaving its old verbs up.
    this._refreshPopup();
  }
  setHomestead(h) { this.h = h; }

  /* ------------------------------------------------- elevation helpers */
  /** Height of one tile in metres (derived, level × 2.5); outside the plot the
      ground sits at the plot's base plane (heights are ABSOLUTE DEM metres, so a
      raw 0 would be a thousand-metre hole). */
  _h(x, y) {
    const p = this.p;
    return (p && p.height && x >= 0 && y >= 0 && x < p.w && y < p.h)
      ? (p.height[y * p.w + x] || 0) : (p ? (this._zBase || 0) : 0);
  }

  /** Level of one tile (the terrain's own units); OOB reads the base level. */
  _lvl(x, y) {
    const p = this.p;
    if (!p) return 0;
    if (x >= 0 && y >= 0 && x < p.w && y < p.h) {
      if (Array.isArray(p.level)) return p.level[y * p.w + x] || 0;
      return Math.round((p.height ? (p.height[y * p.w + x] || 0) : 0) / LEVEL_M);
    }
    return this._baseLvl || 0;
  }

  /** Level of grid corner (cx, cy): the MAXIMUM of the levels of the tiles that
      touch that corner (in-bounds ones — the plot edge contributes nothing). With
      the flow guarantee (|Δ| ≤ 1 between orthogonal neighbours) the max rule gives
      every shared corner ONE height both tiles agree on: a ramp meets the next
      tile's seam exactly, two perpendicular rises make one proper corner ramp, and
      a raised corner always has an in-bounds tile standing at it — a ramp cannot
      end in air. (The old MIN rule was the wedge generator: it let each tile claim
      the lower neighbour's level, so tiles disagreed on their shared corners.)
      Returns METRES (as before — callers project through _z). The level form is
      _cornerL below; the sim-side twin of that is plotmap.cornerLevel, pinned by
      tests/34 — this copy exists because the renderer imports no sim modules. */
  cornerH(cx, cy) {
    const p = this.p;
    if (!p) return 0;
    let mx = null;
    for (let y = cy - 1; y <= cy; y++) {
      for (let x = cx - 1; x <= cx; x++) {
        if (x < 0 || y < 0 || x >= p.w || y >= p.h) continue;
        const l = Array.isArray(p.level) ? (p.level[y * p.w + x] || 0)
          : Math.round((p.height ? (p.height[y * p.w + x] || 0) : 0) / LEVEL_M);
        if (mx === null || l > mx) mx = l;
      }
    }
    return (mx == null ? 0 : mx) * LEVEL_M;
  }

  /** Corner level (the integer form of cornerH) — the geometry primitive every
      tile surface, sprite anchor and buildability tint reads. */
  _cornerL(cx, cy) {
    return this.cornerH(cx, cy) / LEVEL_M;
  }

  /** World px of rise at 1x for an absolute height (metres). */
  _z(m) { return (m - this._zBase) * Z_PX_PER_M; }

  /** World px of rise at 1x for a level. */
  _zL(l) { return (l - this._baseLvl) * LEVEL_M * Z_PX_PER_M; }

  /** A CanvasPattern for a ground texture, its matrix set to the iso projection so
      the painting follows the ground plane across tiles. Cached per (name, bake
      zoom). Returns null when patterns or matrix transforms are unsupported. */
  _groundPattern(g, name, bz) {
    this._texPats = this._texPats || {};
    const key = name + ':' + bz.toFixed(2);
    if (key in this._texPats) return this._texPats[key];
    let pat = null;
    try {
      pat = g.createPattern(groundTex[name], 'repeat');
      if (pat && typeof pat.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
        const S = GROUND_TEX_TILE_PX[name] || 128;
        const k = (TW * bz) / (2 * S), m = (TH * bz) / (2 * S);
        // texture px -> bake px: the same 45° rotation + 2:1 squash as the projection
        pat.setTransform(new DOMMatrix([k, m, -k, m, 0, 0]));
      }
    } catch (e) { pat = null; }
    this._texPats[key] = pat;
    return pat;
  }

  /* ---- WHERE THE FENCE STANDS: on a tile EDGE, never through the middle ----
     Owner 10-25: "new gate and fences still dont sit on tile seams." He was right, and
     the cause was structural rather than artistic: a fence tile drew a post at its
     CENTRE with rails out to the midpoints between centres, which is a line running
     half a tile inside every seam. The fence and the survey line were parallel and
     16 px apart, and the gate — drawn at its own centre, upright and front-on — had
     nothing to join.

     A fence is a boundary, so it is drawn ON a boundary: one edge of its tile, between
     two grid VERTICES, projected through `cornerH` — the same vertices the survey line
     is drawn through, so the two cannot disagree. Because both tiles of a shared vertex
     read the same corner height, a rail also meets its neighbour exactly on a slope.

     Edge choice: the edge is chosen per RUN AXIS, never per tile, because a run has to
     stay collinear.
       · a horizontal leg (connections E/W) lies on a horizontal edge — S, or N on a plot
         whose road is north/west;
       · a vertical leg (connections N/S) lies on a vertical edge — E, or W;
       · a corner (both legs) uses both, and any horizontal edge of a diamond meets any
         vertical one at a vertex, so an L closes with no special case;
       · a boundary only overrides when it is PARALLEL to the leg it would carry. Letting
         it win otherwise kinked the run at the boundary tile — measured, `0,34 -> 1,34`
         BREAK in tools/join-probe.html on the first cut of this change. */
  _fenceEdge(x, y, conn) {
    const p = this.p;
    const hz = conn.has('E') || conn.has('W');
    const vt = conn.has('N') || conn.has('S');
    const front = this._roadSide();
    const nw = front === 'N' || front === 'W';   // the road is on the back/left family
    let hEdge = nw ? 'N' : 'S';
    if (y >= p.h - 1) hEdge = 'S';
    else if (y <= 0) hEdge = 'N';
    let vEdge = nw ? 'W' : 'E';
    if (x <= 0) vEdge = 'W';
    else if (x >= p.w - 1) vEdge = 'E';
    if (hz && vt) return [hEdge, vEdge];   // a corner turns at the front vertex
    if (vt) return [vEdge];
    return [hEdge];                        // a horizontal run, or a lone panel
  }

  /** The seam a fence tile stands on, as PROJECTED points — `[{e, a, b, mid}]`.
   *  This is the probe hook (tools/join-probe.html): it has to sample where the fence is
   *  now drawn, not where it used to be. The rule itself lives in `_fenceEdge`, so a
   *  probe can never agree with a renderer that has drifted from it. */
  fenceSeam(x, y) {
    const set = new Set((this.p.fence || []).map((f) => `${f.x},${f.y}`));
    const gateKey = this.p.gate ? `${this.p.gate.x},${this.p.gate.y}` : null;
    const conn = new Set();
    for (const [d, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      const k = `${x + dx},${y + dy}`;
      if (set.has(k) || k === gateKey) conn.add(d);
    }
    return this._fenceEdge(x, y, conn).map((e) => {
      const [A, B] = edgeVerts(x, y, e);
      const a = project(A[0], A[1], this._z(this.cornerH(A[0], A[1])), this.cam);
      const b = project(B[0], B[1], this._z(this.cornerH(B[0], B[1])), this.cam);
      // gA/gB are the GRID vertices: a probe has to test collinearity on the grid, because
      // on stepped ground two collinear edges are legitimately at different screen heights.
      return { e, a, b, gA: A, gB: B, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    });
  }

  /** Which edge of the plot the gate sits on — the side the public road runs
      along, outside the fence. Derived from p.gate's own tile (plotmap puts it on
      the boundary); null when there is no gate. */
  _roadSide() {
    const p = this.p;
    if (!p || !p.gate) return null;
    const g = p.gate;
    const d = [['S', p.h - 1 - g.y], ['N', g.y], ['W', g.x], ['E', p.w - 1 - g.x]];
    d.sort((a, b2) => a[1] - b2[1]);
    return d[0][0];
  }

  /** World screen bbox of everything the bake draws: the plot diamond PLUS the
      road strip beyond the gate edge. The fit, the clamp and the blit all share it. */
  _bounds() {
    const p = this.p;
    const side = this._roadSide();
    const gx0 = side === 'W' ? -ROAD_W : 0;
    const gy0 = side === 'N' ? -ROAD_W : 0;
    const gx1 = side === 'E' ? p.w + ROAD_W : p.w;
    const gy1 = side === 'S' ? p.h + ROAD_W : p.h;
    const HW = TW / 2, HH = TH / 2;
    const minX = (gx0 - gy1) * HW, maxX = (gx1 - gy0) * HW;
    const minY = (gx0 + gy0) * HH, maxY = (gx1 + gy1) * HH;
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, side };
  }

  /** Tallest rise on the plot, world px at 1x — camera headroom. */
  _maxZ() { return (this._zMax - this._zBase) * Z_PX_PER_M; }

  /** Cheap terraforming fingerprint: any flatten() re-derives height from level,
      so the hash moves and the bake follows. */
  _heightHash() {
    const p = this.p;
    let hsh = 0;
    for (let i = 0; i < p.height.length; i++) hsh = (Math.imul(hsh, 31) + ((p.height[i] || 0) * 2 | 0)) | 0;
    return hsh;
  }

  /** The four screen corners of tile (x, y) — [ (x,y), (x+1,y), (x+1,y+1), (x,y+1) ]
      — raised to the SHARED corner heights: flat ground sits level, a tile with one
      raised side is the TT ramp, a tile with two perpendicular raised sides is the TT
      corner ramp, and every seam meets because both tiles read the same corner. This
      is the single geometry the bake, the highlight, the pick and the ghost share. */
  _tileCorners(x, y) {
    const zc = [
      this._zL(this._cornerL(x, y)),
      this._zL(this._cornerL(x + 1, y)),
      this._zL(this._cornerL(x + 1, y + 1)),
      this._zL(this._cornerL(x, y + 1)),
    ];
    return [
      project(x, y, zc[0], this.cam),
      project(x + 1, y, zc[1], this.cam),
      project(x + 1, y + 1, zc[2], this.cam),
      project(x, y + 1, zc[3], this.cam),
    ];
  }

  resize() {
    const r = this.cv.getBoundingClientRect ? this.cv.getBoundingClientRect() : { width: 900, height: 640 };
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(320, Math.round((r.width || 900) * this.dpr));
    const h = Math.max(240, Math.round((r.height || 640) * this.dpr));
    if (w === this.cv.width && h === this.cv.height && this.p) { if (this.p) this._draw(); return; }
    this.cv.width = w;
    this.cv.height = h;
    this._bdKey = '';               // the painted ridges are sized to the canvas
    if (!this._userCam) this._fit();
    // A popup is anchored to a CELL, not to a pixel: the fit above moved the camera,
    // so re-place the panel rather than dropping it. Closing here ate the tile menu on
    // every late layout (the ResizeObserver's first tick lands ~60 ms after load) — the
    // ?tile screenshot hook died exactly that way.
    if (this._popup) this._placePopup();
    // Setting canvas.width clears it — repaint here, this page has no rAF loop.
    if (this.p) this._draw();
  }

  _fit() {
    if (!this.p) return;
    const W = this.cv.width, H = this.cv.height;
    const target = (W / this.dpr <= PHONE_MAX_W ? TILE_PX_PHONE : TILE_PX_DESKTOP) * this.dpr;
    const fit = fitCamera(this.p.w, this.p.h, W, H, 26 * this.dpr);
    // the tile target wins over fitting the whole diamond: at 47×45 a fit-width view
    // is 19 px a tile, which is exactly the scale the owner rejected
    const zoom = clamp(Math.max(fit.zoom, target / TW), ZOOM_MIN, ZOOM_FIT_MAX);
    const b = this._bounds();
    const cx = (b.minX + b.maxX) / 2;
    // Composition, not centring: the far edge sits high enough to leave a band of sky
    // and ridges above it (the reference's depth), and the near corner runs just past
    // the bottom of the frame. The camera pans, so nothing is lost. Raised tiles rise
    // maxZ above the flat plane — the crest must land ON the sky-band line `top`,
    // so the flat diamond top sits lift further down (top + maxZ·zoom).
    const lift = this._maxZ() * zoom;
    const slackY = H - b.height * zoom - lift;
    const m = Math.min(40 * this.dpr, W * 0.06);
    const top = slackY > m * 2
      ? Math.min(m + slackY * 0.65 + H * 0.05, H * 0.19)
      : m;
    this.cam = { ox: W / 2 - cx * zoom, oy: top - b.minY * zoom + lift, zoom };
    this._clampCam();
    this._groundKey = '';
  }

  /** Keep the plot on the canvas. An edge may never come further in than the margin,
      so a pan cannot push the plot over the horizon; when the diamond is smaller than
      the view it may sit anywhere inside those margins (the fit chooses where). */
  _clampCam() {
    if (!this.p) return;
    const b = this._bounds(), z = this.cam.zoom;
    const W = this.cv.width, H = this.cv.height;
    const m = Math.min(40 * this.dpr, W * 0.06);
    const fits = (span, view) => span <= view - m * 2;
    const spanX = b.width * z, spanY = b.height * z;
    // when the diamond fits, it may hang a little past the bottom edge (the near corner
    // of the reference's frame is out of shot) — that buys the sky band at the top
    const over = Math.round(H * 0.07);
    // the tallest sprite is the pine (146 px of content above its base) and the raised
    // far corner rises maxZ above the flat plane — the top edge has to stand that much
    // further down or the far row's crowns and crest clip at low zoom
    const lift = this._maxZ() * z;
    const headroom = TREE_CONTENT_H * z + lift;
    const loX = fits(spanX, W) ? m - b.minX * z : W - m - b.maxX * z;
    const hiX = fits(spanX, W) ? W - m - b.maxX * z : m - b.minX * z;
    const loY = fits(spanY, H) ? m + headroom - b.minY * z : H - m - b.maxY * z;
    const hiY = fits(spanY, H) ? H + over - b.maxY * z : m + lift - b.minY * z;
    this.cam.ox = clamp(this.cam.ox, loX, hiX);
    this.cam.oy = clamp(this.cam.oy, loY, hiY);
  }

  /* ------------------------------------------------------------- input */
  _bind() {
    const cv = this.cv;
    if (!cv || !cv.addEventListener) return;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr];
    };
    cv.addEventListener('mousemove', (e) => {
      const [x, y] = pos(e);
      // a drag-build in progress owns the pointer: extend the run, never pan
      if (this._paint) {
        const c = this._cellAt(x, y);
        if (c) this._updatePaint(c[0], c[1]);
        return;
      }
      if (this._drag) {
        this.cam.ox += x - this._drag[0];
        this.cam.oy += y - this._drag[1];
        this._drag = [x, y];
        this._moved = true;
        this._userCam = true;
        this._closePopup(true);      // a panel pinned to a cell that has moved is wrong
        this._clampCam();
        this._draw();
        return;
      }
      const h = this._cellAt(x, y);
      // an armed ghost follows the cursor (the touch path repositions on tap instead)
      if (this.ghost && h && (h[0] !== this.ghost.x || h[1] !== this.ghost.y)) {
        this._setGhost(this.ghost.kind, h[0], h[1]);
      }
      const changed = (h === null) !== (this.hover === null)
        || (h && this.hover && (h[0] !== this.hover[0] || h[1] !== this.hover[1]));
      this.hover = h;
      // A2 — the cursor says what the mode is, before the hint line has to. Recomputed
      // only when the cell changes (a _tileActions call per mousemove would be waste).
      if (changed) this._setCursor(h);
      // hover feedback must be live: repaint once per frame while it moves
      if (changed && !this._hoverRaf) {
        this._hoverRaf = requestAnimationFrame(() => { this._hoverRaf = null; this._draw(); });
      }
    });
    cv.addEventListener('mouseleave', () => { this.hover = null; this._drag = null; this._setCursor(null); });
    cv.addEventListener('mousedown', (e) => {
      // armed drag-build: the press starts a run instead of panning the camera
      if (this.mode === 'drag' && this.dragKind && this.p) {
        const c = this._cellAt(...pos(e));
        if (c) { this._startPaint(c[0], c[1]); return; }
      }
      this._drag = pos(e);
    });
    window.addEventListener('mouseup', () => {
      if (this._paint) { this._commitPaint(); return; }   // release = build the run
      this._drag = null;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [mx, my] = pos(e);
      const z2 = clamp(this.cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), ZOOM_MIN, ZOOM_MAX);
      // keep the world point under the cursor fixed while zooming
      this.cam.ox = mx - (mx - this.cam.ox) * (z2 / this.cam.zoom);
      this.cam.oy = my - (my - this.cam.oy) * (z2 / this.cam.zoom);
      this.cam.zoom = z2;
      this._userCam = true;
      this._closePopup(true);
      this._clampCam();
      this._draw();
    }, { passive: false });
    cv.addEventListener('click', (e) => {
      // the tap already handled this press — drop the compat click some phones emit
      if (Date.now() - this._lastTouch < 600) return;
      // a drag-build press is not a click either — the release already built the run
      if (this.mode === 'drag' && this.dragKind) return;
      // a drag is not a click — but a 1-2 px tremor between down and up IS a click,
      // so only suppress when the press actually travelled
      if (this._down && this._moved) {
        const dx = e.clientX - this._down[0], dy = e.clientY - this._down[1];
        if (dx * dx + dy * dy > 16 * this.dpr * this.dpr) { this._moved = false; return; }
      }
      this._moved = false;
      const c = this._cellAt(...pos(e));
      if (!c || !this.p) return;
      this._actAt(c[0], c[1]);
    });
    cv.addEventListener('mousedown', (e) => { this._down = [e.clientX, e.clientY]; this._moved = false; });

    /* ---- touch: a phone has no wheel and no hover. One finger pans the camera,
       a short still press is the click, two fingers pinch-zoom about their midpoint
       with the same compensation the wheel uses. Mouse listeners above stay as-is;
       preventDefault (passive:false) is what stops the page scrolling/zooming,
       since touch-action CSS lives in plot.html and is not ours to set. */
    const tpos = (t) => {
      const r = cv.getBoundingClientRect();
      return [(t.clientX - r.left) * this.dpr, (t.clientY - r.top) * this.dpr];
    };
    const TAP_SLOP = 10;    // CSS px of travel that still counts as a tap
    const TAP_MS = 350;

    cv.addEventListener('touchstart', (e) => {
      if (e.cancelable) e.preventDefault();
      this._lastTouch = Date.now();
      if (e.touches.length >= 2) {
        this._touch = null;              // a second finger means pinch, never a tap
        const a = tpos(e.touches[0]), b = tpos(e.touches[1]);
        this._pinch = {
          d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
          mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        };
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const [x, y] = tpos(t);
      this._pinch = null;
      // armed drag-build: one finger paints the run (the pan gesture stands down)
      if (this.mode === 'drag' && this.dragKind && this.p) {
        const c = this._cellAt(x, y);
        if (c) { this._touch = null; this._startPaint(c[0], c[1]); return; }
      }
      this._touch = { x, y, cx: t.clientX, cy: t.clientY, t: Date.now(), moved: false };
    }, { passive: false });

    cv.addEventListener('touchmove', (e) => {
      if (e.cancelable) e.preventDefault();
      this._lastTouch = Date.now();
      if (e.touches.length >= 2) {
        const a = tpos(e.touches[0]), b = tpos(e.touches[1]);
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (!this._pinch) { this._pinch = { d, mid }; return; }
        const z2 = clamp(this.cam.zoom * (d / this._pinch.d), ZOOM_MIN, ZOOM_MAX);
        // keep the world point under the pinch midpoint fixed — the wheel formula
        this.cam.ox = mid[0] - (mid[0] - this.cam.ox) * (z2 / this.cam.zoom);
        this.cam.oy = mid[1] - (mid[1] - this.cam.oy) * (z2 / this.cam.zoom);
        this.cam.zoom = z2;
        // two fingers also pan: the midpoint follows the fingers
        this.cam.ox += mid[0] - this._pinch.mid[0];
        this.cam.oy += mid[1] - this._pinch.mid[1];
        this._pinch = { d, mid };
        this._userCam = true;
        this._closePopup(true);
        this._clampCam();
        this._draw();
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const [x, y] = tpos(t);
      // a touch paint extends the run; the camera stays put until the finger lifts.
      // Checked BEFORE the pan guard: _startPaint clears _touch (the pan state), so a
      // paint-in-progress is the only thing that can own this move — as shipped, the
      // guard ran first and a touch drag-build could never lay more than one tile.
      if (this._paint) {
        const c = this._cellAt(x, y);
        if (c) this._updatePaint(c[0], c[1]);
        return;
      }
      const g = this._touch;
      if (!g) return;
      // a touch paint extends the run; the camera stays put until the finger lifts
      if (!g.moved && Math.hypot(t.clientX - g.cx, t.clientY - g.cy) > TAP_SLOP) g.moved = true;
      this.cam.ox += x - g.x;
      this.cam.oy += y - g.y;
      g.x = x; g.y = y;
      this._userCam = true;
      if (g.moved) this._closePopup(true);
      this._clampCam();
      this._draw();
    }, { passive: false });

    cv.addEventListener('touchend', (e) => {
      this._lastTouch = Date.now();
      if (e.touches.length >= 2) return;
      if (e.touches.length === 1) {
        // one finger of a pinch lifted — resume as a pan from the survivor, no tap
        this._pinch = null;
        this._touch = null;
        return;
      }
      this._pinch = null;
      const g = this._touch;
      this._touch = null;
      if (this._paint) { this._commitPaint(); return; }   // lift = build the run
      if (!g || g.moved || Date.now() - g.t > TAP_MS) return;
      this._tap(g.x, g.y);
    });
    cv.addEventListener('touchcancel', () => {
      this._touch = null;
      this._pinch = null;
      this._cancelPaint();
    });

    /* The popup is the touch path as well as the mouse path, so it needs the two
       dismissals a menu always has: Escape, and a click that lands outside it.
       Clicks on the canvas are the renderer's own business (_actAt) — skipped here. */
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._paint) return this._cancelPaint();
        if (e.key === 'Escape' && this.ghost) return this._cancelGhost();
        if (e.key === 'Escape' && this._popup) this._closePopup();
        // G — the buildability ground map: green builds, amber takes track only,
        // red is a wall. The TT habit of reading the land before you touch it.
        if (e.key === 'g' || e.key === 'G') {
          this.setOverlay(this.overlay === 'build' ? null : 'build');
        }
      });
      // right-click backs out of a placement the same way Escape does
      cv.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._cancelGhost();
      });
      document.addEventListener('click', (e) => {
        if (!this._popup) return;
        if (e.target === cv || (this._pp && this._pp.contains(e.target))) return;
        this._closePopup();
      });
    }
  }

  /** Shared click dispatch — mouse click and touch tap land here. With a ghost
      armed, the click PLACES (if the ghost sits on this cell and fits) or moves
      the ghost — the touch flow, which has no hover, is tap-move-tap-place. */
  _actAt(x, y) {
    if (this.ghost) {
      const g = this.ghost;
      if (g.ok && g.x === x && g.y === y) {
        this._cancelGhost();
        if (this.opts.onAction) this.opts.onAction({ kind: 'accom', accom: g.kind, x, y });
      } else {
        this._setGhost(g.kind, x, y);
        this._draw();
      }
      return;
    }
    if (this.mode === 'fell') {
      this._closePopup(true);
      const t = this.p.trees.find((q) => q.x === x && q.y === y);
      if (t && this.opts.onFell) this.opts.onFell(t.id);
      return;
    }
    if (this.mode === 'build' && this.buildKind) {
      this._closePopup(true);
      if (this.opts.onBuild) this.opts.onBuild(this.buildKind, x, y);
      return;
    }
    const t = this.p.trees.find((q) => q.x === x && q.y === y);
    if (t && this.opts.onSelectTree) this.opts.onSelectTree(t);
    // inspect is the tile's own menu: what can be DONE here, priced, on the map
    this._openPopup(x, y);
  }

  /** A tap is the touch click. No hover exists on touch, so flash the tapped cell
      for a moment first — otherwise an inspect tap has no feedback before the log. */
  _tap(sx, sy) {
    const c = this._cellAt(sx, sy);
    if (!c || !this.p) return;
    if (this.mode === 'inspect') {
      this.hover = c;
      this._draw();
      clearTimeout(this._tapHover);
      this._tapHover = setTimeout(() => { this.hover = null; this._draw(); }, 400);
    }
    this._actAt(c[0], c[1]);
  }

  _cellAt(sx, sy) {
    if (!this.p) return null;
    const p = this.p;
    const [fx, fy] = unproject(sx, sy, this.cam);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
    // Raised tiles sit ABOVE the flat plane, so the flat inverse lands in front of
    // the tile the player actually sees — diagonally by up to maxZ/TH grid units on
    // a big fall (87 m of kloof ≈ 11 tiles). Scale the search to the terrain and
    // take the FRONT-MOST raised quad that contains the point: painter's order is
    // what the eye believes, so it is what the pick returns (a tile hidden behind
    // a crest is not clickable, correctly).
    const R = Math.min(20, Math.ceil(this._maxZ() / TH) + 2);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    let best = null, bestD = -Infinity;
    for (let dy = -R; dy <= R; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= p.h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= p.w) continue;
        const d = x + y;
        if (d < bestD) continue;
        if (pip(sx, sy, this._tileCorners(x, y))) {
          best = [x, y];
          bestD = d;
        }
      }
    }
    return best;
  }

  frame() { this._draw(); }

  /** The buildability ground map: 'build' or null. Tints every tile by what the
      ground will take — green flat (build/plant), amber slope (track only), red
      where a corner stands two levels up (the steep knoll), blue over water. */
  setOverlay(v) {
    this.overlay = v === 'build' ? 'build' : null;
    this._draw();
  }

  /** One tinted quad per tile, over the ground blit, under the objects. */
  _drawOverlay(ctx) {
    const p = this.p;
    if (!p || this.overlay !== 'build' || !Array.isArray(p.level)) return;
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        if (p.ground[y * p.w + x] === 'water') {
          ctx.fillStyle = 'rgba(90,150,200,0.30)';
        } else {
          const L = this._lvl(x, y);
          const c0 = this._cornerL(x, y), c1 = this._cornerL(x + 1, y);
          const c2 = this._cornerL(x + 1, y + 1), c3 = this._cornerL(x, y + 1);
          const rise = Math.max(c0, c1, c2, c3) - L;
          ctx.fillStyle = rise >= 2 ? 'rgba(210,80,60,0.34)'
            : rise === 1 ? 'rgba(220,180,80,0.30)'
              : 'rgba(120,200,120,0.26)';
        }
        const q = this._tileCorners(x, y);
        ctx.beginPath();
        ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]);
        ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /** Anchor z (world px) of a tile's base centre — the MEAN of the tile's four
      shared corner heights: the surface on flat ground, the ramp's midpoint on a
      one-side slope, the honest centre of a corner ramp. Nothing anchors in air. */
  _anchorZ(x, y) {
    const c = (this._cornerL(x, y) + this._cornerL(x + 1, y)
      + this._cornerL(x + 1, y + 1) + this._cornerL(x, y + 1)) / 4;
    return this._zL(c);
  }

  /** Anchor z for a MULTI-TILE footprint (a cottage, a camp): the footprint's LOWEST
      corner level — the graded cut a building platform sits on. New sites are
      all-flat (canPlaceAccom enforces it), so this clamps only old saves that were
      placed across a step before the rule existed: they sit on the cut, not in air. */
  _footprintZ(x, y, fp) {
    let mn = Infinity;
    for (let py = y; py < y + fp[1]; py++) {
      for (let px = x; px < x + fp[0]; px++) {
        mn = Math.min(mn, this._lvl(px, py));
      }
    }
    return Number.isFinite(mn) ? this._zL(mn) : 0;
  }

  /** TT "flat tile": no touching tile (8 neighbours — corners count) stands higher.
      Buildable, plantable. The renderer-side twin of plotmap.tileFlat (pinned there;
      duplicated here because the renderer imports no sim modules). */
  _tileFlat(x, y) {
    const p = this.p;
    if (!p || !Array.isArray(p.level)) return true;
    const lv = this._lvl(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
        if (this._lvl(nx, ny) > lv) return false;
      }
    }
    return true;
  }

  /** The dop gate (TERRAIN-SPEC §7): flat ground and pit floors dig; the RAMP — a
      tile rising toward higher ground while falling to lower across itself — refuses
      (the wall holds the water). The renderer-side twin of siteworks.dopDiggable
      (pinned there; duplicated here because the renderer imports no sim modules). */
  _dopDiggable(x, y) {
    const p = this.p;
    if (!p || !Array.isArray(p.level)) return true;
    const lv = this._lvl(x, y);
    let hi = false;
    let lo = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
      const d = this._lvl(nx, ny) - lv;
      if (d > 0) hi = true;
      if (d < 0) lo = true;
    }
    return !(hi && lo);
  }

  /** Screen position of a tile's base centre (where sprites anchor). */
  _at(x, y) { return project(x + 0.5, y + 0.5, this._anchorZ(x, y), this.cam); }

  /* ------------------------------------------------------- tile action popup */
  /* Owner's demand (21-10): actions happen ON the map, not in a column of buttons.
     Clicking a tile opens a small priced list beside it; choosing a row hands an
     action descriptor to opts.onAction, and plot.html runs the SAME sim call the
     sidebar button runs. The renderer still imports no sim modules — it reads the
     plot/homestead it was given, and opts.tileState supplies live cash and rules. */

  /** Live sim numbers the popup needs, without the renderer knowing the sim. */
  _state() {
    const s = (this.opts.tileState && this.opts.tileState()) || {};
    return {
      cash: Number.isFinite(s.cash) ? s.cash : Infinity,
      ended: !!s.ended,
      canPlant: s.canPlant !== false,
      // FARMING Part 2: the page's reason a bed cannot stand on THIS tile ('' when it can).
      // Whitelisted like `fenceOk` — a field the page supplies and this object does not copy
      // is a row that quietly lies (tests/47).
      plantSay: typeof s.plantSay === 'function' ? s.plantSay : null,
      day: Number.isFinite(s.day) ? s.day : (this.h && this.h.day) || 1,
      unitKind: s.unitKind || 'room',
      costs: { ...DEFAULT_COSTS, ...(s.costs || {}) },
      // the driveway surcharge for a site, supplied by the page (it knows the plot).
      // Absent → 0, so the standalone probes quote list price.
      driveway: typeof s.driveway === 'function' ? s.driveway : null,
      // whether a fence may legally start on a tile (siteworks connectivity). Absent
      // → the popup shows the rule as a hint instead of a verdict.
      fenceOk: typeof s.fenceOk === 'function' ? s.fenceOk : null,
      // ACCOM footprints, kind → [w, h] (owner verdict 5). Absent → DEFAULT_FPS.
      footprints: s.footprints || null,
      // U8: ACCOM's rung NAMES, kind → label. BUILD_ITEMS below hand-types a label only as a
      // standalone-probe fallback — the caravan round is the reason. The sim renamed the rung
      // to "Caravan stand" and the menu literal still said "Caravan park": two sources of one
      // fact, and the screen wins the argument nobody is watching. Absent → the literal.
      labels: s.labels || null,
      // one home per plot. The sim only refuses an OVERLAPPING site, so the popup needs the
      // page's verdict to refuse a SECOND house and say why. Absent → no house yet.
      hasHouse: !!s.hasHouse,
      // household facility flags, so the build menu can say what a rung demands
      facilities: s.facilities || null,
      // LD-12 / B2 — the terraform timing and the dozer day. THIS IS A WHITELIST: a field
      // the page supplies but this object does not copy is silently dropped, and the popup
      // quietly falls back to the default. Both of the terraform features were dead for
      // exactly that reason. Absent → per-tile price, and the dam note assumes 5 days a
      // level, so the standalone probes still print something honest.
      dozerDay: Number.isFinite(s.dozerDay) ? s.dozerDay : undefined,
      damFillDaysPerLevel: Number.isFinite(s.damFillDaysPerLevel) ? s.damFillDaysPerLevel : 0,
      noWaterSource: !!s.noWaterSource,
      dryDays: Number.isFinite(s.dryDays) ? s.dryDays : 3,
      // U11: the page's handle on siteworks.damEstimate — { ok, cost, strikes, days,
      // digsToStrike, depthLevels } for one tile. The renderer imports no sim module, so
      // the WAIT in front of the price arrives as a function the host supplies. Absent (the
      // standalone probes) → the dop row falls back to the plain per-tile price and the old
      // water-table note, which is still true, only less specific.
      dopQuote: typeof s.dopQuote === 'function' ? s.dopQuote : null,
    };
  }

  /** Footprint table: the sim's ACCOM footprints when supplied, else the fallbacks. */
  _fps() {
    return this._state().footprints || DEFAULT_FPS;
  }

  /** A crop's name as the player reads it (FARMING Part 2). The table is the page's, read
      off `CROPS`. A bed from before the crop table has no `b.crop`, so an unknown crop says
      "bed" rather than naming a crop it never grew. */
  _cropLabel(crop) {
    const crops = (this._state().costs || {}).crops || null;
    return crops && crop && crops[crop] ? String(crops[crop].label).toLowerCase() : 'bed';
  }

  /** How far WEST of a footprint's front corner a bottom-centre bitmap has to be drawn for
      the plate to sit on the tiles. Two facts, both easy to get wrong, and this round got
      both (owner 10-26: "camping site doesnt sit on 3x3 tiles correctly" - the camp is a
      [4,3], and the plate was painting ~24 device px west of it, over about three tiles).

      1. THE MAGNITUDE. The plate is a symmetric diamond of span (fw+fph)*TW/2, but a
         non-square footprint's screen shape is a SKEWED parallelogram: its front corner sits
         (fw-fh)*TW/2 to the right of its back corner, so the centre of the whole thing is
         only HALF that - (fw-fh)*TW/4 - left of the front corner. The old line used TW/2,
         i.e. the full corner-to-corner offset, which is twice the distance to the CENTRE.
      2. THE SPACE. `project()` returns DEVICE px (zoom and dpr already applied), so an
         offset expressed in design px has to be multiplied by the same zoom * dpr before it
         is subtracted. It was not, so the error scaled with the zoom: invisible at zoom 1
         (where the two agree), worst at the fit zoom people actually play at, and the reason
         no bitmap-level gate could see it - building-probe.py measures the cutout, and the
         cutout is correctly centred.

      Square footprints return 0, which is why every [2,2] building looked right and only the
      camp [4,3] and the ablution [2,1] were off. Proven by tools/asset-review.html frame 16. */
  _footprintLean(fw, fh) {
    return (fw - fh) * (TW / 4) * this.cam.zoom * this.dpr;
  }

  /** Footprint of one kind, as drawn: [0, 0] (not placed) clamps to 1×1. */
  _fpOf(kind) {
    const fp = this._fps()[kind] || [1, 1];
    return [Math.max(1, fp[0]), Math.max(1, fp[1])];
  }

  /** A rung's NAME, one place only (U8). The page hands over `labels` read straight off
      `tourism.ACCOM`; the BUILD_ITEMS literal is the fallback for the standalone probes,
      which carry no page. Two files used to type these words independently — the sim
      renamed the caravan to a "stand" this morning and the menu still called it a park. */
  _accomLabel(kind) {
    const st = this._state();
    if (st.labels && st.labels[kind]) return st.labels[kind];
    const it = BUILD_ITEMS.find((b) => b.kind === kind);
    return it ? it.label : kind;
  }

  /* ---- the ghost: footprint follows the cursor, green fits, red blocked ---- */

  /** Renderer-side placement check — the same rules as sim canPlaceAccom, read off
      the plot/homestead the renderer already holds. One answer, two witnesses. */
  _siteOk(x, y, fp) {
    const p = this.p, h = this.h;
    if (!p) return false;
    for (let cx = x; cx < x + fp[0]; cx++) {
      for (let cy = y; cy < y + fp[1]; cy++) {
        if (cx < 0 || cy < 0 || cx >= p.w || cy >= p.h) return false;
        if (p.ground[cy * p.w + cx] === 'water') return false;
        // same flat rule the sim enforces (canPlaceAccom): the ground must hold the
        // whole cell — the ghost turns red on a slope before money moves
        if (!this._tileFlat(cx, cy)) return false;
        if ((p.trees || []).some((t) => t.x === cx && t.y === cy)) return false;
        if ((p.buildings || []).some((b) => cx >= b.x && cx < b.x + (b.fw || 1) && cy >= b.y && cy < b.y + (b.fh || 1))) return false;
        if (p.gate && p.gate.x === cx && p.gate.y === cy) return false;
        if (h) {
          if ((h.beds || []).some((b) => b.x === cx && b.y === cy)) return false;
          if ((h.hives || []).some((v) => v.x === cx && v.y === cy)) return false;
          if ((h.accom || []).some((a) => {
            const af = this._fpOf(a.kind);
            return cx >= a.x && cx < a.x + af[0] && cy >= a.y && cy < a.y + af[1];
          })) return false;
        }
      }
    }
    return true;
  }

  _setGhost(kind, x, y) {
    const fp = this._fpOf(kind);
    const onPlot = x >= 0 && y >= 0 && x + fp[0] <= this.p.w && y + fp[1] <= this.p.h;
    this.ghost = { kind, x, y, fp, ok: onPlot && this._siteOk(x, y, fp) };
    this._emitGhost();
    this._setCursor(this.hover);
    if (this.opts.onGhost) this.opts.onGhost(this.ghost);
  }

  _cancelGhost() {
    if (!this.ghost) return;
    this.ghost = null;
    this._emitGhost();
    this._setCursor(this.hover);
    if (this.opts.onGhost) this.opts.onGhost(null);
    this._draw();
  }

  /* A2 · the cursor is mode feedback, so the mode is felt before the hint is read:
     crosshair while a tool is armed (not-allowed when the footprint will not sit there),
     pointer over a tile that offers a verb, not-allowed over one that offers none.
     Written as a style rather than a CSS class because iso-render is also loaded by the
     standalone probes, which carry no page stylesheet. */
  _setCursor(cell) {
    const cv = this.cv;
    if (!cv || !cv.style) return;
    let c = 'default';
    if (this.ghost) c = this.ghost.ok ? 'crosshair' : 'not-allowed';
    else if (this.mode === 'drag' && this.dragKind) c = 'crosshair';
    else if (this.mode === 'fell') c = 'crosshair';
    else if (cell) {
      const acts = this._tileActions(cell[0], cell[1]);
      c = acts.some((i) => i.kind === 'act' && !i.disabled) ? 'pointer' : 'not-allowed';
    }
    if (cv.style.cursor !== c) cv.style.cursor = c;
    if (typeof window !== 'undefined') window.__cursor = c;
  }

  _emitGhost() {
    if (typeof window === 'undefined') return;
    window.__ghost = this.ghost
      ? { kind: this.ghost.kind, x: this.ghost.x, y: this.ghost.y, fp: this.ghost.fp, ok: this.ghost.ok }
      : null;
  }

  /* ---- drag-build: press, drag a run, release — the road/fence gesture -------------
     Armed by the host (mode 'drag' + dragKind). The renderer owns the path and the
     preview; the SIM owns the rules, so the run is committed as one ordered list and
     plot.html applies it tile by tile (connectivity, cash and terrain all still bite).
     A tap with no travel is a one-tile run — the gesture degrades to the old click. */
  _startPaint(x, y) {
    if (!this.dragKind) return;
    this._closePopup(true);
    this._paint = RECT_KINDS.has(this.dragKind)
      ? { kind: this.dragKind, x0: x, y0: y, x1: x, y1: y, rect: dragRect(x, y, x, y) }
      : { kind: this.dragKind, x0: x, y0: y, x1: x, y1: y, path: dragPath(x, y, x, y) };
    this._emitDrag();
    this._draw();
  }

  _updatePaint(x, y) {
    const p = this._paint;
    if (!p || (x === p.x1 && y === p.y1)) return;
    p.x1 = x; p.y1 = y;
    if (RECT_KINDS.has(p.kind)) p.rect = dragRect(p.x0, p.y0, x, y);
    else p.path = dragPath(p.x0, p.y0, x, y);
    this._emitDrag();
    this._draw();
  }

  /** The tiles the release will touch, as [x, y, ok]. A rect kind grades a BLOCK, so
      the third element carries the renderer's own refusal check (water, tree, edge) —
      the same rules siteworks.flatten enforces, so a red tile will really refuse. */
  _paintTiles() {
    const p = this._paint;
    if (!p) return [];
    if (RECT_KINDS.has(p.kind)) {
      const out = [];
      for (let j = 0; j < p.rect.h; j++) {
        for (let i = 0; i < p.rect.w; i++) {
          const x = p.rect.x + i, y = p.rect.y + j;
          out.push([x, y, this._rectTileOk(x, y)]);
        }
      }
      return out;
    }
    return p.path || [];
  }

  _rectTileOk(x, y) {
    const p = this.p;
    if (!p || x < 0 || y < 0 || x >= p.w || y >= p.h) return false;
    if (p.ground[y * p.w + x] === 'water') return false;
    if ((p.trees || []).some((t) => t.x === x && t.y === y)) return false;
    return true;
  }

  /** Live block bill, without the renderer knowing the sim's prices: how many tiles
      the block holds, how many are NOT flat yet (only those move earth), how many
      refuse. plot.html turns `moved` into money and adds the dozer's day. */
  _rectInfo() {
    const tiles = this._paintTiles();
    const flat = (this.p && Array.isArray(this.p.flat)) ? this.p.flat : [];
    const isFlat = (x, y) => flat.some((t) => t.x === x && t.y === y);
    const good = tiles.filter((t) => t[2] !== false);
    const moved = good.filter(([x, y]) => !isFlat(x, y)).length;
    return {
      n: tiles.length, moved, bad: tiles.length - good.length,
      ok: tiles.length > 0 && tiles.length - good.length === 0,
    };
  }

  _commitPaint() {
    const p = this._paint;
    this._paint = null;
    this._emitDrag();
    if (p && this.opts.onDragPath) {
      if (RECT_KINDS.has(p.kind) && p.rect) this.opts.onDragPath({ rect: { ...p.rect } }, p.kind);
      else if (p.path && p.path.length) this.opts.onDragPath(p.path, p.kind);
    }
    this._draw();
  }

  _cancelPaint() {
    if (!this._paint) return;
    this._paint = null;
    this._emitDrag();
    this._draw();
  }

  /** Public: the host disarms the tool (Esc, mode change) — drop any half-drawn run. */
  cancelPaint() { this._cancelPaint(); }

  _emitDrag() {
    if (typeof window !== 'undefined') {
      if (this._paint && RECT_KINDS.has(this._paint.kind)) {
        window.__dragPath = { kind: this._paint.kind, rect: { ...this._paint.rect }, ...this._rectInfo() };
      } else {
        window.__dragPath = this._paint
          ? { kind: this._paint.kind, path: this._paint.path } : null;
      }
    }
    if (this.opts.onDragHint) {
      if (this._paint && RECT_KINDS.has(this._paint.kind)) {
        this.opts.onDragHint({ kind: this._paint.kind, rect: { ...this._paint.rect }, ...this._rectInfo() });
      } else {
        this.opts.onDragHint(this._paint
          ? { kind: this._paint.kind, n: this._paint.path.length } : null);
      }
    }
  }

  /** What sits on this cell: tree, bed, hive, accom, a plot building, the gate. */
  _occupant(x, y) {
    const p = this.p, h = this.h;
    if (!p) return null;
    const tree = (p.trees || []).find((t) => t.x === x && t.y === y);
    if (tree) return { type: 'tree', tree };
    if (h) {
      const bed = (h.beds || []).find((b) => b.x === x && b.y === y);
      if (bed) return { type: 'bed', bed };
      const hive = (h.hives || []).find((v) => v.x === x && v.y === y);
      if (hive) return { type: 'hive', hive };
      const acc = (h.accom || []).find((a) => {
        const af = this._fpOf(a.kind);
        return x >= a.x && x < a.x + af[0] && y >= a.y && y < a.y + af[1];
      });
      if (acc) return { type: 'accom', acc };
    }
    const bld = (p.buildings || []).find((b) => b.x === x && b.y === y);
    if (bld) return { type: 'building', bld };
    if (p.gate && p.gate.x === x && p.gate.y === y) return { type: 'gate' };
    return null;
  }

  /** The priced list for one tile. Rows: { kind:'act'|'note', id, label, right, action, disabled }. */
  _tileActions(x, y) {
    const p = this.p, h = this.h;
    if (!p) return [];
    const st = this._state();
    const c = st.costs;
    const out = [];
    const act = (id, label, right, action, disabled = false) =>
      out.push({ kind: 'act', id, label, right, action, disabled });
    const note = (id, label, right = '') => out.push({ kind: 'note', id, label, right });
    const occ = this._occupant(x, y);

    if (occ && occ.type === 'tree') {
      const t = occ.tree;
      // same arithmetic as plotmap.fellTree — pine saws for money, aliens only for the
      // fire; natives and the oak now COST (the fine, the village's opinion)
      const m3 = t.kind === 'pine' ? c.m3Pine : c.m3Other;
      const cash = Math.round(c.pineTree * m3 - c.fellCost);
      const right = t.kind === 'pine' ? `+${m3} m³ · +${money(cash)}`
        : t.kind === 'oak' ? 'firewood · the village will notice'
          : t.kind === 'wattle' || t.kind === 'blackwood' ? `+${m3} m³ · firewood`
            : `firewood · −H$${(c.nativeFine ?? 800)} fine`;
      act('fell', `Fell the ${t.kind}`, right, { kind: 'fell', treeId: t.id }, st.ended);
      const species = t.kind === 'pine' ? 'pine'
        : (t.kind === 'wattle' || t.kind === 'blackwood') ? `${t.kind} — alien`
          : t.kind === 'oak' ? 'oak — alien ornamental' : 'indigenous — protected';
      note('age', `${t.age || 0} years standing`, species);
      return out;
    }
    if (occ && occ.type === 'bed') {
      // FARMING Part 2: a bed grows a NAMED crop, and the bed knows which (`b.crop`). The
      // old note said "Growing" over three different decisions with three different waits.
      const cl = this._cropLabel(occ.bed.crop);
      const ready = st.day >= occ.bed.ready;
      if (ready) act('harvest', `Harvest the ${cl}`, 'ready now', { kind: 'harvest' }, st.ended);
      else note('grow', `Growing ${cl}`, `${Math.max(1, occ.bed.ready - st.day)} days`);
      return out;
    }
    if (occ && occ.type === 'hive') {
      // honey accrues to the household by itself; the verb here is the trip to the shop
      const kg = Math.round(((h && h.honey) || 0) * 10) / 10;
      if (kg >= 0.5) act('honey', 'Take the honey', `${kg} kg · to the shop`, { kind: 'sell' }, st.ended);
      else note('comb', 'The comb is quiet', kg ? `${kg} kg` : 'nothing yet');
      return out;
    }
    if (occ && occ.type === 'accom') {
      const a = occ.acc;
      // U8: name the thing the way the sim names it, and stop calling a home an "unlisted
      // unit". A house has capacity 0 and no market rate, so "unlisted" was a promise of a
      // listing that will never exist — read out over the player's own roof.
      const nm = this._accomLabel(a.kind);
      if (!a.built) note('build', `Going up — the ${String(nm).toLowerCase()}`, `${Math.max(0, (a.doneDay || 0) - st.day)} days`);
      else if (a.kind === 'house') note('home', nm, 'your home · never listed');
      else note('listed', nm, a.listed ? 'listed' : 'unlisted');
      return out;
    }
    if (occ && occ.type === 'building') {
      note('bld', occ.bld.kind === 'tank5000' ? 'The water tank' : 'A building', '');
      return out;
    }
    if (occ && occ.type === 'gate') {
      const road = h && h.road ? `${Math.round(h.road.condition)}%` : '';
      note('gate', 'The gate', road ? `road ${road}` : '');
      /* siteworks connectivity (fenceConnects/trackConnects) begins a line ON the gate
         tile — no other tile may start one. Owner verdict 3 ("place fence doesn't
         work") was exactly that: the only legal first tile offered no verbs, so every
         fence click elsewhere died as "touches neither". The gate's own popup now
         carries the two line-starters; from here on, adjacency does the rest. */
      if (p.ground[y * p.w + x] !== 'water') {
        act('track', 'Start the track here', money(c.track), { kind: 'track', x, y },
          st.ended || st.cash < c.track);
        act('mud', 'Start the mud track here', money(c.mud), { kind: 'mud', x, y },
          st.ended || st.cash < c.mud);
        act('fence', 'Start the fence here', money(c.fence), { kind: 'fence', x, y },
          st.ended || st.cash < c.fence);
        note('fence-rule', 'then tile by tile, touching what is down');
      }
      return out;
    }
    if (p.ground[y * p.w + x] === 'water') {
      note('water', 'The stream', 'no building');
      return out;
    }

    // empty ground — the three things a bare Hogsback plot lets you do, plus Build…
    // (the rungs moved into their own menu — see _buildMenuItems)
    /* FARMING Part 2 (owner: three crops so planting is a decision, not a timer). The verb
       surface IS this popup, so the three crops are three priced rows here — each with the
       days the bed is gone and what a day of it earns, because 10.8 / 15.0 / 17.5 a day is
       the only thing that makes them a choice rather than three waits of different length.
       The table comes from the page (costs.crops, read off CROPS); with no page — the
       standalone probes — it falls back to the one generic bed row it always had. */
    const cropKeys = c.crops ? Object.keys(c.crops) : [];
    if (cropKeys.length) {
      // the ground rule first: a bed wants soil and a flat corner, and the row says so
      // rather than offering a verb the sim will refuse on the click
      const bedSay = st.plantSay ? String(st.plantSay(x, y) || '') : '';
      for (const k of cropKeys) {
        const cr = c.crops[k];
        act('bed-' + k, `Plant ${String(cr.label).toLowerCase()}`,
          `${money(cr.cost)} · ${cr.days}d · ${cr.rate} a day`,
          { kind: 'bed', crop: k, x, y },
          st.ended || !st.canPlant || !!bedSay || st.cash < cr.cost);
      }
      if (bedSay) note('bed-ground', 'no bed on this tile', bedSay);
    } else {
      act('bed', 'Plant a bed', money(c.bed), { kind: 'bed', x, y },
        st.ended || !st.canPlant || st.cash < c.bed);
    }
    act('hive', 'Place a hive', money(c.hive), { kind: 'hive', x, y },
      st.ended || st.cash < c.hive);
    // the build menu (owner verdict 5): a visible list of rungs, each at its true
    // footprint, picked there and placed with a ghost preview on the map
    act('buildmenu', 'Build…', 'choose what', { kind: 'buildmenu', x, y }, st.ended);
    // the site works (siteworks, 2026-10-21): tiles that connect, TT-style.
    // The fence's connectivity rule is stated NEXT TO the verb (owner verdict 3:
    // "place fence doesn't work" was the refusal happening silently — the sim's
    // message only reached the sidebar log, so the click read as dead).
    const fenceLegal = st.fenceOk ? !!st.fenceOk(x, y) : null;
    act('track', 'Lay dirt track', money(c.track), { kind: 'track', x, y },
      st.ended || st.cash < c.track);
    act('gravel', 'Lay gravel road', money(c.gravel), { kind: 'gravel', x, y },
      st.ended || st.cash < c.gravel);
    act('mud', 'Mud track', money(c.mud), { kind: 'mud', x, y },
      st.ended || st.cash < c.mud);
    act('fence', 'Fence this tile', money(c.fence), { kind: 'fence', x, y },
      st.ended || st.cash < c.fence || fenceLegal === false);
    note('fence-rule', fenceLegal === false
      ? 'fences start on the gate tile — then touch fence or track'
      : 'fences start on the gate tile, then tile by tile');
    // B2 · the bulldozer's day (COST.bulldozer) is charged ONCE, by whichever verb moves
    // earth first — the sim's own rule is `h.bulldozerDay !== h.day`. A per-tile price
    // that hides that fee is a lie the player only discovers on the click, so every
    // terraform row quotes the total it will actually take, and the day fee is named.
    const dozerDue = st.dozerDay === undefined || st.dozerDay !== st.day;
    const dozerFee = dozerDue ? (c.dozerFee || 0) : 0;
    const withDozer = (per) => per + dozerFee;
    const terra = (id, label, per, action, extraBlocked = false) =>
      act(id, label, money(withDozer(per)), action, st.ended || st.cash < withDozer(per) || extraBlocked);
    terra('flatten', 'Flatten this tile', c.flatten, { kind: 'flatten', x, y });
    // the dam dig (TERRAIN-SPEC §7): dop lowers one level — flats and pit floors
    // take the blade, the ramp refuses (a slope wall is a wall, not a dam), and a
    // hole below the water table seeps into a dam. The hint shows once the player
    // has dug anywhere near the table.
    const diggable = this._dopDiggable(x, y);
    // U11: when the blade can take this tile, the price is the sim's own estimate — the
    // number dopBlock will actually charge, bulldozer included. Otherwise the per-tile
    // fallback the row has always used.
    const dq = st.dopQuote ? st.dopQuote(x, y) : null;
    const est = dq && dq.ok ? dq : null;
    const dopPrice = est ? est.cost : withDozer(c.dop ?? 500);
    act('dop', 'Dop (dig one level)', money(dopPrice), { kind: 'dop', x, y },
      st.ended || st.cash < dopPrice || !diggable);
    if (!diggable) note('dop-rule', 'dig the flat ground', 'a slope wall is a wall, not a dam');
    if (dozerFee) {
      note('dozer-day', `includes today's bulldozer`, `${money(dozerFee)} once a day`);
    }
    if (Number.isInteger(p.waterTable)) {
      const lv = Array.isArray(p.level) ? p.level[y * p.w + x] : Math.round((p.height[y * p.w + x] || 0) / LEVEL_M);
      // LD-12 (owner GO 2026-10-22): the dig is priced and TIMED, because the wait is what
      // decides whether it is water or a grave. The table fills at FILL_PER_DAY levels a
      // day, so a hole N levels under it is N×5 days of nothing — and the sim kills a dry
      // household on day 3. Quoting the days is the difference between a choice and a trap.
      // Two corrections to the old note, both measured: `level` counts UP with height, so
      // the depth to dig is lv − waterTable (the old sign was inverted and read "below the
      // water table" on high ground), and p.damTiles is EMPTY until something is dug, so
      // this cannot be gated on it — that gate is why the warning never showed on day one.
      const per = st.damFillDaysPerLevel || 5;
      const dug = Array.isArray(p.damTiles) && p.damTiles.length > 0;
      const below = lv - p.waterTable;
      if (diggable || dug) {
        // The POSITION, and only the position. The old note read "the water table sits N
        // levels down — N × 5 days to fill", which was wrong in both halves: a dig STOPS at
        // the first strike, one level under the table, so the wait is ~5 days whatever the
        // height — and the height buys DIGS (and money), not days. The wait belongs to
        // damEstimate, which reads tickWater's own rule instead of paraphrasing it.
        note('water-table', below > 0
          ? `the water table sits ${below} level${below === 1 ? '' : 's'} down from this tile`
          : below === 0 ? 'the water table is at this ground' : 'this ground is already below the water table');
      }
      if (est) {
        // LD-12, and the finding is a COMPARISON, not a number. A dig that strikes in five
        // days cannot save a plot that dies in three, so the note says both figures and which
        // one wins - before the money moves, not after. Every term is the sim's own: days and
        // digs from damEstimate, the seep rate from FILL_PER_DAY, the clock from WATER.deathDays.
        const tooLate = est.strikes && est.days > st.dryDays;
        note('dam-wait', est.strikes
          ? `strikes water — ~${est.days} day${est.days === 1 ? '' : 's'} of seep before it is a dam`
            + (tooLate ? `, and a dry plot dies in ${st.dryDays}` : '')
          : `this dig will not reach water — about ${est.digsToStrike} dig${est.digsToStrike === 1 ? '' : 's'} down from here`,
          est.strikes
            ? `${est.depthLevels} level${est.depthLevels === 1 ? '' : 's'} under the table · ${per} days a level`
            : `and ~${per} days of seep once it does`);
      }
      if (diggable && st.noWaterSource) {
        note('dam-first', 'a dam cannot be your first water',
          `the tank comes first — ${st.dryDays || 3} dry days ends this life`);
      }
    }
    // the terraformer (TT-style): one level up or down, the flow pass keeps the
    // ground legal, the bill is the earth actually moved. The price quoted is the
    // base tile plus the dozer day when it is still due.
    terra('raise', 'Raise the ground', c.grade, { kind: 'raise', x, y });
    terra('lower', 'Lower the ground', c.grade, { kind: 'lower', x, y });
    if (!this._tileFlat(x, y)) note('not-flat', 'slope — takes track, not buildings', 'press G for the ground map');
    return out;
  }

  /** The build menu: one priced row per rung, cost + true footprint + what it
      demands. Picking a row does NOT spend — it arms the ghost preview. */
  _buildMenuItems(x, y) {
    const st = this._state();
    const c = st.costs;
    const fps = this._fps();
    const out = [];
    for (const it of BUILD_ITEMS) {
      const def = it.kind === 'room' ? c.unit : c[it.kind];
      if (!Number.isFinite(def)) continue;
      // U8: the sim names its own rungs (see _accomLabel); BUILD_ITEMS types a label only so
      // the standalone probes still have one to show.
      const label = this._accomLabel(it.kind);
      const fp = fps[it.kind] || [1, 1];
      if (fp[0] * fp[1] <= 0) continue;       // not placed (the spare room)
      // the driveway quote: a multi-tile site pays from its cheapest cell
      let dw = 0;
      if (st.driveway && fp[0] * fp[1] > 1) {
        dw = Infinity;
        for (let cx = x; cx < x + fp[0]; cx++) {
          for (let cy = y; cy < y + fp[1]; cy++) {
            if (cx >= 0 && cy >= 0 && cx < this.p.w && cy < this.p.h) {
              dw = Math.min(dw, st.driveway(cx, cy));
            }
          }
        }
        if (!Number.isFinite(dw)) dw = 0;
      } else if (st.driveway) {
        dw = st.driveway(x, y);
      }
      const price = def + dw;
      const right = `${money(price)} · ${fp[0]}×${fp[1]}`
        + (dw > 0 ? ` · +${money(dw)} drive` : '');
      const lacking = st.facilities && it.needs && !st.facilities[it.needs];
      out.push({
        kind: 'act', id: 'build-' + it.kind, label, right,
        action: { kind: 'buildpick', accom: it.kind, x, y },
        // U8: one home per plot. `canPlaceAccom` only refuses a site that OVERLAPS the first
        // house, so a second roof anywhere else is legal to the sim and nonsense as a game;
        // the page says whether one already stands (it counts the Stayed's family house,
        // which is plot scenery, not an accom unit).
        disabled: st.ended || st.cash < price || (it.kind === 'house' && st.hasHouse),
      });
      if (it.kind === 'house' && st.hasHouse) {
        out.push({ kind: 'note', id: 'why-house', label: 'you already have a house', right: 'one home per plot' });
      }
      if (lacking) {
        out.push({
          kind: 'note', id: 'needs-' + it.kind,
          label: it.kind === 'camp' ? 'needs an ablution block before it can let'
            : `needs a ${it.needs}`,
          right: '',
        });
      }
    }
    return out;
  }

  /** Header line: what you just clicked, in the sim's own words where it has any.
      The tile's elevation rides along — it is the one number this game is about. */
  _popupHead(x, y) {
    const occ = this._occupant(x, y);
    const where = `${x},${y} · ${Math.round(this._h(x, y)).toLocaleString()} m`;
    if (!occ) return `Empty ground · ${where}`;
    switch (occ.type) {
      case 'tree': return `${occ.tree.kind} · ${occ.tree.age || 0}y · ${where}`;
      case 'bed': return `A bed of ${this._cropLabel(occ.bed.crop)} · ${where}`;
      case 'hive': return `A hive · ${where}`;
      case 'accom': return `${this._accomLabel(occ.acc.kind)} · ${where}`;
      case 'building': return `A building · ${where}`;
      case 'gate': return `The gate · ${where}`;
      default: return where;
    }
  }

  _openPopup(x, y) {
    if (this._popup && this._popup.x === x && this._popup.y === y) return this._closePopup();
    const items = this._tileActions(x, y);
    if (!items.length) return this._closePopup();
    this._popup = { x, y, items };
    this.sel = [x, y];
    this._renderPopup();
    this._emitPopup();
    this._draw();
  }

  /** The build menu itself: opened from the empty-ground popup's Build… row. */
  _openBuildMenu(x, y) {
    const items = this._buildMenuItems(x, y);
    if (!items.length) return;
    this._popup = { x, y, items, title: 'Build · ' + x + ',' + y };
    this.sel = [x, y];
    this._renderPopup();
    this._emitPopup();
    this._draw();
  }

  /** VIS-10: the panel is anchored to a CELL. Position across a late layout is one thing
      (resize() re-places it); the ROWS are another, and a panel still offering "Plant greens"
      on ground that has become a bed is the wrong tile's verbs with the right anchor. So when
      the world under an open panel changes - a late setPlot (terrain, a save arriving), a plot
      rebuilt after terraforming - re-read that same cell. The build menu is its own list and
      keeps its title, so it is left alone. */
  _refreshPopup() {
    if (!this._popup || this._popup.title) return;
    const { x, y } = this._popup;
    const items = this._tileActions(x, y);
    if (!items.length) { this._closePopup(true); return; }
    this._popup.items = items;
    this._renderPopup();
    this._emitPopup();
  }

  /** Public close — plot.html calls it when a sidebar mode takes over the click. */
  closePopup() { this._closePopup(); }

  _closePopup(quiet = false) {
    if (!this._popup && !this.sel) return;
    this._popup = null;
    this.sel = null;
    if (this._pp) this._pp.style.display = 'none';
    this._emitPopup();
    if (!quiet) this._draw();
  }

  _popupEl() {
    if (this._pp) return this._pp;
    if (typeof document === 'undefined' || !document.createElement) return null;
    const host = (this.cv && this.cv.parentElement) || document.body;
    if (!host) return null;
    const el = document.createElement('div');
    el.className = 'tile-popup';
    el.setAttribute('role', 'menu');
    Object.assign(el.style, {
      // above the floating windows (.win is 70) and below the end-of-run overlay (#over, 80):
      // an open window used to cover the popup's price column, which is exactly the half of a
      // crop row you read before choosing. #stage has no z-index, so 30 competed at the root.
      position: 'absolute', left: '0px', top: '0px', zIndex: '75', display: 'none',
      // 258, not 240: "Plant potato" + "H$200 · 32d · 17.5 a day" is one line at 258 and two
      // at 240, and three two-line rows is what makes the picker look like a crowd. Still
      // inside a 390px phone screen.
      minWidth: '176px', maxWidth: '258px', padding: '4px',
      borderRadius: '9px', background: UI.popBg, border: `1px solid ${UI.popEdge}`,
      boxShadow: '0 10px 26px rgba(0,0,0,.55)', color: UI.popText,
      font: '12.5px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif',
      userSelect: 'none', webkitUserSelect: 'none',
    });
    // a tap inside the panel must not reach the canvas or the document dismisser
    el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    host.appendChild(el);
    this._pp = el;
    return el;
  }

  _renderPopup() {
    const el = this._popupEl();
    if (!el || !this._popup) return;
    const { x, y, items } = this._popup;
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tp-head';
    head.textContent = this._popup.title || this._popupHead(x, y);
    Object.assign(head.style, {
      padding: '4px 8px 5px', fontSize: '10px', letterSpacing: '.07em', textTransform: 'uppercase',
      color: UI.popHead,
      // the panel can now scroll: which cell this menu belongs to must not scroll away with it
      position: 'sticky', top: '0', zIndex: '1', background: UI.popBg,
    });
    el.appendChild(head);

    for (const it of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tp-row';
      row.dataset.act = it.id;
      row.dataset.kind = it.kind;
      // U3: a finger needs 44px of target, a mouse does not. Decided per render, so a
      // popup built before a rotation still grows when the page goes coarse/narrow.
      const touch = typeof window !== 'undefined' && window.matchMedia
        && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 620);
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;'
        + `width:100%;margin:0;padding:${touch ? '9px 9px' : '6px 8px'};`
        + `min-height:${touch ? '44px' : '0'};`
        + 'border:0;border-radius:6px;background:transparent;'
        + `color:${UI.popText};font:inherit;text-align:left;cursor:pointer;`;
      const l = document.createElement('span');
      l.className = 'tp-l';
      l.textContent = it.label;
      const r = document.createElement('span');
      r.className = 'tp-c';
      r.textContent = it.right || '';
      r.style.cssText = `color:${UI.popMuted};font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11.5px`;
      row.append(l, r);
      if (it.kind === 'note') {
        row.disabled = true;
        row.style.cursor = 'default';
        l.style.color = UI.popMuted;
      } else if (it.disabled) {
        row.disabled = true;
        row.style.opacity = '0.42';
        row.style.cursor = 'not-allowed';
      } else {
        row.addEventListener('mouseenter', () => { row.style.background = UI.popRowHover; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._pick(it);
        });
      }
      el.appendChild(row);
    }
    el.style.display = 'block';
    this._placePopup();
  }

  /** Anchor beside the diamond, then clamp inside the canvas. On a narrow phone there is
      no room on either side, so it drops below the tile (or above it near the bottom). */
  _placePopup() {
    const el = this._pp;
    if (!el || !this._popup || !this.cv) return;
    const host = el.parentElement;
    if (!host || !this.cv.getBoundingClientRect) return;
    const cr = this.cv.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const [cx, cy] = this._at(this._popup.x, this._popup.y);
    const px = cx / this.dpr + (cr.left - hr.left);
    const py = cy / this.dpr + (cr.top - hr.top);
    const halfW = (TW * this.cam.zoom) / (2 * this.dpr);
    const halfH = (TH * this.cam.zoom) / (2 * this.dpr);
    /* A verb the player cannot reach is a verb that does not exist. The panel had no ceiling
       and no scroll, so a long tile menu (a bare homesteader tile already offers 13 verbs,
       and the crop picker turns one bed row into three) grew past the bottom of a short
       window and the clamp below had nothing left to clamp. Ceiling first, measure after, so
       `ht` is the height the canvas can actually hold. */
    el.style.maxHeight = `${Math.max(140, Math.floor(cr.height - 12))}px`;
    el.style.overflowY = 'auto';
    el.style.overflowX = 'hidden';
    el.style.overscrollBehavior = 'contain';   // a flick inside the menu must not drag the map
    // a classic scrollbar eats ~15px of the panel's width, which is the difference between a
    // crop row on one line and the label wrapping under it -- and a wrapped row makes the
    // panel taller, which makes the scrollbar, which makes the wrapping. Thin keeps the loop
    // from starting.
    el.style.scrollbarWidth = 'thin';
    el.style.scrollbarColor = `${UI.popEdge} transparent`;
    const w = el.offsetWidth || 180, ht = el.offsetHeight || 120;
    const x0 = cr.left - hr.left, y0 = cr.top - hr.top;
    const xMax = x0 + cr.width - w - 6, yMax = y0 + cr.height - ht - 6;
    let left = px + halfW + 10;
    let top = py - ht / 2;
    const fitsRight = left <= xMax;
    const fitsLeft = px - halfW - 10 - w >= x0 + 6;
    if (!fitsRight && !fitsLeft) {
      left = px - w / 2;
      const below = py + halfH + 10;
      top = below + ht <= yMax ? below : py - halfH - 10 - ht;
    } else if (!fitsRight) {
      left = px - halfW - 10 - w;      // flip to the other side of the cell
    }
    left = clamp(left, x0 + 6, Math.max(x0 + 6, xMax));
    top = clamp(top, y0 + 6, Math.max(y0 + 6, yMax));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  _pick(it) {
    if (!it || it.kind !== 'act' || it.disabled) return;
    const action = it.action;
    if (action && action.kind === 'buildmenu') {
      this._closePopup();
      this._openBuildMenu(action.x, action.y);
      return;
    }
    if (action && action.kind === 'buildpick') {
      // no money moves here: the rung arms the ghost, the click on the map places
      this._closePopup();
      this._setGhost(action.accom, action.x, action.y);
      this._draw();
      return;
    }
    this._closePopup();
    if (this.opts.onAction) this.opts.onAction(action, it);
  }

  /** Scrapeable state for tools/tile-probe.html and the browser gate. */
  _emitPopup() {
    if (typeof window === 'undefined') return;
    window.__popup = this._popup
      ? {
        open: true, x: this._popup.x, y: this._popup.y,
        items: this._popup.items.map((i) => ({
          kind: i.kind, id: i.id, label: i.label, right: i.right,
          action: i.action || null, disabled: !!i.disabled,
        })),
      }
      : { open: false, x: null, y: null, items: [] };
  }

  /* ---------------------------------------------------------- backdrop bake */
  /** Painted Hogsback behind the diamond: sky at the very top, two ridge bands in cold
      blue-grey (the far one lighter), a mist band sitting in the valley between them,
      a near band, then a fade into the page backdrop. Scenery only — baked once per
      canvas size and blitted each frame, so it costs nothing per repaint. */
  _ensureBackdrop() {
    const W = this.cv.width, H = this.cv.height;
    const key = `${W}x${H}`;
    if (this._bdKey === key && this._bdCv) return;
    if (typeof document === 'undefined' || !document.createElement) return;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');

    const sky = g.createLinearGradient(0, 0, 0, H * 0.19);
    sky.addColorStop(0, ART.sky[0]);
    sky.addColorStop(0.55, ART.sky[1]);
    sky.addColorStop(1, ART.sky[2]);
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    /** Ridged value noise on a 1-D lattice: 1 − |2n−1| per octave, which turns smooth
        hills into peaks and shoulders instead of a wave. Returns 0..1. */
    const ridgeY = (t, seed, freq) => {
      let v = 0, amp = 1, norm = 0, f = freq;
      for (let o = 0; o < 4; o++) {
        const x = t * f + seed * 9.7;
        const i = Math.floor(x), fr = x - i;
        const s = fr * fr * (3 - 2 * fr);
        const a = jitter(i, 0, 300 + o), b = jitter(i + 1, 0, 300 + o);
        const n = a * (1 - s) + b * s;
        const r = 1 - Math.abs(2 * n - 1);
        v += r * r * amp;
        norm += amp;
        amp *= 0.52;
        f *= 2.15;
      }
      return v / norm;
    };

    /** One range: a peak line from the base down, filled, with a lighter top edge —
        the edge is what makes a painted ridge read at this size. */
    const ridge = (baseY, amp, colour, seed, freq, edge) => {
      const pts = [];
      const steps = 140;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        pts.push([t * W, baseY - ridgeY(t, seed, freq) * amp]);
      }
      g.beginPath();
      g.moveTo(0, H);
      for (const [x, y] of pts) g.lineTo(x, y);
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = colour;
      g.fill();
      if (edge) {
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = edge;
        g.lineWidth = Math.max(1, this.dpr * 0.8);
        g.stroke();
      }
    };

    // three ranges, the far one palest — haze is the whole depth cue
    ridge(H * 0.120, H * 0.078, ART.far, 1.3, 2.6, 'rgba(206,222,229,0.34)');
    ridge(H * 0.152, H * 0.068, ART.mid, 4.7, 3.4, 'rgba(178,203,212,0.24)');
    ridge(H * 0.192, H * 0.056, ART.near, 8.1, 4.6, 'rgba(126,156,164,0.18)');

    // mist band: it OVERLAPS the base of the nearest range, which is what separates the
    // ranges from each other and from the plot
    for (let i = 0; i < 10; i++) {
      const y = H * (0.158 + i * 0.0072);
      const w = W * (0.55 + jitter(i, 7, 301) * 0.7);
      const x = (W - w) * jitter(i, 3, 302);
      const m = g.createLinearGradient(x, y, x + w, y);
      m.addColorStop(0, 'rgba(228,238,241,0)');
      m.addColorStop(0.5, ART.mist);
      m.addColorStop(1, 'rgba(228,238,241,0)');
      g.fillStyle = m;
      g.fillRect(x, y, w, Math.max(1.5, H * 0.0055));
    }

    // fade to the page backdrop so the plot sits on land, not on a horizon line
    const fade = g.createLinearGradient(0, H * 0.185, 0, H * 0.40);
    fade.addColorStop(0, ART.fade[0]);
    fade.addColorStop(1, ART.fade[1]);
    g.fillStyle = fade;
    g.fillRect(0, H * 0.185, W, H * 0.815);

    this._bdCv = cv;
    this._bdKey = key;
  }

  /* ------------------------------------------------------------ land wash */
  /** The plot is a clearing, not a board game tile: a soft-edged wash of the same land
      colour carries the diamond's own edges outward so the ground runs to the ridges
      instead of stopping at a survey line. Screen space, one path per frame, and the
      polygon is deliberately far bigger than the gradient so no straight edge shows. */
  _landWash(ctx) {
    const p = this.p;
    if (!p) return;
    const gcx = p.w / 2, gcy = p.h / 2;
    const corner = (x, y, k) => project(gcx + (x - gcx) * k, gcy + (y - gcy) * k, 0, this.cam);
    const a = corner(0, 0, 2.6), b = corner(p.w, 0, 2.6), c = corner(p.w, p.h, 2.6), d = corner(0, p.h, 2.6);
    const mid = project(gcx, gcy, 0, this.cam);
    const far = corner(p.w, p.h, 1.4);
    const R = Math.max(40, Math.hypot(far[0] - mid[0], far[1] - mid[1]));
    // the same grass the bake is using this season, dropped into shade — the plot has to
    // read as a clearing in THIS land, not as a bright tile dropped on a dark field
    const month = (this.h && this.h.date && this.h.date.month) || 1;
    const grass = (seasonTint(month) || {}).grass || GROUND.grass;
    const col = (k, al) => `rgba(${Math.round(grass[0] * k)},${Math.round(grass[1] * k)},${Math.round(grass[2] * k)},${al})`;
    const wash = ctx.createRadialGradient(mid[0], mid[1], R * 0.20, mid[0], mid[1], R);
    wash.addColorStop(0, col(0.86, 0.90));
    wash.addColorStop(0.55, col(0.78, 0.82));
    wash.addColorStop(0.85, col(0.62, 0.46));
    wash.addColorStop(1, col(0.50, 0));
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
    ctx.fillStyle = wash;
    ctx.fill();
  }

  /* ------------------------------------------------------- ground bake */
  /* The ground is per-tile VECTOR now (TERRAIN-SPEC §3): every tile a quad raised
     to its own height — blocky TT terracing, half-metre steps — and every drop to
     a lower neighbour a bare-earth SKIRT, the classic TT wall. (Corner-averaged
     quads would make the surface continuous and leave nothing for a skirt to
     expose; cornerH() survives for the smooth edge lines that want it.) All of it
     is STATIC ground — it moves only when terraforming edits p.height — so it
     bakes into an offscreen canvas keyed on zoom step + season + a height hash +
     the laid track, exactly the contract the old pixel bake had. */
  _ensureGround() {
    const p = this.p, cam = this.cam;
    // bake at a quantised step of the live zoom — see bakeStep()
    const bz = bakeStep(cam.zoom);
    this.bakeZoom = bz;
    // the in-sim season re-tints the field (artist2's table); a flatten moves the
    // height hash; a new track tile rides the surface — any of them re-bakes
    const simMonth = (this.h && this.h.date && this.h.date.month) || 1;
    const tint = seasonTint(simMonth);
    const hh = this._heightHash();
    const trackLen = (p.track && p.track.length) || 0;
    // gravel and dirt are the same length when a drive is upgraded tile by tile, so the
    // count alone would not re-bake and the road would keep its old surface. Laying or
    // lifting always moves trackLen, so (trackLen, gravelLen) is enough to see any edit.
    const gravelLen = ((p.track || []).filter((t) => t.kind === 'gravel')).length;
    const mudLen = (p.mud && p.mud.length) || 0;
    // the dams (TERRAIN-SPEC §7): count + total seep + the water surface span —
    // the fill rises day by day, which moves neither the height hash nor any other
    // key, so the fill state is keyed in itself and each seep step re-bakes. The
    // surface level keys separately: the waterline ring and strokes hang off it.
    const damList = Array.isArray(p.damTiles) ? p.damTiles : [];
    const damFill = Math.round(damList.reduce((a, t) => a + (t.depth || 0), 0) * 10);
    const wtKey = Number.isInteger(p.waterTable) ? p.waterTable : null;
    const lvlOf = (t) => (Array.isArray(p.level) ? (p.level[t.y * p.w + t.x] || 0)
      : Math.round((p.height ? (p.height[t.y * p.w + t.x] || 0) : 0) / LEVEL_M));
    let surfHi = -Infinity;
    for (const t of damList) {
      const s = wtKey != null ? Math.min(wtKey, lvlOf(t) + (t.depth || 0)) : lvlOf(t);
      if (s > surfHi) surfHi = s;
    }
    const surfKey = Number.isFinite(surfHi) ? surfHi : 'none';
    // the road (owner 2026-10-21): the strip and its wear hang off the gate side
    // and the condition — bucketed every 10 points, because the condition drifts
    // daily and a per-point key would re-bake the world every dawn
    const roadSideKey = this._roadSide() || 'none';
    const roadCond = clamp(Math.round((this.h && this.h.road && this.h.road.condition != null)
      ? this.h.road.condition : 100), 0, 100);
    const roadBucket = Math.floor(roadCond / 10);
    // ruts now answer to traffic, and traffic moves every day - so it is in the bake key,
    // BUCKETED into five steps. An unbucketed read would re-bake the whole world on any
    // night a guest count changed, for a change in a line 0.05 alpha wide.
    const trafficBucket = Math.round(clamp(((this.h && this.h.lastNights) || 0) / 8, 0, 1) * 4);
    const key = `${p.w}x${p.h}:${bz.toFixed(2)}:${tint.season}:${hh}:${trackLen}:${gravelLen}:${mudLen}:${damList.length}:${damFill}:${surfKey}:${roadSideKey}:${roadBucket}:${trafficBucket}`;
    if (this._groundKey === key && this.groundCv) return;
    this._groundKey = key;
    const bakeT0 = (typeof performance !== 'undefined') ? performance.now() : 0;

    const trackSet = new Set((p.track || []).map((t) => `${t.x},${t.y}`));
    const trackKind = new Map((p.track || []).map((t) => [`${t.x},${t.y}`, t.kind || 'dirt']));
    const mudSet = new Set((p.mud || []).map((t) => `${t.x},${t.y}`));
    /* Which MADE surface a tile carries, or null for natural ground. These three
       collections were built here and never read until 10-22, so a driveway the player
       paid H$250 a tile for changed nothing on screen — on kloof-crest the tile stayed
       'rock' and the drive rendered as grey flagstone. surfAt() is the same question for
       a NEIGHBOUR, which is what lets the wheel ruts follow the drive and bend at a
       corner instead of every tile reusing one axis for the whole road. */
    const surfOf = (ax, ay) => {
      if (ax < 0 || ay < 0 || ax >= p.w || ay >= p.h) return null;
      if (p.ground[ay * p.w + ax] === 'water') return null;
      const k = trackKind.get(`${ax},${ay}`);
      if (k === 'gravel') return 'gravel';
      if (k) return 'track';
      if (mudSet.has(`${ax},${ay}`)) return 'mud';
      return null;
    };
    const damMap = new Map(damList.map((t) => [`${t.x},${t.y}`, t]));
    const wt = wtKey;

    const b = this._bounds();
    const maxZ = this._maxZ();
    const pad = Math.ceil(2 * bz);
    const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!cv) return;
    cv.width = Math.ceil(b.width * bz) + pad * 2;
    // the raised crest lives maxZ above the flat plane — the bake carries it
    cv.height = Math.ceil((b.height + maxZ) * bz) + pad * 2;
    const g = cv.getContext('2d');

    // bake in world screen space at the BAKE zoom; the bbox's top-left corner sits
    // at (pad, pad), the crest maxZ above it
    const bake = { ox: pad - b.minX * bz, oy: pad + maxZ * bz - b.minY * bz, zoom: bz };
    /** A grid corner raised to its corner-averaged height (smooth edge lines). */
    const corner = (cx, cy) => project(cx, cy, this._z(this.cornerH(cx, cy)), bake);
    /** A fractional grid point raised to its containing tile's height (tufts, stream). */
    const spot = (x, y) => project(x, y, this._z(this._h(Math.floor(x), Math.floor(y))), bake);

    const kinds = ['grass', 'scrub', 'rock', 'mud', 'bank', 'water', 'track', 'gravel'];
    const T = {};
    for (const k of kinds) T[k] = (tint && tint[k]) || GROUND[k];

    const rgb = (c, k) => `rgb(${clamp(Math.round(c[0] * k), 0, 255)},${clamp(Math.round(c[1] * k), 0, 255)},${clamp(Math.round(c[2] * k), 0, 255)})`;
    const quad = (a, q1, q2, q3) => {
      g.beginPath();
      g.moveTo(a[0], a[1]); g.lineTo(q1[0], q1[1]); g.lineTo(q2[0], q2[1]); g.lineTo(q3[0], q3[1]);
      g.closePath();
      g.fill();
    };

    /* ---- ONE rut routine for every made surface ---------------------------------
       The drive and the public road meet at the gate, so they must draw their wheel
       lines the same way or the seam shows. Depth is 0..1 and comes from USE, not from a
       threshold nobody reaches: the road's ruts used to be gated on `condition < 20`, and
       measured over a full 240-day run with no repairs at all the condition only fell
       70 -> 66 (roadDecay is scaled by road.km and this plot is short), so that branch
       was effectively dead code and a worn road never showed a rut.

       Traffic is `h.lastNights` - the guest cars of yesterday, which the sim already
       keeps precisely because "tonight's guests are tomorrow morning's traffic". It is a
       plain state number, so reading it breaks no import rule. Zero guests and the drive
       is a faint pair of tracks; a full house rutters it deep. */
    const cars = (this.h && this.h.lastNights) || 0;
    const traffic = clamp(cars / 8, 0, 1);
    const rutDepth = (surfKind, wear01) => {
      const w = (wear01 ?? traffic);
      const base = surfKind === 'mud' ? 0.38 + 0.62 * w   // mud remembers feet, even dry
        : 0.18 + 0.82 * w;                                 // dirt/gravel keep the old ramp
      return clamp((RUT_SOFT[surfKind] ?? 0.5) * base, 0, 1);
    };
    const rutLine = (ax, ay, bx, by, z, depth, tone) => {
      const pa = project(ax, ay, z, bake), pb = project(bx, by, z, bake);
      g.beginPath();
      g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]);
      g.strokeStyle = `rgba(${tone},${(0.34 + depth * 0.40).toFixed(3)})`;
      g.lineWidth = Math.max(1.4, bz * (1.7 + depth * 1.7));
      g.stroke();
    };

    const span = Math.max(1, this._zMax - this._zBase);
    const clr = p.clearing;
    const baseLvl = this._baseLvl;
    const lvlAt = (x, y) => {
      if (x < 0 || y < 0 || x >= p.w || y >= p.h) return baseLvl;
      if (Array.isArray(p.level)) return p.level[y * p.w + x] || 0;
      return Math.round((p.height[y * p.w + x] || 0) / LEVEL_M);
    };
    let skirts = 0;
    let ramps = 0;
    let crestLines = 0;
    let rimLines = 0;

    const contourSegs = [];   // stroked after the tile pass — see the ramp block below
    const waterlineSegs = []; // dam waterlines — stroked after the tile pass too
    const waterEdgeSegs = []; // VIS-01: the water/land boundary, once, after the quads
    let waterlines = 0;

    /* Shared corner levels (the MAX of touching tiles — same rule as _cornerL):
       flat ground sits level, a one-side rise is the TT ramp, two perpendicular
       rises make the TT corner ramp, and every seam meets because both tiles read
       the same corner. Water stays a flat pond at its own level. */
    const cornerLvl = (cx, cy) => {
      let mx = null;
      for (let ty = cy - 1; ty <= cy; ty++) {
        for (let tx = cx - 1; tx <= cx; tx++) {
          if (tx < 0 || ty < 0 || tx >= p.w || ty >= p.h) continue;
          const l = lvlAt(tx, ty);
          if (mx === null || l > mx) mx = l;
        }
      }
      return mx == null ? baseLvl : mx;
    };
    // which tiles render as ramps (any corner above their own level) — the banding
    // pass needs it so flats leaning on a ramp keep a quiet, neutral tone
    const rampMask = new Uint8Array(p.w * p.h);
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const i2 = y * p.w + x;
        const L2 = lvlAt(x, y);
        if (p.ground[i2] !== 'water' && !damMap.has(`${x},${y}`)
          && (cornerLvl(x + 1, y) > L2 || cornerLvl(x + 1, y + 1) > L2
            || cornerLvl(x, y + 1) > L2 || cornerLvl(x, y) > L2)) rampMask[i2] = 1;
      }
    }
    /* ---- the public road (owner 2026-10-21): the potholed main road runs along
       the plot's gate edge, OUTSIDE the boundary — a 2-tile gravel band just
       beyond the fence line. It is the one place the player SEES the road's
       condition: potholes, then cracks, then mud ruts as it wears. Drawn first,
       so the plot's own tiles win at the seam. ---- */
    const side = this._roadSide();
    let roadTiles = 0;
    let potholes = 0;
    let potWorldD = 0;
    if (side) {
      const roadLen = side === 'N' || side === 'S' ? p.w : p.h;
      const roadRgb = [0, 1, 2].map((i2) => Math.round(T.mud[i2] * 0.45 + T.rock[i2] * 0.55));
      const gravelPat = (groundTexState === 'ready' && groundTex.gravel)
        ? this._groundPattern(g, 'gravel', bz) : null;
      const cE = (cx, cy) => this._zL(cornerLvl(cx, cy));
      // far strip first so the near one paints over the seam (painter's order)
      const ks = side === 'N' || side === 'W' ? [1, 0] : [0, 1];
      const centreOf = (t, lat) => side === 'S' ? [t, p.h + 1 + lat]
        : side === 'N' ? [t, -1 + lat]
          : side === 'W' ? [-1 + lat, t] : [p.w + 1 + lat, t];
      const roadZ = (gx, gy) => {
        if (side === 'S') return this._zL(lvlAt(clamp(Math.floor(gx), 0, p.w - 1), p.h - 1));
        if (side === 'N') return this._zL(lvlAt(clamp(Math.floor(gx), 0, p.w - 1), 0));
        if (side === 'W') return this._zL(lvlAt(0, clamp(Math.floor(gy), 0, p.h - 1)));
        return this._zL(lvlAt(p.w - 1, clamp(Math.floor(gy), 0, p.h - 1)));
      };
      for (const k of ks) {
        for (let i = 0; i < roadLen; i++) {
          let rx, ry, zc2;
          if (side === 'S') {
            rx = i; ry = p.h + k;
            zc2 = [cE(rx, p.h), cE(rx + 1, p.h), cE(rx + 1, p.h), cE(rx, p.h)];
          } else if (side === 'N') {
            rx = i; ry = -1 - k;
            zc2 = [cE(rx, 0), cE(rx + 1, 0), cE(rx + 1, 0), cE(rx, 0)];
          } else if (side === 'W') {
            rx = -1 - k; ry = i;
            zc2 = [cE(0, ry), cE(0, ry), cE(0, ry + 1), cE(0, ry + 1)];
          } else {
            rx = p.w + k; ry = i;
            zc2 = [cE(p.w, ry), cE(p.w, ry), cE(p.w, ry + 1), cE(p.w, ry + 1)];
          }
          const q = [
            project(rx, ry, zc2[0], bake), project(rx + 1, ry, zc2[1], bake),
            project(rx + 1, ry + 1, zc2[2], bake), project(rx, ry + 1, zc2[3], bake),
          ];
          g.fillStyle = rgb(roadRgb, 0.94 + jitter(rx, ry, 170) * 0.08);
          quad(q[0], q[1], q[2], q[3]);
          if (gravelPat) {
            g.save();
            g.globalCompositeOperation = 'overlay';
            g.globalAlpha = 0.6;
            g.fillStyle = gravelPat;
            quad(q[0], q[1], q[2], q[3]);
            g.restore();
          }
          roadTiles++;
          /* Wheel lines, one per lane across the 2-tile band, per tile so they ride the
             grade instead of cutting through it. Now CONTINUOUS with wear: the old gate
             was `condition < 20`, which a real 240-day game never gets near (measured
             70 -> 66 with no repairs at all), so a neglected road showed potholes and
             cracks but never a rut. /60 rather than /100 so the ruts are fully there by
             condition 40, where a driver is already picking their line around the holes. */
          {
            const midZ = (zc2[0] + zc2[1] + zc2[2] + zc2[3]) / 4;
            const rDepth = rutDepth('gravel', clamp((100 - roadCond) / 60, 0, 1));
            for (const lat2 of [-0.55, 0.55]) {
              const a0 = side === 'S' || side === 'N' ? [rx + 0.12, ry + 0.5 + lat2] : [rx + 0.5 + lat2, ry + 0.12];
              const a1 = side === 'S' || side === 'N' ? [rx + 0.88, ry + 0.5 + lat2] : [rx + 0.5 + lat2, ry + 0.88];
              rutLine(a0[0], a0[1], a1[0], a1[1], midZ, rDepth, '28,22,15');
            }
          }
        }
      }
      // potholes: one per 8 points of wear (clamped 0-14), spread deterministically
      // along the strip, each growing 0.5×→1.4× as the condition falls 100→0 —
      // a dark pit with a lit rim, the thing you see from the gate
      potholes = clamp(Math.round((100 - roadCond) / 8), 0, 14);
      const grow = 0.5 + (1 - roadCond / 100) * 0.9;
      const R = ROAD_POT_R * grow;
      potWorldD = 2 * R;
      for (let n2 = 0; n2 < potholes; n2++) {
        const t = clamp(((n2 + 0.5) / potholes) * roadLen
          + (jitter(n2, 3, 181) - 0.5) * (roadLen / potholes) * 0.6, 0.3, roadLen - 0.3);
        const lat = (jitter(n2, 9, 182) - 0.5) * 1.3;
        const [gx, gy] = centreOf(t, lat);
        const [sx2, sy2] = project(gx, gy, roadZ(gx, gy), bake);
        g.beginPath();
        g.ellipse(sx2, sy2, R * bz, R * bz * 0.55, 0, 0, 7);
        g.fillStyle = 'rgba(26,20,14,0.72)';
        g.fill();
        g.strokeStyle = 'rgba(214,198,158,0.30)';   // the lit rim
        g.lineWidth = Math.max(1, bz * 0.8);
        g.stroke();
      }
      // cracks (condition < 35): short dark polylines, seeded — never per-frame random
      if (roadCond < 35) {
        const nCracks = clamp(Math.round((35 - roadCond) / 6) + 2, 2, 8);
        for (let n2 = 0; n2 < nCracks; n2++) {
          const t = clamp(((n2 + 0.35) / nCracks) * roadLen
            + (jitter(n2, 5, 183) - 0.5) * 3, 0.2, roadLen - 0.2);
          const lat = (jitter(n2, 11, 184) - 0.5) * 1.2;
          const [gx, gy] = centreOf(t, lat);
          const [sx2, sy2] = project(gx, gy, roadZ(gx, gy), bake);
          const len = R * 1.7 * bz;
          const a0 = jitter(n2, 13, 185) * Math.PI;
          g.beginPath();
          g.moveTo(sx2, sy2);
          for (let s2 = 1; s2 <= 3; s2++) {
            const aa = a0 + (jitter(n2, s2, 186) - 0.5) * 0.9;
            const rr = (len * s2) / 3;
            g.lineTo(sx2 + Math.cos(aa) * rr, sy2 + Math.sin(aa) * rr * 0.55);
          }
          g.strokeStyle = 'rgba(20,16,10,0.55)';
          g.lineWidth = Math.max(1, bz * 0.7);
          g.stroke();
        }
      }
    }
    this._roadTiles = roadTiles;


    /* Painter's order on depthKey (x + y): a front wall covers the ground behind
       it, and a front tile's quad meets its own wall's bottom edge exactly. */
    for (let d = 0; d <= p.w + p.h - 2; d++) {
      for (let x = Math.max(0, d - p.h + 1); x <= Math.min(p.w - 1, d); x++) {
        const y = d - x;
        const i = y * p.w + x;
        const kind = p.ground[i];
        const L = lvlAt(x, y);
        const hRel = clamp((L - baseLvl) / (span / LEVEL_M), 0, 1);
        // a dam tile (TERRAIN-SPEC §7) draws like water for the corner model: its own
        // quad sits flat at the hole floor, the surface comes separately below
        const dam = damMap.get(`${x},${y}`) || null;
        const cL = (kind === 'water' || dam)
          ? [L, L, L, L]
          : [cornerLvl(x, y), cornerLvl(x + 1, y), cornerLvl(x + 1, y + 1), cornerLvl(x, y + 1)];
        const ramp = kind !== 'water' && !dam && (cL[0] > L || cL[1] > L || cL[2] > L || cL[3] > L);
        if (ramp) ramps++;
        const zc = cL.map((l) => this._zL(l));

        /* ---- walls first: they hang below the tile's edge. With the flow
           guarantee an interior drop always has the upper tile's ramp meeting the
           lower tile's surface exactly, so walls only appear where a FRONT-facing
           drop has no ramp tile: the plot edge (the island diorama wall) and any
           old-save pair the flow pass never saw. The +x face (screen bottom-right)
           catches more light than the +y face; both are bare earth, now clearly
           darker than the field so the terrain READS. */
        if (kind !== 'water') {
          const wall = (ax, ay, bx, by, t1, t2, k) => {
            const nbL = lvlAt(ax, ay);
            if (nbL >= Math.max(t1, t2)) return;   // the ramp already meets it
            const zb = this._zL(nbL);
            g.fillStyle = rgb(T.mud, k * (0.90 + jitter(x, y, 160) * 0.20));
            quad(
              project(ax, ay, this._zL(t1), bake),
              project(bx, by, this._zL(t2), bake),
              project(bx, by, zb, bake),
              project(ax, ay, zb, bake),
            );
            // the fall-rim: this wall's top edge is the edge of the world at that
            // level — stroke it dark so the drop reads from across the map
            g.beginPath();
            g.moveTo(project(ax, ay, this._zL(t1), bake)[0], project(ax, ay, this._zL(t1), bake)[1]);
            g.lineTo(project(bx, by, this._zL(t2), bake)[0], project(bx, by, this._zL(t2), bake)[1]);
            g.strokeStyle = rgb(T.mud, 0.75);
            g.lineWidth = 1;
            g.stroke();
            skirts++;
            rimLines++;
          };
          wall(x + 1, y, x + 1, y + 1, cL[1], cL[2], 0.44);
          wall(x, y + 1, x + 1, y + 1, cL[3], cL[2], 0.32);
        }

        /* ---- the tile itself: one quad through its four surface corners ---- */
        let shade;
        // a made surface replaces the natural ground under it (water and a dop hole win:
        // you cannot lay a drive into the stream, and the hole is below the surface)
        const surf = (dam || kind === 'water') ? null : surfOf(x, y);
        let col = surf || kind;
        if (dam) {
          // the dop hole shows as bare mud at the floor level until water stands in
          // it; the pond surface then rises toward the table (the seep depth), an
          // alpha wash so the floor reads through — the dam visibly FILLS day by day
          col = 'mud';
          // the waterline ring: a floor the water has just reached (surface level
          // === floor level) wears the wet-mud band — darker than dry mud, the
          // drawdown ring that climbs the pit as the fill rises
          const surfL = wt != null ? Math.min(wt, L + (dam.depth || 0)) : L;
          shade = (wt != null && surfL === L)
            ? 0.62 + jitter(x, y, 150) * 0.08
            : 0.82 + jitter(x, y, 150) * 0.10;
        } else if (kind === 'water') {
          /* VIS-01 (playtest 10-25): water was "a mosaic of alternating light/dark
             diamonds with seam lines". The per-tile jitter (±5%) is what made the
             alternation, and the tile seam stroke drew a lattice across the water. A
             water body has ONE level and one tone — it is the only surface in the game
             that does, because it is the only one the sim keeps flat. */
          shade = 1.0;
        } else {
          // tilt-shade: a slope that rises toward the camera (its near corner
          // (x+1,y+1) above the tile's level) catches +14%; a slope rising away
          // shows its back and takes −14%. At 30 px a 45° wedge must read instantly.
          const tilt = ramp ? (cL[2] > L ? 1.14 : 0.86) : 1;
          // level banding: plateaus get a tone step per level (±5% around the
          // ground colour, alternating) so flat ground reads as ground you can
          // build on — but flats leaning on a ramp stay neutral, so the ramp's
          // contrast is against quiet ground, and ramps themselves carry only
          // the tilt
          const nearRamp = !ramp && ((x > 0 && rampMask[i - 1]) || (x < p.w - 1 && rampMask[i + 1])
            || (y > 0 && rampMask[i - p.w]) || (y < p.h - 1 && rampMask[i + p.w]));
          /* VIS-05 (playtest 10-25: "cleared ground is a patchwork of brown rectangles
             in a regular grid — it looks like tiles, not land"). Two per-tile terms did
             it: a ±8% jitter and a ±5% level band, each applied per CELL, so every tile
             was a slightly different colour and the grid drew itself. The land still
             breathes — half as loudly, and the band is a hint rather than a stripe. */
          const band = (ramp || nearRamp) ? 1 : (((L - baseLvl) % 2 === 0) ? 1.025 : 0.975);
          shade = (0.95 + jitter(x, y, 150) * 0.07) * (0.92 + hRel * 0.14) * band * tilt;
          // the clearing reads as cut ground: paler, like the old bake's mown lift
          if (clr) {
            const cdx = (x - clr.x) / clr.rx, cdy = (y - clr.y) / clr.ry;
            const rr = Math.sqrt(cdx * cdx + cdy * cdy);
            if (rr < 1) shade *= 1 + 0.07 * clamp((1 - rr) / 0.35, 0, 1);
          }
          // a made surface is QUIET: no level banding, no clearing lift, almost no
          // per-tile jitter. Ground breathes; gravel does not.
          if (surf) shade = 0.96 + jitter(x, y, 152) * 0.07;
        }
        g.fillStyle = rgb(T[col] || T.grass, shade);
        quad(
          project(x, y, zc[0], bake),
          project(x + 1, y, zc[1], bake),
          project(x + 1, y + 1, zc[2], bake),
          project(x, y + 1, zc[3], bake),
        );
        /* ---- the painted texture, over the flat base in 'overlay': hue stays the
           palette's, detail comes from the generated watercolour source. The pattern
           matrix is the iso projection itself, so the texture follows the ground
           across tile boundaries — no per-tile crops, no patchwork. ---- */
        if (groundTexState === 'ready') {
          const texName = GROUND_TEX_KIND[col];
          /* water tiles take their texture from the RIBBON only (VIS-01: a per-tile
             overlay on top of the ribbon's own overlay produced a plaid — two pattern
             passes at different origins). */
          if (texName && groundTex[texName] && col !== 'water') {
            const pat = this._groundPattern(g, texName, bz);
            if (pat) {
              g.save();
              g.globalCompositeOperation = 'overlay';
              g.globalAlpha = GROUND_TEX_ALPHA[col] || 0.5;
              g.fillStyle = pat;
              quad(
                project(x, y, zc[0], bake),
                project(x + 1, y, zc[1], bake),
                project(x + 1, y + 1, zc[2], bake),
                project(x, y + 1, zc[3], bake),
              );
              /* VIS-05: two adjacent quads' anti-aliased edges left a hairline of the
                 base colour between them, and under an 'overlay' blend that hairline is
                 a BRIGHT line — the ground's diamond lattice. Stroking the same pattern
                 along the same path closes the seam at no cost. */
              g.strokeStyle = pat;
              g.lineWidth = 1.2;
              g.stroke();
              g.restore();
            }
          }
        }

        /* ---- wheel ruts: two lines either side of the centre line, each run out to
           the shared edge with a neighbouring made surface. Built PER CONNECTION, not
           from one axis for the whole road, so a straight drive reads as two tracks and
           a corner bends both through the middle of the turn. (The gate-road ruts above
           still take their axis from a single `side` for the entire strip — that is the
           other half of "do the tracks have correct direction all the time", and it is
           the public road, not the player's drive.) ---- */
        if (surf) {
          const zMid = (zc[0] + zc[1] + zc[2] + zc[3]) / 4;
          const links = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => surfOf(x + dx, y + dy));
          const depth = rutDepth(surf);
          const tone = surf === 'gravel' ? '52,48,42' : surf === 'mud' ? '44,32,18' : '74,55,32';
          g.lineCap = 'butt';
          /* the bed: one soft centre stroke per connection, so the track reads as
             one continuous path across tile seams (owner 10-25: "mud tracks don't
             join" — each tile was a lone brown diamond; the ruts alone were too
             faint at zero traffic to carry the eye from tile to tile). */
          for (const [dx, dy] of links) {
            const pa = project(x + 0.5, y + 0.5, zMid, bake);
            const pb = project(x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5, zMid, bake);
            g.beginPath();
            g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]);
            g.strokeStyle = `rgba(${tone},${(0.10 + depth * 0.18).toFixed(3)})`;
            g.lineWidth = Math.max(2, bz * (2.6 + depth * 1.6));
            g.lineCap = 'round';
            g.stroke();
            g.lineCap = 'butt';
          }
          for (const [dx, dy] of links) {
            const px = -dy, py = dx;                       // across the direction of travel
            for (const lat of [-0.24, 0.24]) {
              rutLine(x + 0.5 + px * lat, y + 0.5 + py * lat,
                x + 0.5 + dx * 0.5 + px * lat, y + 0.5 + dy * 0.5 + py * lat, zMid, depth, tone);
            }
          }
        }

        /* ---- the bank is HALF a tile (owner 10-22: "river bank is half bank and
           other half nearest water also be water"). A bank tile that touches the
           stream paints its water-facing half as water, so the damp strip is half the
           tile wide instead of a full tan diamond that read as a dirt road along the
           stream (playtest 10-25 crop). ---- */
        if (kind === 'bank') {
          const sides2 = [
            [1, 0, [[0.5, 0], [1, 0], [1, 1], [0.5, 1]]],
            [-1, 0, [[0, 0], [0.5, 0], [0.5, 1], [0, 1]]],
            [0, 1, [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]],
            [0, -1, [[0, 0], [1, 0], [1, 0.5], [0, 0.5]]],
          ];
          for (const [dx, dy, hq] of sides2) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
            if (p.ground[ny * p.w + nx] !== 'water') continue;
            g.save();
            g.globalAlpha = 0.62;
            g.fillStyle = rgb(T.water, 1.0);
            quad(
              project(x + hq[0][0], y + hq[0][1], zc[0], bake),
              project(x + hq[1][0], y + hq[1][1], zc[1], bake),
              project(x + hq[2][0], y + hq[2][1], zc[2], bake),
              project(x + hq[3][0], y + hq[3][1], zc[3], bake),
            );
            g.restore();
          }
        }

        /* ---- the water/land boundary (VIS-01): with the per-tile seams gone the
           shore has to be drawn deliberately, or the body just stops. One soft bank
           line per edge that faces land. ---- */
        if (kind === 'water') {
          const isW = (nx, ny) => (nx >= 0 && ny >= 0 && nx < p.w && ny < p.h)
            && p.ground[ny * p.w + nx] === 'water';
          const e = [
            [x, y, x + 1, y, zc[0], zc[1], !isW(x, y - 1)],       // back-right edge
            [x, y, x, y + 1, zc[0], zc[3], !isW(x - 1, y)],       // back-left edge
            [x + 1, y, x + 1, y + 1, zc[1], zc[2], !isW(x + 1, y)], // front-right
            [x, y + 1, x + 1, y + 1, zc[3], zc[2], !isW(x, y + 1)], // front-left
          ];
          for (const [ax, ay, bx, by, za, zb, edge] of e) {
            if (edge) waterEdgeSegs.push({ a: project(ax, ay, za, bake), b: project(bx, by, zb, bake) });
          }
        }

        /* ---- the tile seam: a whisper of an edge on every cell, so the tile being
           worked is always readable (owner ask). Subtle enough to keep TT's flat
           read; the diamonds carry the lattice. NOT on water (VIS-01): a seam stroke
           across a water body is a grid on a lake. ---- */
        if (kind !== 'water') {
        g.beginPath();
        g.moveTo(project(x, y, zc[0], bake)[0], project(x, y, zc[0], bake)[1]);
        g.lineTo(project(x + 1, y, zc[1], bake)[0], project(x + 1, y, zc[1], bake)[1]);
        g.lineTo(project(x + 1, y + 1, zc[2], bake)[0], project(x + 1, y + 1, zc[2], bake)[1]);
        g.lineTo(project(x, y + 1, zc[3], bake)[0], project(x, y + 1, zc[3], bake)[1]);
        g.closePath();
        g.strokeStyle = 'rgba(24,30,18,0.07)';
        g.lineWidth = 1;
        g.stroke();
        }

        /* ---- the dam's water surface, over the mud floor (TERRAIN-SPEC §7): the
           pond sits at floor + seep depth, capped at the table, lifted by the
           freeboard lip so a full dam reads as water, not ground; the waterline
           strokes are collected for the post-pass ---- */
        if (dam && wt != null) {
          const surf = Math.min(wt, L + (dam.depth || 0));
          if (surf > L) {
            const wz = this._zL(surf) + DAM_FREEBOARD;
            g.globalAlpha = 0.85;
            g.fillStyle = rgb(T.water, 0.94 + jitter(x, y, 150) * 0.10);
            quad(
              project(x, y, wz, bake),
              project(x + 1, y, wz, bake),
              project(x + 1, y + 1, wz, bake),
              project(x, y + 1, wz, bake),
            );
            g.globalAlpha = 1;
            // the pond wears the same painted water as the stream (owner GO 21-10 on
            // water): projection-aligned pattern overlay, so dam and river read alike
            if (groundTexState === 'ready' && groundTex.water) {
              const wpat = this._groundPattern(g, 'water', bz);
              if (wpat) {
                g.save();
                g.globalCompositeOperation = 'overlay';
                g.globalAlpha = 0.5;
                g.fillStyle = wpat;
                quad(
                  project(x, y, wz, bake),
                  project(x + 1, y, wz, bake),
                  project(x + 1, y + 1, wz, bake),
                  project(x, y + 1, wz, bake),
                );
                g.restore();
              }
            }
            const isRim = (nx, ny) => {
              if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) return false;
              if (damMap.has(`${nx},${ny}`)) return false;
              if (p.ground[ny * p.w + nx] === 'water') return false;
              return lvlAt(nx, ny) >= surf;
            };
            if (isRim(x + 1, y)) {
              waterlineSegs.push({ a: project(x + 1, y, wz, bake), b: project(x + 1, y + 1, wz, bake) });
              waterlines++;
            }
            if (isRim(x, y + 1)) {
              waterlineSegs.push({ a: project(x, y + 1, wz, bake), b: project(x + 1, y + 1, wz, bake) });
              waterlines++;
            }
          }
        }

        /* ---- crest + base contour lines (the terrace reader): a ramp's high
           edges (both corners above its level) stroke the lit top of the slope;
           its level edges stroke the foot. Collected — inline strokes are
           overpainted by the front tiles' quads. ---- */
        if (ramp) {
          const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
          for (const [a, b2] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
            const hi = cL[a] > L && cL[b2] > L;
            const lo = cL[a] === L && cL[b2] === L;
            if (!hi && !lo) continue;
            contourSegs.push({
              a: project(corners[a][0], corners[a][1], zc[a], bake),
              b: project(corners[b2][0], corners[b2][1], zc[b2], bake),
              hi, kind,
            });
            if (hi) crestLines++;
          }
        }
      }
    }
    this._skirts = skirts;
    this._ramps = ramps;

    /* ---- the river as a CURVE (owner: "water never forms sharp corners, it is
       always around bends"): a continuous textured ribbon through the stream tile
       centres, smoothed through midpoints — the tile-level water fills stay beneath
       it for the sim, but the visible water edge is a flowing curve, never a corner.
       A wider muddy shoulder is stroked underneath so the bank meets the water
       without a hard step. ---- */
    if (p.stream) {
      const vert = !!p.stream.vertical;
      const count = vert ? p.h : p.w;
      const pts = [];
      for (let n = 0; n < count; n++) {
        const wob = Math.round(Math.sin(n * 0.35) * 1.2);
        const c = p.stream.at + wob + 0.5;
        const q = vert ? [c, n + 0.5] : [n + 0.5, c];
        /* VIS-01 (playtest 10-25): the ribbon was projected at z = 0 — the FLAT plane
           below the terrain — so it was buried under the very tiles it was meant to
           cover. What the player saw was the raw per-tile water diamonds underneath:
           "a mosaic of alternating light/dark diamonds with seam lines". The ribbon
           now rides the water tiles' own level, like every other ground feature. */
        const tl = vert ? lvlAt(p.stream.at + wob, n) : lvlAt(n, p.stream.at + wob);
        pts.push(project(q[0], q[1], this._zL(tl), bake));
      }
      const strokePath = (colour, width, pattern) => {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
          g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        const L = pts[pts.length - 1];
        g.lineTo(L[0], L[1]);
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.strokeStyle = colour;
        g.lineWidth = width;
        g.stroke();
      };
      /* VIS-01 (playtest 10-25), measured off the crop: the ribbon was stroked at
         2.9 and 3.7 TILE WIDTHS — a 3-tile-wide canal across a 1-tile stream, which
         flooded the land either side so that trees standing legally on the bank read
         as "trees standing in the water". A one-tile band in 2:1 iso is 0.447 × TW
         across (the perpendicular distance between two adjacent grid lines), so the
         body is 0.46 and the muddy shoulder 0.62 — the stream now occupies exactly
         its own tile, and the bank sits inside the neighbour's edge. */
      strokePath(rgb(T.bank, 0.92), TW * bz * 0.62);         // muddy shoulder
      strokePath(rgb(T.water, 0.97), TW * bz * 0.46);        // the water body
      if (groundTexState === 'ready' && groundTex.water) {
        const wpat = this._groundPattern(g, 'water', bz);
        if (wpat) {
          g.save();
          g.globalCompositeOperation = 'overlay';
          /* 0.55 read as a woven plaid on a 1-tile stream (the watercolour source is a
             wide calm sheet; at stream scale its strokes become a lattice). 0.25 keeps
             the painted hint without the weave. */
          g.globalAlpha = 0.25;
          strokePath(wpat, TW * bz * 0.46);
          g.restore();
        }
      }
    }

    /* ---- the contour lines, now that every quad is down: no overdraw, the whole
       line network survives. Crest = the lit top of the slope, base = its foot. */
    for (const s of contourSegs) {
      g.beginPath();
      g.moveTo(s.a[0], s.a[1]);
      g.lineTo(s.b[0], s.b[1]);
      /* VIS-05 (playtest 10-25: "the cleared ground is a patchwork of brown rectangles
         separated by bright green seams, in a regular grid"). The seams were these crest
         lines: stroked at 1.38× the ground colour they were the BRIGHTEST thing in the
         field, so every terrace edge read as a lattice over the land. A crest is a
         lightening, not a highlight — 1.12× and thinner. */
      g.strokeStyle = s.hi ? rgb(T[s.kind] || T.grass, 1.12) : rgb(T.mud, 0.62);
      g.lineWidth = s.hi ? 1.5 : 1.2;
      g.stroke();
    }

    /* the dam waterlines, stroked after every quad: the contact line between the
       water sheet and the pit rim, in the fall-rims' mud language */
    for (const s of waterlineSegs) {      g.beginPath();
      g.moveTo(s.a[0], s.a[1]);
      g.lineTo(s.b[0], s.b[1]);
      g.strokeStyle = rgb(T.mud, 0.75);
      g.lineWidth = 2;
      g.stroke();
    }
    this._waterlines = waterlines;

    /* VIS-01: the shore. One soft dark-bank stroke on every water/land edge — the
       water body ends on a wet line instead of on a colour change between two tiles. */
    for (const s of waterEdgeSegs) {
      g.beginPath();
      g.moveTo(s.a[0], s.a[1]);
      g.lineTo(s.b[0], s.b[1]);
      g.strokeStyle = rgb(T.bank, 0.62);
      g.lineWidth = 2;
      g.stroke();
    }

    /* Crisp full-resolution detail on top of the upscaled field — the field carries the
       shapes, this carries the texture. Both are deterministic (jitter, not random). */
    // grain: a repeating mid-grey noise tile at overlay blend keeps brightness and adds bite
    const grainCv = document.createElement('canvas');
    grainCv.width = grainCv.height = 96;
    const gg2 = grainCv.getContext('2d');
    const gi = gg2.createImageData(96, 96);
    for (let gy2 = 0; gy2 < 96; gy2++) {
      for (let gx2 = 0; gx2 < 96; gx2++) {
        const v = 108 + jitter(gx2, gy2, 141) * 40;
        const i4 = (gy2 * 96 + gx2) * 4;
        gi.data[i4] = gi.data[i4 + 1] = gi.data[i4 + 2] = v;
        gi.data[i4 + 3] = 255;
      }
    }
    gg2.putImageData(gi, 0, 0);
    g.save();
    const c0 = corner(0, 0), c1 = corner(p.w, 0), c2 = corner(p.w, p.h), c3 = corner(0, p.h);
    g.beginPath();
    g.moveTo(c0[0], c0[1]); g.lineTo(c1[0], c1[1]); g.lineTo(c2[0], c2[1]); g.lineTo(c3[0], c3[1]);
    g.closePath();
    g.clip();
    g.globalAlpha = 0.12;
    g.globalCompositeOperation = 'overlay';
    g.fillStyle = g.createPattern(grainCv, 'repeat');
    g.fillRect(0, 0, cv.width, cv.height);
    g.restore();

    // grass and scrub tufts as full-res vector strokes — they stay sharp at any zoom
    if (TW * bz > 8) {
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const kind = p.ground[y * p.w + x];
          if (kind !== 'grass' && kind !== 'scrub') continue;
          if (damMap.has(`${x},${y}`)) continue;   // no tufts in the dam hole
          if (jitter(x, y, 91) > 0.30) continue;
          const [cx, cy] = spot(x + 0.25 + jitter(x, y, 92) * 0.5, y + 0.25 + jitter(x, y, 93) * 0.5);
          const len = Math.max(2.5, TW * bz * 0.13);
          g.strokeStyle = kind === 'grass' ? 'rgba(205,214,150,0.30)' : 'rgba(46,58,32,0.34)';
          g.lineWidth = Math.max(0.7, TW * bz * 0.015);
          g.beginPath();
          g.moveTo(cx - len * 0.45, cy + len * 0.30);
          g.lineTo(cx, cy - len * 0.55);
          g.lineTo(cx + len * 0.45, cy + len * 0.12);
          g.stroke();
        }
      }
    }

    /* Props (the artist's registry), sprinkled deterministically: grassTuft ~1 per 6
       grass cells, flowerPatch ~1 per 12, logs and rocks ~1 per 20 and only within two
       cells of a standing tree (the treeline). Never on a cell that already carries a
       tree, bed, hive, building or the gate. Absent from SPRITES → the block is skipped. */
    if (SPRITES.grassTuft || SPRITES.logs) {
      const used = new Set();
      const nearTree = new Set();
      for (const t of p.trees || []) {
        used.add(`${t.x},${t.y}`);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) nearTree.add(`${t.x + dx},${t.y + dy}`);
        }
      }
      for (const b of (this.h && this.h.beds) || []) used.add(`${b.x},${b.y}`);
      for (const v of (this.h && this.h.hives) || []) used.add(`${v.x},${v.y}`);
      // OWNER: "its in front of a log pile, impossible layering" — baked props can
      // never occlude a building, so a pile inside/next to a footprint always reads
      // wrong. Block the WHOLE footprint plus a one-cell apron: no props there at all.
      const blockRect = (x0, y0, fw, fh) => {
        for (let dy = -1; dy <= fh; dy++) for (let dx = -1; dx <= fw; dx++) used.add(`${x0 + dx},${y0 + dy}`);
      };
      for (const a of (this.h && this.h.accom) || []) {
        const af = this._fpOf(a.kind);
        blockRect(a.x, a.y, af[0], af[1]);
      }
      for (const bd of p.buildings || []) blockRect(bd.x, bd.y, bd.fw || 1, bd.fh || 1);
      if (p.gate) used.add(`${p.gate.x},${p.gate.y}`);
      const pick = (x, y) => {
        const k = `${x},${y}`;
        const near = nearTree.has(k);
        if (near && SPRITES.logs && jitter(x, y, 120) < 1 / 20) return 'logs';
        if (near && SPRITES.rocks && jitter(x, y, 125) < 1 / 20) return 'rocks';
        if (SPRITES.flowerPatch && jitter(x, y, 126) < 1 / 12) return 'flowerPatch';
        if (SPRITES.grassTuft && jitter(x, y, 127) < 1 / 6) return 'grassTuft';
        return null;
      };
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          if (p.ground[y * p.w + x] !== 'grass') continue;
          if (used.has(`${x},${y}`)) continue;
          const name = pick(x, y);
          if (!name) continue;
          const [px2, py2] = spot(x + 0.18 + jitter(x, y, 122) * 0.64, y + 0.18 + jitter(x, y, 123) * 0.64);
          g.save();
          g.translate(px2, py2);
          drawSprite(g, name, bz * (0.85 + jitter(x, y, 124) * 0.35), { seedX: x, seedY: y });
          g.restore();
        }
      }
    }

    /* The old stream ribbon (a hand-drawn wobble line over the water tiles) is GONE —
       owner: "why's there a line running in the stream?" It was a placeholder from
       before water had a surface; the textured water tiles + the tile seams carry the
       stream now. Keep the geometry (p.stream) for the sim and the pick. */

    this.groundCv = { cv, bake, maxZ };
    this._potholes = potholes;
    this._roadTiles = roadTiles;
    if (typeof performance !== 'undefined') {
      this._bakeMs = performance.now() - bakeT0;
      if (typeof window !== 'undefined') {
        window.__bakeMs = this._bakeMs;
        window.__skirts = skirts;
        window.__ramps = ramps;
        window.__crestLines = crestLines;
        window.__rimLines = rimLines;
        window.__waterlines = waterlines;
        window.__damSurf = surfKey;
        window.__damFreeboard = DAM_FREEBOARD;
        window.__roadSide = side;
        window.__roadTiles = roadTiles;
        window.__potholes = potholes;
        window.__potholeWorldD = potWorldD;
        window.__groundKey = key;
        window.__groundTiles = p.w * p.h;
      }
    }
  }

  /* -------------------------------------------------------------- draw */
  _draw() {
    const frameT0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ensureBackdrop();
    if (this._bdCv) {
      ctx.drawImage(this._bdCv, 0, 0);
    } else {
      const backdrop = ctx.createLinearGradient(0, 0, 0, H);
      backdrop.addColorStop(0, BACKDROP[0]);
      backdrop.addColorStop(0.5, BACKDROP[1]);
      backdrop.addColorStop(1, BACKDROP[2]);
      ctx.fillStyle = backdrop;
      ctx.fillRect(0, 0, W, H);
    }
    if (!this.p) return;

    // the land the plot is cleared out of — drawn over the ridges, under the plot
    this._landWash(ctx);

    this._ensureGround();
    if (this.groundCv) {
      // The bake was rendered with the flat diamond bbox left/top at (pad, pad +
      // maxZ·bz) in bake space; the object layer uses this.cam. Translate the blit
      // so both share one origin — otherwise a width-limited fit draws the ground
      // high, and the raised crest would sit maxZ too low.
      const b = this._bounds();
      const pad = Math.ceil(2 * this.bakeZoom);
      // blit-scaled between bake steps: k carries the live zoom the bake step doesn't
      const k = this.cam.zoom / this.bakeZoom;
      const dx = b.minX * this.cam.zoom + this.cam.ox - pad * k;
      const dy = b.minY * this.cam.zoom + this.cam.oy - pad * k - (this.groundCv.maxZ || 0) * this.cam.zoom;
      ctx.drawImage(this.groundCv.cv, dx, dy, this.groundCv.cv.width * k, this.groundCv.cv.height * k);
    }
    this._drawOverlay(ctx);

    /* ---- object layer, ascending depthKey (painter's order) ---- */
    const items = [];
    const p = this.p, h = this.h;
    const push = (x, y, fn) => items.push({ k: depthKey(x, y), fn });

    /* Survey boundary (owner 2026-10-21, lead verdict): this is your land, so the
       boundary stays — but SOLID and faint (fence-colour family, 1 px, alpha 0.35),
       drawn UNDER the fence/badge layer. The fence IS the boundary where it stands,
       so the line only fills the gaps and the frontage; the gate stays open for the
       road. No dashes anywhere in the plot view. */
    {
      const side = this._roadSide();
      const gt = p.gate ? (side === 'S' || side === 'N' ? p.gate.x + 0.5 : p.gate.y + 0.5) : null;
      const wc = (cx, cy) => project(cx, cy, this._z(this.cornerH(cx, cy)), this.cam);
      const fenceAt = new Set((p.fence || []).map((f) => `${f.x},${f.y}`));
      const edges = [
        { A: wc(0, 0), B: wc(p.w, 0), len: p.w, on: (i) => fenceAt.has(`${i},0`), gate: side === 'N' },
        { A: wc(p.w, 0), B: wc(p.w, p.h), len: p.h, on: (i) => fenceAt.has(`${p.w - 1},${i}`), gate: side === 'E' },
        { A: wc(0, p.h), B: wc(p.w, p.h), len: p.w, on: (i) => fenceAt.has(`${i},${p.h - 1}`), gate: side === 'S' },
        { A: wc(0, 0), B: wc(0, p.h), len: p.h, on: (i) => fenceAt.has(`0,${i}`), gate: side === 'W' },
      ];
      ctx.save();
      ctx.strokeStyle = 'rgba(138,106,60,0.35)';
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.beginPath();
      for (const e of edges) {
        // stroke only the runs with no fence under them (and the gate stays open)
        let runStart = null;
        for (let i = 0; i <= e.len; i++) {
          const skip = i < e.len && (e.on(i)
            || (e.gate && gt != null && Math.abs(i + 0.5 - gt) < 0.9));
          if (!skip && runStart === null) runStart = i;
          if ((skip || i === e.len) && runStart !== null) {
            const f0 = runStart / e.len, f1 = i / e.len;
            ctx.moveTo(e.A[0] + (e.B[0] - e.A[0]) * f0, e.A[1] + (e.B[1] - e.A[1]) * f0);
            ctx.lineTo(e.A[0] + (e.B[0] - e.A[0]) * f1, e.A[1] + (e.B[1] - e.A[1]) * f1);
            runStart = null;
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // (laid track now rides the surface in the ground bake — see _ensureGround)

    // fences — vertical objects, so they depth-sort with the trees. A fence now stands
    // on its tile's EDGE, between two grid vertices (see `_fenceEdge`): two rails, a
    // wire above, and a post at each vertex. Heights are world px at 1x, like the
    // sprites: post ~2/3 of a tile's width.
    const fenceSet = new Set((p.fence || []).map((f) => `${f.x},${f.y}`));
    /* The gate is a fence ENDPOINT (owner 10-22: "able to connect to the fences") and it
       now stands on the same seam, so the run of fence, the gate, and the survey line are
       one line rather than three parallel ones. */
    const gateKey = p.gate ? `${p.gate.x},${p.gate.y}` : null;
    const railTo = (k) => fenceSet.has(k) || k === gateKey;
    const DIRS = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]];
    const connections = (x, y) => {
      const c = new Set();
      for (const [d, dx, dy] of DIRS) if (railTo(`${x + dx},${y + dy}`)) c.add(d);
      return c;
    };
    // a grid vertex, on the ground the corner actually sits at (the survey line's own
    // projection — one height per vertex is what makes rails meet across a slope)
    const vert = (gx, gy) => project(gx, gy, this._z(this.cornerH(gx, gy)), this.cam);
    for (const f of p.fence || []) {
      push(f.x, f.y, () => {
        const s = this.cam.zoom * this.dpr;
        const ctx = this.ctx;
        const conn = connections(f.x, f.y);
        ctx.save();
        ctx.lineCap = 'round';
        for (const e of this._fenceEdge(f.x, f.y, conn)) {
          const [A, B] = edgeVerts(f.x, f.y, e);
          const a = vert(A[0], A[1]), b = vert(B[0], B[1]);
          ctx.strokeStyle = '#7a5c32';
          ctx.lineWidth = Math.max(1, 2.2 * s);
          for (const hh of FENCE_PX.rails) {
            ctx.beginPath();
            ctx.moveTo(a[0], a[1] - hh * s);
            ctx.lineTo(b[0], b[1] - hh * s);
            ctx.stroke();
          }
          ctx.strokeStyle = 'rgba(205,196,175,0.6)';
          ctx.lineWidth = Math.max(0.6, 0.8 * s);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1] - FENCE_PX.wire * s);
          ctx.lineTo(b[0], b[1] - FENCE_PX.wire * s);
          ctx.stroke();
          // posts cap the rails at both vertices; a shared vertex is drawn twice, which
          // is invisible and cheaper than a de-dupe pass
          ctx.strokeStyle = '#5d4a2e';
          ctx.lineWidth = Math.max(2, 3 * s);
          for (const v of [a, b]) {
            ctx.beginPath();
            ctx.moveTo(v[0], v[1]);
            ctx.lineTo(v[0], v[1] - FENCE_PX.post * s);
            ctx.stroke();
          }
        }
        ctx.restore();
      });
    }

    // dam site marking on the ground
    if (p.dam) {
      push(p.dam.cx, p.dam.cy, () => {
        const [cx, cy] = this._at(p.dam.cx, p.dam.cy);
        ctx.fillStyle = 'rgba(47,93,112,0.4)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, p.dam.r * TW * this.cam.zoom * 0.5, p.dam.r * TH * this.cam.zoom * 0.5, 0, 0, 7);
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,205,225,0.55)';
        ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
        ctx.lineWidth = 1.1 * this.dpr;
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    // trees, scaled by age
    // the adult size spread (owner verdict 21-10: "slightly random the adult sizes")
    // — deterministic per tree, ±7% around the age curve, so an even-aged stand
    // still reads as individual trees instead of a stamped wall
    const sizeJit = (x, y) => 0.93 + jitter(x, y, 71) * 0.14;

    // hover reveal (owner verdict 21-10, repurposing the faded mist-fade): hovering a
    // tree fades only the canopies that stand IN FRONT of it, so the selection and
    // its tile read through the stand. No hover — everything draws full strength.
    const treeAt = new Set(p.trees.map((t) => t.x + ',' + t.y));
    const fadeSet = new Set();
    if (this.hover) {
      const ht = p.trees.find((t) => t.x === this.hover[0] && t.y === this.hover[1]);
      if (ht) {
        for (const [dx, dy] of [[0, 1], [-1, 2], [1, 2], [0, 2]]) {
          const k = (ht.x + dx) + ',' + (ht.y + dy);
          if (treeAt.has(k)) fadeSet.add(k);
        }
      }
    }

    for (const t of p.trees) {
      push(t.x, t.y, () => {
        const [cx, cy] = this._at(t.x, t.y);
        const age = t.age || 15;
        const ageF = Math.min(1, age / 30);
        // growth stages (owner 21-10): the indigenous giants carry sapling/young art,
        // so their SIZE comes from the art, not the age scale — only a mild wobble on
        // top. The aliens stay single-stage: a uniform stand is the invasive point.
        // The oak is the exception among the aliens — it is a PLANTED ornamental, so it
        // stages like the natives (a garden oak grows into its spread, and the tree
        // carries a review bonus, so its size has to read as age).
        const staged = t.kind === 'indigenous' || t.kind === 'oak';
        const stage = staged ? (age < 12 ? 'sapling' : age < 22 ? 'young' : '') : '';
        const s = (staged ? (0.94 + ageF * 0.10) : (0.72 + ageF * 0.42))
          * sizeJit(t.x, t.y) * this.cam.zoom * this.dpr / 1;
        const hov = this.hover && this.hover[0] === t.x && this.hover[1] === t.y;
        const faded = !hov && fadeSet.has(t.x + ',' + t.y);
        ctx.save();
        if (faded) ctx.globalAlpha = 0.45;   // reveal what the hover selects
        ctx.translate(cx, cy);
        // the season rides on every tree (sprites.js seasonal ramps, 2026-10-21):
        // winter pines carry snow, the aliens go bare, indigenous stays evergreen
        drawSprite(ctx, t.kind, s, {
          seedX: t.x, seedY: t.y, hover: hov, stage,
          // the tree's actual species, from the sim (lead L1). `kind` is the CLASS -
          // indigenous - and until now the art guessed yellowwood vs ironwood off the
          // variant hash, so a stand's identity was a rendering artefact. Absent species
          // falls back to that hash inside drawIndigenous, so node and any older caller
          // keep drawing.
          species: t.species,
          season: seasonTint((this.h && this.h.date && this.h.date.month) || 1).season,
        });
        ctx.restore();
        if (hov) {
          ctx.strokeStyle = 'rgba(255,255,255,.85)';
          ctx.lineWidth = 1.3 * this.dpr;
          ctx.beginPath();
          ctx.ellipse(cx, cy, TW * this.cam.zoom * 0.5, TH * this.cam.zoom * 0.5, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    }

    if (h) {
      for (const b of h.beds || []) {
        push(b.x, b.y, () => {
          const [cx, cy] = this._at(b.x, b.y);
          ctx.save();
          ctx.translate(cx, cy);
          // FARMING-SPEC Part 1: a bed is a 21-day countdown with no visible change — it
          // drew as bare furrows for twenty days and then a speckle appeared. Pass the
          // PROGRESS, not just the flag, so the bed can grow. Derived from planted/ready,
          // so nothing is stored and no golden can move. drawBed already takes an options
          // object and bedCrop is already split out for exactly this.
          //
          // The progress is BUCKETED to the spec's four states, not passed as a raw 0-1.
          // `stateKey` embeds `o.stage` verbatim into the atlas cache key, so a continuous
          // value would bake up to 22 tiles per bed (one per growth day) that only ever
          // look like four — an atlas thrash on the most-seen dynamic sprite, and the same
          // "quantise to finite buckets" rule the tree variants already follow. Four
          // integers here mean four bed tiles, in the browser atlas and in the Godot bake.
          const grow = b.ready > b.planted
            ? (h.day - b.planted) / (b.ready - b.planted) : 1;
          const t = Math.max(0, Math.min(1, grow));
          const stage = t >= 1 ? 3 : t >= 0.45 ? 2 : t >= 0.15 ? 1 : 0;
          // FARMING-SPEC Part 3: the crop, on the same terms as the stage. A bed carries
          // `b.crop` since the picker landed (116685c), and a bed from before it carries
          // nothing - so pass it through UNRESOLVED and let sprites.js fall back, exactly
          // as homestead.harvest does with `CROPS[b.crop] || BED`. Resolving it here would
          // put a second copy of the default-crop decision in the renderer, which is the
          // duplicated-fact shape this seat keeps having to remove.
          drawSprite(ctx, 'bed', this.cam.zoom * this.dpr,
            { stage, ready: stage === 3, crop: b.crop });
          ctx.restore();
        });
      }
      for (const v of h.hives || []) {
        push(v.x, v.y, () => {
          const [cx, cy] = this._at(v.x, v.y);
          ctx.save();
          ctx.translate(cx, cy);
          drawSprite(ctx, 'hive', this.cam.zoom * this.dpr);
          ctx.restore();
        });
      }
      for (const a of h.accom || []) {
        // multi-tile rungs (owner verdict 5): the unit claims its whole footprint —
        // a flat yard pad over the site, the sprite anchored at the footprint's
        // centre, depth-sorted at its far corner so front trees occlude correctly
        const af = this._fpOf(a.kind);
        // a footprint of [0,0] means "not placed on the map" - the spare room is
        // inside the house. It used to draw a whole cottage on the anchor tile.
        if (af[0] < 1 || af[1] < 1) continue;
        push(a.x + af[0] - 1, a.y + af[1] - 1, () => {
          const ctx = this.ctx;
          if (af[0] > 1 || af[1] > 1) {
            // the yard pad follows the ground tile by tile (sites are near-flat, but
            // a half-metre step should still show through the translucent fill)
            ctx.save();
            for (let px = a.x; px < a.x + af[0]; px++) {
              for (let py = a.y; py < a.y + af[1]; py++) {
                const q = this._tileCorners(px, py);
                ctx.beginPath();
                ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]);
                ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]);
                ctx.closePath();
                ctx.fillStyle = 'rgba(116,98,64,0.34)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(70,58,38,0.5)';
                ctx.lineWidth = 1 * this.dpr;
                ctx.stroke();
              }
            }
            ctx.restore();
          }
          // OWNER: "buildings are not on your selected tiles" — a painted building is
          // anchored at its base's bottom vertex, which for a footprint diamond is the
          // FRONT CORNER (grid x+fpw, y+fph), one tile height below the centre the
          // vector sprites compensated for internally. Anchor there and the base sits
          // exactly on the claimed tiles.
          //
          // L6 (art request, 2026-10-23) found the direction and got the magnitude and the
          // space wrong, and the camp has been painting ~24 device px west of its twelve
          // tiles ever since (owner 10-26: "camping site doesnt sit on 3x3 tiles correctly").
          // The front corner sits (w - h) × TW/2 right of the footprint's BACK corner, so it
          // sits only HALF that - TW/4 - right of its CENTRE, which is where a symmetric
          // plate has to be centred; and `project` returns device px, so the offset has to
          // carry zoom × dpr like everything else from it. Both are in _footprintLean now,
          // with the derivation, and frame 16 measures the result on the rendered pixels.
          // The Y is deliberately left on the front corner: that is the owner's fix and it
          // is what makes the base sit on the ground.
          const leanX = this._footprintLean(af[0], af[1]);
          const [cx, cy] = project(a.x + af[0], a.y + af[1],
            this._footprintZ(a.x, a.y, af), this.cam);
          ctx.save();
          ctx.translate(cx - leanX, cy);
          // the sprite key IS the sim kind (sprites.js accomSprite) - no mapping table
          if (a.built) drawSprite(ctx, accomSprite(a.kind), this.cam.zoom * this.dpr);
          else {
            // construction in stages (owner 21-10): days remaining picks the stage —
            // more than a day out is the early site, the last day the frame-up
            const day = (this.h && this.h.day) || 1;
            const left = (a.doneDay || 0) - day;
            drawSprite(ctx, left > 1 ? 'site_early' : 'site_late', this.cam.zoom * this.dpr);
          }
          ctx.restore();
        });
      }
    }

    for (const bd of p.buildings || []) {
      // A building draws if the registry KNOWS its kind — not if this switch happens to
      // name it. The old three-way whitelist (tank5000/toilet/house) is how a plot
      // building with no sprite became invisible with no error anywhere: the entry was
      // on the map, the art was on disk, and this line returned. `tank5000` is the one
      // real alias (the sim's kind carries its capacity, the sprite does not).
      const name = bd.kind === 'tank5000' ? 'tank' : (SPRITES[bd.kind] ? bd.kind : null);
      if (!name) continue;   // not `return`: one unknown kind must not skip the gate
      const bfw = bd.fw || 1, bfh = bd.fh || 1;
      if (bfw > 1 || bfh > 1) {
        // multi-tile plot buildings (the ablution block, 2x1 since VIS-02): the SAME
        // anchoring the accom units use, for the same reason. A painted base is drawn
        // bottom-centre, so it must be placed on the footprint's FRONT CORNER and pulled
        // back by (w-h)*TW/2 — otherwise a non-square base sits half a tile off its
        // tiles, which is exactly the gate defect the owner caught on 10-25.
        push(bd.x + bfw - 1, bd.y + bfh - 1, () => {
          const leanX = this._footprintLean(bfw, bfh);
          const [cx, cy] = project(bd.x + bfw, bd.y + bfh, this._footprintZ(bd.x, bd.y, [bfw, bfh]), this.cam);
          ctx.save();
          ctx.translate(cx - leanX, cy);
          drawSprite(ctx, name, this.cam.zoom * this.dpr);
          ctx.restore();
        });
        continue;   // this building is placed; do NOT fall through to the 1x1 path
      }
      push(bd.x, bd.y, () => {
        const [cx, cy] = this._at(bd.x, bd.y);
        ctx.save();
        ctx.translate(cx, cy);
        drawSprite(ctx, name, this.cam.zoom * this.dpr);
        ctx.restore();
      });
    }

    /* the gate — it stands IN the fence line, on the same seam and at the same angle.
       Owner 10-25: "new gate and fences still dont sit on tile seams." The gate used to
       be drawn upright at its tile's CENTRE: a front elevation with horizontal bars in a
       world where every seam runs at ±26.57°, so it read as a picture propped up in the
       middle of a tile, with the fence rails arriving at a different angle.
       A gate is a flat thing standing in the ground plane, so its SPAN follows the iso
       edge while its posts stay vertical — that is a y-shear, not a rotation, and a shear
       keeps verticals vertical (which is exactly right for gateposts). The art is drawn
       at the projected x-extent of one tile edge (TW/2), which puts its two posts where
       the neighbouring fence posts are. */
    if (p.gate) {
      push(p.gate.x, p.gate.y, () => {
        const s = this.cam.zoom * this.dpr;
        const ctx = this.ctx;
        const conn = connections(p.gate.x, p.gate.y);
        const e = this._fenceEdge(p.gate.x, p.gate.y, conn)[0];
        const [A, B] = edgeVerts(p.gate.x, p.gate.y, e);
        const a = vert(A[0], A[1]), b = vert(B[0], B[1]);
        const slope = (b[1] - a[1]) / ((b[0] - a[0]) || 1);   // ±0.5 — the iso edge itself
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;  // the sprite draws bottom-centre
        ctx.save();
        ctx.translate(mx, my);
        ctx.transform(1, slope, 0, 1, 0, 0);
        drawSprite(ctx, 'gate', (s * (TW / 2)) / (SPRITES.gate.w || 40));
        ctx.restore();
      });
    }

    // probe hook (same family as window.__bakeMs): how many objects this frame asked for.
    // A plot full of trees that reports 0 here is a dead OBJECT LAYER, not dead art —
    // the distinction cost a whole evening on VIS-02.
    if (typeof window !== 'undefined') window.__items = items.length;
    items.sort((a, b) => a.k - b.k);
    for (const it of items) it.fn();

    /* The tile under the pointer (or the last tap, or the tile the popup is about):
       a diamond, 1 px light stroke at 55%, filled 6%. This is the "these are tiles and
       you can click them" cue, so it is drawn at every zoom and in every mode —
       warm red when felling, green when building, white otherwise.
       The polygon is the tile's four RAISED corners — the SAME corners the ground
       bake draws and _cellAt() inverts — so the highlight can never drift off the
       tile the pick returns (owner verdict 2, 2026-10-21). Exposed as
       window.__hoverPoly for tools/tile-probe.html to check corner-exactness.
       With a ghost armed, the ghost's footprint IS the highlight (verdict 5). */
    const lit = (this.ghost || this._paint) ? null : (this.hover || this.sel);
    if (lit) {
      const poly = this._tileCorners(lit[0], lit[1]);
      const sel = this.mode === 'fell' ? UI.selRed
        : this.mode === 'build' ? UI.selGreen : UI.selWhite;
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      ctx.lineTo(poly[1][0], poly[1][1]);
      ctx.lineTo(poly[2][0], poly[2][1]);
      ctx.lineTo(poly[3][0], poly[3][1]);
      ctx.closePath();
      ctx.fillStyle = sel.fill;
      ctx.fill();
      ctx.strokeStyle = sel.stroke;
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.stroke();
      if (typeof window !== 'undefined') window.__hoverPoly = poly;
    } else if (typeof window !== 'undefined') {
      window.__hoverPoly = null;
    }

    /* The ghost preview (owner verdict 5): the rung's true footprint follows the
       cursor, translucent green when the site fits, red when anything blocks it.
       Click / second tap places, Escape or right-click cancels. Each tile fills at
       its own raised corners; the outline runs through the footprint region's
       corner-averaged heights, so it bends with the ground. */
    if (this.ghost) {
      const g = this.ghost;
      const col = g.ok ? GHOST.ok : GHOST.bad;
      for (let cx = g.x; cx < g.x + g.fp[0]; cx++) {
        for (let cy = g.y; cy < g.y + g.fp[1]; cy++) {
          const q = this._tileCorners(cx, cy);
          ctx.beginPath();
          ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]);
          ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]);
          ctx.closePath();
          ctx.fillStyle = col.fill;
          ctx.fill();
        }
      }
      const wc = (cx, cy) => project(cx, cy, this._z(this.cornerH(cx, cy)), this.cam);
      const w0 = wc(g.x, g.y);
      const w1 = wc(g.x + g.fp[0], g.y);
      const w2 = wc(g.x + g.fp[0], g.y + g.fp[1]);
      const w3 = wc(g.x, g.y + g.fp[1]);
      ctx.beginPath();
      ctx.moveTo(w0[0], w0[1]); ctx.lineTo(w1[0], w1[1]);
      ctx.lineTo(w2[0], w2[1]); ctx.lineTo(w3[0], w3[1]);
      ctx.closePath();
      ctx.strokeStyle = col.edge;
      ctx.lineWidth = Math.max(1.5, 1.4 * this.dpr);
      ctx.stroke();
    }

    /* The drag-build run (owner, 2026-10-21): every tile the release will build, lit at
       its own raised corners, with a 1 px edge so a long run reads as a road and not a
       wash. Green here means "this is the line" — the sim still rules on each tile.
       U4: a rect kind carries a per-tile verdict in slot 3, and a refused tile (water,
       tree, edge) draws red so the player sees the block will not take before releasing. */
    if (this._paint) {
      for (const tile of this._paintTiles()) {
        const [px, py, okTile] = tile;
        const g = okTile === false ? GHOST.bad : GHOST.ok;
        const q = this._tileCorners(px, py);
        ctx.beginPath();
        ctx.moveTo(q[0][0], q[0][1]); ctx.lineTo(q[1][0], q[1][1]);
        ctx.lineTo(q[2][0], q[2][1]); ctx.lineTo(q[3][0], q[3][1]);
        ctx.closePath();
        ctx.fillStyle = g.fill;
        ctx.fill();
        ctx.strokeStyle = g.edge;
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.stroke();
      }
    }

    /* (the survey boundary is drawn earlier, solid and under the fence layer —
       see the block after the ground blit; never dashed) */

    // scale label, bottom-left
    ctx.fillStyle = 'rgba(13,23,17,.88)';
    ctx.fillRect(10 * this.dpr, H - 24 * this.dpr, 150 * this.dpr, 17 * this.dpr);
    ctx.fillStyle = '#e4d9bb';
    ctx.font = `${10 * this.dpr}px ui-monospace, monospace`;
    ctx.fillText(`${Math.round(p.w * p.cellM)} × ${Math.round(p.h * p.cellM)} m · ${p.ha} ha · ↑${Math.round(this._zMax - this._zBase)} m · iso`,
      15 * this.dpr, H - 11 * this.dpr);

    // problem badges: the RCT ride-status overlay — at overview zoom every dying
    // asset wears a coloured dot, so the log is not the only place problems live.
    if (this.opts.showBadges !== false && this.cam.zoom < 1.2) this._badges();
    else this.badgeCount = 0;

    if (typeof performance !== 'undefined' && typeof window !== 'undefined') {
      window.__frameMs = performance.now() - frameT0;
    }
  }

  /** Problem badges over their assets. Everything derives from the state snapshot
      already in this.h — no sim calls, no RNG reads, hash-safe by construction.
      Shown only zoomed out (cam.zoom < 1.2): close up the asset itself tells the
      story and a dot would just cover it. */
  _badges() {
    const h = this.h, p = this.p, ctx = this.ctx;
    if (!h || !p) return;
    const list = [];
    // water (blue): a tank under 20%, over the tank itself
    if (h.water && h.water.tank && !h.water.stream && (h.water.store || 0) < TANK_LOW_L) {
      const tank = (p.buildings || []).find((b) => b.kind === 'tank5000');
      if (tank) list.push({ x: tank.x, y: tank.y, col: BADGE.water });
    }
    // harvest (green): a bed ready to come in, one dot per bed, inspect mode only.
    // `at:'back'` - the dot goes on the plate's BACK corner, not its centre. The crop fills
    // the front two-thirds of the diamond, and at fit zoom a centre dot is about half the
    // bed's width, so the old placement covered the one state worth reading AND scored as
    // crop itself in the art seat's gauge: measured on a potato bed at stage 3, the dot laid
    // 100 of the plate's 225 px and moved its crop-pixel reading from 9.3% to 51.6%. A marker
    // that rewrites the thing it marks is not a marker. (Their finding, `236a7cb`.)
    if (this.mode === 'inspect') {
      for (const b of h.beds || []) {
        if (h.day >= b.ready) list.push({ x: b.x, y: b.y, col: BADGE.harvest, at: 'back' });
      }
    }
    // road (orange): condition under 40, where the road meets the plot — the gate
    if (h.road && h.road.condition < 40 && p.gate) {
      list.push({ x: p.gate.x, y: p.gate.y, col: BADGE.road });
    }
    // money (red): honey piling up unsold, over the first hive. The sim tracks no
    // per-month sales, so "never sold this month" is read as ≥ 5 kg waiting —
    // about one hive's worth of a month (0.25 kg/day).
    if ((h.hives || []).length && (h.honey || 0) >= 5) {
      list.push({ x: h.hives[0].x, y: h.hives[0].y, col: BADGE.money });
    }
    // money (red): an accom unit standing but the household has never sold a night.
    // h.nights is a lifetime total — per-unit and per-30-days counts do not exist.
    for (const a of h.accom || []) {
      if (a.built && !(h.nights > 0)) list.push({ x: a.x, y: a.y, col: BADGE.money });
    }
    // money (red): bills in arrears. makePlot never places a house building, so the
    // anchor is the spare-room unit (the house) when the life has one, else plot centre.
    if ((h.arrears || 0) > 0) {
      const house = (h.accom || []).find((a) => a.kind === 'spare');
      list.push(house ? { x: house.x, y: house.y, col: BADGE.money }
        : { x: p.w / 2, y: p.h / 2, col: BADGE.money });
    }

    this.badgeCount = list.length;
    if (!list.length) return;
    const sc = this.cam.zoom * this.dpr;      // world px -> the device space _at() returns
    // two problems on one tile stack upward so both stay readable
    const seen = new Map();
    for (const bd of list) {
      const key = `${bd.x},${bd.y}`;
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      const [cx, cy] = this._at(bd.x, bd.y);
      /* The dot scales with the tile it marks, with a floor: a fixed 7 px disc at fit zoom was
         half the bed's width, but a dot that shrinks below ~9 px across stops being a cue at
         all, and the whole point of the badge is that it reads from the overview. */
      const rd = Math.max(4.5 * this.dpr, 6.5 * sc);
      // 'back' = tangent to the diamond's north corner, so no part of it lies on the plate
      const yBase = bd.at === 'back' ? cy - (TH / 2) * sc - rd : cy - 2 * this.dpr;
      const y = yBase - n * rd * 2.4;
      ctx.beginPath();
      ctx.arc(cx, y, rd, 0, Math.PI * 2);
      ctx.fillStyle = bd.col;
      ctx.fill();
      ctx.lineWidth = 1 * this.dpr;
      ctx.strokeStyle = 'rgba(13,23,17,.85)';
      ctx.stroke();
      if (bd.at === 'back') {
        // The disc is tangent to the corner, so this is a zero-length line in the normal case
        // (it draws nothing) and a real tie to the tile when two badges stack above each other
        // and the second one floats clear of the bed. Dark, never badge-coloured, so it cannot
        // be counted as crop by the gauge.
        ctx.beginPath();
        ctx.moveTo(cx, y + rd);
        ctx.lineTo(cx, cy - (TH / 2) * sc);
        ctx.stroke();
      }
    }
  }

  capture() { return this.cv.toDataURL('image/png'); }
}
