// familyVoice.js — your brother, the family claim.
//
// NARRATIVE-BIBLE §5.4. For the One Who Stayed only. He never left the mountain, he has
// a half-share, and he thinks the pines are the family's pension: Ma planted them for the
// harvest, not for the view. He is the counterweight to the guest feed and the strongest
// voice for taking the Company's money. He never wins the argument and never loses it.
//
// He has no name (pillar 6): the player's family is whatever family the player brings. He
// says "you", "Ma", "the family" — never a name, never a title.
//
// Built like bank.js and companyVoice.js: constants, init, a state-triggered line, a
// summary. Every line is deterministic from state; nothing here touches the RNG streams.
// The raw line carries no prefix — familySummary adds `Your brother: "…"` for the HUD.

/** One line per state, in priority order. Keyed so a note is only ever written once. */
export const BROTHER = {
  treesRefused: {
    key: 'trees-refused',
    text: "You did what with Ma's pines? She planted those for the family, not for the view.",
  },
  treesTaken: {
    key: 'trees-taken',
    text: 'Ja. The family got paid for what the family planted. That is all I ever said.',
  },
  arrears: {
    key: 'arrears',
    text: 'There is money in those pines. There has always been money in those pines.',
  },
  // the same worry, once the pines are gone by hand — he does not pretend otherwise
  arrearsBare: {
    key: 'arrears-bare',
    text: 'There was money in those pines. That is all I will say about it.',
  },
  firstGuest: {
    key: 'first-guest',
    text: 'Somebody paid to sleep here last night. I have been telling you this house is worth something.',
  },
  // Bible §16.5 — the bickering additions. Same rules: state-triggered, once each,
  // log-only, and never below the trees or the money.
  pricey: {
    key: 'pricey',
    text: 'Ma never once asked guests to bring their own toilet paper. Think about that before you raise the rates.',
  },
  wellRated: {
    key: 'well-rated',
    text: 'You call it a review score. Ma called it leaving the gate unlocked for the scout troop. Both got guests.',
  },
  winter: {
    key: 'winter',
    text: 'Do not look so pleased. The mountain is testing you. Winter is the easy part of the test — it is honest.',
  },
  quiet: {
    key: 'quiet',
    text: 'I drove past yesterday. The roof looks all right from the road.',
  },
};

/** Is any rung priced more than 15% over the market? The review engine's own line. */
function pricey(h) {
  const rates = h.rates || {};
  return Object.keys(rates).some((k) => Number(rates[k]) > 1.15);
}

/** Winter is May–July, the same window tourism.js and weather.js charge by. */
function isWinter(h) {
  const m = h.date && h.date.month;
  return m >= 5 && m <= 7;
}

/** How often he may put a line into the log, at most. */
export const NOTE_EVERY_DAYS = 30;

/** Only the One Who Stayed has a brother with a claim on the trees. */
export function hasBrother(h) { return !!h && h.key === 'stayed'; }

export function initFamilyVoice(h) {
  if (!hasBrother(h)) return h;
  h.familyVoice = h.familyVoice || { seen: [], lastNoteDay: null };
  if (!Array.isArray(h.familyVoice.seen)) h.familyVoice.seen = [];
  if (h.familyVoice.lastNoteDay === undefined) h.familyVoice.lastNoteDay = null;
  return h;
}

/** Which line is current, by priority. Private: callers get text or a note, never a key. */
function current(h) {
  if (!hasBrother(h)) return null;
  const c = h.company || {};
  // 1. the trees — the family's pension, decided either way
  if (c.refused) return BROTHER.treesRefused;
  if (c.taken) return BROTHER.treesTaken;
  // 2. the money — and he will not pretend the pines are still standing
  if ((h.arrears || 0) > 0) {
    const pineStanding = !h.plot || !h.plot.trees || h.plot.trees.some((t) => t.kind === 'pine');
    return pineStanding ? BROTHER.arrears : BROTHER.arrearsBare;
  }
  // 3. the first guest in a house that was already standing
  if ((h.nights || 0) > 0 && (h.accom || []).some((a) => a.built)) return BROTHER.firstGuest;
  // 4. the decisions he has an opinion about — pricing, praise, and the season
  if (pricey(h)) return BROTHER.pricey;
  if ((h.rating || 0) >= 4.5) return BROTHER.wellRated;
  if (isWinter(h) && (h.nights || 0) > 0) return BROTHER.winter;
  // 5. a month in, nothing to report — which is itself the report
  if ((h.day || 1) >= 30) return BROTHER.quiet;
  return null;
}

/** His current line, raw. Silence ('') is allowed — he is not a filler voice. */
export function familyLine(h) {
  initFamilyVoice(h);
  const pick = current(h);
  return pick ? pick.text : '';
}

/** HUD layer: the spoken line, named by role and quoted. Silence stays empty. */
export function familySummary(h) {
  initFamilyVoice(h);
  const raw = familyLine(h);
  return { line: raw ? `Your brother: "${raw}"` : '' };
}

/**
 * Optional: put the current line in the day log — once per line, at most once every
 * thirty days. Returns the entry it wrote, or null. Called after the day has turned.
 */
export function maybeFamilyNote(h) {
  initFamilyVoice(h);
  if (!hasBrother(h)) return null;
  const pick = current(h);
  if (!pick) return null;
  const fv = h.familyVoice;
  if (fv.seen.includes(pick.key)) return null;
  if (fv.lastNoteDay != null && h.day - fv.lastNoteDay < NOTE_EVERY_DAYS) return null;
  fv.seen.push(pick.key);
  fv.lastNoteDay = h.day;
  const entry = { day: h.day, text: `Your brother: "${pick.text}"` };
  h.log.push(entry);
  return entry;
}
