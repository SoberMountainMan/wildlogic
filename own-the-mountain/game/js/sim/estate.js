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

/** A fresh household: the picker's starting purse, no ground, no debt.
 *  Slice 2 adds the world clock (month): every canonical life begins on 1
 *  September, so the valley's demand bars read 9 until a plot save carries
 *  the real month over (syncToEstate).
 *  BUG-017/018 add the LIFE: the household belongs to one life, and the pages
 *  read that to find their way back to it without a ?start= in the URL. */
export function createEstate(cash = START_CASH, life = null) {
  return { cash, debt: 0, rep: 0, owned: [], active: null, month: 9, life: life || null };
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
      // Slice 2: the per-plot skill rides the entry, never the household (snap()
      // must not see it). No upper clamp on the read path -- XP_MAX lives in
      // business.js, which imports THIS file; the write path (gainXp) clamps.
      xp: Number.isFinite(o.xp) ? Math.max(0, Math.round(o.xp)) : 0,
    });
  }
  const active = typeof j.active === 'string' && owned.some((o) => o.siteId === j.active)
    ? j.active : null;
  const month = Number.isFinite(j.month) && j.month >= 1 && j.month <= 12 ? Math.round(j.month) : 9;
  // the life the household belongs to. An estate written before BUG-017 has none, and
  // null means what it always meant: no page may infer a life from it.
  const life = typeof j.life === 'string' && j.life ? j.life : null;
  return { cash: j.cash, debt: j.debt, rep: Number.isFinite(j.rep) ? j.rep : 0, owned, active, month, life };
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
    e.owned.push({ siteId, business: biz, mortgage: true, bond, monthly, side, xp: 0 });
  } else {
    if (e.cash < price) {
      return { ok: false, msg: `the ground costs ${money(price)} -- the household has ${money(Math.round(e.cash))}` };
    }
    e.cash -= price;
    e.owned.push({ siteId, business: biz, mortgage: false, bond: 0, monthly: 0, side, xp: 0 });
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

/**
 * The household a run ALREADY IMPLIES (BUG-017, cold playtest 2026-11-15: buying a
 * second plot off the valley map replaced the money the player had earned with the
 * picker's starting purse, and stranded the run they were on).
 *
 * The valley bootstraps an estate the first time you buy as a household. When a
 * single-life save is already in play, the estate is NOT a fresh H$750 000 -- it is
 * that run's purse, and the ground it stands on joins `owned` for free, because the
 * life already paid for it at its own terms. The bond the run took becomes the
 * household's debt, so the header's debt stays true, and the per-site save is left
 * exactly where it is: the run does not restart, it just gains a household above it.
 *
 * Ground the land catalog does not know -- the three canonical start plots -- cannot
 * be an owned entry (loadEstate refuses an estate naming unknown ground). Such a run
 * contributes its purse and its life, and stays reachable as the life's own save:
 * `plot.html?start=<life>` with no `?site=`, which is what the switcher links to.
 *
 * Pure: builds a state, writes nothing. The caller saves it, then buys on it.
 * @param {{life?:string|null, cash?:number, siteId?:string|null, side?:string|null,
 *          business?:string|null, bond?:number, monthly?:number, month?:number}} run
 */
export function adoptRun(run = {}) {
  const cash = Number.isFinite(run.cash) ? Math.round(run.cash) : START_CASH;
  const e = createEstate(cash, typeof run.life === 'string' ? run.life : null);
  if (Number.isFinite(run.month) && run.month >= 1 && run.month <= 12) e.month = Math.round(run.month);
  const site = run.siteId ? SITE_BY_ID[run.siteId] : null;
  if (!site) return e;                       // the purse is the household's; the ground has its own save
  const bond = Number.isFinite(run.bond) && run.bond > 0 ? Math.round(run.bond) : 0;
  const monthly = Number.isFinite(run.monthly) && run.monthly > 0 ? Math.round(run.monthly) : 0;
  e.debt = bond;
  e.owned.push({
    siteId: site.id,
    business: typeof run.business === 'string' ? run.business : suitedBusinesses(site)[0],
    mortgage: bond > 0,
    bond,
    monthly,
    side: typeof run.side === 'string' ? run.side : site.roadSide,
    xp: 0,
  });
  e.active = site.id;
  return e;
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
 *  plot -- on this page or another -- opens with the same purse. Slice 2 adds the
 *  world clock: the plot's month rides out too, so the valley's demand bars read
 *  the real season instead of the September anchor. */
export function syncToEstate(h, e) {
  e.cash = h.cash;
  if (h.date && Number.isFinite(h.date.month)) e.month = h.date.month;
  return e;
}