// offers.js — the mountain asks, once in a while (owner GO 2026-11-15, "take #1").
//
// The 11-14 cold playtest found the dead middle: days 13-30 were seventeen straight
// "End the day" clicks with nothing to decide. The director's incidents are deliberately
// auto-settled ("nothing to do"), so they pace the year but never ask the player anything.
// This module adds the missing half: an OPTIONAL take-it-or-leave-it offer, on its own
// cadence, each one a real trade-off wired to an EXISTING verb and an EXISTING price.
// No new economy is invented here — the wage, the shop premium and the wood split are
// injected from homestead so there is exactly one source for every balance number.
//
// Pure logic, no DOM. tickOffers only ever sets h.offers.pending (a question); it never
// moves cash, produce or trees, so the golden trace (which never answers an offer) is
// byte-identical. answerOffer is the player's decision and is the only mutation path.

import { FIREWOOD, addFirewood, firewoodPrice, firewoodReserve } from './firewood.js';

export const OFFER_GAP = { min: 6, max: 9 };   // days between offers, once the first lands
export const OFFER_FIRST = 12;                // the quiet stretch starts ~day 13
export const OFFER_UNTIL = 120;               // the early game; later the ladder carries it

export function initOffers(h) {
  h.offers = h.offers || { nextDay: OFFER_FIRST, rng: 424242, pending: null, answered: 0 };
  return h;
}

function rnd(h) {
  h.offers.rng = (Math.imul(1664525, h.offers.rng >>> 0) + 1013904223) >>> 0;
  return h.offers.rng / 4294967296;
}

/** The candidate offers, each gated on real state so a question is always answerable
    and always about something the player actually has. `ctx` carries the homestead's
    own constants and its wattle-fell verb, so balance lives in one place. */
function candidates(h, ctx) {
  const out = [];
  const reserve = firewoodReserve(h).total;
  const stack = h.firewood || 0;
  if (stack < reserve) {
    const loads = 3;
    const price = firewoodPrice(h.date);
    out.push({
      id: 'firewood',
      title: 'A neighbour has more offcuts than fires.',
      body: `He will sell you ${loads} loads at today's price — ${price === FIREWOOD.winterPrice ? 'winter' : 'off-season'} money, `
        + `H$${(loads * price).toLocaleString('en-ZA')} the lot. You have ${Math.floor(stack)} loads on the stack. The hearth wants ${reserve}.`,
      accept: `Buy ${loads} loads (−H$${(loads * price).toLocaleString('en-ZA')})`,
      decline: 'Keep the cash',
      consequence: `A stack at zero in the cold months costs H$${FIREWOOD.coldHouseNight} a night in paraffin, and the hearth `
        + 'reserve is not yours to sell.',
    });
  }
  if ((h.produce || 0) >= 20) {
    const kg = Math.floor(h.produce);
    const offer = Math.max(1, ctx.shopPerKg - 10);   // a discount for immediacy, shop is the reference
    out.push({
      id: 'produce',
      title: 'Someone at the gate will buy your harvest today.',
      body: `They will pay H$${offer} a kilo for the ${kg} kg you are holding, cash in hand. The shop pays H$${ctx.shopPerKg} a kilo, and `
        + 'the shop is down the pass.',
      accept: `Sell ${kg} kg now (+H$${(kg * offer).toLocaleString('en-ZA')})`,
      decline: 'Keep it for the shop',
      consequence: 'The gate pays less per kilo and pays now. The shop run is the trip you did not make.',
    });
  }
  const wattle = (h.plot.trees || []).filter((t) => t.kind === 'wattle' || t.kind === 'blackwood');
  if (wattle.length >= 4) {
    out.push({
      id: 'crew',
      title: 'A crew is up the road, looking for work.',
      body: `For the day wage, H$${ctx.wage}, they will drop four wattle and stack the offcuts — alien wood the mill will not take and `
        + 'the fire will.',
      accept: `Hire the crew (−H$${ctx.wage})`,
      decline: 'Wave them on',
      consequence: 'Four stems down and the offcuts stacked, without your chainsaw. You could do it for nothing; this is the version '
        + 'where someone else does.',
    });
  }
  return out;
}

/** Fire an offer if one is due. Returns the pending offer or null. Never mutates a
    golden-visible field — it only asks. */
export function tickOffers(h, ctx) {
  initOffers(h);
  const o = h.offers;
  if (h.ended || o.pending) return o.pending || null;
  if (h.day < o.nextDay || h.day > OFFER_UNTIL) return null;
  const pool = candidates(h, ctx);
  if (!pool.length) { o.nextDay = h.day + 3; return null; }
  const pick = pool[Math.floor(rnd(h) * pool.length)];
  o.pending = pick;
  return pick;
}

/** The player's answer. The only mutation path. `ctx.fellWattle(id)` is homestead.fell
    bound to a wattle id, so the wood split and its notes stay the sim's own. */
export function answerOffer(h, accept, ctx) {
  initOffers(h);
  const o = h.offers;
  const p = o.pending;
  if (!p) return { ok: false, msg: 'nothing is being offered' };
  let msg;
  if (accept) {
    if (p.id === 'firewood') {
      const loads = 3, cost = loads * firewoodPrice(h.date);
      if (h.cash < cost) return { ok: false, msg: `that lot is H$${cost} and you have H$${Math.round(h.cash)}` };
      h.cash -= cost; addFirewood(h, loads);
      msg = `Bought ${loads} loads of wattle offcuts. The stack is ${Math.floor(h.firewood)} loads.`;
    } else if (p.id === 'produce') {
      const kg = Math.floor(h.produce), offer = Math.max(1, ctx.shopPerKg - 10);
      h.cash += kg * offer; h.produce -= kg;
      msg = `Sold ${kg} kg at the gate for H$${(kg * offer).toLocaleString('en-ZA')}. The bed is clear.`;
    } else if (p.id === 'crew') {
      if (h.cash < ctx.wage) return { ok: false, msg: `the crew wants H$${ctx.wage} and you have H$${Math.round(h.cash)}` };
      h.cash -= ctx.wage;
      const wattle = (h.plot.trees || []).filter((t) => t.kind === 'wattle' || t.kind === 'blackwood').slice(0, 4);
      for (const t of wattle) ctx.fellWattle(t.id);
      msg = `The crew dropped ${wattle.length} wattle and stacked the offcuts. Ground is open.`;
    }
    o.answered += 1;
  } else {
    msg = `You let the ${p.id === 'firewood' ? 'offcuts' : p.id === 'produce' ? 'harvest' : 'crew'} go. The mountain shrugs.`;
  }
  o.pending = null;
  o.nextDay = h.day + OFFER_GAP.min + Math.floor(rnd(h) * (OFFER_GAP.max - OFFER_GAP.min));
  return { ok: true, msg };
}
