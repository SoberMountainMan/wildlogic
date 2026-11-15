// business.js -- the six lives a plot commits to (Hogsback Life Simulator, Slice 2).
//
// Slice 1 gave the household ownership: estate.js stores which ground is yours and
// which BUSINESS each plot runs, but that field was a label. This module gives the
// labels a spine, in the three shapes the steal-sheet (MASTER-PLAN.md) names:
//
//   1. IDENTITY  -- what the business produces, what it consumes, how often the
//      money lands, and the 2-3 visible needs it runs on (Two Point's guest needs:
//      what a stay wants is listed, not guessed).
//   2. DEMAND    -- one bar per business, Skylines-style: always visible, driven by
//      world state (season, weather, reputation, distance to the shop). The bar
//      HEIGHTS for farm/forestry/host are READS of the demand functions the sim
//      already runs and throws away (market.vegPrice, firewood.firewoodPrice +
//      the week's quota, tourism.SEASON / occupancyChance) -- LEVEL-DESIGN-LIFE-SIM-
//      BALANCE.md section 3 is the contract, including its refusals: a business the
//      ground cannot run gets NO bar, and a water-out or unlisted bed shows 0 with
//      the reason, never a low number that reads as "they do not want me".
//      The three businesses without a shipped economy yet (water-energy, trade,
//      eco) carry FIRST-PASS curves -- every number marked, for the level seat to
//      tune, none load-bearing for money yet.
//   3. SKILL     -- a per-business XP bar (Stardew): activity on the plot earns XP,
//      40 XP is the one concrete unlock each business has.
//
// Pure logic, no DOM, no RNG. Nothing here mutates a household: the needs preview
// reads the same state reviewNight() reads -- it must NOT call reviewNight itself,
// because the generator branch draws from h.rng, the shared bookings/voice/power
// stream. A HUD refresh cannot be allowed to move the sim's future.
//
// Golden-safe by construction: the canonical three never load an estate, so they
// never reach this module, and no field here lives inside h.

import { BUSINESSES } from './estate.js';
import { SHOP, vegPrice, honeyPrice } from './market.js';
import { FIREWOOD, firewoodPrice, inFirewoodSeason } from './firewood.js';
import { SEASON } from './tourism.js';
// The one water read, taken not re-derived. It runs initHandyman, which rebuilds the
// handyman's derived views: fine for the bars below (they call tourism.occupancyChance,
// which calls waterOut itself, so the page writes nothing this module adds), and the
// needs preview in section 4 reads the fault list directly instead -- see the note there.
import { waterOut } from './handyman.js';
import { WEATHER } from './weather.js';
import { money } from './fmt.js';   // the one money style in the game (U10), for the bar's caption

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;
const monthOf = (m) => {
  const n = Math.round(Number(m));
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : 9;   // day 1 of a life is September
};

/* ---- 1. identities ------------------------------------------------------------
   Data for the cards. `produces`/`consumes` name the shipped lanes the business
   lives on (HOGSBACK-LIFE-SIMULATOR.md section 4's table, promoted from prose);
   `needs` are the 2-3 visible inputs a plot must hold for the lane to pay. */

export const IDENTITIES = {
  farm: {
    produces: ['greens, herbs and potato from the beds', 'honey from the hives'],
    consumes: ['water — a dry plot cannot plant', 'bed slots: twelve solo, more with casuals'],
    cadence: 'a bed pays twelve days after the H$120; the cart to the shop is yours to time',
    needs: ['water for the beds', 'beds planted', 'the shop can still take it'],
  },
  host: {
    produces: ['guest-nights on the letting ladder', 'the reviews that make the next month'],
    consumes: ['the road treadmill once cars arrive', 'a cleaner, ablutions, the small things'],
    cadence: 'bookings land nightly; the money shows in the morning report',
    needs: ['a listed bed', 'a rating worth letting', 'the road guests judge you on'],
  },
  forestry: {
    produces: ['pine into lumber and poles', 'wattle and blackwood into winter firewood'],
    consumes: ['standing pine to mill', 'the pass: under 50 the weighbridge takes its cut'],
    cadence: 'cash from the mill and the yard; the village takes six loads a week at winter money',
    needs: ['standing pine or alien wood', 'the hearth reserve stays un-sold', 'a road the bakkie can take'],
  },
  'water-energy': {
    produces: ['surplus water to neighbours on dry ground', 'power through the storm nights'],
    consumes: ['a dam-site to fill from', 'the hardware first: tanks, lines, panels'],
    cadence: 'dry months pay best — May to August, when every tank on the mountain runs low',
    needs: ['dam-site ground', 'storage that stands', 'a line to the neighbours'],
  },
  trade: {
    produces: ['the stall: foot traffic, not a cart', 'better eyes for what the shop lacks'],
    consumes: ['proximity — the traffic walks, it does not drive', 'stock to put on the counter'],
    cadence: 'small and daily, best in the December crowds, worst when the weather keeps people home',
    needs: ['close to the shop', 'stock on the counter', 'weekend weather'],
  },
  eco: {
    produces: ['conservation guests: birders, walkers', 'the standing forest itself — grants follow'],
    consumes: ['indigenous forest to show', 'patience — no chainsaw on the pitch'],
    cadence: 'premium nights in the green months; the loerie only sings where the forest stands',
    needs: ['indigenous forest standing', 'the mountain forest share kept', 'reputation the village vouches for'],
  },
};

/* ---- 2. demand ----------------------------------------------------------------
   demandFor(key, w) -> { level 0..1, detail } | null.
   w = { month, weather, rep, km, water, forest, beds, units }  (fields optional;
   a bar is refused only when the field that proves "cannot run" is actually known.)
   Rules obeyed from the level note, section 3.3:
   - heights for farm/forestry/host READ the shipped functions, never re-derive;
   - no bar at all for a business the ground cannot run (rule 6);
   - winter timber and winter tourism are visibly OUT OF PHASE -- the curves above
     do it themselves (firewood May-Aug, SEASON troughs Jun-Jul), which is the
     plan-A/plan-B lesson, not a coincidence to flatten. */

/** The one-month price the shop pays for veg, against the December peak. */
function farmLevel(m) {
  return r2(vegPrice({ month: m }) / (SHOP.vegPrice * 1.3));
}

function farmDetail(m) {
  const hp = honeyPrice({ month: m });
  return `the village takes ${SHOP.vegCapacity} kg veg a day at ${money(vegPrice({ month: m }))}/kg`
    + (hp < SHOP.honeyPrice ? '; honey pays the low price in the cold months' : '');
}

function timberLevel(m) {
  return r2(firewoodPrice({ month: m }) / FIREWOOD.winterPrice);
}

function timberDetail(m) {
  // the shipped price table, printed with the shared money formatter -- the page must
  // not invent a currency style for a number the sim already owns
  return inFirewoodSeason({ month: m })
    ? `winter money — ${FIREWOOD.weekCap} loads a week at ${money(FIREWOOD.winterPrice)}`
    : `off-season: the village lights up at ${money(FIREWOOD.offSeasonPrice)} a load`;
}

/** The mountain's own tourism curve, as a 0..1 height for month m.
 *  A weather override on the PLOT reads occupancyChance instead (unitDemand) --
 *  this month-shape is what a portfolio card can honestly claim. */
function hostLevel(m, weather, rep) {
  let level = (SEASON[m] || 1) / 2.0;                 // December peaks at 1.00
  if (weather && WEATHER[weather]) level *= WEATHER[weather].guestMult;
  level *= 1 + clamp(rep || 0, -20, 20) / 200;        // FIRST PASS: rep tilt, +-10% band
  return r2(clamp(level, 0, 1));
}

/* FIRST-PASS curves -- no shipped economy reads behind these yet. Every number is
   a tuning proposal for the owner and the level seat, not a measurement. */
function waterLevel(m, weather, unlocked) {
  let level = 0.40
    + (m >= 5 && m <= 8 ? 0.35 : 0)                  // the dry months: every neighbour's tank runs low
    + (weather === 'storm' ? 0.15 : 0)               // and the grid drops -- the power half of the lane
    + (unlocked ? 0.10 : 0);                         // unlock: a name for the tap
  return r2(clamp(level, 0, 0.95));
}

function tradeLevel(m, weather, km, unlocked) {
  const k = Number.isFinite(km) ? km : 2.5;          // no distance read: the valley's middle
  let level = clamp(1.1 - 0.22 * k, 0.25, 1.0)       // foot traffic walks, it does not drive
    + (m === 12 || m <= 2 ? 0.12 : 0)                // the December crowds
    + (weather === 'storm' ? -0.12 : weather === 'rain' ? -0.05 : weather === 'snow' ? -0.18 : 0)
    + (unlocked ? 0.05 : 0);                         // unlock: the stall's stand
  return r2(clamp(level, 0, 0.95));
}

function ecoLevel(m, weather, rep, unlocked) {
  let level = 0.50
    + (m >= 9 && m <= 11 ? 0.20 : (m === 3 || m === 4) ? 0.10 : 0)   // the green months
    + (m === 6 || m === 7 ? -0.20 : 0)                               // dead of winter
    + (weather === 'mist' ? 0.10 : 0)                                // birders love a misty morning
    + (unlocked ? clamp(rep || 0, 0, 20) / 100 : 0);                 // unlock: the village vouches
  return r2(clamp(level, 0, 0.9));
}

/**
 * The bar for one business against one world reading. null means SHOW NO BAR:
 * the ground cannot run that lane (level note rule 6 -- "a bar that promises a
 * lane the plot cannot pay is worse than no bar"). Unknown fields never refuse:
 * a valley card knows the ground, the plot header knows the household; each
 * passes what it has.
 */
export function demandFor(key, w = {}, opts = {}) {
  if (!IDENTITIES[key]) return null;
  const m = monthOf(w.month);
  const unlocked = !!opts.unlocked;
  const has = (v) => v !== null && v !== undefined;

  switch (key) {
    case 'farm': {
      if (has(w.water) && w.water === 'none') return null;          // nothing to water beds with
      if (has(w.beds) && w.beds === 0) return null;                 // no produce bar before there is a bed
      return { level: farmLevel(m), detail: farmDetail(m) };
    }
    case 'forestry': {
      if (has(w.forest) && w.forest !== 'pine' && w.forest !== 'mixed') return null;
      return { level: timberLevel(m), detail: timberDetail(m) };
    }
    case 'host': {
      if (has(w.units) && w.units === 0) return null;               // no rung to let, no bar
      const level = hostLevel(m, w.weather, w.rep);
      return { level, detail: `${(level * 100).toFixed(0)}% of the December peak, this month` };
    }
    case 'water-energy': {
      if (has(w.water) && w.water !== 'dam-site') return null;
      return { level: waterLevel(m, w.weather, unlocked), detail: 'first pass — dry months and storm nights' };
    }
    case 'trade': {
      return { level: tradeLevel(m, w.weather, w.km, unlocked), detail: 'first pass — foot traffic, weather, distance' };
    }
    case 'eco': {
      if (has(w.forest) && w.forest !== 'indigenous' && w.forest !== 'mixed') return null;
      return { level: ecoLevel(m, w.weather, w.rep, unlocked), detail: 'first pass — the green months pay' };
    }
    default:
      return null;
  }
}

/** The valley header's three bars: the mountain's mood this month, no ground needed.
 *  farm/forestry/host are the shipped lanes the owner can actually sell into. */
export function mountainDemand(w = {}) {
  const m = monthOf(w.month);
  const host = hostLevel(m, w.weather, w.rep);
  return [
    { key: 'farm', label: BUSINESSES.farm, level: farmLevel(m), detail: farmDetail(m) },
    { key: 'forestry', label: BUSINESSES.forestry, level: timberLevel(m), detail: timberDetail(m) },
    // the same SEASON curve the bar is built from, in words -- the header already prints
    // the percent, so a second number there would only repeat the meter
    { key: 'host', label: BUSINESSES.host, level: host, detail: hostSeasonWord(host) },
  ];
}

/** What the mountain's letting season is doing this month, from the shipped SEASON curve. */
function hostSeasonWord(level) {
  return level >= 0.8 ? 'the letting season' : level >= 0.45 ? 'a normal season' : 'the quiet months';
}

/** The plot's live tourism read for ONE unit -- the occupancyChance the level note
 *  says to surface, with its two refusal labels (rules 2 and 3): no water and
 *  unlisted are ZERO with a reason, never a low number that blames the guests.
 *  `tourism` is the module's occupancyChance passed in by the page -- business.js
 *  does not import tourism (the pages already load both; keeping this a read
 *  argument keeps the dependency graph flat and the function testable standalone). */
export function unitDemand(h, unit, occupancyChance) {
  if (!h || !unit) return null;
  if (waterOut(h)) return { level: 0, label: 'no water' };
  if (!unit.listed) return { level: 0, label: 'unlisted' };
  if (typeof occupancyChance !== 'function') return null;
  return { level: r2(clamp(occupancyChance(h, unit) / 0.95, 0, 1)), label: null };
}

/* ---- 3. skill -------------------------------------------------------------------
   Activity on a plot lands XP on the estate's owned entry (never on h -- snap()
   must not see any of this). One threshold, one concrete unlock per business. */

export const XP_MAX = 40;

export const SKILLS = {
  farm:           { at: XP_MAX, name: "the shop's regular", says: 'the alarm names the excess — the bar tells you before the cart does' },
  host:           { at: XP_MAX, name: "tonight's needs radar", says: 'every listed bed shows what its guests want, before the night falls' },
  forestry:       { at: XP_MAX, name: "the week's quota", says: 'the winter bar draws its six segments and fills down as loads sell' },
  'water-energy': { at: XP_MAX, name: 'a name for the tap', says: 'neighbours ask you first — demand +0.10 (first pass)' },
  trade:          { at: XP_MAX, name: "the stall's stand", says: 'a counter the village knows — demand +0.05 (first pass)' },
  eco:            { at: XP_MAX, name: 'the village vouches', says: 'the grant line opens — reputation lifts eco demand (first pass)' },
};

export function levelUnlocked(entry) {
  const k = entry && entry.business;
  return !!(k && SKILLS[k] && Number(entry.xp) >= SKILLS[k].at);
}

/** The bar's fill 0..1 and the line under it, for either page to render. */
export function skillLine(entry) {
  const k = entry && entry.business;
  const skill = k && SKILLS[k];
  if (!skill) return null;
  const xp = clamp(Math.round(Number(entry.xp) || 0), 0, skill.at);
  return {
    key: k,
    xp,
    at: skill.at,
    pct: r2(xp / skill.at),
    unlocked: xp >= skill.at,
    name: skill.name,
    says: skill.says,
  };
}

/** Write XP onto the estate entry the household owns. Clamped; returns the new XP
 *  or null when the household/entry is missing -- callers cannot corrupt the estate. */
export function gainXp(e, siteId, n) {
  if (!e || !Array.isArray(e.owned)) return null;
  const entry = e.owned.find((o) => o.siteId === siteId);
  if (!entry) return null;
  const add = Math.round(Number(n) || 0);
  entry.xp = clamp((Number(entry.xp) || 0) + add, 0, XP_MAX);
  return entry.xp;
}

/* The gain rules -- one observable action each, deliberately small and first-pass.
   XP is earned by DOING the business; nothing here moves money or a sim field. */

/** After a night: the host lane counts guests slept; water-energy counts storms
 *  ridden; eco counts the forest that still sings. */
export function xpNight(key, h, report) {
  if (!key || !h) return 0;
  switch (key) {
    case 'host':
      return 2 * (report && report.nights ? report.nights : 0);
    case 'water-energy': {
      const bad = h.weather && (h.weather.kind === 'storm' || h.weather.kind === 'snow' || h.weather.kind === 'cold');
      return bad && !h.ended ? 1 : 0;
    }
    case 'eco': {
      // the loerie rides the standing-forest praise pool -- its day is the eco lane's day
      const sung = (h.log || []).some((l) => l.day === h.day && l.event === 'loerie');
      return sung ? 1 : 0;
    }
    default:
      return 0;
  }
}

/** After a trip to the shop: the farm lane counts kilos, the trade lane counts trips
 *  made from ground that is actually near the counter. */
export function xpSale(key, h, res) {
  if (!key || !h || !res || !res.ok) return 0;
  const veg = Number(res.veg) || 0;
  const honey = Number(res.honey) || 0;
  switch (key) {
    case 'farm':
      return clamp(Math.round(veg / 5 + honey), 0, 6);
    case 'trade': {
      const km = (h.plot && h.plot.kmFromShop) || 0;
      return km <= 2.5 ? 2 : 0;
    }
    default:
      return 0;
  }
}

/** After a felled stem: forestry counts millable and burnable wood. Indigenous
 *  pays a fine, not XP -- the sim's own rule, kept. */
export function xpFell(key, res) {
  if (key !== 'forestry' || !res || !res.ok) return 0;
  return res.kind === 'indigenous' ? 0 : 1;
}

/* ---- 4. guest needs -------------------------------------------------------------
   The review engine (tourism.reviewNight) already scores what a guest met, per
   factor. These reads mirror the SAME state checks -- deliberately not a call to
   reviewNight: the generator branch draws h.rng, the shared bookings/voice/power
   stream, and a HUD refresh must not be able to move the sim's future. The bar
   and the money cannot drift here because nothing is recomputed that the sim
   numbers; only yes/no states are read. */

/** The need labels a review answers with, keyed by the engine's own penalty keys
 *  (PENALTY_* in tourism.js -- no parallel vocabulary, the reviewQuotes contract). */
export const NEED_OF = {
  road: 'a drive they could take',
  roadBad: 'a drive they could take',
  mud: 'not to get stuck at the gate',
  driveway: 'not to get stuck at the gate',
  cold: 'warmth',
  firewood: 'a fire laid',
  ablution: 'a bathroom',
  cleaning: 'linen that had been changed',
  braai: 'a braai',
  wifi: 'wifi',
  power: 'lights that stayed on',
  noise: 'quiet at night',
  weeds: 'a garden kept',
  value: "what they paid to be worth",
  repair: 'a place that worked',
  oak: 'the big oak standing',
};

const MID_RUNGS = new Set(['camp', 'caravan']);

/**
 * What tonight's guest wants, and whether the plot meets it. Pure.
 * `unit` is an ACCOM entry; power is shown as the BACKUP STATE, not tonight's
 * roll -- the preview cannot know the storm's coin, and saying so is honest.
 * @param {object} h household
 * @param {object} unit the rung
 * @param {number} weed the plot's weed share (tourism.weedShare -- passed in, so
 *        this module never scans the forest itself and cannot disturb a seed)
 */
export function guestNeeds(h, unit, weed = 0) {
  if (!h || !unit) return [];
  const f = h.facilities || {};
  const kind = unit.kind;
  const camp = kind === 'camp';
  const wet = !!(h.weather && (h.weather.kind === 'rain' || h.weather.kind === 'storm'));   // tourism's isWet, mirrored
  const m = h.date ? h.date.month : 9;
  const hearthCold = (m >= 5 && m <= 7 && !camp && !f.fire) || (m >= 5 && m <= 8 && !camp && !((h.firewood || 0) > 0));
  const rate = (h.rates && h.rates[kind]) || 1;
  const overdue = !!(h.nights > 0 && (h.repairs || []).some((j) => h.day > j.deadline));
  const powerBad = !!(h.weather && (h.weather.kind === 'storm' || h.weather.kind === 'snow'));
  return [
    { key: 'road', ask: 'the drive in', ok: (h.road ? h.road.condition : 0) >= 40 },
    { key: 'warmth', ask: 'warm at night', ok: !hearthCold },
    // Plumbing is the sim's one water-off fault (handyman.waterOut). Read here rather than
    // called: waterOut runs initHandyman, which rebuilds the HUD's derived views -- a
    // preview of tonight must not write to the household. tests/56 pins this line against
    // waterOut itself, so the two cannot drift apart.
    { key: 'water', ask: 'showers running', ok: !(h.repairs || []).some((j) => j.fault === 'plumbing') },
    { key: 'bath', ask: 'a bathroom', ok: !MID_RUNGS.has(kind) || !!f.ablution },
    { key: 'clean', ask: 'changed linen', ok: !!h.cleaner },
    { key: 'braai', ask: 'a braai', ok: !!f.braai },
    { key: 'wifi', ask: 'a signal', ok: !!f.wifi },
    { key: 'power', ask: 'lights in a storm', ok: f.power ? true : f.generator ? !powerBad : !powerBad, risk: !f.power && powerBad },
    { key: 'work', ask: 'nothing broken', ok: !overdue },
    { key: 'garden', ask: 'the garden kept', ok: weed <= 0.15 },
    { key: 'price', ask: 'a fair rate', ok: rate <= 1.15 },
    { key: 'dry', ask: 'a dry arrival', ok: !(wet && !f.driveway) },
  ];
}

/** The met-count line a review reads as: Two Point's score screen, in one line. */
export function needsScore(needs) {
  const met = needs.filter((n) => n.ok).length;
  return { met, total: needs.length, unmet: needs.filter((n) => !n.ok) };
}

/** The one sentence under a review: what the guest wanted that the night did not give.
 *  Reads h.lastReview (the engine's own record: score, quote, worst key). */
export function reviewNeeds(review) {
  if (!review) return null;
  const want = NEED_OF[review.worst];
  if (!want) return { good: true, line: 'nothing they could name — the needs were met' };
  return { good: false, line: `what they wanted: ${want}` };
}

/* ---- 5. the plot's own inputs -----------------------------------------------------
   The identity's visible needs/inputs, evaluated against the household -- every
   fact is a read of summary(h) (which already carries waterOk, the shop appetite,
   the firewood week, the tourism state), so no new math and no forest scan here. */

/** @param s summary(h) (homestead.js) -- the shipped HUD read. */
export function inputs(key, h, s) {
  if (!IDENTITIES[key] || !h || !s) return [];
  const need = (i, ask, ok, says) => ({ i, ask, ok, says });
  switch (key) {
    case 'farm':
      return [
        need(0, IDENTITIES.farm.needs[0], !!s.water, s.water ? 'water ok' : 'no water to plant on'),
        need(1, IDENTITIES.farm.needs[1], (s.beds || 0) > 0, `${s.beds || 0} bed${(s.beds || 0) === 1 ? '' : 's'}`),
        need(2, IDENTITIES.farm.needs[2], (s.produce || 0) <= s.shop.veg, `${s.produce} of ${s.shop.veg} kg`),
      ];
    case 'host':
      return [
        need(0, IDENTITIES.host.needs[0], (s.tourism.units || 0) > 0, `${s.tourism.units} unit${s.tourism.units === 1 ? '' : 's'}`),
        need(1, IDENTITIES.host.needs[1], s.tourism.rating >= 3.5, `★${s.tourism.rating.toFixed(2)}`),
        need(2, IDENTITIES.host.needs[2], s.tourism.roadOk, `road ${s.tourism.road}%`),
      ];
    case 'forestry':
      return [
        need(0, IDENTITIES.forestry.needs[0], (h.lumber || 0) > 0 || (s.trees || 0) > 0, `${s.trees} standing · ${s.poles} sawn`),
        need(1, IDENTITIES.forestry.needs[1], (h.firewood || 0) >= s.firewoodReserve.total, `stack ${s.firewood} of ${s.firewoodReserve.total} loads kept`),
        need(2, IDENTITIES.forestry.needs[2], s.tourism.road >= 50, `road ${s.tourism.road}% · the pass cuts under 50`),
      ];
    case 'water-energy': {
      const stream = !!(h.water && h.water.stream);
      const tank = !!(h.water && h.water.tank);
      const fac = h.facilities || {};
      return [
        need(0, IDENTITIES['water-energy'].needs[0], h.plot && h.plot.water === 'dam-site',
          h.plot && h.plot.water === 'dam-site' ? 'a dam above you' : 'no dam-site on this ground'),
        // summary.tank is null on a stream plot -- the stream IS the storage (homestead.js)
        need(1, IDENTITIES['water-energy'].needs[1], stream || tank,
          stream ? 'a stream that never runs dry' : tank && s.tank ? `tank ${s.tank.pct}%` : 'no storage yet'),
        need(2, IDENTITIES['water-energy'].needs[2], !!(fac.power || fac.generator),
          fac.power ? 'solar on the line' : fac.generator ? 'a generator' : 'nothing on the line yet'),
      ];
    }
    case 'trade':
      return [
        need(0, IDENTITIES.trade.needs[0], (h.plot ? h.plot.kmFromShop : 9) <= 2.5, `${h.plot ? h.plot.kmFromShop : '?'} km to the counter`),
        need(1, IDENTITIES.trade.needs[1], (s.produce || 0) + (s.honey || 0) > 0, `${s.produce} kg + ${s.honey} kg on the cart`),
        need(2, IDENTITIES.trade.needs[2], !(s.weather && (s.weather.kind === 'storm' || s.weather.kind === 'snow')), s.weather ? s.weather.label : '—'),
      ];
    case 'eco':
      return [
        need(0, IDENTITIES.eco.needs[0], (s.company && s.company.mountainForest >= 40), `${s.trees} stems standing`),
        need(1, IDENTITIES.eco.needs[1], (s.company && s.company.mountainForest || 0) >= 60, s.company ? `the mountain is ${s.company.mountainForest}% forest` : '—'),
        need(2, IDENTITIES.eco.needs[2], s.tourism.rating >= 4.0, `★${s.tourism.rating.toFixed(2)}`),
      ];
    default:
      return [];
  }
}
