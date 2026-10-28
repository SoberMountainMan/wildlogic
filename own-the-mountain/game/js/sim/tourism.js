// tourism.js — tier 2: the thing that can actually pay a bond.
//
// Hogsback is a tourist village: cabins, garden rooms, guests, and a tar road that
// potholes. Vegetables keep you alive; beds pay the bank. Pure logic, no DOM.
//
// Operates on the household object from homestead.js. Deliberately does not import
// homestead.js — homestead imports this, and a cycle would make both untestable.

import { forestFactor, mountainFactor } from './company.js';
import { initVoices, recordVoice, recentVoices, decemberRegular } from './voices.js';
import { roadWearMult, guestMult, isWinter } from './weather.js';
import { waterOut, repairPenalty, repairComplaint } from './handyman.js';
import { guestReview } from './reviewQuotes.js';
import { mulberry32, seedOf, drivewaySurcharge, drivewayTiles, steep, tileFlat } from './plotmap.js';
import { trackWithin, driveWithin, driveAccess, stuckChance, MUD, isFlat } from './siteworks.js';
import { FIREWOOD, inFirewoodSeason, lumberOff } from './firewood.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

/**
 * The market rate per rung (owner research, real Hogsback listings, 2026-10-20).
 * The player sets their own rate AGAINST this number: the HUD shows the competitor
 * beside the player's, and the gap drives fill (GUEST-LADDER.md, "Player-set rates").
 * H$ a night for the whole unit, not per bed.
 */
export const MARKET = {
  camp: 360,      // 2 pitches
  caravan: 300,   // a stand — the guest brings the van
  room: 900,
  spare: 650,
  cabin: 1400,
  chalet: 2200,
  luxury: 3200,
};

export const ACCOM = {
  // Rung 1 of the guest ladder (owner GO 2026-10-20): two pitches, a tap and a hope.
  // The ablution block is not an upgrade — without it the camp cannot be let at all.
  // footprint [w, h] in tiles (owner verdict 5, 2026-10-21): what the ghost preview
  // shows and what the ground must hold. spare is INSIDE the house — footprint 0,
  // it is never placed on the map.
  camp: {
    label: 'Camping site', cost: 15000, buildDays: 3, capacity: 2, rate: MARKET.camp,
    needs: ['ablution'], footprint: [4, 3],
    blurb: 'Two flat pitches and a view. Campers forgive wattle; they do not forgive no loo.',
  },
  // Rung 2: the caravan stand. Mud is the fail state — a van that cannot reach the
  // stand does not become a booking, it becomes a review.
  caravan: {
    label: 'Caravan stand', cost: 40000, buildDays: 7, capacity: 2, rate: MARKET.caravan,
    // the stand is 2x2 (owner GO 2026-10-23): a 2x1 diamond is 96 px, about 3.75 m of
    // diagonal, and a real caravan on a Hogsback stand is 5-7 m. Two generations of art
    // overshot it by 20-27% and the 10% crop gate refused to fake the difference. A 2x2
    // is 128 px (~5 m) and — the part that matters — it is SQUARE, so the painted sprite
    // needs no x-offset anchor at all. The 2x1 was the hard case.
    needs: ['driveway'], footprint: [2, 2],
    // owner ruling 2026-10-23: one caravan let at a time, so the stand is ONE stand for
    // a van and its two guests. "Two gravel stands" used to be the copy, which described
    // a game that no longer exists (the art seat flagged it).
    blurb: 'One gravel stand with a power point. Room for a van and two guests. After rain, an unmade drive stops the trade.',
  },
  room: {
    label: 'Garden room', cost: 95000, buildDays: 21, capacity: 1, rate: MARKET.room,
    lumber: 8, footprint: [1, 1],   // mill lumber the build can absorb — see buildAccom (wattle bundle, 10-20)
    blurb: 'One bed, one bathroom, shares the garden. The cheap way into hosting.',
  },
  spare: {
    label: 'Spare room', cost: 25000, buildDays: 7, capacity: 1, rate: MARKET.spare,
    only: 'stayed', lumber: 4, footprint: [0, 0],
    blurb: 'The house is already yours. Fix up the back room and let it.',
  },
  cabin: {
    label: 'Cabin', cost: 240000, buildDays: 30, capacity: 2, rate: MARKET.cabin,
    lumber: 14, footprint: [2, 2],
    blurb: 'A two-bed cottage of its own. Slow to build, pays for a bond.',
  },
  // The first home (TERRAIN-SPEC §4, owner 2026-10-21): a plot starts with NO house —
  // where the home goes is the player's first real decision. Flat ground only, like
  // every build (the §6 gate). capacity 0 — it is a home, not a rung.
  house: {
    label: 'House', cost: 45000, buildDays: 30, capacity: 0, rate: 0,
    footprint: [2, 2],
    blurb: 'Your own roof, your own ground. Flat land only — flatten it first.',
  },
};

/** The tile footprint of a rung: [w, h] on the ground, [0, 0] when it is not placed
 *  (the spare room is inside the house). Defaults to 1×1 for rungs without one. */
export function accomFootprint(kind) {
  const fp = ACCOM[kind] && ACCOM[kind].footprint;
  return fp || [1, 1];
}

/**
 * Can this rung stand with its WHOLE footprint at x, y (top-left tile)?
 * Every cell must be on the plot, dry, treeless and clear of anything standing —
 * no other unit (each cell of one counts), no bed, hive, building or the gate.
 * A [0, 0] footprint (the spare room) is always placeable — it is not placed.
 * Pure and exported so the HUD ghost preview and the sim agree on one answer.
 */
export function canPlaceAccom(h, kind, x, y) {
  const p = h.plot;
  if (!p) return { ok: true };
  const [fw, fh] = accomFootprint(kind);
  if (fw * fh <= 0) return { ok: true };
  for (let cx = x; cx < x + fw; cx++) {
    for (let cy = y; cy < y + fh; cy++) {
      if (cx < 0 || cy < 0 || cx >= p.w || cy >= p.h) {
        return { ok: false, msg: 'the site runs off the plot' };
      }
      if (p.ground[cy * p.w + cx] === 'water') {
        return { ok: false, msg: 'water runs through the site' };
      }
      // TERRAIN-SPEC §2/§6: a building stands on flat ground only — every cell must be
      // corner-flat (no touching tile higher, diagonals included). A site across a
      // level step buries half its yard and floats the rest; this is the gate that
      // keeps every rung ON the ground. Flatten first — that is what the blade is for.
      if (!tileFlat(p, cx, cy)) {
        return { ok: false, msg: 'the ground falls away inside the site — flatten it first' };
      }
      if ((p.trees || []).some((t) => t.x === cx && t.y === cy)) {
        return { ok: false, msg: 'a tree stands in the site — fell it first' };
      }
      if ((h.accom || []).some((a) => {
        const [aw, ah] = accomFootprint(a.kind);
        const w = Math.max(1, aw), ht = Math.max(1, ah);
        return cx >= a.x && cx < a.x + w && cy >= a.y && cy < a.y + ht;
      })) {
        return { ok: false, msg: 'something is already standing there' };
      }
      if ((h.beds || []).some((b) => b.x === cx && b.y === cy)) {
        return { ok: false, msg: 'a bed is planted in the site' };
      }
      if ((h.hives || []).some((v) => v.x === cx && v.y === cy)) {
        return { ok: false, msg: 'a hive sits in the site' };
      }
      if ((p.buildings || []).some((b) => b.x === cx && b.y === cy)
        || (p.gate && p.gate.x === cx && p.gate.y === cy)) {
        return { ok: false, msg: 'something is already standing there' };
      }
    }
  }
  return { ok: true };
}

/**
 * The driveway surcharge for a MULTI-TILE site: the cheapest cell of the footprint
 * does the paying — you run the drive to the near corner, not through the camp.
 * Zero for a footprint that is not placed.
 */
export function accomSurcharge(h, kind, x, y) {
  const [fw, fh] = accomFootprint(kind);
  if (fw * fh <= 0) return 0;
  let min = Infinity;
  for (let cx = x; cx < x + fw; cx++) {
    for (let cy = y; cy < y + fh; cy++) {
      if (cx < 0 || cy < 0 || cx >= h.plot.w || cy >= h.plot.h) continue;
      min = Math.min(min, drivewaySurcharge(h.plot, cx, cy));
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/** The rungs that are built unlisted: listing is the player's decision, and the mistake
 *  the review engine exists to punish. The older rungs keep letting the moment they
 *  are finished, as they always did. The house is a home, never a listing. */
export const UNLISTED_ON_BUILD = new Set(['camp', 'caravan', 'house']);

/** Facilities are gates, not upgrades (GUEST-LADDER.md). Built once, owned forever —
 *  except wifi, which is a line rental every month. */
export const FACILITY = {
  ablution: { label: 'Ablution block', cost: 12000, buildDays: 2 },
  // `where` (owner live play 10-28: "click braai or generator etc and it says going up
  // but where"): the unsited facilities put nothing on the map, so the log line is the
  // only place the purchase can say what the money became. Sited kinds (ablution) need
  // no where — the block stands where FACILITY_SITE put it.
  braai:    { label: 'Braai',           cost: 3500,  buildDays: 1,
              where: 'a stone braai and a bench go up in the camp yard, where the guests sit' },
  driveway: { label: 'Driveway',        cost: 9000,  buildDays: 3 },
  fire:     { label: 'Fireplace',       cost: 1800,  buildDays: 1,
              where: 'a fire circle in the camp yard, beside the braai' },
  wifi:     { label: 'Wifi line',       cost: 2500,  buildDays: 1, monthly: 400,
              where: 'a line rental — nothing stands on the plot; the village exchange switches it on' },
  // Power, two ways (GUEST-LADDER.md, "Power: generator vs solar"): the generator is
  // cheap and trips; solar is silent and never does. Both hold the lights on.
  // The generator also DRINKS (owner, 2026-10-21): "generators cost fuel to run". It is
  // cheap to buy and expensive to keep — the bill is the other half of the trade.
  generator: { label: 'Generator',      cost: 8000,  buildDays: 1, fuelPerDay: 45,
              where: 'in the shed by the yard — you will hear it, and pay for its fuel every day' },
  power:    { label: 'Solar power',     cost: 35000, buildDays: 7,
              where: 'panels on the open ground by the yard — silent, and it never trips' },
};
export const FACILITY_KINDS = Object.keys(FACILITY);

/** WHICH FACILITIES ARE A BUILDING (playtest VIS-02, 10-25).
 *
 *  Every facility used to be a pure boolean on `h.facilities`, so the H$12,000 ablution
 *  block — the thing the camp CANNOT be let without, and the only facility the review
 *  engine charges 2.0 stars for — put nothing on the map at all. The art seat filed that
 *  three times and correctly refused to paint a sprite with no surface to draw on
 *  (sprites.js:1929, make-sprite-assets.py:138): a sprite nothing draws is dead art.
 *
 *  The fix belongs here, not in the renderer. A block of showers and toilets is a
 *  BUILDING; it stands on a tile, the player can see it, and the camp's own tile list
 *  already knows how to hold one. So an ablution build now reserves a tile at the moment
 *  it is paid for and pushes the building when it finishes — same rhythm as a unit.
 *
 *  Deliberately NOT sited: `braai` and `fire` are fittings inside/at a unit that already
 *  has art, `driveway` is a surface (siteworks lays it), `wifi` is a line rental, and
 *  `generator`/`power` are still vector-only — each would need its own sprite to stop
 *  being a second invisible purchase, and that is a separate round. One building, drawn
 *  properly, beats six reserved tiles nobody painted. */
export const FACILITY_SITE = { ablution: [2, 1] };

/** Where a sited facility should go: beside the unit it serves, else the plot's middle.
 *  Deterministic — same plot, same camp, same tile, forever. No rng is drawn, so no
 *  golden trace moves. */
function facilityAnchor(h) {
  const p = h.plot;
  const built = (h.accom || []).filter((a) => a.built && ACCOM[a.kind] && ACCOM[a.kind].footprint);
  const serve = built.find((a) => a.kind === 'camp') || built.find((a) => a.kind === 'caravan') || built[0];
  if (serve) {
    const [fw, fh] = accomFootprint(serve.kind);
    return [Math.floor(serve.x + Math.max(1, fw) / 2), Math.floor(serve.y + Math.max(1, fh) / 2)];
  }
  return [Math.floor(p.w / 2), Math.floor(p.h / 2)];
}

/** How far from the unit it serves a sited facility may land, in tiles. The art seat's
 *  in-game probe (10-28, tools/ablution-anchor-probe.html) measured the arboretum: with
 *  an unbounded spiral the H$12,000 block bought for the camp lands 30 tiles away
 *  (73-78 m across three seeds) because every cell near the camp is treed. A facility
 *  bought for a camp that appears across the mountain is not placement, it is
 *  abandonment. Six tiles is the yard the camp stands in; beyond that the honest answer
 *  is a refusal with the reason, the same rule the owner set for beds. */
export const FACILITY_RADIUS = 6;

/** First free, dry, buildable fw×fh block spiralling out from `facilityAnchor`, within
 *  FACILITY_RADIUS of it. Null when the yard has no room — buildFacility refuses at the
 *  door on that (money does not move), rather than completing an invisible unplaced
 *  purchase or stranding the block across the mountain. Deterministic — same plot, same
 *  camp, same tile, forever. No rng is drawn, so no golden trace moves. */
export function freeFacilityTile(h, fw = 1, fh = 1) {
  const p = h.plot;
  if (!p || !p.ground) return null;
  const [ax, ay] = facilityAnchor(h);
  const taken = new Set();
  for (const b of p.buildings || []) {
    for (let cx = b.x; cx < b.x + (b.fw || 1); cx++) for (let cy = b.y; cy < b.y + (b.fh || 1); cy++) taken.add(cx + ',' + cy);
  }
  for (const t of p.trees || []) taken.add(t.x + ',' + t.y);
  for (const b of h.beds || []) taken.add(b.x + ',' + b.y);
  for (const v of h.hives || []) taken.add(v.x + ',' + v.y);
  for (const a of h.accom || []) {
    const [afw, afh] = accomFootprint(a.kind);
    for (let cx = a.x; cx < a.x + Math.max(1, afw); cx++) {
      for (let cy = a.y; cy < a.y + Math.max(1, afh); cy++) taken.add(cx + ',' + cy);
    }
  }
  for (const b of h.facilityBuilds || []) {
    if (b.x == null) continue;
    for (let cx = b.x; cx < b.x + (b.fw || 1); cx++) for (let cy = b.y; cy < b.y + (b.fh || 1); cy++) taken.add(cx + ',' + cy);
  }
  const free = (x, y) => {
    for (let cx = x; cx < x + fw; cx++) {
      for (let cy = y; cy < y + fh; cy++) {
        if (cx < 1 || cy < 1 || cx >= p.w - 1 || cy >= p.h - 1) return false;
        if (p.ground[cy * p.w + cx] === 'water') return false;
        if (taken.has(cx + ',' + cy)) return false;
        if (steep(p, cx, cy) !== 0) return false;
      }
    }
    return true;
  };
  const R = FACILITY_RADIUS;
  for (let r = 0; r <= R; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (const dy of (r === 0 ? [0] : [-r, r])) if (free(ax + dx, ay + dy)) return { x: ax + dx, y: ay + dy };
    }
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      for (const dx of [-r, r]) if (free(ax + dx, ay + dy)) return { x: ax + dx, y: ay + dy };
    }
  }
  return null;
}

/** The review weights. One number per thing a guest notices, in stars. */
export const PENALTY = {
  road: 1.0,        // condition under 40
  roadBad: 1.5,     // condition under 25
  cold: 1.0,        // May–August, no fireplace, not a tent
  weeds: 0.5,       // wattle + blackwood over 15% of the trees (was 25% — level probe
                    // found it never fired: real peak share is 17%)
  cleaning: 0.75,   // no cleaner
  braai: 0.5,       // no braai — every night, all year
  driveway: 1.0,    // rain, no driveway
  mud: 1.0,         // rain on a MUD driveway (owner GO 2026-10-21) — the cheap track's bill
  ablution: 2.0,    // camping/caravan with no bathroom
  wifi: 0.25,       // no line — wifi is table stakes in the real market (research 10-20)
  power: 0.8,       // storm or snow with no solar: the power goes out
  noise: 0.15,      // the generator ran all night — cheap power has a sound
  value: 0.5,       // charging >15% over market for a night that was not worth it
  firewood: 1.5,    // winter, a hearth house, and the wood store is dry (owner GO 10-21)
  oak: 0.5,         // the village noticed the big oak coming down (owner GO 10-21)
};

/** The standing oaks' gift (owner GO 10-21): each oak on the plot lifts the review
 *  floor 0.1 — the ornamental charm guests came for — capped at 0.4. */
export const OAK_BONUS = 0.1;
export const OAK_BONUS_CAP = 0.4;
export function oakBonus(h) {
  const oaks = (h.plot && Array.isArray(h.plot.trees))
    ? h.plot.trees.filter((t) => t.kind === 'oak').length : 0;
  return Math.min(OAK_BONUS_CAP, oaks * OAK_BONUS);
}

/** What the guest says when that is the worst thing about the night. */
export const PENALTY_QUOTE = {
  road: 'the road was terrible',
  cold: 'It was so cold I boiled the kettle for heat.',
  weeds: 'the property is overrun with wattle',
  cleaning: 'we cleaned before we slept',
  braai: 'not even a braai — what kind of Hogsback stay is this?',
  driveway: 'we got stuck at the gate',
  mud: 'we got stuck in the mud at the gate',
  ablution: 'guests are using the bush',
  wifi: 'no wifi and no signal — we were cut off from the world',
  power: 'the power went out in the storm and there was no backup',
  noise: 'the generator ran all night',
  value: 'not worth what we paid',
  firewood: 'the fireplace was cold — we wore coats to dinner',
  oak: 'someone cut the big oak',
};

export const PLATFORM_FEE = 0.10;   // booking sites take a cut
export const CLEANING = 100;        // linen, cleaning, the small things
// The village housekeeper (owner model, 2026-10-19): hired per CLEAN, not per day. She
// costs H$60 on a night you let and nothing on a night you don't — no permanent wage.
// Setup cost added 2026-10-20 (level audit: she was a strict freebie — no cost, no timing,
// so she was never a decision): linen, a spare key, the first month's supplies.
export const CLEANER = 60;
// H$8,000 (level audit 2026-10-20): at H$2,000 she was hired on the same day in every run —
// a fee, not a decision. At 8k the payback is ~4 years of saves at average occupancy, so
// only a well-booked household should take her on.
export const CLEANER_SETUP = 8000;
export function cleaningCost(h) { return h.cleaner ? CLEANER : CLEANING; }
export function getCleaner(h) {
  if (h.cleaner) return err('she already works for you');
  if (!(h.nights > 0)) return err('you need a first guest before you need her');
  if (h.cash < CLEANER_SETUP) {
    return err(`setting her up costs ${money(CLEANER_SETUP)} — you have ${money(Math.round(h.cash))}`);
  }
  h.cash -= CLEANER_SETUP;
  h.cleaner = true;
  h.log.push({
    day: h.day,
    text: `A woman from the village now does the cleans. −${money(CLEANER_SETUP)} to set her up, `
      + `then ${money(CLEANER)} a let night and nothing on the empty ones.`,
  });
  return ok('cleaner hired', { perClean: CLEANER, setup: CLEANER_SETUP });
}
export const PATCH_COST = 800;      // per load of tar, covering ~2 km
export const ROAD_START = 70;
export const ROAD_DECAY = 0.35;     // per day on a 2 km road, all weather
export const PATCH_GAIN = 10;

/* ---- traffic wear (owner ruling 2026-10-21, corrected same day: "road math is
   4th power, my mistake") ----
   Road damage scales with axle weight to the FOURTH power. A loaded timber truck
   runs ~8 t on the drive axle against a car's ~1 t — 8^4 = 4096× the damage per
   pass. Guest cars are noise; the company's trucks are the bill that makes patching
   a real monthly cost. The exponent is one exposed constant; the game-feel point is
   simply: more trucks, more wear. */
export const CAR_AXLE = 1;
export const TRUCK_AXLE = 8;
export const WEAR_EXP = 4;
export const TRUCKS_PER_DAY = { neutral: 2, supplier: 4, opposed: 1, owner: 0, left: 0.5 };
// Tuned on the 2 km reference road (roadDecay base 0.525/day): neutral +34%,
// supplier +68%, opposed +17%, owner/left untouched. Cars alone barely register.
// Traffic wear scales with the same (0.5 + km/2) distance factor as roadDecay:
// the trucks chew every km of your access road, so distance still costs.
export const TRAFFIC_K = 0.00001456;
export const MUD_WEAR = MUD.wear;   // mud surface factor (siteworks.MUD) for the traffic term

/** Guest cars on the road today: one vehicle per let night, from the LAST night's
 *  trade — the road wears before tonight's bookings are drawn. */
export function guestCars(h) { return h.lastNights || 0; }

/** The company's timber trucks, by stance. */
export function trucksPerDay(h) {
  const rel = (h.company && h.company.relation) || 'neutral';
  return TRUCKS_PER_DAY[rel] ?? TRUCKS_PER_DAY.neutral;
}

/** The surface factor of the plot's laid driveway (owner GO 2026-10-21): mud wears
 *  ~2.5× faster than gravel. The factor is the tile-weighted mix — all gravel 1.0,
 *  all mud 2.5, half-and-half 1.75 — and no laid tiles at all changes nothing. */
export function surfaceWear(h) {
  const p = h.plot;
  const mud = (p && Array.isArray(p.mud) ? p.mud.length : 0);
  const track = (p && Array.isArray(p.track) ? p.track.length : 0);
  if (!(mud + track)) return 1;
  return (mud * MUD_WEAR + track) / (mud + track);
}

/** Daily traffic wear on the road, in condition points, before the weather factor. */
export function trafficWear(h) {
  const axles = guestCars(h) * CAR_AXLE ** WEAR_EXP + trucksPerDay(h) * TRUCK_AXLE ** WEAR_EXP;
  return axles * TRAFFIC_K * (0.5 + (h.road.km || 0) / 2) * surfaceWear(h);
}

/**
 * A long access road is a permanent bill. The far plot is cheap to buy and expensive
 * to keep, which is the other half of the "closer to the shop costs more" trade.
 * A 0.4 km driveway wears slowly; 4.4 km of mountain road wears eleven times faster.
 */
export function roadDecay(h) { return ROAD_DECAY * (0.5 + (h.road.km || 0) / 2); }
export function patchCost(h) { return PATCH_COST * Math.max(1, Math.round((h.road.km || 0) / 2)); }

/** Bookings by month. December is the year; June is the dead of winter. */
export const SEASON = {
  1: 1.8, 2: 1.1, 3: 1.0, 4: 1.6, 5: 0.5, 6: 0.45,
  7: 0.5, 8: 0.6, 9: 0.9, 10: 1.1, 11: 1.3, 12: 2.0,
};
const BASE_OCCUPANCY = 0.55;

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Deterministic RNG carried in the household, so a save reloads to the same future. */
export function nextRandom(h) {
  h.rng = (Math.imul(1664525, h.rng >>> 0) + 1013904223) >>> 0;
  return h.rng / 4294967296;
}

/* ---- player-set rates (GUEST-LADDER.md, "Player-set rates", owner 2026-10-20) ----
   The player does not invent a price, they choose a position against the market: 1.0 is
   the competitor's rate, 0.8 undercuts, 1.4 is greed. Elasticity, not a cliff. */

/** Clamps on the multiplier the player may set. */
export const RATE_MIN = 0.5;
export const RATE_MAX = 2.0;

/** The demand curve, piecewise-linear through the owner's five measured points.
 *  0.8× ≈ +12% demand, 1.2× ≈ −25%, 1.5× ≈ −55% — a slope, not a cliff. */
const PRICE_POINTS = [
  [0.5, 1.25],
  [0.8, 1.12],
  [1.0, 1.00],
  [1.2, 0.75],
  [1.5, 0.45],
  [2.0, 0.20],
];
export function priceDemand(mult) {
  const m = clamp(Number(mult) || 1, RATE_MIN, RATE_MAX);
  for (let i = 1; i < PRICE_POINTS.length; i++) {
    const [x1, y1] = PRICE_POINTS[i - 1];
    const [x2, y2] = PRICE_POINTS[i];
    if (m <= x2) return y1 + ((m - x1) / (x2 - x1)) * (y2 - y1);
  }
  return PRICE_POINTS[PRICE_POINTS.length - 1][1];
}

/** The nightly rate actually charged: market × the player's multiplier × reputation. */
export function rateFor(h, kind) {
  const mult = (h.rates && h.rates[kind]) || 1;
  return Math.round((MARKET[kind] || 0) * mult * ratingMult(h));
}

/** Set a rung's rate as a multiplier of market. Clamped, logged, adjustable any day. */
export function setRate(h, kind, mult) {
  initTourism(h);
  if (!MARKET[kind]) return err('no market rate for that rung');
  const m = clamp(Math.round((Number(mult) || 1) * 100) / 100, RATE_MIN, RATE_MAX);
  h.rates[kind] = m;
  const label = (ACCOM[kind] && ACCOM[kind].label) || kind;
  const vs = m === 1 ? 'at the market rate' : m > 1 ? `${Math.round((m - 1) * 100)}% over market` : `${Math.round((1 - m) * 100)}% under market`;
  h.log.push({
    day: h.day,
    text: `${label}: ${money(rateFor(h, kind))} a night, ${vs} (${money(MARKET[kind])}).`,
  });
  return ok('rate set', { kind, mult: m, rate: rateFor(h, kind) });
}

export function initTourism(h) {
  initVoices(h);
  h.rng = h.rng || 20261019;
  h.road = h.road || { condition: ROAD_START, km: h.plot.kmFromShop };
  if (h.road.km == null) h.road.km = h.plot.kmFromShop;   // migrate older saves
  h.lastNights = h.lastNights || 0;   // the guest cars of yesterday drive today's wear
  h.accom = h.accom || [];          // { id, kind, x, y, doneDay, built, listed }
  // Facilities are household flags. A household that never touched the ladder pays
  // nothing and reads exactly as it always did (goldens must hold).
  h.facilities = h.facilities || {};
  for (const k of FACILITY_KINDS) h.facilities[k] = !!h.facilities[k];
  h.facilityBuilds = h.facilityBuilds || [];   // { kind, doneDay, built }
  // Open for bookings. TRUE by default: the golden economy depends on it. Closing the
  // switch stops the lets AND the reviews — the first-open decision is the tutorial.
  h.open = h.open == null ? true : !!h.open;
  // Units that predate the flag are listed (the old economy let them without asking);
  // the ladder rungs are built unlisted, because listing is the decision.
  for (const a of h.accom) if (a.listed == null) a.listed = !UNLISTED_ON_BUILD.has(a.kind);
  h.rating = h.rating == null ? 4.0 : h.rating;
  // Player-set rates: a multiplier of the market rate per rung, starting AT market.
  // Every rung has an entry so a save made before a rung was buildable still has one.
  h.rates = h.rates || {};
  for (const k of Object.keys(MARKET)) {
    h.rates[k] = h.rates[k] == null ? 1 : clamp(h.rates[k], RATE_MIN, RATE_MAX);
  }
  // The power stream's draw counter, so a reloaded save replays the same trips.
  h.powerDraws = h.powerDraws || 0;
  // Fuel: the generator's daily bill, accumulated to the month boundary so the log
  // gets one line a month instead of one a day.
  h.fuelSpend = h.fuelSpend || 0;   // H$ burned so far this month
  h.fuelDays = h.fuelDays || 0;     // days the generator ran this month
  h.fuelMonth = h.fuelMonth || 0;   // last month's total, for the HUD
  h.nights = h.nights || 0;         // guest-nights sold
  h.earned = h.earned || 0;         // ZAR from accommodation
  h.complaints = h.complaints || 0;
  h.cleaner = !!h.cleaner;
  return h;
}

/* ---- the ladder's own verbs ---- */

/** Build a facility. Same rhythm as a unit: paid now, ready in buildDays. */
export function buildFacility(h, kind) {
  initTourism(h);
  const def = FACILITY[kind];
  if (!def) return err('unknown facility');
  if (h.facilities[kind]) return err(`you already have the ${def.label.toLowerCase()}`);
  if (h.facilityBuilds.some((b) => b.kind === kind && !b.built)) {
    return err(`the ${def.label.toLowerCase()} is already going up`);
  }
  if (h.cash < def.cost) return err(`${def.label} costs ${money(def.cost)} — you have ${money(Math.round(h.cash))}`);
  // A sited facility reserves its tiles NOW, so a second purchase cannot claim the same
  // ground while the first is still going up, and so the block is chosen against the camp
  // as it stands today rather than as it stands in two days. And when the yard has no
  // room, the build refuses BEFORE the money moves — the owner's rule for beds applies
  // here too: a tile either accepts the build or explains itself before the click. An
  // invisible unplaced purchase and a block stranded across the mountain were both
  // measured defects (art probe 10-28); refusal with the reason is the third shape.
  const fp = FACILITY_SITE[kind] || null;
  const site = fp ? freeFacilityTile(h, fp[0], fp[1]) : null;
  if (fp && !site) {
    return err(`no room beside your unit for the ${def.label.toLowerCase()} — clear the trees or flatten ground next to it first`);
  }
  h.cash -= def.cost;
  h.facilityBuilds.push({
    kind, doneDay: h.day + def.buildDays, built: false,
    x: site ? site.x : null, y: site ? site.y : null,
    fw: fp ? fp[0] : 1, fh: fp ? fp[1] : 1,
  });
  h.log.push({ day: h.day, text: `${def.label} started. Ready in ${def.buildDays} day${def.buildDays === 1 ? '' : 's'}. −${money(def.cost)}`
    + (def.where ? ` ${def.where}.` : '') });
  return ok('facility started', { kind, cost: def.cost, doneDay: h.day + def.buildDays, site });
}

/** List or delist a unit. Delisted = no lets and no reviews, and the pitch waits. */
export function setListed(h, id, on) {
  initTourism(h);
  const a = h.accom.find((u) => u.id === id);
  if (!a) return err('no such unit');
  if (!a.built) return err('it is not finished yet');
  // A home takes no bookings. `capacity: 0` is not a missing number, it is what the house
  // IS. The UI seat found this live (10-23): a listed house accepted guests at rate 0 and
  // paid the per-clean fee on every one, so cash moved the wrong way 23 times in 50 days
  // while the review engine scored a bed nobody slept in. A page can stop offering a verb;
  // only the sim can stop the state.
  if ((ACCOM[a.kind].capacity || 0) < 1) {
    return err(`${ACCOM[a.kind].label} is not a booking — it is where you live.`);
  }
  a.listed = !!on;
  h.log.push({
    day: h.day,
    text: a.listed
      ? `${ACCOM[a.kind].label} listed for bookings.`
      : `${ACCOM[a.kind].label} taken off the booking sites.`,
  });
  return ok(a.listed ? 'listed' : 'delisted', { id, listed: a.listed });
}

/** The switch. Closed = no income, no reviews, no risk. */
export function setOpen(h, on) {
  initTourism(h);
  h.open = !!on;
  h.log.push({
    day: h.day,
    text: h.open ? 'Open for bookings.' : 'Closed for bookings — no lets, no reviews.',
  });
  return ok(h.open ? 'open' : 'closed', { open: h.open });
}

/** Wet ground: rain or the heavy stuff. Snow is cold, not mud. */
export function isWet(h) { return h.weather && (h.weather.kind === 'rain' || h.weather.kind === 'storm'); }

/** Wet enough for MUD: rain, the heavy stuff, or a hanging mist (owner's ruling names
    rain and mist as the days the cheap track bites). */
export function wetGround(h) {
  const k = h.weather && h.weather.kind;
  return k === 'rain' || k === 'storm' || k === 'mist';
}

/** Wattle + blackwood as a share of the standing trees on the plot. */
export function weedShare(h) {
  const trees = (h.plot && h.plot.trees) || [];
  if (!trees.length) return 0;
  return trees.filter((t) => t.kind === 'wattle' || t.kind === 'blackwood').length / trees.length;
}

/** What the average rating does to the rate. Graded, not binary (level probe 10-20:
    a 4.25★ and a 5.00★ household used to earn exactly the same). */
export function ratingMult(h) {
  if (h.rating >= 4.8) return 1.15;
  if (h.rating >= 4.3) return 1.08;
  if (h.rating < 3.5) return 0.8;
  return 1;
}

/** The generator's trip chance on a storm or snow night (owner: "it kept tripping"). */
export const GENERATOR_TRIP = 0.4;

/**
 * The generator's own stream. Same shape as the handyman's: the closure cannot survive
 * JSON, so the draw counter lives on the household and a reload replays it.
 */
function powerStream(h) {
  const base = mulberry32(seedOf(String(h.key || 'house') + ':power'));
  for (let i = 0; i < (h.powerDraws || 0); i++) base();
  return base;
}
function powerRoll(h) {
  if (typeof h.powerRng !== 'function') h.powerRng = powerStream(h);
  h.powerDraws = (h.powerDraws || 0) + 1;
  return h.powerRng();
}

/**
 * How the lights are kept on, per night. Solar never trips and never makes a sound; the
 * generator holds on a clear night but is heard, and on a storm or snow night it trips
 * 40% of the time. No backup at all = the old outage.
 */
export function powerNight(h) {
  initTourism(h);
  const f = h.facilities;
  const bad = !!(h.weather && (h.weather.kind === 'storm' || h.weather.kind === 'snow'));
  if (f.power) return { source: 'solar', out: false, noise: false, tripped: false };
  if (f.generator) {
    if (bad && powerRoll(h) < GENERATOR_TRIP) {
      return { source: 'generator', out: true, noise: false, tripped: true };
    }
    return { source: 'generator', out: false, noise: true, tripped: false };
  }
  return { source: 'none', out: bad, noise: false, tripped: false };
}

/* ---- fuel: the generator costs money to run (owner, 2026-10-21) ----
   "Generators cost fuel to run." Buying it is H$8,000 once; running it is H$45 a day,
   every day it is the household's power source. Solar is the expensive fix that then
   costs nothing — the trade is upfront against forever, not cheap against dear. */

/** Winter surcharge: cold starts and a heater on the same tank (May–July, as weather.js). */
export const WINTER_FUEL = 1.3;

/**
 * What the generator burns TODAY, in H$. Zero unless it is actually the power source:
 * solar wins when both are owned, and a household with nothing built has nothing to
 * power — a generator you don't run is a generator you didn't need.
 */
export function generatorFuel(h) {
  initTourism(h);
  const f = h.facilities;
  if (!f.generator || f.power) return 0;
  if (!(h.accom || []).some((a) => a.built)) return 0;
  const base = FACILITY.generator.fuelPerDay;
  return Math.round(base * (isWinter(h) ? WINTER_FUEL : 1));
}

/** The HUD's two numbers: today's burn, and the month to date. */
export function fuelSummary(h) {
  initTourism(h);
  return {
    perDay: generatorFuel(h),
    monthSpend: Math.round(h.fuelSpend || 0),
    lastMonth: Math.round(h.fuelMonth || 0),
    days: h.fuelDays || 0,
    source: h.facilities.power ? 'solar' : h.facilities.generator ? 'generator' : 'none',
  };
}

/**
 * Close the fuel month: one log line, then the counter resets. Called from endDay on
 * the 1st, beside the bills — the generator is a bill, not a daily drip of log noise.
 * Returns the line, or null when the generator never ran.
 */
export function flushFuel(h) {
  initTourism(h);
  const spent = Math.round(h.fuelSpend || 0);
  const days = h.fuelDays || 0;
  h.fuelSpend = 0;
  h.fuelDays = 0;
  h.fuelMonth = spent;
  if (!spent) return null;
  return `The generator drank ${money(spent)} this month (${days} day${days === 1 ? '' : 's'} running).`;
}

/**
 * One guest night, scored 1–5 from what the guest actually met. Deterministic: the
 * review is not a dice roll, it is a consequence. Returns the penalties so the HUD (and
 * the tests) can show WHY the stars moved.
 */
export function reviewNight(h, unit) {
  initTourism(h);
  const f = h.facilities;
  const pens = [];
  const add = (key, amount, quote) => pens.push({ key, amount, quote: quote || PENALTY_QUOTE[key] });

  if (h.road.condition < 25) add('road', PENALTY.roadBad);
  else if (h.road.condition < 40) add('road', PENALTY.road);

  const winter = h.date.month >= 5 && h.date.month <= 7;   // May–July (owner, 10-20)
  if (winter && !f.fire && unit.kind !== 'camp') add('cold', PENALTY.cold);
  // the hearth house with a dry wood store (owner GO 2026-10-21): fireplaces are
  // implicit in the rooms and cabins — no new facility. What kills the night is a
  // winter stay with no wood in the stack to burn.
  if (inFirewoodSeason(h.date) && unit.kind !== 'camp' && !((h.firewood || 0) > 0)) {
    add('firewood', PENALTY.firewood);
  }
  // the felled oak (owner GO 2026-10-21): once the first one comes down, the reviews
  // carry the village's opinion. One-time trigger, permanent weight.
  if (h.oakCut) add('oak', PENALTY.oak);

  if (weedShare(h) > 0.15) add('weeds', PENALTY.weeds);
  if (!h.cleaner) add('cleaning', PENALTY.cleaning);
  if (!f.braai) add('braai', PENALTY.braai);
  if (isWet(h) && !f.driveway) add('driveway', PENALTY.driveway);
  // mud on the drive (owner GO 2026-10-21): a laid MUD driveway draws its own complaint
  // on a rain or mist day, even on the nights the guests made it in. Weight matches the
  // old stuck-at-gate line; it stacks with the wet weather's own effects.
  if (wetGround(h) && h.plot) {
    const access = driveAccess(h.plot, unit.x, unit.y);
    if (access.mud > 0) add('mud', PENALTY.mud);
  }
  if (!f.ablution && (unit.kind === 'camp' || unit.kind === 'caravan')) add('ablution', PENALTY.ablution);
  if (!f.wifi) add('wifi', PENALTY.wifi);
  // the power only fails when the weather is bad — that is when a guest notices
  const power = powerNight(h);
  if (power.out) {
    add('power', PENALTY.power, power.tripped ? 'the generator tripped all night' : undefined);
  } else if (power.noise) {
    add('noise', PENALTY.noise);
  }

  // the handyman's hook: a fault past its deadline is 1.5 stars and its own quote.
  // Pure — the module owns the wording, we only place it in the night's ledger.
  const broken = repairPenalty(h);
  if (broken > 0) add('repair', broken, repairComplaint(h).replace(/^"|"$/g, ''));

  // Value for money (GUEST-LADDER.md): charging over market for a night that was not
  // worth it is worse than charging market for a bad place. Judged on the night BEFORE
  // this penalty, so it is a surcharge on a mediocre night, never a spiral of its own.
  const before = clamp(Math.round((5 - pens.reduce((a, p) => a + p.amount, 0)) * 100) / 100, 1, 5);
  if (((h.rates && h.rates[unit.kind]) || 1) > 1.15 && before < 4.0) add('value', PENALTY.value);

  const total = pens.reduce((a, p) => a + p.amount, 0);
  // the standing oaks lift the review floor, the felled one drags it — the charm is the crop
  const score = clamp(Math.round((5 - total + oakBonus(h)) * 100) / 100, 1, 5);
  // the largest penalty is what the guest writes about; ties keep the table's order
  const worst = pens.reduce((a, p) => (!a || p.amount > a.amount ? p : a), null);
  return { score, penalties: pens, total: Math.round(total * 100) / 100, quote: worst ? worst.quote : null, worst: worst ? worst.key : null };
}

export function seasonFactor(date) { return SEASON[date.month] || 1; }

/* ---- the real calendar (owner, 2026-10-19): busy = weekends + SA school holidays ----
   Day 1 is Tuesday 1 September 2026, so weekday index = h.day % 7 with Monday = 0.
   School-holiday windows are the SA 2026 inland calendar, approximate to the week. */
const WEEKEND = new Set([4, 5]);   // Friday and Saturday nights
export function weekdayOf(h) { return h.day % 7; }
export function weekdayName(h) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekdayOf(h)];
}
export function isWeekend(h) { return WEEKEND.has(weekdayOf(h)); }

/** SA school holidays, inland 2026, approximate. [fromMonthDay, toMonthDay] as numbers. */
const HOLIDAYS = [
  [1201, 113],   // summer: 1 Dec – 13 Jan (wraps the year)
  [320, 406],    // autumn
  [626, 720],    // winter
  [918, 1005],   // spring
];
export function isSchoolHoliday(date) {
  const md = date.month * 100 + date.day;
  return HOLIDAYS.some(([a, b]) => (a <= b ? md >= a && md <= b : md >= a || md <= b));
}
export function calendarFactor(h) {
  let f = 1;
  if (isWeekend(h)) f *= 1.4;
  if (isSchoolHoliday(h.date)) f *= 1.3;
  return f;
}

export function roadFactor(condition) {
  if (condition >= 70) return 1;
  if (condition >= 50) return 0.85;
  if (condition >= 30) return 0.6;
  return 0.25;
}

export function priceFactor(rate) {
  // H$850 a night is the anchor; guests stop coming well above it
  return clamp(1.2 - (rate - 850) / 1700, 0.35, 1.2);
}

/** Chance a unit is occupied on a given night. */
/** Who is travelling (L5, owner GO 2026-10-23). A rung knows its `capacity`, not its
 *  party — so the family, the privacy couple and the birders could not be told apart, and
 *  the narrative seat could not write a line that knew which one had arrived.
 *
 *  DERIVED, never drawn: a new draw in the booking path would shift the stream and move
 *  every golden. The unit and the day decide it, so the same night always has the same
 *  guest — which is also what makes a save replay identically.
 *
 *  An open pitch gets a family or a group of friends; a room or a cabin gets a couple or
 *  somebody on their own. Capacity is how many you can let, not who sleeps in it. */
export const PARTIES = ['solo', 'couple', 'family', 'friends'];
export function partyOf(h, unit) {
  const kind = (unit && unit.kind) || 'room';
  const hsh = (Math.imul(seedOf(String((unit && unit.id) || 'u0')), 2654435761)
    ^ Math.imul(((h && h.day) || 1) + ((h && h.nights) || 0), 2246822519)) >>> 0;
  const openPitch = kind === 'camp' || kind === 'caravan';
  return openPitch ? (hsh % 3 === 0 ? 'friends' : 'family')
    : (hsh % 3 === 0 ? 'solo' : 'couple');
}

export function occupancyChance(h, unit) {
  const def = ACCOM[unit.kind];
  // No water, no guests: an open plumbing fault closes the beds (handyman.js waterOut).
  if (waterOut(h)) return 0;
  // Snow brings the crowds UP the mountain (owner: snow days are busy season) — but only
  // while the road can take them. A snow day on a bad road is cancellations, not guests.
  const weather = h.weather && h.weather.kind;
  let snowFactor = 1;
  if (weather === 'snow') snowFactor = h.road.condition >= 50 ? 1.5 : 0.3;
  return clamp(
    BASE_OCCUPANCY * seasonFactor(h.date) * calendarFactor(h) * (h.rating / 4)
      * roadFactor(h.road.condition) * priceFactor(def.rate) * forestFactor(h)
      * mountainFactor(h) * (weather === 'snow' ? snowFactor : guestMult(h))
      // the player's own price against the market: greed empties the beds (priceDemand)
      * priceDemand((h.rates && h.rates[unit.kind]) || 1),
    0, 0.95,
  );
}

export function buildAccom(h, kind, x, y) {
  const def = ACCOM[kind];
  if (!def) return err('unknown building');
  if (def.only && def.only !== h.key) return err(`${def.label} is not available on this start`);
  // footprint validation (owner verdict 5): a MULTI-TILE site must hold its whole
  // footprint before a cent is charged. 1×1 rungs keep the historical single-cell
  // tolerance below — every golden trace and existing life builds them as before.
  const [fw, fh] = accomFootprint(kind);
  if (fw * fh > 1) {
    const place = canPlaceAccom(h, kind, x, y);
    if (!place.ok) return err(place.msg);
  }
  // TERRAIN-SPEC §6: walls stand on FLAT ground only. A SLOPE tile is the 45° ramp —
  // walkable, trackable, never buildable. The gate is CORNER-flat (tileFlat): no
  // touching tile higher, diagonals included. The old orthogonal steep() check let a
  // tile with a raised DIAGONAL through — the inside-corner case that renders as a
  // wedge under the building, which is exactly the "house floating" the owner saw.
  // Every tile of the footprint; what the player wants level, the bulldozer grades.
  if (h.plot && h.plot.level && fw * fh > 0) {
    const p = h.plot;
    for (let cx = x; cx < x + Math.max(1, fw); cx++) {
      for (let cy = y; cy < y + Math.max(1, fh); cy++) {
        if (!tileFlat(p, cx, cy)) {
          return err('too steep to build on — flatten it first');
        }
      }
    }
  }
  // lumber from the mill: a build absorbs its lumber need at a FLAT H$ a unit (LD-11,
  // owner GO 2026-10-22 — it used to be 30% of the build, which made the same wood worth
  // 12× more on the cabin than on a hive) IF the yard holds the units — otherwise full
  // price, as always.
  const need = def.lumber || 0;
  const lumber = lumberOff(def.cost, need, h.lumber || 0);
  // the driveway (PIVOT-PLAN §A3/A4): a unit far from the gate needs a road cut to it.
  // The clearing by the gate is cheap; a site deep in the scrub is not. Unless you have
  // already laid your own driveway to it (siteworks.js) — gravel OR mud (owner GO
  // 2026-10-21: mud is the unlock, track the upgrade) — then what you laid IS the
  // driveway and the surcharge is cancelled outright. A multi-tile site pays from its
  // CHEAPEST cell.
  const tracked = h.plot ? driveWithin(h.plot, x, y) : false;
  const surcharge = h.plot && !tracked ? accomSurcharge(h, kind, x, y) : 0;
  const cost = Math.round(lumber.cost) + surcharge;
  if (h.cash < cost) return err(`${def.label} costs ${money(cost)} — you have ${money(Math.round(h.cash))}`);
  if (h.accom.some((a) => a.x === x && a.y === y)) return err('something is already there');
  h.cash -= cost;
  if (lumber.used) h.lumber -= lumber.used;
  const unit = {
    id: 'a' + h.accom.length, kind, x, y,
    built: false, doneDay: h.day + def.buildDays,
    // the ladder rungs are built unlisted — listing is the player's decision (and the
    // mistake the review engine exists to punish). The old rungs keep letting as before.
    listed: !UNLISTED_ON_BUILD.has(kind),
  };
  h.accom.push(unit);
  const paidNote = lumber.used ? ` −${money(cost)} (mill lumber covered ${lumber.used} units, −${money(lumber.off)})` : ` −${money(cost)}`;
  h.log.push({ day: h.day, text: `${def.label} started. Ready in ${def.buildDays} days.${paidNote}` });
  // Owner live play 10-28: "nothing stops you placing camp site without ablution block".
  // The let-side gate exists (tickTourism hard-blocks a camp with no ablution, tests/33),
  // but it speaks only when the first guest is turned away. The buyer hears it at BUY
  // time now, while there is still money in the plan for the bathroom.
  if (kind === 'camp' && !h.facilities.ablution
      && !(h.facilityBuilds || []).some((b) => b.kind === 'ablution' && !b.built)) {
    h.log.push({ day: h.day, text: 'No ablution block yet — the camp will take no guests until it is built (H$12,000, under Farm).' });
  }
  if (surcharge > 0) {
    h.log.push({ day: h.day, text: `Driveway to the site: ${drivewayTiles(h.plot, x, y)} tiles from the gate, +${money(surcharge)}.` });
  } else if (tracked) {
    h.log.push({ day: h.day, text: `Track to the site: no driveway to cut, no surcharge.` });
  }
  // flat ground is the other half of the site cost: the blade has already been over it.
  if (h.plot && isFlat(h.plot, x, y)) {
    h.log.push({ day: h.day, text: `${def.label} on flat ground — no cut, no fill.` });
  }
  return ok('building started', { unit, cost, surcharge });
}

/**
 * Structural ceiling on road condition, by distance (LD-05, owner GO 2026-10-19): a long
 * gravel road is never perfect — dust, mist, a farm gate. The incomer's 0.4 km tops out
 * at 97; the homesteader's 4.4 km at 69, which is permanently below the "good road" band.
 * Distance must show in the income line, not only in the cost line.
 */
export function roadCeiling(h) {
  return clamp(Math.round(100 - (h.road.km || 0) * 7), 62, 100);
}

export function patchRoad(h) {
  const ceil = roadCeiling(h);
  if (h.road.condition >= ceil) {
    return err(`that is as good as this road gets — ${h.road.km} km of gravel has a ceiling of ${ceil}%`);
  }
  const cost = patchCost(h);
  if (h.cash < cost) return err(`a patch costs ${money(cost)} — you have ${money(Math.round(h.cash))}`);
  h.cash -= cost;
  h.road.condition = clamp(h.road.condition + PATCH_GAIN, 0, ceil);
  h.complaints = 0;
  h.log.push({ day: h.day, text: `Patched ${Math.min(2, h.road.km).toFixed(1)} km of road. −${money(cost)}` });
  return ok('road patched', { condition: h.road.condition, cost });
}

/**
 * One night. Called from homestead.endDay, before the date turns.
 * Returns the night's events.
 */
export function tickTourism(h) {
  initTourism(h);
  const events = [];
  let earned = 0;
  let nights = 0;
  let blocked = 0;

  // construction finishes
  for (const a of h.accom) {
    if (!a.built && h.day >= a.doneDay) {
      a.built = true;
      // a HOUSE takes no guests: capacity 0, never listed, it is where you live. The old
      // line announced it "ready for guests", which is the kind of sentence the player
      // believes (flagged by the narrative seat, bible §20.1, lead fix 10-23).
      events.push((ACCOM[a.kind].capacity || 0) > 0
        ? `${ACCOM[a.kind].label} is finished and ready for guests.`
        : `${ACCOM[a.kind].label} is finished. It takes no bookings — it is where you live.`);
    }
  }
  for (const b of h.facilityBuilds) {
    if (!b.built && h.day >= b.doneDay) {
      b.built = true;
      h.facilities[b.kind] = true;
      // VIS-02: the block the player paid H$12,000 for is a BUILDING, so it goes on the
      // plot the day it is finished — not a boolean in a card. Pushed straight into
      // `p.buildings` rather than through plotmap.build(), which prices a verb from
      // PRICES and would refuse a facility kind it has never heard of.
      if (b.x != null && h.plot && Array.isArray(h.plot.buildings)) {
        h.plot.buildings.push({ kind: b.kind, x: b.x, y: b.y, fw: b.fw || 1, fh: b.fh || 1 });
      }
      events.push(`${FACILITY[b.kind].label} is finished.`);
    }
  }

  // the road wears every day: geometry and weather, plus who drives it. Guest cars
  // do nothing; the company's trucks do a lot (cube law, owner ruling 2026-10-21).
  h.road.condition = clamp(h.road.condition - (roadDecay(h) + trafficWear(h)) * roadWearMult(h), 0, 100);

  // The arrival record (audio Request 2, lead 2026-10-23). `h.lastNights` cannot serve as an
  // arrival signal: this function overwrites it with TONIGHT's roll further down, so a page
  // reading it in the morning is reading tomorrow's traffic against today's road. This is the
  // traffic the tyre model actually spent, stamped with the condition it left behind — the
  // only honest trigger for a vehicle crossing the gate. No RNG, no balance: a record of a
  // number that already existed. Outside `snap()`, so no golden sees it.
  h.lastArrival = {
    day: h.day,
    cars: guestCars(h),
    trucks: trucksPerDay(h),
    road: Math.round(h.road.condition),
  };

  // the generator runs, and running costs. Charged after construction finishes, so a
  // generator that came ready today starts drinking today. No RNG: fuel is a bill.
  const fuel = generatorFuel(h);
  if (fuel > 0) {
    h.cash -= fuel;
    h.fuelSpend += fuel;
    h.fuelDays += 1;
  }

  // bookings. Closed = no lets, no reviews, no risk — but the buildings still stand.
  for (const a of h.accom) {
    if (!a.built) continue;
    if (!a.listed) continue;      // delisted: the pitch waits, the guest never comes
    if (!h.open) continue;        // closed for bookings

    // the gates, with teeth: an unready unit is ALLOWED to be listed, but the night
    // it cannot be let is a lost night, and the guest still has something to say.
    // The caravan's driveway need (owner GO 2026-10-21) is met by the facility OR by
    // any laid driveway — mud included (mud is the unlock, track the upgrade).
    const laid = h.plot ? driveWithin(h.plot, a.x, a.y) : false;
    if (a.kind === 'caravan' && isWet(h) && !h.facilities.driveway && !laid) {
      blocked += 1;
      h.complaints += 1;
      events.push('No caravan let tonight: "we got stuck at the gate and walked the last 400 metres".');
      continue;
    }
    if (a.kind === 'camp' && !h.facilities.ablution) {
      blocked += 1;
      h.complaints += 1;
      events.push('No camping let tonight: "guests are using the bush".');
      continue;
    }

    // the laid driveway can stick on a wet night (owner GO 2026-10-21): the mud share
    // sets the base, every slope tile under mud adds to it (siteworks.stuckChance).
    // The roll rides the household's own stream, so a reload replays the same nights.
    if (wetGround(h) && h.plot) {
      const access = driveAccess(h.plot, a.x, a.y);
      if (access.tiles > 0 && nextRandom(h) < stuckChance(access.share, access.mudSlope)) {
        blocked += 1;
        h.complaints += 1;
        events.push('No let tonight: "we got stuck in the mud at the gate".');
        continue;
      }
    }

    const p = occupancyChance(h, a);
    if (nextRandom(h) < p) {
      // who is travelling (L5, owner GO 2026-10-23). A rung knows its `capacity`, not its
      // party — so the family, the privacy couple and the birders were indistinguishable,
      // and the narrative seat could not write a line that knew which one had arrived.
      // Derived, not drawn: a new draw here would shift the booking stream and move every
      // golden. The unit and the day decide it, so the same night always has the same guest.
      const party = partyOf(h, a);
      a.party = party;
      h.lastParty = party;
      // the rate is the player's own: market × multiplier, carried by the reputation
      const gross = rateFor(h, a.kind);
      // a village housekeeper is paid per clean, only on nights you actually let
      const net = Math.round(gross * (1 - PLATFORM_FEE) - cleaningCost(h));
      h.cash += net;
      h.nights += 1;
      h.earned += net;
      earned += net;
      nights += 1;

      // winter hearths burn the household's wood (owner GO 2026-10-21): every winter
      // let night in a hearth house takes 0.05 loads. Fireplaces are implicit in the
      // rooms and cabins — guests cannot burn what the household never stacked.
      if (inFirewoodSeason(h.date) && a.kind !== 'camp') {
        h.firewood = Math.round(Math.max(0, (h.firewood || 0) - FIREWOOD.guestBurn) * 100) / 100;
      }

      // what they said about it
      const voice = recordVoice(h, a.id);
      if (voice.mood === 'bad') events.push(`"${voice.text}"`);
      decemberRegular(h, a.id, events);   // bible §5.8 — deterministic, no RNG

      // the review engine: every guest night, every rung. The night's state decides,
      // not a dice roll — so the complaint is reproducible from the state alone.
      const review = applyReview(h, a);
      if (review.score < 3.5) {
        // the guest's own sentence (bible §13, reviewQuotes.js); the engine's terse quote
        // is the fallback for the two factors the bank deliberately leaves alone. The
        // bank's lines are full sentences, so the trailing stop is trimmed rather than
        // doubled by the wrapper.
        const said = (guestReview(h, a, review) || review.quote).replace(/\.$/, '');
        events.push(`A guest left a bad review: "${said}".`);
      }
    }
  }

  if (nights) events.push(`${nights} night${nights === 1 ? '' : 's'} booked · +${money(earned)}`);
  h.lastNights = nights;   // tonight's guests are tomorrow morning's traffic
  return { earned, nights, blocked, events, fuel, occupancy: h.accom.filter((a) => a.built).length ? occupancyChance(h, h.accom.find((a) => a.built)) : 0 };
}

/**
 * The review lands on the average with inertia: a few hundredths a night. Bad reviews
 * do not kill you today — they kill you over a season. That is the point.
 */
export function applyReview(h, unit) {
  const review = reviewNight(h, unit);
  h.rating = clamp(h.rating + (review.score - h.rating) * 0.05, 1, 5);
  if (review.score < 3.5) h.complaints += 1;
  // the score the guest actually gave, kept for the morning (owner GO 2026-10-22, L2):
  // the UI needs a number to play a sound against, and the object used to be thrown away.
  // Lead fix 2026-10-23: this was OVERWRITTEN per unit-night, so a host with four units
  // kept whichever unit the loop reached last — a 4.6 could follow a 2.1 and the player
  // heard the good news. It is now the WORST night of the day, which is what the rating
  // inertia and the complaint count are already keyed to, and it carries the guest's own
  // quote so the number and the sentence cannot disagree.
  // Display-side only — `snap()` is a whitelist (day/cash/beds/goals...), so the golden
  // traces cannot see any of this and none of them moves.
  const kept = h.lastReview && h.lastReview.day === h.day ? h.lastReview : null;
  if (!kept || review.score < kept.score) {
    h.lastReview = {
      score: review.score,
      day: h.day,
      unit: (unit && unit.id) || null,
      kind: (unit && unit.kind) || null,
      quote: review.quote || null,
      worst: review.worst || null,
    };
  }
  return review;
}

/** What the HUD needs. */
export function tourismSummary(h) {
  const built = h.accom.filter((a) => a.built);
  const building = h.accom.filter((a) => !a.built);
  return {
    units: built.length,
    building: building.length,
    capacity: built.reduce((a, u) => a + ACCOM[u.kind].capacity, 0),
    rating: Math.round(h.rating * 100) / 100,
    road: Math.round(h.road.condition),
    roadCeil: roadCeiling(h),
    cleaner: !!h.cleaner,
    perClean: cleaningCost(h),
    weekday: weekdayName(h),
    schoolHoliday: isSchoolHoliday(h.date),
    roadKm: h.road.km,
    patchCost: patchCost(h),
    roadOk: h.road.condition >= 40,
    nights: h.nights,
    earned: Math.round(h.earned),
    complaints: h.complaints,
    open: !!h.open,
    listed: built.filter((a) => a.listed).length,
    facilities: { ...h.facilities },
    fuel: fuelSummary(h),
    facilityBuilds: h.facilityBuilds.filter((b) => !b.built).map((b) => ({
      kind: b.kind, label: FACILITY[b.kind].label, daysLeft: Math.max(0, b.doneDay - h.day),
    })),
    rateMult: ratingMult(h),
    // the HUD shows the player's rate with the competitor's beside it
    rates: Object.fromEntries(Object.keys(MARKET).map((k) => [k, rateFor(h, k)])),
    rateMults: { ...h.rates },
    market: { ...MARKET },
    weeds: Math.round(weedShare(h) * 100) / 100,
    tonight: built.length ? Math.round(occupancyChance(h, built[0]) * 100) : 0,
    nextReady: building.length ? Math.min(...building.map((a) => a.doneDay - h.day)) : null,
    voices: recentVoices(h, 5),
  };
}
