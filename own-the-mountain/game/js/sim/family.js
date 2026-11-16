// game/js/sim/family.js -- Slice 4: needs meters + the readiness-gated family.
//
// The emotional core of the life-sim reframe (HOGSBACK-LIFE-SIMULATOR.md section 11):
// family turns "stay alive" from a ledger into people. It is a CHOICE, never automatic,
// and the game shows "ready / not yet, because..." with the same honesty as the build
// gates. Once started, dependents raise the stakes (more mouths, school/health costs);
// later they pay back as a labour CAP RELEASE on beds the household already owns, and
// they are the people who can carry a legacy horizon longer than one runway.
//
// Numbers hang off the level seat's measured note (LEVEL-DESIGN-LIFE-SIM-BALANCE.md
// section 6), not invention:
//   - a mouth eats FOOD.eatKg (2 kg); growing a mouth is ~7x cheaper than shop-feeding it.
//   - a working dependent is worth at/under the casual rate: labour as a cap release
//     (LABOUR.perWorker beds), NOT a wage, or the family becomes the dominant income.
//   - readiness is months of SURPLUS (not months of cash) + a visible food store +
//     water safe + a built home + a float of three months of bills (the day-91 finding:
//     any purchase leaving < 3 months of bills died at exactly day 91, 8/8 seeds).
//
// GOLDEN-SAFE BY CONSTRUCTION: this module is a leaf (imports only fmt). Every economic
// effect is zero while h.family.dependents === 0, so the no-family path -- the one the
// golden traces run -- is byte-identical. h.family is outside snap()'s whitelist.
// Context that lives in homestead.js (billTotal, waterSafe, home, eatKg...) is passed in
// by the homestead wrappers so there is no import cycle.

import { money } from './fmt.js';

export const FAMILY = {
  mouthEatKg: 2,             // per person, mirrors FOOD.eatKg (passed in by the wrapper)
  dependentLivingShare: 3,   // a dependent adds LIVING_PER_DAY / 3 (school/health/clothing)
  surplusMonths: 3,          // months of positive net surplus before the gate opens
  floatMonths: 3,            // three months of bills in hand (the day-91 cliff)
  storeDays: 30,             // a VISIBLE store: 30 days of food for the current mouths
  growBeds: 2,               // ...or this many growing beds (a habit, not a milestone)
  childGrowDays: 120,        // a child becomes a helping hand after this many days
  maxChildren: 3,
};

const err = (msg) => ({ ok: false, msg });

/** One refusal builder for both verbs: name the gate AND its actual number (kg, months,
 *  float), so "not yet" is actionable. Narrative seat finding 11-16: haveChild previously
 *  joined bare labels and printed "not yet — Food security" without the 240 kg it wanted. */
function whyNotReady(r) {
  return r.gates.filter((g) => !g.ok).map((g) => g.label + ': ' + g.detail).join('; ');
}

/** One household member plus any dependents. */
export function mouths(h) {
  return 1 + ((h.family && h.family.dependents) || 0);
}

export function initFamily(h) {
  h.family = {
    started: false,
    partner: false,
    children: [],            // { bornDay }
    dependents: 0,
    startedDay: 0,
    // rolling surplus tracker: months of positive net, sampled at each month boundary
    econ: { prevEarned: h.earned || 0, prevMonth: h.date ? h.date.month : 0, surplusMonths: 0 },
  };
}

function recount(h) {
  h.family.dependents = (h.family.partner ? 1 : 0) + h.family.children.length;
}

/** Grown children release harvest capacity on owned beds (a cap, not a wage). */
export function familyLabour(h) {
  if (!h.family) return 0;
  let beds = 0;
  for (const c of h.family.children) {
    if (h.day - c.bornDay >= FAMILY.childGrowDays) beds += 6; // == LABOUR.perWorker, passed shape
  }
  return beds;
}

/**
 * The extra nightly cost of the dependents, PURE (does not mutate). The base endDay has
 * already fed the single player; this feeds the extra mouths from the remaining store or
 * the shop, and adds the per-dependent living share. Returns zeros when there is no
 * family, so the caller's no-family arithmetic is untouched.
 */
export function familyNight(h, ctx) {
  const d = (h.family && h.family.dependents) || 0;
  if (d <= 0) return { homeKg: 0, extraFood: 0, extraLiving: 0 };
  const eatKg = ctx.eatKg, shopPerKg = ctx.shopPerKg;
  let homeKg = 0, extraFood = 0;
  let store = h.produce || 0;
  for (let i = 0; i < d; i++) {
    if (store >= eatKg) { store -= eatKg; homeKg += eatKg; }
    else extraFood += eatKg * shopPerKg;
  }
  const extraLiving = d * Math.round(ctx.livingPerDay / FAMILY.dependentLivingShare);
  return { homeKg, extraFood, extraLiving };
}

/**
 * Nightly growth + the rolling surplus sample. Mutates ONLY h.family. Call once per
 * endDay, after the economy. Tracks months of positive net surplus for the readiness
 * gate; ages children (growth is read off bornDay, so no per-day state is needed).
 */
export function tickFamily(h, ctx) {
  if (!h.family) return;
  const e = h.family.econ;
  const month = h.date.month;
  if (month !== e.prevMonth) {
    const net = (h.earned - e.prevEarned) - (ctx.billTotal || 0);
    e.surplusMonths = net > 0 ? e.surplusMonths + 1 : 0;
    e.prevEarned = h.earned;
    e.prevMonth = month;
  }
}

/**
 * The readiness gate, readable before committing (section 11: "ready / not yet,
 * because..."). ctx supplies the homestead-side facts. Returns { gates, ready }.
 */
export function readiness(h, ctx) {
  const f = h.family || { dependents: 0, econ: { surplusMonths: 0 }, children: [] };
  const m = mouths(h);
  const storeOk = (h.produce || 0) >= m * FAMILY.mouthEatKg * FAMILY.storeDays;
  const bedsOk = (h.beds || []).length >= FAMILY.growBeds;
  const gates = [
    { key: 'home', label: 'A built home', ok: !!ctx.home,
      detail: ctx.home ? 'a roof stands' : 'build a house or a room first' },
    { key: 'surplus', label: FAMILY.surplusMonths + ' months of surplus', ok: f.econ.surplusMonths >= FAMILY.surplusMonths,
      detail: f.econ.surplusMonths + ' of ' + FAMILY.surplusMonths + ' months in the black' },
    { key: 'food', label: 'Food security', ok: storeOk || bedsOk,
      detail: storeOk ? Math.floor(h.produce || 0) + ' kg in the store'
        : bedsOk ? (h.beds || []).length + ' growing beds'
        : 'keep ' + (m * FAMILY.mouthEatKg * FAMILY.storeDays) + ' kg stored or ' + FAMILY.growBeds + ' beds growing' },
    { key: 'water', label: 'Water safe', ok: !!ctx.waterSafe,
      detail: ctx.waterSafe ? 'stream or a full tank' : 'secure a stream or a tank' },
    { key: 'float', label: FAMILY.floatMonths + ' months of bills in hand', ok: h.cash >= (ctx.billTotal || 0) * FAMILY.floatMonths,
      detail: money(Math.round(h.cash)) + ' of ' + money(Math.round((ctx.billTotal || 0) * FAMILY.floatMonths)) },
  ];
  return { gates, ready: gates.every((g) => g.ok) };
}

/** The choice itself. Refuses with the reasons unless every gate is true. */
export function startFamily(h, ctx) {
  if (!h.family) initFamily(h);
  if (h.family.started) return err('the household already has a family');
  const r = readiness(h, ctx);
  if (!r.ready) return err('not yet — ' + whyNotReady(r));
  h.family.started = true;
  h.family.partner = true;
  h.family.startedDay = h.day;
  recount(h);
  // Numeral derived from state, not typed; phrasing kept distinct from the family-start
  // milestone (which spends "same ground / reason to keep it" the next morning).
  return { ok: true, msg: 'There is another person in this house. The mountain has to hold ' + mouths(h) + ' of you now.' };
}

/** A subsequent, gated choice. Children grow into helping hands, then carry the legacy. */
export function haveChild(h, ctx) {
  if (!h.family || !h.family.started) return err('start a family first');
  if (h.family.children.length >= FAMILY.maxChildren) return err('the house is full');
  const r = readiness(h, ctx);
  if (!r.ready) return err('not yet — ' + whyNotReady(r));
  h.family.children.push({ bornDay: h.day });
  recount(h);
  // The promise made checkable (childGrowDays, the same constant familyLabour reads), and the
  // sentence VARIES by birth count so three births are not three copies of one line (the offers
  // repetition class / Bible 21.3; narrative finding 11-16). No milestone phrasing reused.
  const n = h.family.children.length;
  const days = FAMILY.childGrowDays;
  const msg = n === 1
    ? 'A child joins the household. In ' + days + ' days they will be another pair of hands on the beds.'
    : n === 2
    ? 'A second child. The store has to work harder than the calendar; the new hands arrive in ' + days + ' days.'
    : 'A third. ' + n + ' of them in this house now, and in ' + days + ' days the youngest carries a share of the harvest.';
  return { ok: true, msg };
}

/**
 * Presentational needs meters (RimWorld-shaped: food/warmth/water/rest), read-only.
 * They READ existing state and never write it, so they cannot move a trace. Each is
 * 0..1 with a plain-language detail. Water already has real teeth (thirst); warmth is
 * the cold-house stack; food is the store; rest is overwork (a snake day / bought labour).
 */
export function needs(h, ctx) {
  const m = mouths(h);
  const foodDays = (h.produce || 0) / (m * FAMILY.mouthEatKg);
  const food = Math.max(0, Math.min(1, foodDays / 7));
  const warmth = ctx.firewoodSeason
    ? Math.max(0, Math.min(1, (ctx.firewoodReserveDays || 0) / 7))
    : 1;
  const water = ctx.waterSafe ? 1 : 0;
  const rest = (h.lostDay === h.day) ? 0.3 : 1;
  return [
    { key: 'food', label: 'Food', value: food, ok: foodDays >= 1,
      detail: foodDays >= 1 ? Math.floor(foodDays) + ' days in the store' : 'the shop feeds you at a premium' },
    { key: 'warmth', label: 'Warmth', value: warmth, ok: warmth > 0,
      detail: ctx.firewoodSeason ? (warmth > 0 ? 'the stack is dry' : 'a cold house — stack wood') : 'out of the cold months' },
    { key: 'water', label: 'Water', value: water, ok: !!ctx.waterSafe,
      detail: ctx.waterSafe ? 'stream or tank' : 'no water — the clock is running' },
    { key: 'rest', label: 'Rest', value: rest, ok: rest > 0.5,
      detail: rest > 0.5 ? 'steady' : 'a snake day — the beds are closed' },
  ];
}

/** Everything the family card needs, in one read. */
export function familySummary(h, ctx) {
  const f = h.family;
  if (!f) return null;
  const r = readiness(h, ctx);
  const night = familyNight(h, ctx);
  return {
    started: f.started,
    dependents: f.dependents,
    mouths: mouths(h),
    partner: f.partner,
    children: f.children.map((c) => ({ ageDays: h.day - c.bornDay, grown: h.day - c.bornDay >= FAMILY.childGrowDays })),
    labourBeds: familyLabour(h),
    ready: r.ready,
    gates: r.gates,
    needs: needs(h, ctx),
    costPerDay: night.extraFood + night.extraLiving,
  };
}