// storyteller.js - the mountain asks, and it aims at what you lean on.
//
// Slice 3 (owner GO 11-15, "go slice 3"). The bar is RimWorld's storyteller for pacing and
// This War of Mine for scarcity: every obstacle is either auto-settled WITH a felt cost
// (director.js, handyman.js - those already comply) or ASKED as a choice. What was missing
// is the second half, and the level note (LEVEL-DESIGN-LIFE-SIM-BALANCE.md) measured exactly
// where it fails: asked decisions stop dead at day 120 (offers.js OFFER_UNTIL), the director's
// hits land every 9-21 days and never ask anything, and plan B is either unpurchasable when it
// matters or decoration.
//
// THE CONTRACT (this is what keeps the goldens alive):
//   - tickStory() sets h.story.pending and writes NOTHING ELSE that snap() can see. No cash,
//     no road, no rating, no produce, no trees. The canonical three lives (tools/golden-home.mjs)
//     never answer a question, so for them this module does not exist.
//   - answerStory() is the only mutation path, and every branch refuses a household that
//     cannot pay rather than driving it negative.
//   - Every number is read from the shipped sim (tourism rates, weather tables, market
//     capacity, bank steps, wildlife rhythm) and the homestead's own verbs arrive through ctx,
//     exactly like offers.js. No price in this file is a second source: where ctx does not
//     carry it, the ask stands down instead of guessing.
//
// THE INTERLOCK, which is why this file is not just a question queue: the weather is the gift
// and the threat at once. A storm puts 1,600 L into the tank (homestead WATER.refill) and
// takes the power off the same night (tourism.powerNight). This module reads the forecast, so
// the water ask stands DOWN when the rain is coming and the power ask stands UP when it is,
// and a household that bought the hedge rides the night out while a plan-A household is asked
// for money it does not have.
//
// Pure logic, no DOM. Own rng stream (like voices/weather/offers/director), so adding an ask
// shape here never shifts the booking sequence or another seat's cadence.

import { WEATHER, CHANCES } from './weather.js';
import { ACCOM, FACILITY, PLATFORM_FEE, rateFor, cleaningCost } from './tourism.js';
import { SHOP, vegPrice } from './market.js';
import { BANK, canRestructure } from './bank.js';
import { WILDLIFE } from './wildlife.js';
import { pressure } from './director.js';
import { money } from './fmt.js';   // one money formatter for every line (fmt.js)

export const STORY = {
  firstDay: 10,
  // The cadence the note asked for: 4-7 days with a portfolio, 7-12 with one business, and
  // slower on a bare plot, where there is honestly less to decide.
  gap: {
    portfolio: { min: 4, max: 7 },
    single: { min: 7, max: 12 },
    bare: { min: 10, max: 16 },
  },
  expireDays: 3,          // an unanswered question does not sit on the desk forever
  forecastDays: 4,        // how far the weather peek looks - the pre-storm ask's whole point
  starHit: 0.6,           // FIRST PASS: keeping the money instead of refunding it
  fixMultiplier: 3,       // FIRST PASS: a permanent fix costs three of the director's call-outs
  outageNights: 2,        // FIRST PASS, and the level seat's main knob: guest-nights an
                          // exposed outage cancels. Measured on the incomer's 2-unit host
                          // (14 exposed nights a life): 1 => solar pays back in 3.4 seasons,
                          // 2 => 1.7, 3 => 1.2. The note's "~1.5 storm seasons" lands at 2.
  guardWages: 2,          // the boy with two dogs costs two day wages
  guardDays: 10,
  freshHitDays: 2,        // how long the tradesman is still in the yard
  repeatCooldown: 21,     // days before the same SHAPE asks again ('outage' excepted: it is weather)
  seasonDays: 90,         // the damage ledger is read as a storm season (Dec-Feb)
  hedgeShare: 0.25,       // FIRST PASS (note 4.4): a hedge is worth pitching when a year's
                          // measured damage is at least a quarter of its price (for a
                          // generator, its price plus a year of fuel)
  glutShare: 1.2,         // FIRST PASS: store that will not fit in a day of shop runs
};

/** Rungs whose plumbing needs power: an indoor bathroom is a geyser and a pump. A camp or a
    caravan stand joins them through the ablution block, whose geysers are on the same board -
    which is why the set is computed and not hardcoded. FIRST PASS for the level seat. */
export const PLUMBING = new Set(['room', 'spare', 'cabin', 'chalet', 'luxury']);
const TENTED = new Set(['camp', 'caravan']);
const WET = new Set(['storm', 'snow']);   // the kinds Eskom does not survive

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

export function initStory(h) {
  h.story = h.story || {
    rng: 20261115, nextDay: STORY.firstDay, pending: null,
    asked: 0, answered: 0, expired: 0,
    repairs: {},        // director incidents the player bought off, for good
    seen: {},           // ask id -> the day it last asked
    guardUntil: 0,      // the garden is watched until this day
    warnedYear: 0,      // one pre-storm warning per calendar year
    dirCount: -1,       // the director's event count as of the last tick
    marks: null,        // h.earned as of the last tick, so tonight's letting can be measured
    out: { nights: 0, value: 0 },   // the damage ledger: exposed nights, and their money
  };
  h.story.repairs = h.story.repairs || {};
  h.story.seen = h.story.seen || {};
  h.story.out = h.story.out || { nights: 0, value: 0 };
  return h;
}

function rnd(h) {
  initStory(h);
  h.story.rng = (Math.imul(1664525, h.story.rng >>> 0) + 1013904223) >>> 0;
  return h.story.rng / 4294967296;
}

/* ---------------- the forecast (read, never rolled) --------------------------------
   weather.js rolls from `h.weatherRng` and the month alone, so the next few days can be
   replayed from a COPY of that number without disturbing the stream. endDay has already
   rolled tonight by the time tickStory runs, so day+1 is the next draw. A mirror is a debt:
   tests/57 pins these values against the engine's own rolls, 40 days deep. */

/** The month `i` days after the household's date. The sim runs 30-day months (MONTH_DAYS). */
function monthAhead(h, i) {
  const d = h.date.day + i;
  return ((h.date.month - 1 + Math.floor((d - 1) / 30)) % 12) + 1;
}

/** [{in, month, kind, label, litres}] for the next `days` nights. Pure: no writes, no draws
    on any live stream. `refill` is the homestead's own WATER.refill table, passed in by
    tickStory - this module never carries a second copy of it. */
export function forecast(h, days = STORY.forecastDays, refill = null) {
  let s = (h.weatherRng || 314159) >>> 0;
  const out = [];
  for (let i = 1; i <= days; i++) {
    const month = monthAhead(h, i);
    const table = CHANCES[month] || CHANCES[3];
    s = (Math.imul(1664525, s >>> 0) + 1013904223) >>> 0;
    let r = s / 4294967296;
    let kind = 'clear';
    for (const [k, p] of Object.entries(table)) {
      if (r < p) { kind = k; break; }
      r -= p;
    }
    out.push({
      in: i, month, kind, label: WEATHER[kind].label,
      litres: refill ? (refill[kind] || 0) : null,
    });
  }
  return out;
}

const wetAhead = (f = []) => f.find((d) => WET.has(d.kind)) || null;

/** The first night in the window that actually puts water into the tank. Null when the
    forecast is dry, or when the refill table was not supplied (fail closed, never guess). */
function rainAhead(f, use) {
  if (!f || !f.length || !Number.isFinite(use) || f.some((d) => d.litres == null)) return null;
  return f.find((d) => d.litres > use * 0.5) || null;
}

/* ---------------- the shipped numbers this module quotes --------------------------- */

/** Built, listed rungs whose plumbing needs power - the outage exposure. */
export function powerUnits(h) {
  const ablution = !!(h.facilities && h.facilities.ablution);
  return (h.accom || []).filter((a) => a.built && a.listed
    && (PLUMBING.has(a.kind) || (ablution && TENTED.has(a.kind))));
}

/** One night's net for one room, after the platform's cut and the cleans (tourism's own
    arithmetic: `Math.round(rate * (1 - PLATFORM_FEE) - cleaningCost)`). */
export function unitNet(h, kind) {
  return Math.round(rateFor(h, kind) * (1 - PLATFORM_FEE) - cleaningCost(h));
}

/** The share of tonight's letting that power feeds: the affected rooms' net over the whole
    listed base. 1 for an all-indoor guest house, small for a campsite with one cabin. */
export function powerShare(h) {
  const listed = (h.accom || []).filter((a) => a.built && a.listed);
  if (!listed.length) return 0;
  const all = listed.reduce((s, a) => s + Math.max(0, unitNet(h, a.kind)), 0);
  if (all <= 0) return 0;
  const fed = powerUnits(h).reduce((s, a) => s + Math.max(0, unitNet(h, a.kind)), 0);
  return Math.max(0, Math.min(1, fed / all));
}

/** The refund the outage ask puts in front of the player: the money the guest actually paid
    tonight, times the share of it that needed power. It is the note's rule (a power-out costs
    a guest night for power-dependent plumbing) priced off the engine's own ledger, so a
    two-pitch camp is asked about a camp and a cabin complex is asked about a season. */
export function exposureNet(h, tonightGuestMoney = 0) {
  const share = powerShare(h);
  if (share <= 0) return 0;
  const paid = Math.max(0, tonightGuestMoney || 0);
  if (paid > 0) return Math.round(paid * share);
  // no ledger yet (a preview before the first night): one night of the best-fed room
  const units = powerUnits(h);
  if (!units.length) return 0;
  return units.reduce((best, a) => Math.max(best, unitNet(h, a.kind)), 0);
}

/** Kept for the card and the board: one night of the best-paying room power feeds. */
export function nightNet(h) {
  const units = powerUnits(h);
  if (!units.length) return 0;
  return units.reduce((best, a) => Math.max(best, unitNet(h, a.kind)), 0);
}

function unitLabel(h) {
  const units = powerUnits(h).slice().sort((a, b) => rateFor(h, b.kind) - rateFor(h, a.kind));
  return units.length ? ((ACCOM[units[0].kind] || {}).label || units[0].kind) : 'guest';
}

/** How many businesses this household is actually running: the cadence dial. Read off the
    ground, never off the estate file (a seat cannot depend on another seat's save). */
export function operating(h) {
  const hosting = (h.accom || []).some((a) => a.built);
  const farming = (h.beds || []).length > 0 || (h.hives || []).length > 0 || (h.produce || 0) > 0;
  const forestry = (h.lumber || 0) > 0 || (h.firewood || 0) > 0 || (h.workers || 0) > 0;
  const trade = !!h.contract || (h.company && h.company.jobs > 0);
  return [hosting, farming, forestry, trade].filter(Boolean).length;
}

function gapFor(h) {
  const n = operating(h);
  const g = n >= 2 ? STORY.gap.portfolio : n === 1 ? STORY.gap.single : STORY.gap.bare;
  return g.min + Math.floor(rnd(h) * (g.max - g.min + 1));
}

/* ---------------- the ask library ---------------------------------------------------
   Every shape is gated on state the player can see, prices itself off a shipped number, and
   is aimed at the source the household leans on (the note's section 5.2). A shape with
   nothing to say about THIS plot returns null, so the pool empties honestly instead of
   asking a filler question. */

/** 1. THE OUTAGE - the reactive half of the interlock. The storm took the power last night
    and a guest was in the dark with a cold shower. Refund the night, or keep the money and
    hear about it. Sized so solar is worth owning (note 4.4: a hedge should cost about 1.5-3
    months of the income it protects). */
function askOutage(h, view) {
  // The view is built by tickStory, but this module is also called directly from tests and
  // from a preview with no ctx at all (the lead's crash note, 11-15): every read below
  // degrades to a state-derived default instead of throwing on an undefined view.
  const v = view || {};
  const guestTonight = Number.isFinite(v.guestTonight) ? v.guestTonight : 0;
  const share = Number.isFinite(v.share) ? v.share : powerShare(h);
  if (!WET.has(h.weather && h.weather.kind)) return null;
  if (!(h.lastNights > 0)) return null;            // nothing was let, so nobody is owed
  const f = h.facilities || {};
  if (f.power) return null;                        // solar: it never trips. Ridden out, free.
  const amount = exposureNet(h, guestTonight) * STORY.outageNights;
  if (amount <= 0) return null;
  const units = powerUnits(h);
  const nights = STORY.outageNights;
  const generator = !!f.generator;
  const why = generator
    // tourism.powerNight rolls once per reviewed room, so a hedged household is asked less
    // often than a bare one, not never. That is the trade, stated plainly.
    ? `The generator holds most nights and not every one - it rolls once a room, and `
      + `${units.length} room${units.length === 1 ? '' : 's'} were letting.`
    : 'Eskom went down with the weather and nothing on this plot was behind it.';
  return {
    id: 'outage', source: 'power',
    title: `${h.weather.label} last night, and the ${unitLabel(h).toLowerCase()} was in the dark.`,
    body: `${why} ${guestTonight > 0
      ? `${h.lastNights} night${h.lastNights === 1 ? ' was' : 's were'} booked for `
        + `${money(guestTonight)}, and ${Math.round(share * 100)}% of that money needed power.`
      : `The ${unitLabel(h).toLowerCase()} lets at ${money(nightNet(h))} a night after the `
        + 'platform and the cleans, and all of it needed power.'
    } The guest wants ${nights === 1 ? 'it' : `the ${nights} nights`} back: ${money(amount)}.`,
    accept: `Refund ${nights === 1 ? 'the night' : `the ${nights} nights`} (-${money(amount)})`,
    decline: 'Keep the money',
    consequence: `Refunding costs ${money(amount)} and the review says "honest, they paid it `
      + `straight back". Keeping it costs about ${STORY.starHit.toFixed(1)} stars, and the rating `
      + 'moves your rate and your fill on every night of the season.',
    amount,
  };
}

/** 2. THE PRE-STORM ASK (note 4.4: "December is nine days out and you have no backup").
    Prospective, and offered only to a household that (a) can actually buy the hedge and
    (b) has ALREADY EATEN enough exposed damage this year to make the pitch honest - the
    level note's complaint is that plan B is decoration, and a hedge offered without a
    measured cost of going without is still decoration. Which hedge is offered depends on
    how soon the weather lands: solar takes a week to fit, so a storm on Thursday is a
    generator conversation and November is a solar one. */
function askBeforeStorm(h, view) {
  const f = h.facilities || {};
  if (f.power || f.generator) return null;         // hedged either way
  const hosting = (h.accom || []).some((a) => a.built && a.listed);
  if (!hosting) return null;                       // a guestless plot does not need the grid
  const ahead = wetAhead(view.f);
  const seasonDue = h.date.month === 11;
  if (!ahead && !seasonDue) return null;
  if (h.story.warnedYear === h.date.year) return null;   // one warning per season
  const rate = damageRate(h);
  const gen = FACILITY.generator;
  const sol = FACILITY.power;
  const solarFits = !ahead || ahead.in > sol.buildDays;
  // The array is bought once and then free; the generator is cheap to buy and expensive to
  // keep, so its honest comparison is a year of running. A hedge is pitched only when the
  // damage already booked justifies some part of it - and the card says the payback out loud.
  const genYearCost = gen.cost + gen.fuelPerDay * 360;
  const wantSolar = solarFits && h.cash >= sol.cost && rate >= sol.cost * STORY.hedgeShare;
  const hedge = wantSolar ? sol : gen;
  if (h.cash < hedge.cost) return null;                  // do not dangle what cannot be bought
  if (rate < (wantSolar ? sol.cost : genYearCost) * STORY.hedgeShare) return null;
  const when = ahead ? `in ${ahead.in} day${ahead.in === 1 ? '' : 's'}` : 'before December';
  const payback = Math.round((hedge.cost / rate) * 10) / 10;
  return {
    id: 'beforestorm', source: 'power', hedge: wantSolar ? 'power' : 'generator',
    title: `There is weather coming ${when} and you have no backup.`,
    body: `Storm nights so far this year have cost you ${money(rate)} a year in rooms that needed `
      + `power and did not have it. ${wantSolar
        ? `Solar is ${money(sol.cost)} and ${sol.buildDays} days to fit, which is why this is the week `
          + 'to book it: it never trips and it never buys fuel.'
        : `A generator is ${money(gen.cost)} and one day to fit, then ${money(gen.fuelPerDay)} a day in `
          + `fuel whatever the weather. Solar is ${money(sol.cost)} and ${sol.buildDays} days to fit, `
          + "so it is not this week's answer."}`,
    accept: `${wantSolar ? 'Book the solar array' : 'Fit the generator now'} (-${money(hedge.cost)})`,
    decline: 'Ride it on Eskom',
    consequence: `At this year's rate the array pays for itself in about ${payback} storm season${payback === 1 ? '' : 's'}.`
      + (wantSolar ? '' : ` The generator's fuel is ${money(gen.fuelPerDay)} every day you own it, `
        + 'which is the half of this trade that surprises people.'),
    cost: hedge.cost,
  };
}

/** What the exposed nights have actually cost, annualised from the damage ledger - measured,
    not assumed. The pre-storm ask and the plan-B board both read this. */
export function damageRate(h) {
  const out = (h.story && h.story.out) || { nights: 0, value: 0 };
  const days = Math.max(1, (h.day || 1) - STORY.firstDay);
  return Math.round(out.value * (360 / days));
}

/** Kept for the status board: the ledger as booked, with no projection. */
export function damageSoFar(h) {
  const out = (h.story && h.story.out) || { nights: 0, value: 0 };
  return { nights: out.nights, value: Math.round(out.value) };
}

/** 3. THE TANK AGAINST THE FORECAST - the gift half of the same weather. The ask stands down
    when rain is due, and says why, which is the interlock becoming visible. */
function askDrySpell(h, view) {
  const w = h.water || {};
  if (!w.tank || w.stream) return null;
  const cap = view.cap;
  const store = w.store || 0;
  if (!Number.isFinite(cap) || !Number.isFinite(view.use)) return null;
  if (store > cap * 0.3) return null;
  const rain = rainAhead(view.f, view.use);
  if (rain) return null;                           // the mountain is about to fill it for free
  const cost = view.deliveryCost;
  if (!Number.isFinite(cost) || h.cash < cost) return null;
  const left = view.use > 0 ? Math.floor(store / view.use) : 0;
  return {
    id: 'dryspell', source: 'water',
    title: `Four dry days ahead and the tank is at ${Math.round((100 * store) / cap)}%.`,
    body: `That is ${left} day${left === 1 ? '' : 's'} of house water. The neighbour with the bakkie `
      + `is in the village today: ${view.deliveryL.toLocaleString('en-ZA')} L for ${money(cost)}.`,
    accept: `Order the delivery (-${money(cost)})`,
    decline: `See how long ${left} days is`,
    consequence: 'Three days with no water ends a life on this plot, and a guest with no water is '
      + 'not a booking - it is a refund. The delivery costs less than one night of a garden room.',
    cost,
  };
}

/** 4. FARMING, in the shape the hosting pool already has (book now or pay for it later): the
    shop has a fixed appetite and a glut does not fit inside a day. This is also the one ask a
    broke household can answer WITH money coming in rather than going out - the note's tight
    branch wants a decision, not a windfall, so the decision is price against time. */
function askGlut(h) {
  const kg = Math.floor(h.produce || 0);
  const cap = SHOP.vegCapacity;
  if (kg < cap * STORY.glutShare) return null;     // a normal week: just walk it down
  const price = vegPrice(h.date);
  const now = Math.round(kg * price * SHOP.overFactor);
  return {
    id: 'glut', source: 'farming',
    title: `You are holding ${kg} kg and the shop takes ${cap} a day.`,
    body: `A table in Alice will collect the whole lot today at the shop's off-whole-sale price, `
      + `${money(Math.round(price * SHOP.overFactor))} a kilo - ${money(now)} cash. Hauling it `
      + `yourself pays the full ${money(price)} a kilo, over ${Math.ceil(kg / cap)} trips.`,
    accept: `Sell the ${kg} kg now (+${money(now)})`,
    decline: 'Keep walking to the shop',
    consequence: `The discount is ${Math.round((1 - SHOP.overFactor) * 100)}% of the counter price, `
      + 'paid today, and the veg does not keep forever either.',
    amount: now, kg,
  };
}

/** 5. WILDLIFE, asked instead of taken. The fence line is the permanent answer and placing one
    is the player's job (owner ruling 11-02); this is the stopgap the morning after a raid. */
function askBaboon(h, ctx) {
  const last = (h.wildlife && h.wildlife.baboon) || 0;
  const fenced = !!(h.plot && Array.isArray(h.plot.fence) && h.plot.fence.length);
  if (fenced) return null;                         // posts are the answer, and they are by hand
  if (h.story.guardUntil > h.day) return null;     // already watched
  if (!last || h.day - last > 6) return null;      // only while it is a fresh wound
  if (!Number.isFinite(ctx.wage)) return null;
  const took = Math.min(WILDLIFE.baboonMaxKg, Math.round((h.produce || 0) * WILDLIFE.baboonTake));
  const cost = STORY.guardWages * ctx.wage;
  if (h.cash < cost) return null;
  return {
    id: 'baboon', source: 'farming',
    title: 'The troop knows where the beds are now.',
    body: `They took about ${took} kg the last time they bothered. For ${money(cost)} - two day wages - `
      + 'a boy with two dogs sleeps by the garden for a fortnight. A fence line is the permanent '
      + 'answer, and you place that yourself.',
    accept: `Hire the guard for ${STORY.guardDays} days (-${money(cost)})`,
    decline: 'Let them come back',
    consequence: `An open garden is raided every ${WILDLIFE.baboonEvery} days for `
      + `${Math.round(WILDLIFE.baboonTake * 100)}% of what is standing, up to ${WILDLIFE.baboonMaxKg} kg.`,
    cost,
  };
}

/** 6. THE DIRECTOR'S HITS, converted (note section 3: they land every 9-21 days and ask for
    nothing). The call-out is already auto-paid - what was never offered is the day the
    tradesman says he can fix the thing for good, so the same bill cannot land four times in a
    season. Accepting takes the row out of director.js's cost pool (see DIRECTOR_FIXES there). */
export const DIRECTOR_FIXES = {
  pipe: { what: 'the pipe run under the kitchen', zar: 3500 },
  geyser: { what: 'the geyser and its bracket', zar: 4500 },
  fence: { what: 'the boundary line', zar: 1800 },
};

function askAftermath(h, view) {
  const d = h.director || {};
  if (!view.freshHit) return null;                       // the director did not just speak
  const fix = DIRECTOR_FIXES[d.last];
  if (!fix || h.story.repairs[d.last]) return null;
  const hit = h.lastHit;
  if (!hit || h.day - hit.day > STORY.freshHitDays) return null;
  const cost = fix.zar * STORY.fixMultiplier;
  if (h.cash < cost) return null;
  return {
    id: `fix-${d.last}`, source: 'wallet', fixId: d.last,
    title: 'He is still in the yard, and he says the same thing will happen again.',
    body: `The call-out on ${fix.what} was ${money(fix.zar)}. Doing it properly while he is up the `
      + `road costs ${money(cost)} - three call-outs, and the fourth one never arrives.`,
    accept: `Do it permanently (-${money(cost)})`,
    decline: 'Pay the next call-out when it comes',
    consequence: 'The mountain sends these every 9 to 21 days. Three of them costs more than fixing '
      + 'it once, which is the whole argument for doing things properly up here.',
    cost,
  };
}

/** 7. THE TIGHT BRANCH, INVERTED (note 4.4 item 5): a broke household used to get a windfall
    roll out of the director's pool. It now gets one more DECISION. Mrs Naidoo already exists
    and already has a price; this only asks the question the bank never volunteered. */
function askBank(h) {
  if (!canRestructure(h)) return null;
  const left = BANK.maxRestructures - h.bank.restructures;
  return {
    id: 'bank', source: 'wallet',
    title: `${BANK.manager} has heard about the month.`,
    body: `She will carry the arrears once, today, and put ${money(BANK.restructureStep)} on the bond `
      + `for as long as you hold the plot. That is ${left} favour${left === 1 ? '' : 's'} she has left.`,
    accept: `Take the carry (+${money(BANK.restructureStep)} a month, forever)`,
    decline: 'Sort it out yourself',
    consequence: 'Three months of arrears and the plot is the bank\'s. A carry buys one month to sell '
      + 'something; it does not buy the month after that.',
    call: 'restructure',
  };
}

const leanMap = (h) => ({
  power: (h.accom || []).some((a) => a.built && a.listed) ? 3 : 1,
  water: (h.water && h.water.tank && !h.water.stream) ? 3 : 1,
  farming: ((h.beds || []).length ? 2 : 0) + ((h.hives || []).length ? 1 : 0)
    + ((h.produce || 0) >= SHOP.vegCapacity ? 2 : 0),
  wallet: pressure(h) === 'tight' ? 6 : (h.arrears > 0 ? 4 : 1),
});

/** The eligible pool with the lean weights applied. Anything that costs money the household
    does not have has already returned null inside its own builder. */
function candidates(h, ctx, view) {
  const out = [];
  const v = view || {};                          // never assume the caller had a ctx
  const lean = leanMap(h);
  const push = (a, weight) => {
    if (!a || !(weight > 0)) return;
    const last = h.story.seen[a.id];
    if (last != null && a.id !== 'outage' && h.day - last < STORY.repeatCooldown) return;
    out.push({ ask: a, weight });
  };
  push(askOutage(h, view), lean.power * 2);
  push(askBeforeStorm(h, view), lean.power);
  push(askDrySpell(h, view), lean.water);
  push(askGlut(h), 1 + lean.farming);
  push(askBaboon(h, ctx), lean.farming);
  push(askAftermath(h, view), lean.wallet);
  push(askBank(h), lean.wallet * 2);
  return out;
}

/* ---------------- the verbs --------------------------------------------------------- */

/** One night on the storyteller's clock: set a question, or let an old one lapse. It never
    moves a snap()-visible field, which is the entire golden contract. */
export function tickStory(h, ctx = {}) {
  initStory(h);
  const s = h.story;
  const bookmark = () => { s.dirCount = (h.director && h.director.count) || 0; };
  if (h.ended) { s.pending = null; bookmark(); return null; }
  const water = ctx.water || {};
  // Tonight's letting, measured from the engine's own cumulative ledger. This is the number
  // the refund is priced on, and the reason the tick reads state instead of guessing it.
  const mark = s.marks == null ? (h.earned || 0) : s.marks;
  const guestTonight = Math.max(0, Math.round((h.earned || 0) - mark));
  s.marks = h.earned || 0;
  const view = {
    f: forecast(h, STORY.forecastDays, water.refill),
    cap: water.capL,
    use: water.usePerDay,
    deliveryCost: water.deliveryCost,
    deliveryL: water.deliveryL,
    guestTonight,
    share: powerShare(h),
    // a director hit this very night? Compared BEFORE the count is bookmarked below.
    freshHit: s.dirCount >= 0 && ((h.director && h.director.count) || 0) > s.dirCount,
  };
  // THE DAMAGE LEDGER - the interlock, counted. A wet night that took guests with nothing
  // behind them is the price of not hedging, and the pre-storm ask quotes it back. A generator
  // does hold the lights on, so a hedged household books no damage - which is the whole point
  // of the pitch. Same teeth as the ask (STORY.outageNights), one source for both.
  const f = h.facilities || {};
  if (WET.has(h.weather && h.weather.kind) && (h.lastNights > 0) && view.share > 0
    && !f.power && !f.generator) {
    s.out.nights += 1;
    s.out.value += exposureNet(h, guestTonight) * STORY.outageNights;
  }
  if (s.pending) {
    if (h.day > (s.pending.dueDay || h.day)) {
      s.pending = null;
      s.expired += 1;
      s.nextDay = h.day + gapFor(h);
    }
    s.dirCount = (h.director && h.director.count) || 0;
    return null;
  }
  if (h.day < s.nextDay || h.day < STORY.firstDay) {
    s.dirCount = (h.director && h.director.count) || 0;
    return null;
  }
  const pool = candidates(h, ctx, view);
  s.dirCount = (h.director && h.director.count) || 0;
  if (!pool.length) { s.nextDay = h.day + 3; return null; }
  const total = pool.reduce((a, b) => a + b.weight, 0);
  let r = rnd(h) * total;
  let chosen = pool[pool.length - 1].ask;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) { chosen = p.ask; break; }
  }
  s.pending = { ...chosen, dueDay: h.day + STORY.expireDays, askedDay: h.day };
  s.seen[chosen.id] = h.day;
  s.asked += 1;
  s.nextDay = h.day + gapFor(h);
  s.forecast = view.f;
  return s.pending;
}

/** The player's answer. THE ONLY MUTATION PATH in this file. `ctx` carries the homestead's own
    verbs, so the sim stays the single owner of every build rule and every price. */
export function answerStory(h, accept, ctx = {}) {
  initStory(h);
  const s = h.story;
  const p = s.pending;
  if (!p) return err('nothing is being asked');
  const clear = () => { s.pending = null; s.answered += 1; s.nextDay = h.day + gapFor(h); };

  if (p.id === 'outage') {
    if (!accept) {
      const before = h.rating;
      h.rating = Math.max(1, Math.round((h.rating - STORY.starHit) * 100) / 100);
      clear();
      return ok(`You kept the ${money(p.amount)}. The ${unitLabel(h)} guest put it in writing.`,
        { stars: Math.round((h.rating - before) * 100) / 100 });
    }
    if (h.cash < p.amount) return err(`the refund is ${money(p.amount)} and you have ${money(Math.round(h.cash))}`);
    h.cash -= p.amount;
    clear();
    return ok(`Refunded the night: -${money(p.amount)}. Expensive, and the review says "honest".`);
  }

  if (p.id === 'beforestorm') {
    s.warnedYear = h.date.year;
    if (!accept) { clear(); return ok('You left it. The forecast stays the forecast.'); }
    const kind = p.hedge === 'power' ? 'power' : 'generator';
    const r = ctx.buildPower
      ? ctx.buildPower(kind)
      : (ctx.buildGenerator ? ctx.buildGenerator() : err('there is no builder on this plot today'));
    if (!r.ok) return r;
    clear();
    const def = FACILITY[kind];
    return ok(`${def.label} is going up${kind === 'generator' ? ' in the shed' : ''}. `
      + `-${money(def.cost)} to fit`
      + (def.fuelPerDay ? ` and ${money(def.fuelPerDay)} a day to keep.` : ', and nothing a day after that.'));
  }

  if (p.id === 'dryspell') {
    if (!accept) { clear(); return ok('The tank stays where it is. So, for now, does the rain.'); }
    const r = ctx.buyWater ? ctx.buyWater() : err('no tanker is in reach today');
    if (!r.ok) return r;
    clear();
    const litres = ((ctx.water && ctx.water.deliveryL) || 2500).toLocaleString('en-ZA');
    return ok(`Water came up the pass: ${litres} L.`);
  }

  if (p.id === 'glut') {
    if (!accept) { clear(); return ok('You will walk it to the shop a crate at a time.'); }
    h.cash += p.amount;
    h.produce = Math.max(0, Math.round(((h.produce || 0) - p.kg) * 10) / 10);
    clear();
    return ok(`Sold ${p.kg} kg to Alice for +${money(p.amount)}. The store is empty and the cash is not.`);
  }

  if (p.id === 'baboon') {
    if (!accept) { clear(); return ok('The garden is on its own, the way it was.'); }
    if (h.cash < p.cost) return err(`the boy wants ${money(p.cost)} and you have ${money(Math.round(h.cash))}`);
    h.cash -= p.cost;
    s.guardUntil = h.day + STORY.guardDays;
    clear();
    return ok(`A boy and two dogs by the beds for ${STORY.guardDays} nights. -${money(p.cost)}.`);
  }

  if (String(p.id).indexOf('fix-') === 0) {
    if (!accept) { clear(); return ok('He drives back down the pass. The next call-out is not his problem.'); }
    if (h.cash < p.cost) return err(`doing it properly is ${money(p.cost)} and you have ${money(Math.round(h.cash))}`);
    h.cash -= p.cost;
    s.repairs[p.fixId] = h.day;
    clear();
    const what = (DIRECTOR_FIXES[p.fixId] || {}).what || 'It';
    return ok(`${what}, done properly, once. -${money(p.cost)}. That bill does not come round again.`);
  }

  if (p.id === 'bank') {
    if (!accept) {
      clear();
      return ok(`${BANK.manager} nods. She has seen this before, she says, and she has not.`);
    }
    const r = ctx.restructure ? ctx.restructure() : err('the bank has no branch here');
    if (!r.ok) return r;
    clear();
    return ok(`${BANK.manager} carried the month. The bond is ${money(h.bond.monthly)} now.`);
  }

  s.pending = null;
  return err('that question is older than the mountain');
}

/* ---------------- the plan A / plan B read ------------------------------------------
   The note's complaint is that the hedge is invisible: you cannot see at a glance which
   sources are single-pointed. storyStatus(h) is that glance, built only from shipped state.
   Display-side only - nothing it reads is charged for, and h.story is outside snap(). */
export function storyStatus(h, ctx = {}) {
  initStory(h);
  const f = h.facilities || {};
  const w = h.water || {};
  const water = ctx.water || {};
  const cap = Number.isFinite(water.capL) ? water.capL : null;
  const use = Number.isFinite(water.usePerDay) ? water.usePerDay : null;
  const store = w.store || 0;
  const hosting = powerUnits(h).length > 0;
  const rain = rainAhead(h.story.forecast || [], use);
  const row = (key, label, planA, planB, have, atRisk, read) => ({
    key, label, planA, planB, have, atRisk, read, hedged: have !== 'none',
  });
  const tankCost = Number.isFinite(water.tankCost) ? money(water.tankCost) : 'H$5 400';
  return {
    pressure: pressure(h),
    operating: operating(h),
    asked: h.story.asked,
    answered: h.story.answered,
    expired: h.story.expired,
    pending: h.story.pending
      ? { id: h.story.pending.id, dueDay: h.story.pending.dueDay, askedDay: h.story.pending.askedDay }
      : null,
    nextDay: h.story.nextDay,
    gapDays: Math.max(0, h.story.nextDay - h.day),
    forecast: (h.story.forecast || []).slice(0, 3).map((d) => d.label),
    stormDue: !!wetAhead(h.story.forecast || []),
    rainDue: rain ? rain.in : null,
    guarded: h.story.guardUntil > h.day ? h.story.guardUntil - h.day : 0,
    fixed: Object.keys(h.story.repairs),
    exposure: nightNet(h),
    damage: damageSoFar(h),
    damageRate: damageRate(h),
    sources: [
      row('power', 'Power', 'Eskom: H$1 100 a month and whatever the weather decides',
        `Generator ${money(FACILITY.generator.cost)} then ${money(FACILITY.generator.fuelPerDay)} a day, `
        + `or solar ${money(FACILITY.power.cost)} once`,
        f.power ? 'solar' : f.generator ? 'generator' : 'none',
        hosting && WET.has(h.weather && h.weather.kind),
        hosting ? `${money(nightNet(h))} of letting at risk a night, `
          + `${money(damageSoFar(h).value)} lost on ${damageSoFar(h).nights} exposed night`
          + (damageSoFar(h).nights === 1 ? '' : 's')
          : 'nothing is letting yet'),
      row('water', 'Water', w.stream ? 'The stream, which is the reason this plot cost what it cost'
        : 'The mains: a bill, not a supply',
        `Tank ${tankCost}, then ${money(water.deliveryCost || 400)} a delivery`,
        w.stream ? 'stream' : (w.tank ? 'tank' : 'none'),
        !w.stream && !!w.tank && cap != null && store < cap * 0.3,
        w.tank && cap
          ? `${Math.round((100 * store) / cap)}% of ${cap.toLocaleString('en-ZA')} L`
          + (use ? ` (${Math.floor(store / use)} days)` : '')
          : (w.stream ? 'running water' : 'no storage on the plot')),
      row('food', 'Food', 'The shop counter, which has a fixed appetite',
        'Beds, hives, and the walk down the pass',
        (h.beds || []).length ? 'beds' : 'none',
        (h.produce || 0) >= SHOP.vegCapacity * STORY.glutShare,
        `the shop takes ${SHOP.vegCapacity} kg a day at ${money(vegPrice(h.date))}`),
      row('wallet', 'Wallet', 'This month\'s cash',
        `${BANK.manager}: ${money(BANK.restructureStep)} on the bond, ${BANK.maxRestructures} times`,
        h.bank && h.bank.restructures ? 'restructured' : 'none',
        h.arrears > 0,
        `${h.arrears || 0} month(s) in arrears, ${Math.round(h.cash).toLocaleString('en-ZA')} in hand`),
    ],
  };
}
