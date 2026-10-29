// director.js — the invisible hand that paces the year.
//
// RimWorld's storyteller, cut down to size: not a plot, just a sense of timing. When you
// are comfortable the mountain sends you bills; when you are broke it sends you a film
// crew. The player should never feel the hand, only that the year has weather in it.

export const DIRECTOR = {
  minGap: 9,          // days between events
  maxGap: 21,
};

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });

export function initDirector(h) {
  h.director = h.director || { nextDay: 6, rng: 90210, count: 0, last: null };
  return h;
}

function rnd(h) {
  h.director.rng = (Math.imul(1664525, h.director.rng >>> 0) + 1013904223) >>> 0;
  return h.director.rng / 4294967296;
}

/** Rough daily burn, for judging how comfortable the household is. */
export function dailyBurn(h) {
  const wages = (h.workers || 0) * 180;
  const bond = (h.bond && h.bond.monthly ? h.bond.monthly : 0) / 30;
  const bills = ((h.services && h.services.water ? 450 : 0) + (h.services && h.services.eskom ? 1100 : 0) + 400) / 30;
  return 180 + wages + bond + bills;
}

/** How many months of runway are left. */
export function runway(h) { return h.cash / Math.max(1, dailyBurn(h) * 30); }

export function pressure(h) {
  const r = runway(h);
  if (r > 6) return 'comfortable';
  if (r < 2) return 'tight';
  return 'steady';
}

// Gate 1 (owner 10-28, narrative audit 25.1): a charged incident says so. The money has
// already moved and nothing is owed - every cost line ends with the same promise, and the
// one line that DOES leave work (the fallen pine) names the work and where to do it.
const COST = [
  { id: 'pipe', text: 'A pipe burst under the kitchen. −H$3 500 — seen to the same morning; nothing to do.', zar: -3500 },
  { id: 'fence', text: 'The fence came down in the wind. −H$1 800 — paid on the spot and put back up; nothing to do.', zar: -1800 },
  { id: 'geyser', text: 'The geyser gave up. −H$4 500 — replaced the same morning; nothing to do.', zar: -4500 },
  { id: 'tree', text: 'A pine came down across the road. −8% road — patch it before the next rain (Siteworks).', road: -8 },
];

const GAIN = [
  { id: 'film', text: 'A film crew paid for three quiet days. +H$6 000 — booked, not hosted.', zar: 6000 },
  { id: 'tip', text: 'A guest left a tip and a thank-you note. +H$900', zar: 900 },
  { id: 'neighbour', text: 'A neighbour bought your whole harvest. +H$1 200', zar: 1200 },
  { id: 'review', text: 'A guest told the whole of East London about you. ★ +0.15', rating: 0.15 },
];

const FLAVOUR = [
  'A porcupine took up residence under the stoep.',
  'Three days of mist. The valley disappeared.',
  'All three peaks out at once at sunrise.',
  'The hadedas are back. Everyone has an opinion about it.',
  'A neighbour dropped off a jar of fig jam and stayed an hour.',
];

/** Fire an event if it is time. Returns {event} or null. */
/* ---- the grapevine seam (L9, owner GO 2026-10-23) --------------------------------
   The narrative seat writes the village's flavour (the pothole raised at the ratepayers'
   meeting "by name — the pothole's, not yours"; the market asking after your rates). This
   file decides WHEN a flavour line is due; they decide what it says.
   Registered with setFlavourHook(fn) where fn is (h) => string | null.
   It fires in the SAME slot the built-in FLAVOUR pool uses, after the same RNG draw — so
   a hook cannot change the director's rhythm, and with no hook registered the village
   speaks exactly as it always did. */
let FLAVOUR_HOOK = null;
export function setFlavourHook(fn) { FLAVOUR_HOOK = typeof fn === 'function' ? fn : null; }
export function hasFlavourHook() { return !!FLAVOUR_HOOK; }

export function tickDirector(h) {
  initDirector(h);
  if (h.day < h.director.nextDay) return null;

  const p = pressure(h);
  const roll = rnd(h);
  let pool;
  if (p === 'comfortable') pool = roll < 0.62 ? COST : roll < 0.82 ? GAIN : FLAVOUR;
  else if (p === 'tight') pool = roll < 0.2 ? COST : roll < 0.8 ? GAIN : FLAVOUR;
  else pool = roll < 0.45 ? COST : roll < 0.75 ? GAIN : FLAVOUR;

  const ev = pool[Math.floor(rnd(h) * pool.length) % pool.length];
  let out = typeof ev === 'string'
    ? { id: 'flavour', kind: 'flavour', text: ev }
    : { ...ev, kind: pool === COST ? 'cost' : 'gain' };
  // the narrative seat's line takes the flavour slot, if one is registered. The draw
  // above already happened, so the director's rhythm is untouched either way.
  if (pool === FLAVOUR && FLAVOUR_HOOK) {
    let said = null;
    try { said = FLAVOUR_HOOK(h); } catch { said = null; }
    if (typeof said === 'string' && said.trim()) {
      out = { id: 'flavour', kind: 'flavour', text: said.trim() };
    }
  }

  if (out.zar) h.cash += out.zar;
  // BUG-002 (playtest 2026-10-25): a cost the player did not choose used to move cash in
  // silence. Keep the last one on the household so the status bar can announce it with the
  // number and the reason. Display-side only — `snap()` is a whitelist, so no golden moves.
  if (out.zar) h.lastHit = { day: h.day, amount: out.zar, why: out.text };
  if (out.road) h.road.condition = Math.max(0, h.road.condition + out.road);
  if (out.rating) h.rating = Math.min(5, h.rating + out.rating);

  h.director.count += 1;
  h.director.last = out.id || out.text;
  h.director.nextDay = h.day + DIRECTOR.minGap + Math.floor(rnd(h) * (DIRECTOR.maxGap - DIRECTOR.minGap));
  h.log.push({ day: h.day, text: out.text });
  return { ...out, pressure: p };
}

export function directorSummary(h) {
  initDirector(h);
  return {
    pressure: pressure(h),
    runway: Math.round(runway(h) * 10) / 10,
    events: h.director.count,
    next: Math.max(0, h.director.nextDay - h.day),
  };
}
