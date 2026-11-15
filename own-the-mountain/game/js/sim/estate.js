// estate.js -- the household above the plots (Hogsback Life Simulator, Slice 1).
//
// The life-sim reframe (owner, 2026-11-15): one household owns many of the 30
// mountain plots, each runs a business, and the valley map is a live portfolio.
// That needs a META layer the single-plot sim never had: one wallet, one debt,
// one reputation, a list of owned ground, and which plot is active. This module
// is that layer, and it is deliberately thin -- the plot sim (homestead.js) is
// reused unchanged; the household just supplies its cash and takes it back.
//
// Two layers, one source of truth per fact:
//   estate (this file, localStorage 'otm-estate') -- cash, debt, rep, owned, active
//   plot   (homestead save, saveKey(life, site))  -- ground, buildings, beds, guests
// estate.cash IS the household cash: a page syncs it INTO h.cash on load and OUT
// of h.cash on every save (syncFromEstate / syncToEstate), so switching plots
// carries the wallet. The plot's own bond instalment still runs through the
// sim's monthlyBills unchanged -- there is no second credit system.
//
// Pure logic, no DOM. localStorage is guarded so node tests import this directly
// and pass a fake store; every function also accepts an explicit store argument.
// Nothing here is in a golden trace's path: the canonical three never load an
// estate, and snap() never sees this module.

import { SITE_BY_ID } from './sites.js';
import { LAND_MORTGAGE, bondPayment, START_CASH } from './plotmap.js';
import { money } from './fmt.js';

/** The one localStorage key the household meta lives under. */
export const ESTATE_KEY = 'otm-estate';

/** The business identities a plot can commit to (Slice 2 gives them loops).
 *  Keys are stored on owned entries; labels are what the valley map prints. */
export const BUSINESSES = {
  farm: 'Farm / orchard',
  host: 'Host / B&B',
  forestry: 'Forestry',
  'water-energy': 'Water & energy',
  trade: 'Trade / stall',
  eco: 'Conservation / eco',
};

/** The storage a call reads/writes: the explicit one, else the browser's, else
 *  none (node). Same guard saves.js uses, so a test never touches a real store. */
function storeOf(store) {
  return store || (typeof localStorage !== 'undefined' ? localStorage : null);
}

/** A fresh household: the picker's starting purse, no ground, no debt. */
export function createEstate(cash = START_CASH) {
  return { cash, debt: 0, rep: 0, owned: [], active: null };
}

/**
 * Read the household, or null when there is none / it cannot be trusted.
 * A state that cannot be read is treated as no state at all (the saves.js
 * convention): the pages fall back to the single-plot path rather than
 * promising a wallet they cannot deliver. Normalises every field so a
 * save/load roundtrip is stable.
 * @param {Storage} [store]
 */
export function loadEstate(store) {
  const s = storeOf(store);
  if (!s) return null;
  let j = null;
  try { j = JSON.parse(s.getItem(ESTATE_KEY)); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  if (!Number.isFinite(j.cash) || !Number.isFinite(j.debt)) return null;
  if (!Array.isArray(j.owned)) return null;
  const owned = [];
  for (const o of j.owned) {
    // an entry naming ground the catalog does not know is a corrupt estate,
    // not a plot to silently drop -- the wallet would not add up
    if (!o || !SITE_BY_ID[o.siteId]) return null;
    owned.push({
      siteId: o.siteId,
      business: typeof o.business === 'string' ? o.business : null,
      mortgage: !!o.mortgage,
      bond: Number.isFinite(o.bond) ? o.bond : 0,
      monthly: Number.isFinite(o.monthly) ? o.monthly : 0,
      side: typeof o.side === 'string' ? o.side : null,
    });
  }
  const active = typeof j.active === 'string' && owned.some((o) => o.siteId === j.active)
    ? j.active : null;
  return { cash: j.cash, debt: j.debt, rep: Number.isFinite(j.rep) ? j.rep : 0, owned, active };
}

/** Write the household. Returns false when there is no store (node, private mode). */
export function saveEstate(e, store) {
  const s = storeOf(store);
  if (!s || !e) return false;
  try { s.setItem(ESTATE_KEY, JSON.stringify(e)); return true; } catch { return false; }
}

/** The owned ground, as a copy -- a caller cannot mutate the estate by accident. */
export function ownedPlots(e) {
  return e && Array.isArray(e.owned) ? e.owned.slice() : [];
}

/** Does this household own that ground? */
export function ownsPlot(e, siteId) {
  return ownedPlots(e).some((o) => o.siteId === siteId);
}

/**
 * Buy one of the 30 sites, cash or bond, on the SAME land terms the picker
 * quotes (LAND_MORTGAGE: 15% down, 8 years, no fees). The deposit or the full
 * price leaves the shared wallet; a bond's principal joins the shared debt.
 * Refuses -- with the state untouched -- when the household cannot raise the
 * money, already owns the ground, or names ground the catalog does not know.
 * Buying makes the plot active: it is the one you are looking at.
 * @param {object} e the estate (mutated on success only)
 * @param {string} siteId a sites.js id
 * @param {{mortgage?:boolean, business?:string|null, side?:string|null}} [opts]
 */
export function buyPlot(e, siteId, { mortgage = false, business = null, side = null } = {}) {
  if (!e || !Array.isArray(e.owned)) return { ok: false, msg: 'no household to buy for' };
  const site = SITE_BY_ID[siteId];
  if (!site) return { ok: false, msg: 'no such ground on the mountain' };
  if (ownsPlot(e, siteId)) return { ok: false, msg: 'this ground is already yours' };
  const price = site.price;
  const deposit = Math.round(price * LAND_MORTGAGE.depositFrac);
  const bond = price - deposit;
  const monthly = bondPayment(bond, LAND_MORTGAGE.rate, LAND_MORTGAGE.years);
  const biz = business || suitedBusinesses(site)[0];
  if (mortgage) {
    if (e.cash < deposit) {
      return { ok: false, msg: `the deposit is ${money(deposit)} -- the household has ${money(Math.round(e.cash))}` };
    }
    e.cash -= deposit;
    e.debt += bond;
    e.owned.push({ siteId, business: biz, mortgage: true, bond, monthly, side });
  } else {
    if (e.cash < price) {
      return { ok: false, msg: `the ground costs ${money(price)} -- the household has ${money(Math.round(e.cash))}` };
    }
    e.cash -= price;
    e.owned.push({ siteId, business: biz, mortgage: false, bond: 0, monthly: 0, side });
  }
  e.active = siteId;
  return {
    ok: true,
    msg: mortgage
      ? `${money(deposit)} down, ${money(monthly)} a month for ${LAND_MORTGAGE.years} years`
      : `${money(price)} paid outright`,
    price, deposit: mortgage ? deposit : price, bond: mortgage ? bond : 0, monthly: mortgage ? monthly : 0,
  };
}

/** Switch the active plot. Refuses ground the household does not own. */
export function setActive(e, siteId) {
  if (!ownsPlot(e, siteId)) return { ok: false, msg: 'you do not own that ground' };
  e.active = siteId;
  return { ok: true };
}

/**
 * What this ground is good for, read off the catalog attributes -- the same
 * reads the bake measured (water, forest, slope, distance to the shop).
 * Rules (HOGSBACK-LIFE-SIMULATOR.md section 4): stream + flat => farm/host; pine or
 * mixed => forestry; dam-site => water & energy; near the shop => trade;
 * indigenous => conservation. Every plot reads 2-3 ways: a floor of two keeps
 * the rough ground honest (it is water + forestry, not nothing), a cap of three
 * keeps the card readable on a phone. When more than three rules fire, the
 * DISTINCTIVE ground wins the slots: a stream keeps farm AND host, a dam keeps
 * water & energy, the shop front keeps trade -- generic forestry yields first.
 * Flat = slopePct <= 16: the good tier was baked at 8.5-15.1%, the rough at
 * 27%+, so 16 splits the tiers the way the catalog does. Pure, no RNG.
 * @param {object} site a SITES entry
 * @returns {string[]} 2-3 business keys, strongest first
 */
export function suitedBusinesses(site) {
  const flat = site.slopePct <= 16;
  const near = site.kmFromShop <= 2;
  const picks = [];
  if (site.water === 'stream' && flat) picks.push('farm');
  if (flat && (site.water === 'stream' || near)) picks.push('host');
  if (site.water === 'dam-site') picks.push('water-energy');
  if (near) picks.push('trade');
  if (site.forest === 'indigenous') picks.push('eco');
  if (site.forest === 'pine' || site.forest === 'mixed') picks.push('forestry');
  for (const b of ['forestry', 'host', 'farm', 'trade', 'water-energy', 'eco']) {
    if (picks.length >= 2) break;
    if (!picks.includes(b)) picks.push(b);
  }
  return picks.slice(0, 3);
}

/**
 * The startPlan-shaped terms for an OWNED plot, so plot.html can hand them to
 * newHomestead without a second purchase: the bond is the one the household
 * already took, and cashLeft is the shared wallet as it stands now. null when
 * the household does not own the ground.
 * @param {object} e the estate
 * @param {string} siteId
 */
export function plotPlan(e, siteId) {
  const o = ownedPlots(e).find((x) => x.siteId === siteId);
  const site = SITE_BY_ID[siteId];
  if (!o || !site) return null;
  const deposit = o.mortgage ? Math.round(site.price * LAND_MORTGAGE.depositFrac) : site.price;
  return {
    price: site.price,
    deposit,
    bond: o.bond,
    monthly: o.monthly,
    upFront: deposit,
    cashLeft: e.cash,
  };
}

/** The wallet IN: a plot's household cash is the household's, on every load. */
export function syncFromEstate(h, e) {
  h.cash = e.cash;
  return h;
}

/** The wallet OUT: every plot save writes the household cash back, so the next
 *  plot -- on this page or another -- opens with the same purse. */
export function syncToEstate(h, e) {
  e.cash = h.cash;
  return e;
}