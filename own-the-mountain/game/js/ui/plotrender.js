// plotrender.js — top-down view of ONE plot at ~3.5 m per cell.
//
// Separate from render.js on purpose: the valley map is real DEM/OSM at 4 m/px, this is a
// generated grid. Mixing them in one class made both harder to read.
//
// The ground is prerendered once per plot and cell size into an offscreen canvas — that is
// where the texture, the jitter and the stream banks live. Each frame only draws the things
// that move or change: trees, beds, hives, buildings, the gate, the hover.

const GROUND = {
  grass: [86, 119, 65],
  scrub: [129, 143, 75],
  rock: [154, 149, 135],
  mud: [94, 75, 57],
  bank: [132, 139, 91],
  water: [42, 112, 134],
};

const PAL = {
  pine: '#1e452b',
  pineLite: '#2a5c39',
  indi: '#2f5f34',
  indiLite: '#3d7440',
  tank: '#9fb3c8',
  toilet: '#a5805f',
  cabin: '#c49a63',
  gate: '#e8b45a',
  label: '#f2efe6',
};

/** Stable 0-1 hash for a cell, so texture never shimmers between frames. */
function jitter(x, y, salt = 0) {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise. Continuous, so ground reads as land instead of as a grid of tiles. */
function vnoise(x, y, salt) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = jitter(xi, yi, salt), b = jitter(xi + 1, yi, salt);
  const c = jitter(xi, yi + 1, salt), d = jitter(xi + 1, yi + 1, salt);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export class PlotRenderer {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.p = null;
    this.h = null;
    this.hover = null;
    this.mode = 'inspect';
    this.buildKind = null;
    this.dpr = 1;
    this.groundCv = null;
    this._groundKey = '';
    this.resize();
    this._bind();
    // The stage changes size without a window resize (a stacked panel, a preview pane, a
    // phone rotating). Without this the canvas keeps its old backing store and stretches,
    // which is exactly what "one blurry square" was.
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      this._ro = new ResizeObserver(() => {
        clearTimeout(this._rt);
        this._rt = setTimeout(() => this.resize(), 60);
      });
      this._ro.observe(canvas.parentElement);
    }
  }

  setPlot(p) { this.p = p; this._groundKey = ''; this.resize(); }
  setHomestead(h) { this.h = h; }

  resize() {
    const r = this.cv.getBoundingClientRect ? this.cv.getBoundingClientRect() : { width: 900, height: 640 };
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(320, Math.round((r.width || 900) * this.dpr));
    const h = Math.max(240, Math.round((r.height || 640) * this.dpr));
    if (w === this.cv.width && h === this.cv.height && this.cell) return;
    this.cv.width = w;
    this.cv.height = h;
    this._fit();
    // Setting canvas.width clears it. There is no rAF loop on this page, so a resize
    // would leave a blank canvas unless we repaint here.
    if (this.p) this._draw();
  }

  _fit() {
    if (!this.p) return;
    const pad = 22 * this.dpr;
    const cell = Math.floor(Math.min(
      (this.cv.width - pad * 2) / this.p.w,
      (this.cv.height - pad * 2) / this.p.h,
    ));
    if (cell !== this.cell) this._groundKey = '';   // texture is baked at cell size
    this.cell = cell;
    this.ox = Math.round((this.cv.width - cell * this.p.w) / 2);
    this.oy = Math.round((this.cv.height - cell * this.p.h) / 2);
  }

  _cellAt(sx, sy) {
    if (!this.p || !this.cell) return null;
    const x = Math.floor((sx - this.ox) / this.cell);
    const y = Math.floor((sy - this.oy) / this.cell);
    if (x < 0 || y < 0 || x >= this.p.w || y >= this.p.h) return null;
    return [x, y];
  }

  _bind() {
    const cv = this.cv;
    if (!cv || !cv.addEventListener) return;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr];
    };
    cv.addEventListener('mousemove', (e) => {
      const [x, y] = pos(e);
      this.hover = this._cellAt(x, y);
    });
    cv.addEventListener('mouseleave', () => { this.hover = null; });
    cv.addEventListener('click', (e) => {
      const [sx, sy] = pos(e);
      const c = this._cellAt(sx, sy);
      if (!c) return;
      const [x, y] = c;
      if (this.mode === 'fell') {
        const t = this.p.trees.find((q) => q.x === x && q.y === y);
        if (t && this.opts.onFell) this.opts.onFell(t.id);
        return;
      }
      if (this.mode === 'build' && this.buildKind) {
        if (this.opts.onBuild) this.opts.onBuild(this.buildKind, x, y);
        return;
      }
      const t = this.p.trees.find((q) => q.x === x && q.y === y);
      if (t && this.opts.onSelectTree) this.opts.onSelectTree(t);
    });
  }

  frame() { this._draw(); }

  /* ---------------------------------------------------------- ground bake */
  _ensureGround() {
    const p = this.p, cs = this.cell;
    const key = `${p.w}x${p.h}:${cs}:${p.ground.length}`;
    if (this._groundKey === key && this.groundCv) return;
    this._groundKey = key;

    const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
    if (!cv) return;
    cv.width = p.w * cs;
    cv.height = p.h * cs;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    // Render several samples per simulation cell. The model grid is for placement; it should
    // not be the visual pixel grid. A warped, smoothly sampled material field keeps its rules
    // but turns the square patches into organic ground transitions.
    const texel = Math.max(3, Math.min(7, Math.ceil(cs / 1.7)));
    const tw = p.w * texel, th = p.h * texel;
    const low = document.createElement('canvas');
    low.width = tw;
    low.height = th;
    const lg = low.getContext('2d');
    const img = lg.createImageData(tw, th);
    const kinds = p.ground;
    const smooth = (a, b, t) => {
      const q = Math.max(0, Math.min(1, (t - a) / (b - a)));
      return q * q * (3 - 2 * q);
    };
    // Bilinear influence from the simulation terrain, softened by noise at render time.
    // These are masks rather than flat materials: the placement grid stays exact, while
    // the painted edge can feather and meander between cells.
    const support = (gx, gy, kind) => {
      gx = Math.max(0, Math.min(p.w - 1, gx));
      gy = Math.max(0, Math.min(p.h - 1, gy));
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const x1 = Math.min(p.w - 1, x0 + 1), y1 = Math.min(p.h - 1, y0 + 1);
      const fx = smooth(0, 1, gx - x0), fy = smooth(0, 1, gy - y0);
      const v = (x, y) => kinds[y * p.w + x] === kind ? 1 : 0;
      const a = v(x0, y0) * (1 - fx) + v(x1, y0) * fx;
      const b = v(x0, y1) * (1 - fx) + v(x1, y1) * fx;
      return a * (1 - fy) + b * fy;
    };
    const mix = (a, b, t) => a + (b - a) * t;

    for (let py = 0; py < th; py++) {
      const wy = (py + 0.5) / texel;
      for (let px = 0; px < tw; px++) {
        const wx = (px + 0.5) / texel;
        // Domain warp bends the cell boundaries; layered value noise adds broad soil variation,
        // small clover/grass flecks, and fine grain so the field doesn't look airbrushed.
        const warpX = (vnoise(wx * 0.12, wy * 0.12, 81) - 0.5) * 1.95
          + (vnoise(wx * 0.39, wy * 0.39, 82) - 0.5) * 0.78
          + (vnoise(wx * 1.05, wy * 1.05, 88) - 0.5) * 0.24;
        const warpY = (vnoise(wx * 0.12, wy * 0.12, 83) - 0.5) * 1.95
          + (vnoise(wx * 0.39, wy * 0.39, 84) - 0.5) * 0.78
          + (vnoise(wx * 1.05, wy * 1.05, 89) - 0.5) * 0.24;
        const gx = wx - 0.5 + warpX, gy = wy - 0.5 + warpY;
        const broad = vnoise(wx * 0.13, wy * 0.13, 85);
        const mid = vnoise(wx * 0.72, wy * 0.72, 86);
        const fine = vnoise(wx * 2.1, wy * 2.1, 87);
        const shade = 1 + (broad - 0.5) * 0.27 + (mid - 0.5) * 0.16 + (fine - 0.5) * 0.08;
        const tint = (broad - 0.5) * 9 + (mid - 0.5) * 4;
        const boundaryNoise = (vnoise(wx * 0.28, wy * 0.28, 90) - 0.5) * 0.38
          + (vnoise(wx * 0.91, wy * 0.91, 91) - 0.5) * 0.13;
        let color = [0, 0, 0];
        const types = ['grass', 'scrub', 'rock', 'mud', 'bank', 'water'];
        let total = 0;
        for (const kind of types) {
          if (kind === 'grass') continue;
          const mask = support(gx, gy, kind);
          const weight = smooth(0.43 + boundaryNoise, 0.78 + boundaryNoise, mask);
          const mat = GROUND[kind];
          for (let c = 0; c < 3; c++) color[c] = mix(color[c], mat[c], weight);
          total = Math.max(total, weight);
        }
        // Grass is the base layer; discrete terrain values become irregular soft islands.
        const i = (py * tw + px) * 4;
        const base = GROUND.grass;
        const edgeBlend = Math.min(1, total);
        img.data[i] = Math.max(0, Math.min(255, mix(base[0], color[0], edgeBlend) * shade + tint * 0.8));
        img.data[i + 1] = Math.max(0, Math.min(255, mix(base[1], color[1], edgeBlend) * shade + tint));
        img.data[i + 2] = Math.max(0, Math.min(255, mix(base[2], color[2], edgeBlend) * shade - tint * 0.35));
        img.data[i + 3] = 255;
      }
    }
    lg.putImageData(img, 0, 0);
    g.drawImage(low, 0, 0, cv.width, cv.height);

    // Fine grass marks sit on the colour field, not on cell corners. Keep them restrained:
    // they are surface detail, not a repeating tile pattern.
    if (cs >= 6) {
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const kind = p.ground[y * p.w + x];
          if ((kind !== 'grass' && kind !== 'scrub') || jitter(x, y, 91) > 0.38) continue;
          const cx = (x + 0.18 + jitter(x, y, 92) * 0.64) * cs;
          const cy = (y + 0.18 + jitter(x, y, 93) * 0.64) * cs;
          const len = cs * (0.08 + jitter(x, y, 94) * 0.10);
          g.strokeStyle = kind === 'grass' ? 'rgba(205,210,150,0.22)' : 'rgba(42,55,31,0.24)';
          g.lineWidth = Math.max(0.7, cs * 0.025);
          g.beginPath();
          g.moveTo(cx - len * 0.6, cy + len * 0.25);
          g.lineTo(cx, cy - len * 0.45);
          g.lineTo(cx + len * 0.6, cy + len * 0.1);
          g.stroke();
        }
      }
    }

    // Draw the stream as a continuous channel, not a chain of blue square cells.
    if (p.stream) {
      const pts = [];
      const vertical = !!p.stream.vertical;
      const count = vertical ? p.h : p.w;
      for (let n = 0; n < count; n++) {
        const wobble = Math.round(Math.sin(n * 0.35) * 1.2);
        const c = p.stream.at + wobble + 0.5;
        pts.push(vertical ? [c * cs, (n + 0.5) * cs] : [(n + 0.5) * cs, c * cs]);
      }
      const strokePath = (color, width) => {
        g.beginPath();
        pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
        g.strokeStyle = color;
        g.lineWidth = width;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.stroke();
      };
      strokePath('rgba(34,61,48,0.72)', cs * 3.1);   // damp banks
      strokePath('#34768a', cs * 1.22);               // deep water
      strokePath('rgba(160,211,218,0.46)', Math.max(1, cs * 0.13)); // broken water glint
    }

    this.groundCv = cv;
  }

  /* ------------------------------------------------------------- draw */
  _draw() {
    const ctx = this.ctx, W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const backdrop = ctx.createLinearGradient(0, 0, W, H);
    backdrop.addColorStop(0, '#233322');
    backdrop.addColorStop(0.48, '#19291e');
    backdrop.addColorStop(1, '#101a14');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, W, H);
    if (!this.p) return;
    if (!this.cell) this._fit();
    const p = this.p, cs = this.cell;

    // A little mountain beyond the boundary: quiet contour lines and the edge of the
    // neighbouring forest give the surveyed plot a place in the landscape, not a void.
    ctx.save();
    ctx.lineWidth = Math.max(0.7, this.dpr);
    ctx.strokeStyle = 'rgba(180,194,145,0.055)';
    for (let band = 0; band < 8; band++) {
      const y0 = H * (0.08 + band * 0.12);
      ctx.beginPath();
      for (let x = 0; x <= W; x += Math.max(18 * this.dpr, W / 26)) {
        const y = y0 + Math.sin(x / (W * 0.13) + band * 0.8) * 13 * this.dpr
          + Math.sin(x / (W * 0.047) - band * 0.43) * 4 * this.dpr;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Distant canopy only outside the plot. It is deliberately low-contrast: the held land
    // remains the focus, but the boundary no longer looks pasted onto a black screen.
    for (let i = 0; i < 180; i++) {
      const x = jitter(i, p.seed, 121) * W;
      const y = jitter(i, p.seed, 122) * H;
      if (x >= this.ox - 8 * this.dpr && x <= this.ox + p.w * cs + 8 * this.dpr
        && y >= this.oy - 8 * this.dpr && y <= this.oy + p.h * cs + 8 * this.dpr) continue;
      const rr = (3 + jitter(i, p.seed, 123) * 6) * this.dpr;
      ctx.fillStyle = i % 3 === 0 ? 'rgba(71,101,62,0.32)' : 'rgba(39,73,47,0.38)';
      ctx.beginPath();
      ctx.ellipse(x, y, rr * 1.2, rr * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    this._ensureGround();
    if (this.groundCv) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.groundCv, this.ox, this.oy);
    } else {
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const base = GROUND[p.ground[y * p.w + x]] || GROUND.grass;
          ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
          ctx.fillRect(this.ox + x * cs, this.oy + y * cs, cs, cs);
        }
      }
    }

    // dam site
    if (p.dam) {
      ctx.fillStyle = 'rgba(47,93,112,0.45)';
      ctx.beginPath();
      ctx.arc(this.ox + (p.dam.cx + 0.5) * cs, this.oy + (p.dam.cy + 0.5) * cs, p.dam.r * cs, 0, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,205,225,0.55)';
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.lineWidth = 1.2 * this.dpr;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.h) {
      for (const b of this.h.beds || []) {
        const ready = this.h.day >= b.ready;
        const bx = this.ox + b.x * cs, by = this.oy + b.y * cs;
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(bx + cs * 0.14, by + cs * 0.16, cs * 0.78, cs * 0.78);
        ctx.fillStyle = '#5b4327';
        ctx.fillRect(bx + cs * 0.1, by + cs * 0.1, cs * 0.8, cs * 0.8);
        ctx.fillStyle = ready ? '#9ed162' : '#4d7a35';
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(bx + cs * 0.2, by + cs * (0.24 + i * 0.22), cs * 0.6, cs * 0.1);
        }
        if (ready) {
          ctx.strokeStyle = 'rgba(220,255,180,.75)';
          ctx.lineWidth = 1.3 * this.dpr;
          ctx.strokeRect(bx + cs * 0.08, by + cs * 0.08, cs * 0.84, cs * 0.84);
        }
      }
      for (const v of this.h.hives || []) {
        const vx = this.ox + (v.x + 0.5) * cs, vy = this.oy + (v.y + 0.5) * cs;
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(vx - cs * 0.2, vy - cs * 0.18, cs * 0.44, cs * 0.5);
        ctx.fillStyle = '#d8a94a';
        ctx.fillRect(vx - cs * 0.22, vy - cs * 0.26, cs * 0.44, cs * 0.5);
        ctx.fillStyle = '#6b4a1a';
        ctx.fillRect(vx - cs * 0.22, vy - cs * 0.06, cs * 0.44, cs * 0.06);
        ctx.fillRect(vx - cs * 0.22, vy + cs * 0.1, cs * 0.44, cs * 0.05);
      }
      for (const a of this.h.accom || []) {
        const ax = this.ox + a.x * cs, ay = this.oy + a.y * cs;
        if (a.built) {
          ctx.fillStyle = 'rgba(0,0,0,0.32)';
          ctx.fillRect(ax + cs * 0.16, ay + cs * 0.26, cs * 0.8, cs * 0.66);
          ctx.fillStyle = '#c9a06a';
          ctx.fillRect(ax + cs * 0.1, ay + cs * 0.15, cs * 0.8, cs * 0.7);
          ctx.fillStyle = '#7a5a34';
          ctx.beginPath();
          ctx.moveTo(ax + cs * 0.02, ay + cs * 0.2);
          ctx.lineTo(ax + cs * 0.5, ay - cs * 0.1);
          ctx.lineTo(ax + cs * 0.98, ay + cs * 0.2);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(230,200,140,.8)';
          ctx.setLineDash([4 * this.dpr, 3 * this.dpr]);
          ctx.lineWidth = 1.4 * this.dpr;
          ctx.strokeRect(ax + cs * 0.12, ay + cs * 0.16, cs * 0.76, cs * 0.68);
          ctx.setLineDash([]);
        }
      }
    }

    // trees: shadow, trunk, canopy. Size by age, with a floor so a pine is still a pine
    // when the stage is narrow instead of a two-pixel speck.
    for (const t of p.trees) {
      const cx = this.ox + (t.x + 0.5) * cs, cy = this.oy + (t.y + 0.5) * cs;
      const ageF = Math.min(1, (t.age || 15) / 30);
      // Canopies are intentionally generous at the full-plot zoom. The old 0.3-cell
      // crowns collapsed into repeated little triangles, not a forest.
      const r = Math.max(cs * (t.kind === 'pine' ? 0.43 + ageF * 0.15 : 0.48 + ageF * 0.15), 4.2 * this.dpr);
      const hov = this.hover && this.hover[0] === t.x && this.hover[1] === t.y;
      const shade = jitter(t.x, t.y, 5);

      // shadow on the ground, offset south-east
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.42, cy + r * 0.52, r * 0.92, r * 0.55, 0, 0, 7);
      ctx.fill();

      if (t.kind === 'pine') {
        const g1 = 61 + shade * 18;
        const triangle = (top, half, baseY, fill) => {
          ctx.beginPath();
          ctx.moveTo(cx, cy + top * r);
          ctx.lineTo(cx + half * r, cy + baseY * r);
          ctx.lineTo(cx - half * r, cy + baseY * r);
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.strokeStyle = 'rgba(8,16,10,.48)';
          ctx.lineWidth = Math.max(0.65, 0.8 * this.dpr);
          ctx.stroke();
        };
        // Three overlapping bough tiers and a visible trunk make the pine silhouette read
        // at the zoom where the whole holding is on screen.
        triangle(-0.46, 1.04, 0.86, hov ? '#1f4d30' : `rgb(${17 + shade * 9 | 0},${g1 * 0.67 | 0},${29 + shade * 8 | 0})`);
        triangle(-1.04, 0.80, 0.28, hov ? '#2b633d' : `rgb(${20 + shade * 10 | 0},${g1 * 0.83 | 0},${34 + shade * 8 | 0})`);
        triangle(-1.62, 0.57, -0.38, hov ? '#3d7a4e' : `rgb(${26 + shade * 12 | 0},${g1 | 0},${40 + shade * 10 | 0})`);
        ctx.fillStyle = '#3b2918';
        ctx.fillRect(cx - r * 0.075, cy + r * 0.52, r * 0.15, r * 0.42);
      } else {
        // Broadleaf canopy: a dark outer crown, five overlapping crowns and small light
        // patches. This is deliberately organic rather than the old three-dot icon.
        ctx.fillStyle = 'rgba(10,25,13,0.72)';
        ctx.beginPath();
        ctx.ellipse(cx + r * 0.1, cy + r * 0.12, r * 1.14, r * 0.82, 0, 0, Math.PI * 2);
        ctx.fill();
        const leaf = hov ? '#3f7944' : `rgb(${31 + shade * 9 | 0},${72 + shade * 14 | 0},${38 + shade * 9 | 0})`;
        ctx.fillStyle = leaf;
        for (const [dx, dy, scale] of [[0, -0.24, 0.72], [-0.48, -0.12, 0.58], [0.48, -0.08, 0.62], [-0.20, -0.58, 0.56], [0.30, -0.55, 0.52]]) {
          ctx.beginPath();
          ctx.arc(cx + dx * r, cy + dy * r, scale * r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(157,183,97,0.48)';
        ctx.beginPath();
        ctx.arc(cx - r * 0.28, cy - r * 0.49, r * 0.16, 0, Math.PI * 2);
        ctx.arc(cx + r * 0.39, cy - r * 0.29, r * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
      if (hov) {
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1.4 * this.dpr;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.2, 0, 7);
        ctx.stroke();
      }
    }

    // gate on the road edge
    if (p.gate) {
      const gx = this.ox + p.gate.x * cs, gy = this.oy + p.gate.y * cs;
      ctx.fillStyle = PAL.gate;
      ctx.fillRect(gx + cs * 0.2, gy + (p.gate.side === 'S' ? cs * 0.72 : cs * 0.2), cs * 0.6, cs * 0.16);
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.font = `${9 * this.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('gate', gx + cs * 0.5, gy + (p.gate.side === 'S' ? cs * 1.2 : -cs * 0.12));
      ctx.textAlign = 'left';
    }

    // A survey line and four corner stakes make it clear this is your bounded holding,
    // rather than a crop pasted onto the canvas.
    const bx = this.ox, by = this.oy, bw = p.w * cs, bh = p.h * cs;
    ctx.save();
    ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
    ctx.strokeStyle = 'rgba(224,196,132,0.58)';
    ctx.lineWidth = 1.4 * this.dpr;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
    for (const [sx, sy] of [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]]) {
      ctx.fillStyle = '#c7a66c';
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(52,38,22,0.75)';
      ctx.beginPath();
      ctx.arc(sx, sy, 0.9 * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // frame + scale
    ctx.fillStyle = 'rgba(13,23,17,.88)';
    ctx.fillRect(this.ox, this.oy - 18 * this.dpr, 144 * this.dpr, 16 * this.dpr);
    ctx.fillStyle = '#e4d9bb';
    ctx.font = `${10 * this.dpr}px ui-monospace, monospace`;
    ctx.fillText(`${Math.round(p.w * p.cellM)} × ${Math.round(p.h * p.cellM)} m · ${p.ha} ha`,
      this.ox + 5 * this.dpr, this.oy - 6 * this.dpr);
  }

  capture() { return this.cv.toDataURL('image/png'); }
}
