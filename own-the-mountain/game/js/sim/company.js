// company.js — the incumbent.
//
// One company owns the pine on the mountain and pays the village's wages. It will buy
// the standing timber on your plot for cash, today, in full. Take the money and the
// trees are gone: no shade, no birds, and nothing left for the guests to come and see.
//
// That is the whole game in one irreversible decision. Pure logic, no DOM.

import { PRICES, STEM_M3 } from './plotmap.js';
import { initCompanyVoice } from './companyVoice.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

export const COMPANY = {
  name: 'Amatola Forestry',
  premium: 1.15,        // they pay 15% over standing value to get it done quickly
  forestWeight: 0.55,   // how much of the booking rate depends on the trees
  contractM3: 40,       // a month's quota
  contractPay: 26000,   // ~44% over what the same trees fetch standing
  contractDays: 28,
  // Owner ruling (2026-10-21): the thing decay was eating was never "the valley" — it is
  // the indigenous forest ON the mountain, which Amatola is converting to plantation.
  // Same 0-100 meaning, an honest name. The tension is timber farming vs tourism.
  cuttingRate: { neutral: 0.10, supplier: 0.14, opposed: 0.04, owner: 0, left: 0.02 },
  mountainWeight: 0.3,  // how much the mountain forest's state moves bookings
};

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function pineOnPlot(h) { return h.plot.trees.filter((t) => t.kind === 'pine'); }

/** What the company will pay for the standing pine, in full, today. */
export function offerValue(h) {
  return Math.round(pineOnPlot(h).length * STEM_M3.pine * PRICES.pineTree * COMPANY.premium);
}

export function initCompany(h) {
  h.company = h.company || { taken: false, refused: false, paid: 0, treesSold: 0, relation: 'neutral' };
  // Save migration (owner ruling 2026-10-21): old saves carry h.valley = { health };
  // it was always the indigenous forest on the mountain.
  if (h.valley && !h.mountain) h.mountain = { forest: h.valley.health };
  h.mountain = h.mountain || { forest: 100 };
  delete h.valley;
  h.contract = h.contract || { state: 'none', m3: 0, dueDay: 0, delivered: 0, paid: 0 };
  // Forest health is simply how much of the original tree cover is still standing,
  // less the household's native/oak felling penalty (homestead.nativeForestHit —
  // a native cut costs the forest three times what a pine cut costs).
  if (h.forestStart == null) h.forestStart = Math.max(1, h.plot.trees.length);
  h.forest = clamp(100 * h.plot.trees.length / h.forestStart - (h.forestPenalty || 0), 0, 100);
  const n = pineOnPlot(h).length;
  // DEFECT (found by qa, 2026-10-20, tests/29): the offer used to be a stale snapshot —
  // quoted once, paid in full at acceptance, so pines felled BY HAND were paid a second
  // time inside the standing-timber offer. The offer now tracks the LIVE stand: van Wyk
  // quotes the standing price to the rand, and what is standing changes when you cut.
  // Shape contract: an offer is ALWAYS null or a live quote — never undefined.
  if (!h.company.taken && !h.company.refused) {
    h.company.offer = n
      ? { zar: offerValue(h), trees: n, m3: Math.round(n * STEM_M3.pine * 10) / 10 }
      : null;
  } else if (h.company.offer) {
    h.company.offer = null;
  }
  initCompanyVoice(h);
  return h;
}

/** How much the forest matters to a guest: 1.0 with the trees, 0.45 stripped bare. */
export function forestFactor(h) {
  const f = clamp(h.forest == null ? 100 : h.forest, 0, 100) / 100;
  return (1 - COMPANY.forestWeight) + COMPANY.forestWeight * f;
}

/** Take the money. The trees go. This cannot be undone. */
export function acceptOffer(h) {
  initCompany(h);
  const offer = h.company.offer;
  if (!offer) return err('there is no offer on the table');
  if (h.company.taken) return err('you already sold the standing timber');
  if (h.company.refused) return err('you already turned them down');

  const pine = pineOnPlot(h);
  h.plot.trees = h.plot.trees.filter((t) => t.kind !== 'pine');
  // pay the LIVE stand — initCompany has just re-quoted it, so offer.zar is current
  h.cash += offer.zar;
  h.company.taken = true;
  h.company.paid = offer.zar;
  h.company.treesSold = pine.length;
  h.company.offer = null;
  h.forest = clamp(100 * h.plot.trees.length / h.forestStart, 0, 100);

  h.log.push({ day: h.day, text: `${COMPANY.name} bought ${pine.length} pines for ${money(offer.zar)}. The plot is bare.` });
  return ok('sold to the company', { zar: offer.zar, trees: pine.length, forest: h.forest });
}

/** Turn them down. The offer does not come back. */
export function refuseOffer(h) {
  initCompany(h);
  if (!h.company.offer) return err('there is no offer on the table');
  if (h.company.taken) return err('you already sold');
  h.company.refused = true;
  h.company.offer = null;
  h.log.push({ day: h.day, text: `You told ${COMPANY.name} no. The pines stay.` });
  return ok('refused');
}

/** The mountain's indigenous forest is theirs to cut, whether or not you approve. */
export function mountainFactor(h) {
  initCompany(h);
  return (1 - COMPANY.mountainWeight) + COMPANY.mountainWeight * (h.mountain.forest / 100);
}

/** Felling on your own plot counts towards an open contract. */
export function noteFelled(h, m3, kind) {
  initCompany(h);
  if (kind !== 'pine') return;
  if (h.contract.state === 'active') {
    h.contract.delivered = Math.round((h.contract.delivered + m3) * 100) / 100;
  }
}

/** They offer a quota on the 1st, unless you have told them where to go. */
export function maybeOfferContract(h) {
  initCompany(h);
  if (h.date.day !== 1) return null;
  if (h.company.relation === 'opposed' || h.company.relation === 'owner' || h.company.relation === 'left') return null;
  if (h.contract.state === 'active') return null;
  h.contract = {
    state: 'offered',
    m3: COMPANY.contractM3,
    dueDay: h.day + COMPANY.contractDays,
    delivered: 0,
    paid: h.contract.paid || 0,
  };
  h.log.push({
    day: h.day,
    text: `${COMPANY.name} wants ${COMPANY.contractM3} m³ of pine within ${COMPANY.contractDays} days. `
      + `They will pay ${money(COMPANY.contractPay)}.`,
  });
  return h.contract;
}

export function acceptContract(h) {
  initCompany(h);
  if (h.contract.state !== 'offered') return err('there is no contract to accept');
  h.contract.state = 'active';
  h.company.relation = 'supplier';
  h.log.push({ day: h.day, text: `You signed with ${COMPANY.name}.` });
  return ok('signed', { dueDay: h.contract.dueDay, m3: h.contract.m3 });
}

export function declineContract(h) {
  initCompany(h);
  if (h.contract.state !== 'offered') return err('there is no contract to decline');
  h.contract.state = 'declined';
  h.log.push({ day: h.day, text: `You did not sign with ${COMPANY.name} this month.` });
  return ok('declined');
}

/** Judge an open contract. Called every day. */
export function tickCompany(h) {
  initCompany(h);

  // the mountain keeps being cut — unless you own it, or they have gone
  const rate = COMPANY.cuttingRate[h.company.relation] ?? COMPANY.cuttingRate.neutral;
  h.mountain.forest = Math.max(0, h.mountain.forest - rate);
  if (h.company.relation === 'owner' || h.company.relation === 'left') {
    if (h.contract.state === 'active') h.contract.state = 'declined';
    return null;
  }

  if (h.contract.state !== 'active') return null;
  if (h.day < h.contract.dueDay) return null;

  const done = h.contract.delivered >= h.contract.m3;
  if (done) {
    h.cash += COMPANY.contractPay;
    h.contract.state = 'done';
    h.contract.paid = (h.contract.paid || 0) + COMPANY.contractPay;
    h.log.push({ day: h.day, text: `Contract met: ${h.contract.m3} m³ delivered. +${money(COMPANY.contractPay)}` });
    return { ok: true, paid: COMPANY.contractPay };
  }
  h.contract.state = 'failed';
  // LD-09 (adversarial probe, 2026-10-20): a failed quota used to be FREE — 17 signed,
  // 15-17 failed, zero penalty. Now the first miss draws the schedule line and a SECOND
  // missed quota ends the supply relationship. The Company is not a villain, but it
  // keeps books. The count lives on the HOUSEHOLD, not the contract — each new quota
  // replaces the contract object, and the grudge outlives the paperwork.
  h.quotaFails = (h.quotaFails || 0) + 1;
  if (h.quotaFails === 1) {
    h.log.push({
      day: h.day,
      text: `You delivered ${Math.round(h.contract.delivered)} of ${h.contract.m3} m³. No payment. `
        + `Van Wyk: "The quota does not care about your bookings. That is not cruelty. It is a schedule."`,
    });
  } else {
    h.company.relation = 'opposed';
    h.log.push({
      day: h.day,
      text: `You delivered ${Math.round(h.contract.delivered)} of ${h.contract.m3} m³. No payment — `
        + `and that was the second missed quota. ${COMPANY.name} will not be asking again.`,
    });
  }
  return { ok: false, delivered: h.contract.delivered };
}

/** Join the ratepayers and refuse to supply. Slows them down; costs you the contracts. */
export function oppose(h) {
  initCompany(h);
  if (h.company.relation === 'opposed') return err('you already refused to supply them');
  h.company.relation = 'opposed';
  if (h.contract.state === 'offered' || h.contract.state === 'active') h.contract.state = 'declined';
  h.log.push({ day: h.day, text: `You joined the ratepayers. ${COMPANY.name} will not be asking again.` });
  return ok('opposed');
}

/** The trade-off, said plainly (owner ruling 2026-10-21): one line per stance, in the
 *  game's own voice. Money, saws and trucks — what you chose and what it does. */
export function stanceSummary(h) {
  initCompany(h);
  const pay = `${money(Math.round(COMPANY.contractPay / 1000))}k`;
  const LINES = {
    supplier: `You signed. ${pay} a month — their saws run faster, and their trucks chew your road.`,
    neutral: 'They cut whether you like it or not. The trucks pass most days.',
    opposed: 'You are fighting them. The saws slow down. So does the money.',
    owner: 'The mountain is yours. The saws are silent.',
    left: 'Gone — the mountain breathes. The road is quiet.',
  };
  return { stance: h.company.relation, line: LINES[h.company.relation] || '' };
}

export function companySummary(h) {
  initCompany(h);
  return {
    name: COMPANY.name,
    forest: Math.round(h.forest),
    offer: h.company.offer,
    taken: h.company.taken,
    refused: h.company.refused,
    paid: h.company.paid,
    treesSold: h.company.treesSold,
    factor: Math.round(forestFactor(h) * 100),
    relation: h.company.relation,
    mountainForest: Math.round(h.mountain.forest),
    mountainFactor: Math.round(mountainFactor(h) * 100),
    contract: h.contract.state === 'none' ? null : {
      state: h.contract.state,
      m3: h.contract.m3,
      delivered: Math.round(h.contract.delivered * 10) / 10,
      dueIn: Math.max(0, h.contract.dueDay - h.day),
      pay: COMPANY.contractPay,
      paid: h.contract.paid || 0,
    },
  };
}
