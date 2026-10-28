import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)
// firewood.js — the winter verb (LD-02 + LD-04 from LEVEL-DESIGN-AUDIT.md).
//
// Winter used to be a flat tax: −H$5k to −H$15k for everyone, nothing to do about it. Now
// every tree you fell leaves offcuts that stack as firewood loads, and for the four cold
// months the village buys them. The decision the audit asked for: fell in autumn and
// stack, or sell the trees standing — the wood is worth more to you in May than in March.
//
// Owner GO 2026-10-19. Prices from DESIGN-RETHINK §6 (H$1,200/load in winter). Pure logic,
// no DOM — the gate imports this directly.
//
// ---- THE WOOD HIERARCHY (owner GO 2026-10-21, pinned so no future seat "fixes" it) ----
//   BUILD  >  SELL  >  BURN
// A pine stem saws into 2 lumber units. Those units are worth most off a build (H$500 a
// unit, so 14 units is H$7,000 off the cabin — far more than H$1,330 of poles).
// Second-best is the yard: H$95 a unit, H$150 a trip, 10 units a trip. Last is the fire:
// burning a stem is the quick verb, and the village's appetite is CAPPED at 6 loads a week
// — beyond that it pays off-season money. The quick verb is capped; the industry (build,
// then sell) is not. Pine is not firewood (0.25 load a stem) and wattle is not millable —
// the split is the point, not a bug.
//
// LD-11 (owner GO 2026-10-22): the build discount is a FLAT H$ a unit, not 30% of the
// build. A percentage made the same wood worth H$5,880 on seven hives and H$72,000 on the
// cabin, so whoever built first ate the timber — a H$66k swing the player could not see.
// Flat value also makes the sentence above true: 14 units is H$7,000 whether they go into
// a cabin or a tank.

export const FIREWOOD = {
  perTree: 0.5,          // two felled trees make one load — the OLD kind-blind rule
  // The wood split (owner GO 2026-10-21): "pine cannot be firewood. other trees cannot
  // be milled." Loads per felled stem, by kind:
  pineYield: 0.25,       // pine is resinous rubbish on the fire — a quarter load of offcuts
  wattleYield: 1.0,      // wattle/blackwood: the full load it always gave (burns clean)
  indigenousYield: 0.5,  // indigenous: half a load, and NO lumber (it cannot be milled)
  // Firewood is a survival resource, like water:
  householdBurn: 0.10,   // the homestead's own hearth, loads per night, May–August
  guestBurn: 0.05,       // every winter let night in a hearth house burns this much
  winterNights: 120,     // May–August — the reserve is priced against a whole winter
  hearthReserve: 12,     // 0.10 × 120: the household's own winter, never for sale
  guestWinterNights: 60, // expected let nights per hearth unit across May–August
  coldHouseNight: 120,   // a dry stack in winter: paraffin and blankets, per night
  winterPrice: 1200,     // May–Aug: the village burns wood
  offSeasonPrice: 400,   // nobody lights a fire in January, but somebody always buys
  maxPerSale: 3,         // the bakkie carries three loads a trip
  weekCap: 6,            // the village's winter appetite: 6 loads a WEEK at winter money
};

/** The yard's pole trade (owner GO 2026-10-21). A pine stem saws into 2 lumber units;
 *  the yard buys units as poles. The flat trip fee is the point: a single stem is not
 *  worth the bakkie's diesel, a full load is. */
export const POLES = {
  price: 95,             // H$ a lumber unit
  tripFee: 150,          // haulage, flat, per trip
  perTrip: 10,           // units the bakkie carries — five pine stems
};

/** H$ net for a given number of pole units (what the popup prints). */
export function polesNet(units) {
  const n = Math.max(0, Math.min(Math.floor(units) || 0, POLES.perTrip));
  return n * POLES.price - POLES.tripFee;
}

/** What one lumber unit is worth off a build (LD-11, owner GO 2026-10-22). Flat, not a
 *  percentage: the same unit must be worth the same whether it lands in a hive or a cabin,
 *  or the player is rewarded for building the expensive thing first. */
export const LUMBER_UNIT = 500;

/** The build discount. A build that needs `need` units takes H$`need × LUMBER_UNIT` off
 *  its cash IF the yard actually holds them; otherwise full price, and the units stay.
 *  Never discounts below zero — a cheap build cannot become free money. */
export function lumberOff(cost, need, have) {
  const n = Math.max(0, Math.floor(need) || 0);
  if (!n || (have || 0) < n) return { cost, used: 0, off: 0 };
  const off = Math.min(n * LUMBER_UNIT, Math.max(0, cost));
  return { cost: cost - off, used: n, off };
}

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

/** Winter here is May–August — the same months that already cost more to live through. */
export function inFirewoodSeason(date) {
  return date.month >= 5 && date.month <= 8;
}

export function firewoodPrice(date) {
  return inFirewoodSeason(date) ? FIREWOOD.winterPrice : FIREWOOD.offSeasonPrice;
}

/** Offcuts from felling. One tree = half a load; homestead.fell calls this per tree. */
export function addThinnings(h, trees = 1) {
  h.firewood = Math.round(((h.firewood || 0) + trees * FIREWOOD.perTree) * 10) / 10;
  return h.firewood;
}

/** Add whole loads directly — the kind-aware path homestead.fell uses (owner GO
    2026-10-21: pine 0.25, wattle 1.0, indigenous 0.5). Fractional loads keep stacking.
    Two decimals: a quarter load must not round up to 0.3. */
export function addFirewood(h, loads) {
  h.firewood = Math.round(((h.firewood || 0) + loads) * 100) / 100;
  return h.firewood;
}

/** Burn the stack down: the household hearth (0.10/night) and winter guests (0.05 per
 *  let night, charged in tourism). Never dips below zero. */
export function burnFirewood(h, loads) {
  h.firewood = Math.round(Math.max(0, (h.firewood || 0) - loads) * 100) / 100;
  return h.firewood;
}

/** The hearth units that host winter guests: built, listed, not a tent. Fireplaces are
 *  implicit in the rooms and cabins — no new facility (owner GO 2026-10-21). */
export function hearthUnits(h) {
  return (h.accom || []).filter((u) => u.built && u.listed && u.kind !== 'camp').length;
}

/**
 * The wood the household may NOT sell: its own winter (0.10 × 120 = 12 loads) plus
 * what the winter guests of the built, listed hearth units will burn
 * (0.05 × 60 let nights per unit = 3 loads each). The hearth comes first.
 */
export function firewoodReserve(h) {
  const hearth = FIREWOOD.hearthReserve;
  const guests = hearthUnits(h) * FIREWOOD.guestWinterNights * FIREWOOD.guestBurn;
  const total = Math.round((hearth + guests) * 10) / 10;
  return { hearth, guests: Math.round(guests * 10) / 10, total };
}

/** Sell whole loads, up to what the bakkie carries. Fractional loads keep stacking.
 *  The guard (owner GO 2026-10-21): a sale that would take the stack below the winter
 *  reserve is refused — "keeping N loads for the hearth".
 *  The cap (owner GO 2026-10-21): the village buys 6 loads a week at the winter price;
 *  beyond that the same load fetches off-season money. The quick verb is capped — the
 *  industry (build, then sell poles) is not. */
export function sellFirewood(h) {
  const reserve = firewoodReserve(h);
  const sellable = Math.floor(((h.firewood || 0) - reserve.total) + 1e-9);
  if (sellable < 1) {
    return err(`the hearth comes first — keeping ${reserve.total} loads for the hearth `
      + `and the winter guests (${Math.floor(h.firewood || 0)} stacked)`);
  }
  const loads = Math.min(sellable, FIREWOOD.maxPerSale);
  const season = inFirewoodSeason(h.date);
  let soldWeek = firewoodWeekSold(h);
  let net = 0;
  let winterLoads = 0;
  let cheapLoads = 0;
  for (let i = 0; i < loads; i++) {
    const atWinter = season && soldWeek < FIREWOOD.weekCap;
    if (atWinter) { net += FIREWOOD.winterPrice; winterLoads++; } else { net += FIREWOOD.offSeasonPrice; cheapLoads++; }
    soldWeek++;
  }
  h.firewoodWeekSold = soldWeek;
  burnFirewood(h, loads);
  h.cash += net;
  const price = winterLoads ? FIREWOOD.winterPrice : FIREWOOD.offSeasonPrice;
  const capped = cheapLoads && season ? ` · ${cheapLoads} beyond the week's six at the low price` : '';
  return ok(`Sold ${loads} load${loads === 1 ? '' : 's'} of firewood. +${money(net)}${capped}`, {
    loads, net, price, winterLoads, cheapLoads, left: Math.floor(h.firewood),
    kept: reserve.total,
  });
}

/** The week's counter, reset lazily (weeks are day-based, no calendar state to save). */
export function firewoodWeekSold(h) {
  const wk = Math.floor(((h.day || 1) - 1) / 7);
  if (h.firewoodWeek !== wk) {
    h.firewoodWeek = wk;
    h.firewoodWeekSold = 0;
  }
  return h.firewoodWeekSold || 0;
}

/** Loads the village will still take at the winter price this week. */
export function firewoodWeekLeft(h) {
  return Math.max(0, FIREWOOD.weekCap - firewoodWeekSold(h));
}

/**
 * Sell sawn lumber to the yard as poles (owner GO 2026-10-21). The mill side of the
 * wood economy: H$95 a unit, H$150 a trip, 10 units a trip. Selling four units is
 * allowed — the flat fee is what makes it a bad idea. The 30% build discount stays
 * lumber's better use (see the hierarchy at the top of this file).
 * @param {object} h household
 * @param {number} units how many units to load (clamped to the bakkie and the shed)
 */
export function sellPoles(h, units = POLES.perTrip) {
  const have = Math.floor(h.lumber || 0);
  if (have < 1) return err('nothing sawn — pine stems become lumber when you fell them');
  const want = Math.max(1, Math.floor(Number(units) || POLES.perTrip));
  const n = Math.min(have, want, POLES.perTrip);
  const gross = n * POLES.price;
  const net = gross - POLES.tripFee;
  h.lumber -= n;
  h.cash += net;
  // Bible §14.3 — the mill measures, pays and does not chat. The only thing it ever
  // remarks on is the pass, because the pass is what the load cost you before you got here.
  const pass = h.road && h.road.condition >= 50
    ? ' The weighbridge says what it says, and today it said well.'
    : ' The pass takes its cut before you do.';
  return ok(`Sold ${n} pole${n === 1 ? '' : 's'} to the yard. +${money(gross)} less `
    + `${money(POLES.tripFee)} haulage = ${net < 0 ? '−' : '+'}${money(Math.abs(net))}${pass}`, {
    units: n, gross, fee: POLES.tripFee, net, left: h.lumber,
  });
}
