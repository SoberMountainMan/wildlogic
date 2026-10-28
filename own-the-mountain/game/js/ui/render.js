// render.js — TOP-DOWN map renderer for the real Hogsback map (v2).
//
// Why top-down: v1 drew a 2:1 isometric carpet of 64 m diamonds and fitted a 9.4 km
// box onto the screen. Everything was 6 px wide and the terrain read as a flat wash.
// This renderer treats the DEM as a real map: 1 map pixel = 4.03 m, hillshaded from
// the actual slopes, with real OSM roads, forests, water, buildings and named
// landmarks drawn on top. The camera is a plain pan/zoom, not a fake 3D projection,
// so Main Road looks like Main Road.
//
// Data contract (unchanged from v1): main.js fetches the bake, decodes Int16BE into
// an Int16Array, then calls setTerrain(dem, meta, mapJson). setState(g, consts) is
// called after every sim action. frame(dt, t) is called by the boot loop.
//
// Owner: ui. No sim maths lives here — plots, roads and industries are read from
// the sim state and only drawn.

const DEG = Math.PI / 180;

const PAL = {
  bg: '#0f1512',
  void: '#0b0f0d',
  water: '#2f5d70',
  waterDeep: '#264d5e',
  stream: '#4b7f92',
  forest: 'rgba(26,52,32,0.62)',
  canopy: '#20402a',
  canopyLite: '#2c5232',
  building: '#c3b096',
  buildingEdge: '#6d5c46',
  tar: '#4d4d47',
  tarEdge: '#33332f',
  dirt: '#8b6f4d',
  dirtEdge: '#5d4a32',
  path: '#a08a63',
  ink: '#0d1210',
  label: '#f2efe6',
  labelDim: '#c9c6ba',
  gold: '#e8b45a',
  good: '#6fbf73',
  warn: '#d9a13b',
  bad: '#c4553f',
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* Elevation ramp, normalised to whatever the bake's own min/max are — the v3 box
   reaches 1963 m at Gaika's Kop, v2 topped out at 1597 m. Hard-coding metres here
   made the whole map one colour when the box changed. */
const RAMP = [
  [0.00, 52, 76, 50], [0.15, 66, 94, 56], [0.30, 84, 110, 62],
  [0.45, 106, 124, 70], [0.60, 130, 140, 82], [0.75, 152, 156, 104],
  [0.88, 172, 170, 140], [1.00, 194, 190, 176],
];
function elevRGB(e, lo, hi) {
  const t = clamp((e - lo) / Math.max(1, hi - lo), 0, 1);
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const a = RAMP[i - 1], b = RAMP[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    }
  }
  const z = RAMP[RAMP.length - 1];
  return [z[1], z[2], z[3]];
}

const ROAD_STYLE = {
  secondary: { w: 7.6, col: '#8d8d7e', edge: '#22221c' },
  tertiary: { w: 6.2, col: '#84847a', edge: '#22221c' },
  unclassified: { w: 4.0, col: '#a8865c', edge: '#4a3a24' },
  residential: { w: 4.2, col: '#a8865c', edge: '#4a3a24' },
  service: { w: 3.0, col: '#a8865c', edge: '#4a3a24' },
  track: { w: 2.4, col: '#c0a273', edge: 'rgba(70,56,36,0.85)' },
  path: { w: 1.8, col: '#d3bb8c', edge: 'rgba(70,56,36,0.7)' },
  footway: { w: 1.6, col: '#d3bb8c', edge: 'rgba(70,56,36,0.65)' },
};

/* Which landmark classes get a label, and in what order they win space. */
const LM_PRIORITY = {
  peak: 1, waterfall: 2, village: 3, hamlet: 4, nature_reserve: 5,
  hotel: 6, place_of_worship: 7, attraction: 8, viewpoint: 8,
  information: 9, library: 9, community_centre: 9, events_venue: 9,
  guest_house: 10, hostel: 10, chalet: 10, camp_site: 10, caravan_site: 10,
  restaurant: 11, fuel: 11, park: 11, survey_point: 12,
};

export class MapRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { onSelectPlot, onHoverPlot, onRoadTarget, onCancelRoad }
   */
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.dpr = 1;
    this.cam = { x: 0, y: 0, zoom: 1 };   // screen px per map px
    this.baseZoom = 1;
    this.dragging = false; this.dragMoved = 0;
    this.lastPtr = { x: 0, y: 0 };
    this.hover = null; this.selected = null; this.roadMode = null;
    this.g = null; this.kinds = {};
    this.plots = [];
    this.dem = null; this.meta = null; this.mapJson = null;
    this.landmarks = []; this.roads = []; this.forests = []; this.waters = [];
    this.buildings = [];
    this.terrainCv = null; this.propsCv = null;
    this._fpsEma = 60; this._t = 0; this._fitPending = false;
    this.resize();
    this._bindInput();
  }

  /* ------------------------------------------------ data in */
  setTerrain(dem, meta, mapJson) {
    this.dem = dem; this.meta = meta; this.mapJson = mapJson || {};
    const osm = this.mapJson.osm || [];
    this.roads = osm.filter((f) => ROAD_STYLE[f.kind]);
    this.forests = osm.filter((f) => f.kind === 'wood' || f.kind === 'forest' || f.kind === 'scrub'
      || f.kind === 'grassland' || f.kind === 'heath' || f.kind === 'meadow' || f.kind === 'farmland'
      || f.kind === 'residential' || f.kind === 'village_green');
    this.waters = osm.filter((f) => f.kind === 'water' || f.kind === 'river' || f.kind === 'stream' || f.kind === 'waterfall');
    this.buildings = osm.filter((f) => f.kind === 'building');
    this.landmarks = (this.mapJson.landmarks || []).slice().sort(
      (a, b) => (LM_PRIORITY[a.cat] || 50) - (LM_PRIORITY[b.cat] || 50));
    this._prerenderTerrain();
    this._prerenderProps();
    this.fitToMap();
  }

  setState(g, consts) {
    this.g = g;
    this.kinds = (consts && consts.INDUSTRY_KINDS) || {};
    const w = this.meta ? this.meta.width : 100, h = this.meta ? this.meta.height : 100;
    this.plots = (g.plots || []).map((p, i) => {
      let x = p.x, y = p.y;
      if (x == null || y == null) {           // no bake loaded: deterministic ring
        const a = i * 2.399;
        x = w / 2 + Math.cos(a) * w * 0.28;
        y = h / 2 + Math.sin(a) * h * 0.28;
      }
      return { ...p, mx: x, my: y };
    });
  }

  /* ------------------------------------------------ camera */
  resize() {
    const r = this.cv.getBoundingClientRect ? this.cv.getBoundingClientRect() : { width: 960, height: 640 };
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.dpr = dpr;
    this.cv.width = Math.max(320, Math.round((r.width || 960) * dpr));
    this.cv.height = Math.max(240, Math.round((r.height || 640) * dpr));
    if (this.terrainCv) this.fitToMap();
    else this._fitPending = true;
  }

  /** Approximate lat/lon -> map pixel (linear within the box; fine at this scale). */
  mapXY(lat, lon) {
    const [w, s, e, n] = this.meta.bbox;
    return [((lon - w) / (e - w)) * this.meta.width, ((n - lat) / (n - s)) * this.meta.height];
  }

  fitToMap() {
    if (!this.meta) { this._fitPending = true; return; }
    const { width: w, height: h } = this.meta;
    const fit = Math.min(this.cv.width / w, this.cv.height / h) * 0.98;
    this.baseZoom = fit;
    // Open showing the WHOLE box: the point of the v3 expansion is that Gaika's Kop
    // and the three peaks are on screen together with the village. Zoom in for detail.
    let z = fit * 1.02;
    let cx = w / 2, cy = h / 2;
    // QA / shareable views: ?view=village | peaks | gaika | north
    const q = typeof location !== 'undefined' ? location.search : '';
    const v = /[?&]view=([\w-]+)/.exec(q);
    if (v) {
      const which = v[1];
      const owner = this.landmarks.filter((l) => l.src === 'owner' && l.cat === 'peak');
      if (which === 'village') { [cx, cy] = this.mapXY(-32.5916, 26.9425); z = fit * 3.4; }
      else if (which === 'peaks' && owner.length) {
        cx = owner.reduce((a, p) => a + p.x, 0) / owner.length;
        cy = owner.reduce((a, p) => a + p.y, 0) / owner.length;
        z = fit * 3.4;
      } else if (which === 'gaika') {
        const g = this.landmarks.find((l) => /gaika/i.test(l.name) && l.cat === 'peak');
        if (g) { cx = g.x; cy = g.y; z = fit * 3.4; }
      } else if (which === 'north') { [cx, cy] = this.mapXY(-32.566, 26.9062); z = fit * 3.4; }
    }
    this.cam.zoom = z;
    this.cam.x = this.cv.width / 2 - cx * z;
    this.cam.y = this.cv.height / 2 - cy * z;
    this._clampCam();
  }

  /** Keep the map covering the canvas: no empty space when zoomed in. */
  _clampCam() {
    if (!this.meta) return;
    const mw = this.meta.width * this.cam.zoom, mh = this.meta.height * this.cam.zoom;
    const W = this.cv.width, H = this.cv.height;
    if (mw <= W) this.cam.x = (W - mw) / 2;
    else this.cam.x = clamp(this.cam.x, W - mw, 0);
    if (mh <= H) this.cam.y = (H - mh) / 2;
    else this.cam.y = clamp(this.cam.y, H - mh, 0);
  }

  worldToScreen(mx, my) {
    return [mx * this.cam.zoom + this.cam.x, my * this.cam.zoom + this.cam.y];
  }
  screenToWorld(sx, sy) {
    return [(sx - this.cam.x) / this.cam.zoom, (sy - this.cam.y) / this.cam.zoom];
  }

  focusPlot(id) {
    const p = this.plots.find((q) => q.id === id);
    if (!p) return;
    this.selected = id;
    const z = Math.max(this.cam.zoom, this.baseZoom * 2.2);
    this.cam.zoom = z;
    this.cam.x = this.cv.width / 2 - p.mx * z;
    this.cam.y = this.cv.height / 2 - p.my * z;
  }

  /* ------------------------------------------------ prerender: terrain */
  elevAt(x, y) {
    if (!this.dem) return 0;
    const w = this.meta.width, h = this.meta.height;
    return this.dem[clamp(y | 0, 0, h - 1) * w + clamp(x | 0, 0, w - 1)];
  }

  _prerenderTerrain() {
    if (!this.dem || typeof document === 'undefined') return;
    const w = this.meta.width, h = this.meta.height, dem = this.dem;
    const mpp = this.meta.mPerPx || 4;
    /* VIS-03 (playtest 10-25: "the valley map is a flat green wash… whole map slightly
       soft/upscaled"): the relief was baked at ONE pixel per DEM pixel — 4 m/px — and
       then upscaled, so the hillshade smoothed to nothing and the contour lines were
       a 1-px halo. Baked at 2× and drawn back at map size: at fit zoom it DOWNscales
       (smooth), zoomed in it upscales half as far (crisp). */
    const SS = 2;
    const cv = document.createElement('canvas');
    cv.width = w * SS; cv.height = h * SS;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(cv.width, cv.height);
    const d = img.data;
    const EXAG = 2.0;                     // vertical exaggeration for the hillshade
    const LX = -0.62, LY = -0.62, LZ = 0.48;   // light from the north-west, low sun
    const ELo = this.meta.elevMin, EHi = this.meta.elevMax;
    // 20 m contours over 800 m of relief; 40 m once the box spans a real mountain
    // (v3 runs 820-1968 m, and 20 m lines turn into noise at fit zoom).
    const CI = (EHi - ELo) > 900 ? 40 : 20;
    const elevAt = (x, y) => dem[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
    for (let Y = 0; Y < cv.height; Y++) {
      for (let X = 0; X < cv.width; X++) {
        const x = Math.floor(X / SS), y = Math.floor(Y / SS);
        const i = y * w + x;
        const e = dem[i];
        // sample wide (2 px = 8 m) so 1 m DEM quantisation does not turn the
        // hillshade into camo noise at 4 m/px
        const xl = x > 1 ? i - 2 : i, xr = x < w - 2 ? i + 2 : i;
        const yu = y > 1 ? i - 2 * w : i, yd = y < h - 2 ? i + 2 * w : i;
        const dzdx = (dem[xr] - dem[xl]) / (4 * mpp);
        const dzdy = (dem[yd] - dem[yu]) / (4 * mpp);
        // surface normal, exaggerated
        let nx = -dzdx * EXAG, ny = -dzdy * EXAG, nz = 1;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const lam = Math.max(0, nx * LX + ny * LY + nz * LZ);
        // VIS-03: a wider, deeper range — the old 0.56–1.30 read as a wash at fit zoom
        const shade = clamp(0.52 + lam * 0.95, 0.48, 1.42);

        let [r, g, b] = elevRGB(e, ELo, EHi);
        // rock shows through on steep ground
        const grad = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
        if (grad > 0.30) {
          const t = clamp((grad - 0.30) / 0.55, 0, 0.75);
          r += (141 - r) * t; g += (133 - g) * t; b += (121 - b) * t;
        }
        r *= shade; g *= shade; b *= shade;

        // contours: CI-metre lines, and a heavier line every 5th — now at 2× so the
        // line is a real line on screen instead of a 1-px halo
        if (Y > 0 && X > 0) {
          const band = Math.floor(e / CI);
          if (band !== Math.floor(elevAt(x - 1, y) / CI) || band !== Math.floor(elevAt(x, y - 1) / CI)) {
            const k = band % 5 === 0 ? 0.55 : 0.74;
            r *= k; g *= k; b *= k;
          }
        }
        const o = (Y * cv.width + X) * 4;
        d[o] = r > 255 ? 255 : r; d[o + 1] = g > 255 ? 255 : g; d[o + 2] = b > 255 ? 255 : b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.terrainCv = cv;
    this.terrainSS = SS;
  }

  /* ------------------------------------------------ prerender: OSM props */
  _prerenderProps() {
    if (!this.mapJson || typeof document === 'undefined') return;
    const { width: w, height: h } = this.meta;
    const cv = document.createElement('canvas');
    // VIS-03: baked at 2× like the relief, so road casings and polygon edges are real
    // edges on screen rather than half-pixel stubs (drawn back at map size in draw())
    const SS = 2;
    cv.width = w * SS; cv.height = h * SS;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(SS, SS);
    this.propsSS = SS;

    // forests first: a dark green wash plus canopy speckle so it does not read flat
    for (const f of this.forests) {
      const pts = f.pts || [];
      if (pts.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = f.kind === 'wood' || f.kind === 'forest' ? PAL.forest : 'rgba(52,72,40,0.30)';
      ctx.fill();
    }
    // canopy speckle (4 m/px: a tree is about one pixel, so speckle is the texture)
    ctx.fillStyle = PAL.canopy;
    for (const f of this.forests) {
      const pts = f.pts || [];
      if (pts.length < 3) continue;
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const area = (maxX - minX) * (maxY - minY);
      const n = clamp(Math.round(area / 90), 40, 4000);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = minX + hash2(i, 11, area) * (maxX - minX);
        const y = minY + hash2(i, 23, area) * (maxY - minY);
        if (!pointInPoly(x, y, pts)) continue;
        ctx.rect(x, y, 1, 1);
      }
      ctx.fillStyle = hash2(1, 2, 3) > 0.5 ? PAL.canopy : PAL.canopyLite;
      ctx.fill();
    }

    // water
    for (const f of this.waters) {
      const pts = f.pts || [];
      if (pts.length < 2) continue;
      if (f.kind === 'water' && pts.length > 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = PAL.water; ctx.fill();
        ctx.strokeStyle = PAL.waterDeep; ctx.lineWidth = 1; ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.strokeStyle = PAL.stream;
        ctx.lineWidth = f.kind === 'river' ? 2.4 : 1.3;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke();
      }
    }

    // buildings (only ~30 in the bake, so draw them honestly)
    for (const f of this.buildings) {
      const pts = f.pts || [];
      if (pts.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = PAL.building; ctx.fill();
      ctx.strokeStyle = PAL.buildingEdge; ctx.lineWidth = 0.7; ctx.stroke();
    }

    // roads: casing then fill, widest first so junctions look joined
    const order = ['secondary', 'tertiary', 'unclassified', 'residential', 'service', 'track', 'path', 'footway'];
    for (const kind of order) {
      const style = ROAD_STYLE[kind];
      const list = this.roads.filter((r) => r.kind === kind);
      if (!list.length) continue;
      for (const pass of [0, 1]) {
        ctx.beginPath();
        for (const r of list) {
          const pts = r.pts || [];
          if (pts.length < 2) continue;
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        }
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.lineWidth = pass === 0 ? style.w + 1.6 : style.w;
        ctx.strokeStyle = pass === 0 ? style.edge : style.col;
        ctx.setLineDash(kind === 'path' || kind === 'footway' ? [3, 3] : []);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    this.propsCv = cv;
  }

  /* ------------------------------------------------ input */
  _bindInput() {
    const cv = this.cv;
    if (!cv || !cv.addEventListener) return;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr];
    };
    cv.addEventListener('mousedown', (e) => {
      this.dragging = true; this.dragMoved = 0;
      this.lastPtr = pos(e);
    });
    cv.addEventListener('mousemove', (e) => {
      const [x, y] = pos(e);
      if (this.dragging) {
        const dx = x - this.lastPtr[0], dy = y - this.lastPtr[1];
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.cam.x += dx; this.cam.y += dy;
        this._clampCam();
        this.lastPtr = [x, y];
      } else {
        const id = this._plotAt(x, y);
        if (id !== this.hover) {
          this.hover = id;
          if (this.opts.onHoverPlot) this.opts.onHoverPlot(id);
        }
      }
    });
    const up = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.dragMoved > 6) return;
      const [x, y] = pos(e);
      const id = this._plotAt(x, y);
      if (!id) return;
      if (this.roadMode && this.roadMode.from && id !== this.roadMode.from) {
        if (this.opts.onRoadTarget) this.opts.onRoadTarget(id);
        return;
      }
      this.selected = id;
      if (this.opts.onSelectPlot) this.opts.onSelectPlot(id);
    };
    cv.addEventListener('mouseup', up);
    cv.addEventListener('mouseleave', () => { this.dragging = false; this.hover = null; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const [wx, wy] = this.screenToWorld(sx, sy);
      const f = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      this.cam.zoom = clamp(this.cam.zoom * f, this.baseZoom * 0.7, this.baseZoom * 14);
      this.cam.x = sx - wx * this.cam.zoom;
      this.cam.y = sy - wy * this.cam.zoom;
      this._clampCam();
    }, { passive: false });
  }

  _plotAt(sx, sy) {
    let best = null, bestD = 22 * this.dpr;
    for (const p of this.plots) {
      const [px, py] = this.worldToScreen(p.mx, p.my);
      const d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { bestD = d; best = p.id; }
    }
    return best;
  }

  /* ------------------------------------------------ frame */
  frame(dtMs, tSec) {
    this._t = tSec || 0;
    this._draw(this.ctx);
    const dt = dtMs || 16.7;
    this._fpsEma = this._fpsEma * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  }
  fps() { return Math.round(this._fpsEma); }
  capture() { return this.cv.toDataURL('image/png'); }

  _draw(ctx) {
    const W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#18231c');
    bg.addColorStop(1, '#0c1210');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.terrainCv) { this._waiting(ctx, W, H); return; }

    ctx.save();
    ctx.translate(this.cam.x, this.cam.y);
    ctx.scale(this.cam.zoom, this.cam.zoom);
    // 2× bakes: smooth while the map is smaller than its own pixels, nearest when
    // magnified (VIS-03 — the old unconditional `false` aliased the downscale)
    ctx.imageSmoothingEnabled = this.cam.zoom < 2;
    ctx.drawImage(this.terrainCv, 0, 0, this.meta.width, this.meta.height);
    if (this.propsCv) ctx.drawImage(this.propsCv, 0, 0, this.meta.width, this.meta.height);
    ctx.restore();

    this._simRoads(ctx);
    this._cableway(ctx);
    this._plots(ctx);
    this._industries(ctx);
    this._mist(ctx, W, H);
    this._labelGrid = new Set();
    this._roadLabels(ctx);
    this._landmarks(ctx);
    this._overlays(ctx, W, H);
  }

  _waiting(ctx, W, H) {
    ctx.fillStyle = 'rgba(12,18,15,.82)';
    ctx.fillRect(0, H / 2 - 46, W, 92);
    ctx.fillStyle = PAL.label;
    ctx.font = `${15 * this.dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('loading Hogsback DEM + OSM — serve over http, not file://', W / 2, H / 2 + 5 * this.dpr);
    ctx.textAlign = 'left';
  }

  /* ---------------- game layer ---------------- */
  _simRoads(ctx) {
    const g = this.g;
    if (!g || !g.roads || !g.roads.length) return;
    const byId = {};
    for (const p of this.plots) byId[p.id] = p;
    for (const r of g.roads) {
      const a = byId[r.a] || byId[r.from], b = byId[r.b] || byId[r.to];
      if (!a || !b) continue;
      const [ax, ay] = this.worldToScreen(a.mx, a.my);
      const [bx, by] = this.worldToScreen(b.mx, b.my);
      const hp = r.health == null ? 100 : r.health;
      const col = hp < 40 ? '#b2503a' : hp < 70 ? '#c98f3f' : '#d9c08a';
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 7 * this.dpr;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.strokeStyle = col;
      ctx.lineWidth = 4.5 * this.dpr;
      if (r.washedOut) ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.restore();
    }
  }

  _cableway(ctx) {
    const g = this.g;
    const cw = g && g.cableway;
    if (!cw) return;
    const p = this.plots.find((q) => q.id === (cw.from || cw.plot));
    if (!p) return;
    const [x, y] = this.worldToScreen(p.mx, p.my);
    ctx.save();
    ctx.strokeStyle = 'rgba(220,220,210,.7)';
    ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 26 * this.dpr, y - 22 * this.dpr); ctx.stroke();
    ctx.restore();
  }

  _plots(ctx) {
    // Hexes shrink when zoomed out: eight of the 24 anchors sit within 500 m of each
    // other because the real village does, and full-size hexes pile up at fit zoom.
    const zr = this.cam.zoom / this.baseZoom;
    const R = clamp(6 + 8 * (zr - 1) / 1.5, 6, 15) * this.dpr;
    for (const p of this.plots) {
      const [x, y] = this.worldToScreen(p.mx, p.my);
      if (x < -60 || y < -60 || x > this.cv.width + 60 || y > this.cv.height + 60) continue;
      const sel = this.selected === p.id, hov = this.hover === p.id;
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (60 * i - 30) * DEG;
        const px = Math.cos(a) * R, py = Math.sin(a) * R;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      if (sel) {
        /* VIS-03: the selection was a 1.5-px white edge on a dark hex — invisible at
           fit zoom. Now: warm fill + halo ring outside the hex. */
        ctx.fillStyle = 'rgba(255,212,118,0.92)';
        ctx.fill();
      } else if (p.owned) { ctx.fillStyle = 'rgba(232,180,90,0.88)'; ctx.fill(); }
      else { ctx.fillStyle = 'rgba(12,20,15,0.55)'; ctx.fill(); }
      if (sel) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (60 * i - 30) * DEG;
          const px = Math.cos(a) * (R + 4.5 * this.dpr), py = Math.sin(a) * (R + 4.5 * this.dpr);
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(255,255,255,.42)';
        ctx.lineWidth = 1.6 * this.dpr;
        ctx.stroke();
      }
      ctx.lineWidth = (sel ? 3.0 : hov ? 2.4 : 1.6) * this.dpr;
      ctx.strokeStyle = sel ? '#ffffff' : p.owned ? '#3a2a10' : 'rgba(248,246,236,0.92)';
      ctx.stroke();
      if (p.industry) {
        ctx.fillStyle = '#141a16';
        ctx.beginPath(); ctx.arc(0, 0, 3.4 * this.dpr, 0, 7); ctx.fill();
      }
      ctx.restore();
      // plot name: always for the SELECTED plot (VIS-03: "selected plot not
      // highlighted" — a white hex nobody has named is not a selection), and for
      // every plot once the zoom makes the text readable
      if (sel || this.cam.zoom > this.baseZoom * 1.7) {
        ctx.save();
        const name = p.name || p.id;
        ctx.font = `${(sel ? 12 : 10.5) * this.dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        const ty = y + R + 13 * this.dpr;
        if (sel) {
          // a dark plate behind the name so it survives any terrain under it
          const tw = ctx.measureText(name).width;
          ctx.fillStyle = 'rgba(10,14,11,.82)';
          ctx.fillRect(x - tw / 2 - 5 * this.dpr, ty - 10 * this.dpr, tw + 10 * this.dpr, 14 * this.dpr);
          ctx.strokeStyle = 'rgba(255,255,255,.55)';
          ctx.lineWidth = 1 * this.dpr;
          ctx.strokeRect(x - tw / 2 - 5 * this.dpr, ty - 10 * this.dpr, tw + 10 * this.dpr, 14 * this.dpr);
        } else {
          ctx.fillStyle = 'rgba(0,0,0,.65)';
          ctx.fillText(name, x + 1, ty + 1);
        }
        ctx.fillStyle = sel ? '#ffffff' : p.owned ? PAL.gold : PAL.labelDim;
        ctx.fillText(name, x, ty);
        ctx.restore();
      }
    }
  }

  _industries(ctx) {
    const g = this.g;
    if (!g || !g.industries) return;
    for (const ind of g.industries) {
      const p = this.plots.find((q) => q.id === ind.plot);
      if (!p) continue;
      const [x, y] = this.worldToScreen(p.mx, p.my);
      const kind = this.kinds[ind.kind] || {};
      const label = (kind.label || ind.kind || '?').slice(0, 2).toUpperCase();
      ctx.save();
      ctx.fillStyle = 'rgba(18,26,20,.88)';
      ctx.strokeStyle = 'rgba(232,180,90,.9)';
      ctx.lineWidth = 1.2 * this.dpr;
      ctx.beginPath();
      ctx.rect(x - 8 * this.dpr, y - 26 * this.dpr, 16 * this.dpr, 13 * this.dpr);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = PAL.gold;
      ctx.font = `bold ${8 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - 16 * this.dpr);
      ctx.restore();
    }
  }

  /* ---------------- labels ---------------- */
  /** One label per screen cell: stops the village core turning into a word pile. */
  _claimLabel(x, y, cellPx) {
    if (!this._labelGrid) this._labelGrid = new Set();
    const cx = Math.floor(x / cellPx), cy = Math.floor(y / cellPx);
    const k = cx + ',' + cy;
    if (this._labelGrid.has(k)) return false;
    this._labelGrid.add(k);
    return true;
  }

  _roadLabels(ctx) {
    const dpr = this.dpr;
    const z = this.cam.zoom / this.baseZoom;
    if (z < 1.2) return;
    ctx.save();
    ctx.font = `600 ${9.5 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const seen = new Set();
    for (const r of this.roads) {
      if (!r.name || seen.has(r.name)) continue;
      if (r.kind !== 'secondary' && r.kind !== 'tertiary') continue;
      const pts = r.pts || [];
      if (pts.length < 3) continue;
      seen.add(r.name);
      const mid = pts[Math.floor(pts.length / 2)];
      const [x, y] = this.worldToScreen(mid[0], mid[1]);
      if (x < 40 || y < 20 || x > this.cv.width - 40 || y > this.cv.height - 20) continue;
      if (!this._claimLabel(x, y, 90 * dpr)) continue;
      ctx.lineWidth = 3.2 * dpr;
      ctx.strokeStyle = 'rgba(8,12,10,.9)';
      ctx.strokeText(r.name, x, y);
      ctx.fillStyle = '#f4f0e2';
      ctx.fillText(r.name, x, y);
    }
    ctx.restore();
  }

  _landmarks(ctx) {
    if (!this.landmarks.length) return;
    const placed = [];
    const hit = (r) => placed.some((q) => !(r.x2 < q.x1 || r.x1 > q.x2 || r.y2 < q.y1 || r.y1 > q.y2));
    const z = this.cam.zoom / this.baseZoom;
    for (const lm of this.landmarks) {
      const [x, y] = this.worldToScreen(lm.x, lm.y);
      if (x < -80 || y < -40 || x > this.cv.width + 80 || y > this.cv.height + 40) continue;
      const prio = LM_PRIORITY[lm.cat] || 50;
      // peaks / falls / the village / the reserve always show; the rest fade in
      if (prio >= 10 && z < 1.9) continue;
      if (prio >= 9 && z < 2.2) continue;
      if (prio >= 8 && z < 1.3) continue;
      if (!this._claimLabel(x, y, 52 * this.dpr)) continue;
      const isPeak = lm.cat === 'peak';
      const isFall = lm.cat === 'waterfall';
      const isPlace = lm.cat === 'village' || lm.cat === 'hamlet';
      const isReserve = lm.cat === 'nature_reserve' || lm.cat === 'wood';
      const ownerPeak = lm.src === 'owner' && lm.cat === 'peak';
      if (!this._claimLabel(x, y, (isPeak ? 34 : 52) * this.dpr)) continue;
      const r = (isPlace ? 4.2 : isPeak ? 3.6 : isFall ? 3.0 : 2.2) * this.dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fillStyle = isPeak ? '#f0e6c8' : isFall ? '#9fd6e8' : isPlace ? '#ffd9a0' : isReserve ? '#9ccb8f' : '#e6e2d6';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.lineWidth = 1.1 * this.dpr;
      ctx.stroke();

      const fs = (isPlace ? 12.5 : isPeak ? 11.5 : 10.5) * this.dpr;
      ctx.font = `${isPlace || ownerPeak ? '600 ' : ''}${fs}px system-ui, sans-serif`;
      const tw = ctx.measureText(lm.name).width;
      const bx = x + r + 4 * this.dpr, by = y - fs * 0.72;
      const box = { x1: bx - 2, y1: by - 2, x2: bx + tw + 2, y2: by + fs + 1 };
      if (!hit(box)) {
        placed.push(box);
        ctx.textAlign = 'left';
        ctx.lineWidth = 3 * this.dpr;
        ctx.strokeStyle = 'rgba(8,12,10,.85)';
        ctx.strokeText(lm.name, bx, by + fs * 0.78);
        ctx.fillStyle = isPeak ? '#f6eccd' : isFall ? '#c9ecf6' : isPlace ? '#ffd9a0' : PAL.label;
        ctx.fillText(lm.name, bx, by + fs * 0.78);
      }
      ctx.restore();
    }
  }

  /* ---------------- atmosphere ---------------- */
  _mist(ctx, W, H) {
    const g = this.g;
    const rain = g && g.weather ? clamp(g.weather.rain / 10, 0, 1) : 0.35;
    const t = this._t;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 4; i++) {
      const drift = ((t * (6 + i * 3)) % (W + 700)) - 350;
      const cx = drift, cy = H * (0.18 + i * 0.21) + Math.sin(t * 0.2 + i) * 18;
      const rad = Math.max(W, H) * (0.30 + i * 0.06);
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      const a = (0.035 + rain * 0.04) * (1 - i * 0.12);
      grd.addColorStop(0, `rgba(214,228,222,${a})`);
      grd.addColorStop(1, 'rgba(214,228,222,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  /* ---------------- overlays: scale, north, frame ---------------- */
  _overlays(ctx, W, H) {
    const mpp = (this.meta && this.meta.mPerPx) || 4;
    const dpr = this.dpr;
    // scale bar: pick a round distance that lands near 120 css px
    const targetPx = 120 * dpr;
    const metres = targetPx / this.cam.zoom * mpp;
    const nice = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].find((v) => v >= metres) || 10000;
    const barPx = (nice / mpp) * this.cam.zoom;
    const bx = 16 * dpr, by = H - 20 * dpr;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 4.5 * dpr;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.stroke();
    ctx.strokeStyle = '#f2efe6';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4 * dpr); ctx.lineTo(bx, by + 4 * dpr);
    ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx + barPx, by - 4 * dpr); ctx.lineTo(bx + barPx, by + 4 * dpr);
    ctx.stroke();
    ctx.font = `600 ${10 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + 1, by - 9 * dpr + 1);
    ctx.fillStyle = '#f2efe6';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx, by - 9 * dpr);

    // north arrow
    const nx = W - 30 * dpr, ny = 30 * dpr;
    ctx.beginPath();
    ctx.moveTo(nx, ny - 13 * dpr); ctx.lineTo(nx + 6 * dpr, ny + 5 * dpr);
    ctx.lineTo(nx, ny + 1 * dpr); ctx.lineTo(nx - 6 * dpr, ny + 5 * dpr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fill();
    ctx.strokeStyle = '#f2efe6'; ctx.lineWidth = 1.2 * dpr; ctx.stroke();
    ctx.fillStyle = '#f2efe6';
    ctx.font = `700 ${10 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', nx, ny + 17 * dpr);
    ctx.textAlign = 'left';

    // mist vignette so the map edge does not end like a cut cake
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(10,16,13,0)');
    vg.addColorStop(1, 'rgba(10,16,13,0.32)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/* Kept so any older wiring that imported IsoRenderer still resolves. */
export { MapRenderer as IsoRenderer };

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function dateLabel(g) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = g && g.date;
  if (!d) return '—';
  return `${M[d.month - 1]} ${d.day}`;
}
