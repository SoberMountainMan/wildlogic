// homestead.js — one plot, one household, one month at a time.
//
// Tier 1 of the redesign: you arrive, you have almost no money, and every month the
// bills arrive whether or not you have earned anything. Pure logic, no DOM.
//
// Deliberately NOT wired into sim/state.js yet. The old 24-plot tycoon sim still backs
// the 133-test gate; this is the new game growing beside it until it replaces it.

import { makePlot, startPlan, PRICES, fellTree, tileFlat } from './plotmap.js';
import { initTourism, tickTourism, tourismSummary, flushFuel, FACILITY } from './tourism.js';
import { initCompany, companySummary, tickCompany, maybeOfferContract, noteFelled } from './company.js';
import { quote, appetite, SHOP } from './market.js';
import { rollWeather, livingExtra, cropMult, weatherLine } from './weather.js';
import { initSubsidy, maybeOffer, tickSubsidy, settleSubsidy, subsidySummary } from './subsidy.js';
import { initBank, bankSummary, restructure } from './bank.js';
import { initDirector, tickDirector, directorSummary } from './director.js';
import { tickWildlife } from './wildlife.js';
import { tickGrapevine } from './grapevine.js';
import { initHolding, holdingSummary, expand } from './holding.js';
import { initLegacy, tickLegacy, legacySummary } from './legacy.js';
import { initGoals, tickGoals, goalSummary } from './goals.js';
import { addFirewood, burnFirewood, firewoodPrice, inFirewoodSeason, FIREWOOD, firewoodReserve,
  firewoodWeekLeft, POLES, polesNet, lumberOff } from './firewood.js';
import { maybeFamilyNote } from './familyVoice.js';
import { pushArrivalNotes, tickArrival, coldHouseLine } from './arrivalVoice.js';   // bible §18 — the day-one opening, §20 — the roof and the first week
// bible §16.4 — the village's voice. Imported for its registration: the module installs
// itself on the director's flavour seam (L9) once, at import, so the hook is live for every
// household and a test can still reach "no hook registered" by clearing it.
import './grapevine.js';
import { tickHandyman, maybeBreak } from './handyman.js';
import { tickWater } from './siteworks.js';
import { money } from './fmt.js';   // the sim's one money formatter (leaf module, imports nothing)

export const MONTH_DAYS = 30;          // simple months; the calendar is not the point
export const START_DATE = { year: 2026, month: 9, day: 1 };  // 1 September, before the season
export const LIVING_PER_DAY = 180;     // food, paraffin, the bakkie
export const FUEL_PER_TRIP = 20;       // one trip to the shop

export const BILLS = {
  water: { label: 'Municipal water', zar: 450 },
  eskom: { label: 'Eskom', zar: 1100 },
  rates: { label: 'Rates', zar: 400 },
};

// FARMING-SPEC Part 2 — one crop meant planting was not a decision. Three crops with
// different rate-vs-patience make it one. Numbers are the owner-approved proposal table.
// `yield` is gross Hogsbucks at the shop's H$10/kg (so potato 760 = 76 kg), exactly as the
// old BED.yield was. The decision is real because the RATES differ: potato pays most per
// day but ties up the bed and your cash; greens pay least but land before the 1st. Winter
// `cropMult` halves the harvest for all three, so a potato planted into April is a mistake
// the player can now make and learn from.
export const CROPS = {
  greens: { label: 'Greens', growDays: 12, cost: 120, yield: 250 },  // fast, cash-flow, +130
  herbs:  { label: 'Herbs',  growDays: 20, cost: 160, yield: 460 },  // the middle, +300
  potato: { label: 'Potato', growDays: 32, cost: 200, yield: 760 },  // best rate, bed gone a month, +560
};
// The crop a bed grows when the caller does not say. Greens: the broke player's crop, and
// the closest to what a "just plant a bed" verb always meant. `BED` stays exported as the
// default crop's row so every existing reference (plot.html, the goal hint, tests/15) keeps
// resolving — the choice is additive, not a rename of the whole mechanic.
export const DEFAULT_CROP = 'greens';
export const BED = CROPS[DEFAULT_CROP];
// You can only tend so many beds yourself. Hiring is the first real growth lever.
// You can tend 12 beds yourself. Beyond that, labour is hired THE WAY IT ACTUALLY WORKS
// HERE: a casual for the day, on harvest days — never a permanent wage. Owner rule
// (2026-10-19): there is a minimum wage; the daily rate never goes below H$180.
export const LABOUR = { bedSlots: 12, perWorker: 6, wagePerDay: 180 };
export const HIVE = { cost: 2800, honeyPerDay: 0.25, pricePerKg: 150, lumber: 2 };
export const TANK = { cost: 4600, delivery: 800, lumber: 4 };
// Lumber (new): felled pine saws into h.lumber units. A build that defines a lumber
// need costs 30% less cash when the shed covers it — you did the sawmill work yourself.
// Needs here: tank 4, hive 2. (Accommodation needs — room 6, spare 4, cabin 12 — live
// in tourism.js ACCOM; that file is out of bounds for this change, wiring pending.)
export const WATER = {
  capL: 5000, usePerDay: 150,          // a full tank is ~33 clear days
  refill: { clear: 0, mist: 120, rain: 400, storm: 1600, cold: 0, snow: 200 },
  deathDays: 3,                        // no water for three days and this life is over
  deliveryCost: 400, deliveryL: 2500,  // a neighbour with a bakkie, for when the tank runs dry
};
export const FOOD = { eatKg: 2, shopPerKg: 35 };   // eat from the plot, or the shop feeds you at H$70/day

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

/** Honey only flows in the warm months. Hogsback winters are cold and wet. */
export function inHoneySeason(date) {
  return date.month >= 9 || date.month <= 4;
}

export function dateLabel(d) { return `${d.day} ${MONTH_NAMES[d.month - 1]}`; }

/** What this household owes on the 1st, given what it is connected to. */
export function monthlyBills(h) {
  const items = [];
  if (h.services.water) items.push({ key: 'water', ...BILLS.water });
  if (h.services.eskom) items.push({ key: 'eskom', ...BILLS.eskom });
  items.push({ key: 'rates', ...BILLS.rates });
  // the wifi line is a rental, not a build: H$400 a month while it is in
  if (h.facilities && h.facilities.wifi) {
    items.push({ key: 'wifi', label: 'Wifi line', zar: FACILITY.wifi.monthly });
  }
  if (h.bond.monthly > 0) items.push({ key: 'bond', label: 'Bond', zar: h.bond.monthly });
  return { items, total: items.reduce((a, b) => a + b.zar, 0) };
}

/** A fresh household from one of the three lives.
 *  @param {object} option the START_OPTIONS entry
 *  @param {object|null} plan a precomputed startPlan
 *  @param {number|null} [gameSeed] pin the tree layer (tests, golden replays). A real new
 *    game draws one — the bush varies per new game (owner, 2026-10-21), the save carries
 *    the seed so it replays identically forever. */
export function newHomestead(option, plan = null, gameSeed = null) {
  const p = plan || startPlan(option.plot, option.mode);
  const seed = gameSeed == null
    ? ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0)   // a new game, a new bush
    : gameSeed >>> 0;
  const plot = makePlot(option.plot, seed);
  plot.paid = p.upFront;
  const h = {
    version: 2,
    key: option.key,
    name: option.name,
    groundLabel: option.groundLabel || null,   // the screen name; `plot.id` is a seed, not a label
    gameSeed: seed,      // the tree layer's seed — stored, so a save replays its own bush
    date: { ...START_DATE },
    day: 1,
    cash: p.cashLeft,
    bond: { principal: p.bond, monthly: p.monthly },
    services: {
      // the far plot has no municipal connection — that is why it was cheap
      water: option.key !== 'homesteader',
      eskom: true,
    },
    water: { tank: false, stream: option.plot.water === 'stream', store: 0, thirst: 0 },
    arrears: 0,
    missedMonths: 0,
    plot,
    beds: [],
    hives: [],
    labourToday: 0,      // extra harvest capacity bought today (casuals), reset nightly
    casualsHired: 0,     // lifetime count — the goals card ticks off the first one
    firewood: 0,         // loads stacked from felling, sold through the winter
    coldHouseNights: 0,  // cold-month nights with an empty stack (the paraffin bill)
    // the animals (wildlife.js): the day each last paid a visit, and whether the
    // dug dam has been found yet. Plain counters, so a save replays identically.
    wildlife: { baboon: 0, samango: 0, snake: 0, wetland: false },
    lostDay: 0,          // a snake day: harvest() refuses while this is today
    forestPenalty: 0,    // extra forest% lost to native/oak felling (3x a pine cut)
    naidooWarned: false, // Naidoo's one-time line on the first native cut
    oakCut: false,       // the village noticed the first oak down — the reviews remember
    lumber: 0,           // pine sawn into building timber — discounts builds that need it
    produce: 0,          // kg of vegetables waiting for a trip to the shop
    honey: 0,            // kg
    log: [],
    ended: null,
    lastBill: null,
  };
  initTourism(h);
  initCompany(h);
  initSubsidy(h);
  initBank(h);
  initDirector(h);
  initHolding(h);
  initLegacy(h);
  initGoals(h);
  rollWeather(h);
  // the first sentence of the game. It printed `H$243520` while start.html printed
  // `H$243 520` — two money styles in one minute of play (fmt.js, lead 10-23).
  note(h, `${option.name}: ${dateLabel(h.date)}, ${money(h.cash)} in hand.`);
  // bible §18: the mountain's opening beat. Log-only (snap() excludes h.log, so the
  // goldens cannot move), read entirely off the state above, and it touches no field.
  pushArrivalNotes(h, monthlyBills(h));
  if (h.bond.monthly) note(h, `The bond is ${money(h.bond.monthly)} on the 1st of every month.`);
  if (!h.services.water) note(h, 'No municipal water here. You last three days without it — build a tank first.');
  tickGoals(h);   // a plot with a stream already has water; do not tell the player otherwise
  return h;
}

/**
 * One log line. The optional `event` name is the shared trigger the audio and narrative
 * seats key their cues to (bible §17.6 — one name per state event, so a sentence and a
 * sound can never disagree about what happened). `wildlife.js` already pushes entries like
 * this; until now it was the only module that could, which is why the chainsaw line Naidoo
 * has been saying since 10-21 had no sound attached to it. `h.log` is outside `snap()`, so
 * neither the text nor the event can move a golden trace.
 */
function note(h, text, event = null) {
  const entry = { day: h.day, date: dateLabel(h.date), text };
  if (event) entry.event = event;
  h.log.push(entry);
  if (h.log.length > 200) h.log.shift();
}

/** Water comes from a stream (never dry) or a tank (drinks, refills with the weather,
 *  and when it is empty the countdown starts: three days, then this life is over). */
export function waterOk(h) {
  return h.water.stream || (h.water.tank && h.water.store > 0);
}

/* ---------------- actions ---------------- */

/** First free, dry, flat, clear 1x1 tile for a yard building (the tank), spiralling out
 *  from the plot's middle. Deterministic; null when no such tile exists. The same shape
 *  as tourism's freeFacilityTile, local because homestead cannot import tourism (the
 *  sim's no-cycle rule). */
function freeYardTile(h) {
  const p = h.plot;
  if (!p || !p.ground) return null;
  const ax = Math.floor(p.w / 2), ay = Math.floor(p.h / 2);
  const taken = new Set();
  for (const b of p.buildings || []) taken.add(b.x + ',' + b.y);
  for (const t of p.trees || []) taken.add(t.x + ',' + t.y);
  for (const b of h.beds || []) taken.add(b.x + ',' + b.y);
  for (const v of h.hives || []) taken.add(v.x + ',' + v.y);
  for (const f of p.fence || []) taken.add(f.x + ',' + f.y);
  const free = (x, y) => x >= 1 && y >= 1 && x < p.w - 1 && y < p.h - 1
    && p.ground[y * p.w + x] !== 'water' && p.ground[y * p.w + x] !== 'rock'
    && !taken.has(x + ',' + y) && tileFlat(p, x, y);
  const R = Math.max(p.w, p.h);
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

export function buildTank(h) {
  if (h.water.tank) return err('you already have a tank');
  const base = TANK.cost + TANK.delivery;
  // LD-11 (owner GO 2026-10-22): flat H$ a unit, never a percentage — see firewood.js.
  const lumber = lumberOff(base, TANK.lumber, h.lumber || 0);
  const cost = Math.round(lumber.cost);
  if (h.cash < cost) return err(`the tank costs ${money(cost)} — you have ${money(Math.round(h.cash))}`);
  if (lumber.used) h.lumber -= lumber.used;
  h.cash -= cost;
  h.water.tank = true;
  h.water.store = WATER.capL;          // the delivery includes a fill
  h.water.thirst = 0;                  // a full tank is water, same as a delivery
  // Owner live play 10-28: "cant see water tank or how to place it". The tank was a
  // boolean — the painted sprite and the renderer's tank5000 path have existed since
  // T15, but the sim never stood one up, so H$5,400 bought nothing the eye could find.
  // The delivery now stands the tank in the yard: first free, dry, flat, clear tile
  // from the plot's middle. plot.buildings is outside snap()'s whitelist, so no golden
  // moves (the scripts buy the tank; only the ground record changes).
  const site = freeYardTile(h);
  if (site) h.plot.buildings.push({ kind: 'tank5000', x: site.x, y: site.y });
  note(h, (lumber.used
    ? `Bought a 5 000 L tank — your own pine lumber took ${money(lumber.off)} off the cash. −${money(cost)}`
    : `Bought a 5 000 L tank and paid the delivery. −${money(cost)}`)
    + (site ? ' It stands in the yard.' : ' The yard has no clear flat tile, so it works from behind the scenes.'));
  // BUG-007 (playtest 10-26): the WHAT NOW card only refreshed on End Day, so buying the
  // tank cleared the alarm but left "Get water onto the plot" unchecked until the player
  // spent a day they did not have to spend. tickGoals is idempotent (skips done, no RNG) and
  // writes only to h.goals.done and the log — neither in snap(), so no golden moves. The same
  // one-line refresh goes at the end of every verb that satisfies a goal immediately.
  tickGoals(h);
  return ok('tank built', { cost, lumberUsed: lumber.used, site });
}

/** Emergency water: a neighbour with a bakkie and a jojo on the back. */
export function buyWater(h) {
  if (h.water.stream) return err('the stream does the job');
  if (!h.water.tank) return err('nowhere to put it — build a tank first');
  if (h.cash < WATER.deliveryCost) return err(`water costs ${money(WATER.deliveryCost)} — you have ${money(Math.round(h.cash))}`);
  h.cash -= WATER.deliveryCost;
  const wasDry = h.water.store <= 0;
  h.water.store = Math.min(WATER.capL, h.water.store + WATER.deliveryL);
  h.water.thirst = 0;
  note(h, `Bought water: ${WATER.deliveryL} L delivered. −${money(WATER.deliveryCost)}`);
  return ok('water bought', { litres: WATER.deliveryL, cost: WATER.deliveryCost, wasDry });
}

/** Beds that can come in TODAY: twelve on your own, six more per casual hired today. */
export function bedSlots(h) { return LABOUR.bedSlots + (h.labourToday || 0); }

export function plantBed(h, x, y, crop = DEFAULT_CROP) {
  const c = CROPS[crop];
  if (!c) return err(`no such crop: ${crop}`);
  if (h.cash < c.cost) return err(`${c.label} cost ${money(c.cost)}`);
  // owner ruling 21-10: rock takes no crop — "nothing takes root in stone".
  // (Hives are SET DOWN, not planted — buyHive has no rock rule.)
  if (h.plot && h.plot.ground && h.plot.ground[y * h.plot.w + x] === 'rock') {
    return err('that is rock — nothing takes root in stone');
  }
  if (!waterOk(h)) return err('no water — build a tank or buy a plot with a stream');
  if (h.beds.some((b) => b.x === x && b.y === y)) return err('there is already a bed there');
  // TERRAIN-SPEC §2 + §6: the flat rule is CORNER-flat (tileFlat, the same gate buildAccom
  // uses) — no touching tile, diagonals included, stands higher. The old orthogonal
  // steep() check let a raised DIAGONAL through, the inside-corner wedge, and the art
  // seat measured 517 of 4160 cells on one plot passing steep() but failing tileFlat —
  // beds silently refused there, or planted onto the wedge a building would refuse.
  if (!tileFlat(h.plot, x, y)) return err('too steep to plant — flatten it first');
  h.cash -= c.cost;
  const bed = { id: 'b' + h.beds.length, x, y, crop, planted: h.day, ready: h.day + c.growDays };
  h.beds.push(bed);
  note(h, `Planted ${c.label.toLowerCase()}. Ready in ${c.growDays} days. −${money(c.cost)}`);
  tickGoals(h);   // BUG-007: the 'bed' goal ticks now, not on the next End Day
  return ok('bed planted', { bed });
}

export function buyHive(h, x, y) {
  const lumber = lumberOff(HIVE.cost, HIVE.lumber, h.lumber || 0);
  const cost = Math.round(lumber.cost);
  if (h.cash < cost) return err(`a hive costs ${money(cost)} — you have ${money(Math.round(h.cash))}`);
  if (h.hives.some((b) => b.x === x && b.y === y)) return err('there is already a hive there');
  if (lumber.used) h.lumber -= lumber.used;
  h.cash -= cost;
  const hive = { id: 'v' + h.hives.length, x, y, bought: h.day };
  h.hives.push(hive);
  note(h, lumber.used
    ? `Bought a hive — built from your own lumber, ${money(lumber.off)} off. −${money(cost)}`
    : `Bought a hive. −${money(cost)}`);
  return ok('hive bought', { hive, lumberUsed: lumber.used });
}

/**
 * A casual for the day — the LD-01 fix. Hiring used to be a permanent H$180/day wage
 * against six beds that only gross H$128/day; the goal card taught a money-loser and the
 * goal-following run died. Here you pay H$180 ON A HARVEST DAY and six extra beds come in
 * that day. Six beds gross 6 × the crop's yield (greens H$250 … potato H$760, so H$1,500 to
 * H$4,560) against a one-off H$180 — the wage only ever pays for itself, and how often you
 * can spend it depends on the crop you chose (12 to 32 days). Labour costs when you work.
 */
export function hireCasual(h) {
  if (h.cash < LABOUR.wagePerDay) {
    return err(`a casual wants ${money(LABOUR.wagePerDay)} for the day — you have ${money(Math.round(h.cash))}`);
  }
  h.cash -= LABOUR.wagePerDay;
  h.labourToday = (h.labourToday || 0) + LABOUR.perWorker;
  h.casualsHired = (h.casualsHired || 0) + 1;
  note(h, `Hired a casual for the day. −${money(LABOUR.wagePerDay)}. Six more beds can come in today.`);
  return ok('casual hired', { slots: bedSlots(h) });
}

export function harvest(h) {
  // the snake day (wildlife.js): the ground is not worked today. Nobody argues with an
  // adder, and the nearest doctor is an hour away.
  if (h.lostDay === h.day) return err('nobody is working that ground today — a snake in the beds');
  const ready = h.beds.filter((b) => h.day >= b.ready);
  if (!ready.length) return err('nothing is ready yet');
  // Harvest capacity is labour: 12 beds solo, +6 per casual hired today. What you cannot
  // bring in today stays ready in the ground — no rot, just another pair of hands needed.
  const capacity = bedSlots(h);
  const taking = ready.slice(0, capacity);
  const waiting = ready.length - taking.length;
  let kg = 0;
  for (const b of taking) {
    // Yield is per CROP, in Hogsbucks at H$10/kg (potato 760 = 76 kg). A bed replants to
    // whatever it grew — the crop is a decision you make once and live with, not a per-day
    // re-pick. `b.crop` is absent on a bed from before the crop table, so it falls back to
    // the default rather than crashing on an old save.
    const c = CROPS[b.crop] || BED;
    kg += (c.yield / 10) * cropMult(h);
    b.planted = h.day;
    b.ready = h.day + c.growDays;
  }
  h.produce += kg;
  note(h, `Harvested ${Math.round(kg)} kg of vegetables.`);
  return ok(`harvested ${Math.round(kg)} kg`, { kg, waiting });
}

/** The municipal fine for cutting an indigenous native (owner GO 2026-10-21, verbatim:
    "cutting indigenous should have severe penalty"). Per stem — the bakkie gets seen
    on the village road. */
export const NATIVE_FINE = 800;

/** A native — or the oak, alien but a LIVING landmark — costs the forest three times
 *  what a pine cut costs: one share for the missing tree itself, two more because the
 *  mountain notices natives falling. Carried on the household and subtracted wherever
 *  the forest share is computed (company.initCompany). */
export function nativeForestHit(h) {
  h.forestPenalty = (h.forestPenalty || 0) + (2 * 100 / h.forestStart);
}

export function fell(h, treeId) {
  const r = fellTree(h.plot, treeId);
  if (!r.ok) return r;
  // The wood split (owner GO 2026-10-21): "pine cannot be firewood. other trees cannot
  // be milled. so if your plot is full o pine you dont have firewood and vice versa."
  // pine → cash + 2 lumber + 0.25 loads of rubbish offcuts; wattle/blackwood → the full
  // load it always gave, no cash (the mill takes pine only); indigenous → NO cash, the
  // H$800 fine, a 3x forest hit and Naidoo's warning — but 0.5 loads, because it burns
  // ("the penalty is the deterrent, not a ban"); oak → burns like wattle, and the
  // village notices ("someone cut the big oak").
  if (r.kind === 'wattle' || r.kind === 'blackwood') {
    addFirewood(h, FIREWOOD.wattleYield);
    note(h, `Felled a ${r.kind}. Alien wood — the mill won't look at it, but it burns. `
      + `(${Math.floor(h.firewood)} loads stacked)`);
  } else if (r.kind === 'pine') {
    h.cash += r.cash;
    h.lumber = (h.lumber || 0) + 2;    // a pine saws into lumber for the next build
    addFirewood(h, FIREWOOD.pineYield);
    note(h, `Felled a ${r.kind} · +${money(r.cash)} · resinous offcuts, poor burning `
      + `(${Math.floor(h.firewood)} loads stacked)`);
  } else if (r.kind === 'oak') {
    nativeForestHit(h);
    addFirewood(h, FIREWOOD.wattleYield);
    if (!h.oakCut) {
      h.oakCut = true;
      note(h, `You felled an oak. Someone cut the big oak — the village will have opinions.`);
    } else {
      note(h, `Felled an oak. Alien, but it was this valley's charm. `
        + `(${Math.floor(h.firewood)} loads stacked)`);
    }
  } else {
    h.cash -= NATIVE_FINE;
    nativeForestHit(h);
    addFirewood(h, FIREWOOD.indigenousYield);
    if (!h.naidooWarned) {
      h.naidooWarned = true;
      // the cue the audio seat found waiting for (Request 5): the line has existed since
      // 10-21 and `chainsaw` has existed in the synth bank since 10-22 — the only thing
      // missing was the event name on the entry. Latched once per life, so once is right.
      note(h, `Naidoo: "I heard a chainsaw on your ground. I count what stands." `
        + `−${money(NATIVE_FINE)} fine.`, 'chainsaw');
    } else {
      note(h, `Felled an indigenous tree. −${money(NATIVE_FINE)} fine — the mountain notices `
        + `natives falling. It burns well (${Math.floor(h.firewood)} loads stacked)`);
    }
  }
  noteFelled(h, r.m3, r.kind);
  tickGoals(h);   // gate 2 (owner 10-28): the wood goal ticks on the twelfth stem, not on the next End Day
  return r;
}

/**
 * Carry produce and honey to the shop. One trip costs fuel.
 * The shop takes a village's appetite at full price, the excess at a discount, and
 * refuses the rest — so little and often beats one big dump.
 */
export function sellAll(h) {
  const veg = Math.round(h.produce * 10) / 10;
  const honey = Math.round(h.honey * 100) / 100;
  if (veg <= 0 && honey <= 0) return err('nothing to sell');

  const q = quote(h, veg, honey);
  const net = q.zar - FUEL_PER_TRIP;
  h.produce = q.vegRefused;
  h.honey = q.honeyRefused;
  h.cash += net;
  h.sold = (h.sold || 0) + 1;

  // Bible §14.1 — the shop has a voice: brisk, stock-first, secretly fond of regulars.
  // The count always stays in the line; the flavour rides after it.
  const refused = Math.round((q.vegRefused + q.honeyRefused) * 10) / 10;
  const left = refused > 0
    ? ` ${refused} kg stayed behind — the shelves are full. Tomorrow is another shop.`
    : h.date.month === 12 ? ' December we take double and still run out. Plan for it.'
      : h.date.month === 6 ? ' Winter stock moves slow. The soup pot keeps us honest.'
        : h.sold > 2 ? ' You are becoming a fixture.' : '';
  note(h, `Sold ${q.vegSold} kg veg and ${q.honeySold} kg honey for ${money(q.zar)}, less ${money(FUEL_PER_TRIP)} fuel.${left}`);
  tickGoals(h);   // BUG-007: the 'sale' goal ticks on the sale, not the following day
  return ok('sold', { zar: q.zar, net, veg: q.vegSold, honey: q.honeySold, refused: q.vegRefused + q.honeyRefused, detail: q.detail });
}

/** What the shop will absorb today, for the HUD. */
export function shopToday(h) { return appetite(h.date); }

/* ---------------- the clock ---------------- */

function advanceDate(h) {
  h.date.day += 1;
  if (h.date.day > MONTH_DAYS) {
    h.date.day = 1;
    h.date.month += 1;
    if (h.date.month > 12) { h.date.month = 1; h.date.year += 1; }
    // the birds announce the season before any panel does (owner, 2026-10-21):
    // the piet-my-vrou (red-chested cuckoo) arrives in September and goes quiet in
    // April. Log-only — log text is not in snap(), so the traces cannot move.
    if (h.date.month === 9) {
      h.log.push({ day: h.day, text: 'The piet-my-vrou is calling. Spring is here.' });
    } else if (h.date.month === 4) {
      h.log.push({ day: h.day, text: 'The piet-my-vrou has gone quiet. Autumn.' });
    }
  }
}

/**
 * One day. Order matters: you live, the crops grow, the date turns, then the 1st
 * charges you for the month that is starting.
 */
export function endDay(h) {
  if (h.ended) return { ok: false, msg: 'the run is over', ended: h.ended };

  const cashBefore = h.cash;
  let living = 0;
  let bills = 0;
  let food = 0;
  let ateHome = false;

  h.day += 1;
  rollWeather(h);

  // the dam seeps first (TERRAIN-SPEC §7): a dopped hole below the water table rises
  // FILL_PER_DAY a day, and the night it reaches the table h.water.stream goes on —
  // BEFORE the clock below, so the filled dam stops the countdown that same night.
  tickWater(h);

  // water: the tank drinks and the weather refills it; a stream never runs dry.
  // An empty mouth for three days ends this life — that is what water is worth here.
  let driedToday = false;
  if (h.water.tank && !h.water.stream) {
    const beforeL = h.water.store || 0;
    h.water.store = Math.max(0, Math.min(WATER.capL,
      beforeL - WATER.usePerDay + (WATER.refill[h.weather.kind] || 0)));
    driedToday = beforeL > 0 && h.water.store === 0;
  }
  if (h.water.stream || (h.water.tank && h.water.store > 0)) {
    h.water.thirst = 0;
  } else {
    h.water.thirst += 1;
    if (driedToday) note(h, 'The tank is dry.');
    const left = WATER.deathDays - h.water.thirst;
    if (left > 0) note(h, `No water. ${left} day${left === 1 ? '' : 's'} left.`);
    else {
      h.ended = { result: 'lose', reason: 'No water for three days. That is the end of this life.' };
      note(h, h.ended.reason);
    }
  }

  // food: eat from the plot when the store can feed you, or pay the shop's premium
  if (h.produce >= FOOD.eatKg) {
    h.produce -= FOOD.eatKg;
    ateHome = true;
  } else {
    food = FOOD.eatKg * FOOD.shopPerKg;
  }

  // the casuals went home — labour is bought per day, on the days you work
  living = LIVING_PER_DAY + food + livingExtra(h);
  h.labourToday = 0;
  h.cash -= living;

  for (const b of h.beds) if (h.day === b.ready) note(h, `A bed is ready to harvest.`);
  if (inHoneySeason(h.date)) h.honey += h.hives.length * HIVE.honeyPerDay;

  // the animals (bible §15, names frozen in §17.6): baboons on the garden, samangos on the
  // hives, a snake in the beds, toads in a dug dam. State-driven, no dice — the events go
  // into the day's list so the morning report and the audio cue read the same night.
  const wild = tickWildlife(h);
  // the village's own voice, on its own rhythm (owner GO 2026-10-23) — not an event cue,
  // so no `event` name on the line.
  tickGrapevine(h);
  // the first week, and the day the roof lands (bible §20, lead wiring 10-23 at the
  // narrative seat's request). One line a day at most, every gate true for exactly one
  // day, keyed on `doneDay` rather than `built` on purpose: `built` flips inside
  // tickTourism, so a trigger reading it would depend on WHERE in endDay it is called.
  // Log-only — `snap()` excludes `h.log`, so no golden can see any of this.
  tickArrival(h);

  // the hearth (owner GO 2026-10-21): firewood is a survival resource, like water.
  // May–August the household burns 0.10 loads a night. A dry stack in winter costs
  // H$120 a night in paraffin and blankets — the cold house — until wood is stacked.
  if (inFirewoodSeason(h.date)) {
    if ((h.firewood || 0) > 0) {
      burnFirewood(h, FIREWOOD.householdBurn);
      h.coldHouseNights = 0;
    } else {
      h.cash -= FIREWOOD.coldHouseNight;
      h.coldHouseNights = (h.coldHouseNights || 0) + 1;
      if (h.coldHouseNights === 1) {
        // the sentence is the narrative seat's (`coldHouseLine`), because "the house goes
        // cold" was a lie for a household with no house — two of the three lives. homestead
        // still owns the charge and the number; the words are read off hasRoof().
        note(h, coldHouseLine(h));
      }
    }
  }

  // the night belongs to today's date, so this runs before the calendar turns
  const night = tickTourism(h);
  // Subsidy judgement runs AFTER the night's wear (level audit 2026-10-20): judging the
  // road before the storm landed made "hold it through December" risk-free. Now a bad
  // night can break the streak, which is the decision the subsidy was written to be.
  tickSubsidy(h);
  const directed = tickDirector(h);
  tickGoals(h);
  tickCompany(h);
  tickLegacy(h);
  maybeFamilyNote(h);   // the brother's log line, log-only, hash-safe (snap() excludes log)
  for (const e of night.events) note(h, e);

  // the mountain breaks things after the guests have used them; fixes land first
  tickHandyman(h);
  maybeBreak(h);

  advanceDate(h);
  settleSubsidy(h);
  maybeOffer(h);
  maybeOfferContract(h);

  const events = [...night.events];
  // the animals spoke earlier in the night (wildlife.js wrote their lines into the log);
  // this puts the same text in the morning report, so the report and the cue agree.
  for (const name of wild) {
    const line = h.log.find((l) => l.event === name && l.day === h.day);
    if (line) events.push(line.text);
  }
  if (directed) events.push(directed.text);
  if (h.date.day === 1) {
    const bill = monthlyBills(h);
    h.lastBill = { date: dateLabel(h.date), total: bill.total };
    if (h.cash >= bill.total) {
      h.cash -= bill.total;
      bills = bill.total;
      h.arrears = 0;
      h.billsPaid = (h.billsPaid || 0) + 1;
      events.push(`Bills: ${money(bill.total)} paid (${bill.items.map((i) => i.label).join(', ')}).`);
      note(h, `Paid the month: ${money(bill.total)}.`);
    } else {
      h.arrears += 1;
      h.missedMonths += 1;
      events.push(`Bills: ${money(bill.total)} due — you are ${money(Math.round(bill.total - h.cash))} short. Three months short and the plot is the bank's.`);
      note(h, `Missed the bills. ${money(bill.total)} was due.`);
      if (h.arrears >= 3) {
        h.ended = { result: 'lose', reason: 'Three months of unpaid bills. The bank has the plot.' };
        note(h, h.ended.reason);
      }
    }
    // the generator's month, in one line — the fuel was already paid day by day
    const fuelLine = flushFuel(h);
    if (fuelLine) { events.push(fuelLine); note(h, fuelLine); }
  }

  if (h.cash < -20000 && !h.ended) {
    h.ended = { result: 'lose', reason: 'H$20 000 in the red. There is nothing left to sell.' };
    note(h, h.ended.reason);
  }

  // the morning report: what the night brought in, what the day cost, what is left
  const report = {
    day: h.day,
    date: dateLabel(h.date),
    weather: h.weather.label,
    guests: night.earned || 0,
    nights: night.nights || 0,
    living,
    food,
    ateHome,
    fuel: night.fuel || 0,
    tankPct: h.water.stream ? null : Math.round(100 * (h.water.store || 0) / WATER.capL),
    bills,
    delta: Math.round(h.cash - cashBefore),
    cash: Math.round(h.cash),
    events,
  };

  return { ok: true, day: h.day, date: dateLabel(h.date), events, ended: h.ended, report };
}

/* ---------------- save / load ---------------- */

export function toJSON(h) { return JSON.stringify(h); }
export function fromJSON(str) {
  const h = JSON.parse(str);
  if (!h) return null;
  if (h.version === 1) {
    // v1 → v2: water became a stored resource with a three-day countdown.
    // An old save with a tank keeps its water; without one, the clock starts now.
    h.version = 2;
    h.water = {
      tank: !!(h.water && h.water.tank),
      stream: !!(h.water && h.water.stream),
      store: h.water && h.water.tank ? WATER.capL : 0,
      thirst: 0,
    };
  }
  if (h.version !== 2) return null;
  return h;
}

/** A compact summary for the HUD. */
export function summary(h) {
  const bill = monthlyBills(h);
  const ready = h.beds.filter((b) => h.day >= b.ready).length;
  return {
    day: h.day,
    date: dateLabel(h.date),
    cash: Math.round(h.cash),
    billTotal: bill.total,
    daysToBill: MONTH_DAYS - h.date.day + 1,
    bond: h.bond.monthly,
    beds: h.beds.length,
    slots: bedSlots(h),
    casualsHired: h.casualsHired || 0,
    firewood: Math.floor(h.firewood || 0),
    firewoodPrice: firewoodPrice(h.date),
    firewoodSeason: inFirewoodSeason(h.date),
    firewoodReserve: firewoodReserve(h),
    firewoodWeekLeft: firewoodWeekLeft(h),
    coldHouseNights: h.coldHouseNights || 0,
    poles: Math.floor(h.lumber || 0),
    polePrice: POLES.price,
    poleTripFee: POLES.tripFee,
    polePerTrip: POLES.perTrip,
    poleNetFull: polesNet(POLES.perTrip),
    ready,
    hives: h.hives.length,
    honey: Math.round(h.honey * 10) / 10,
    produce: Math.round(h.produce * 10) / 10,
    water: waterOk(h),
    tank: h.water.stream ? null : {
      pct: Math.round(100 * (h.water.store || 0) / WATER.capL),
      thirst: h.water.thirst || 0,
      daysLeft: Math.max(0, WATER.deathDays - (h.water.thirst || 0)),
      capL: WATER.capL,
    },
    food: { eatKg: FOOD.eatKg, shopCostPerDay: FOOD.eatKg * FOOD.shopPerKg,
            selfFed: h.produce >= FOOD.eatKg },
    trees: h.plot.trees.length,
    arrears: h.arrears,
    ended: h.ended,
    tourism: tourismSummary(h),
    company: companySummary(h),
    shop: appetite(h.date),
    weather: { kind: h.weather.kind, label: h.weather.label, line: weatherLine(h) },
    subsidy: subsidySummary(h),
    bank: bankSummary(h),
    director: directorSummary(h),
    holding: holdingSummary(h),
    legacy: legacySummary(h),
    goals: goalSummary(h),
  };
}
