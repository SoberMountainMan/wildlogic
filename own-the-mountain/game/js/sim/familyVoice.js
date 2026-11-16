// familyVoice.js — your brother, the family claim, and the family's own milestones.
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
//
// SLICE 4 (lead dispatch 2026-11-16, owner GO "then slice 4"): the second half of this file is
// the family's own milestones, read off `h.family` (`family.js`, landed `385ab50`). They are
// LOG-ONLY and they keep the rhythm the brother already keeps — at most one family-voice line a
// day, and every line keyed so it can only ever be written once. Rules this half obeys:
//
//   - It fires for ANY life that starts a family, not only the One Who Stayed. The brother needs
//     a claim on the trees; a child does not.
//   - Triggered by state, never by a number typed in: the grown tier reads `FAMILY.childGrowDays`
//     through `familyLabour`, the store line reads `FAMILY.mouthEatKg` and `FAMILY.storeDays`,
//     the winter line reads the same 5-7 window as the brother's. If the level seat reprices a
//     constant, the sentence moves with it or stops firing — it cannot go quietly stale.
//   - Pending is counted, not windowed. A line whose state is "how many of these are true" is
//     compared against how many the voice has already recorded, so a milestone that loses its
//     single day to another emitter is not lost, and a save loaded with a fourteen-year-old child
//     still gets the line once. Nothing here keys on `h.day === bornDay`, which would miss.
//   - The sim's `startFamily`/`haveChild` messages already say what happened, and homestead.js
//     already charges the dependents in a daily line. This module does not repeat either: no cost
//     number and no mouth count is reprinted as if it were news. The milestone waits for the
//     morning after, which keeps it off the day the sim has already spoken; `mayWrite()` states
//     the direction that guarantee runs in and what it cannot cover.
//   - Golden-safe by construction: `snap()` (`tools/golden-home.mjs`) is a whitelist of sim fields
//     and writes only `h.log` plus `h.familyVoice` here, neither of which it reads. The no-family
//     path never enters this code at all.

import { FAMILY, mouths, familyLabour } from './family.js';

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

/** The once-only ledger both halves of this file write through. Created lazily and only where
 *  there is something to say: a hermit's household never grows the field (test 29 pins that for
 *  the brother's half), and the milestone half only reaches here through a started family. */
function ensureVoice(h) {
  h.familyVoice = h.familyVoice || { seen: [], lastNoteDay: null };
  if (!Array.isArray(h.familyVoice.seen)) h.familyVoice.seen = [];
  if (h.familyVoice.lastNoteDay === undefined) h.familyVoice.lastNoteDay = null;
  return h.familyVoice;
}

export function initFamilyVoice(h) {
  if (!hasBrother(h)) return h;
  ensureVoice(h);
  return h;
}

/* ------------------------------------------------------------------ Slice 4: the family's own
 * milestones. `h.family` is the lead's state (`family.js`, `385ab50`); nothing here adds a field
 * to it. The bank is in PRIORITY ORDER, and the order is an argument: `partner-winter` goes
 * before `grown` because it is the only line that goes stale — a first-winter sentence in
 * February is a lie, and this module would rather stay silent than say it out of season. */

/** FNV-1a, the same pick the other voice modules use: replay says the same thing, and the
 *  guests keep their own RNG stream (`voiceRng` is theirs and this does not touch it). */
function hash(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x;
}

/** not `pick`: familyLine() already binds that name locally */
function pickVariant(h, seed, bank) {
  const arr = bank.map((x) => (typeof x === 'function' ? x(h) : x));
  return arr[hash(`${seed}|${h.day}`) % arr.length];
}

export const MILESTONES = [
  {
    // the morning after the readiness decision. The sim's own startFamily message has the day;
    // this is what the house notices the next day. Only the partner variants: at this point
    // `children` is empty, so no line here may mention a child.
    prefix: 'family-start',
    due: (h) => (h.family.started && h.day > (h.family.startedDay || 0) ? 1 : 0),
    line: (h) => pickVariant(h, 'family-start', [
      'The house is louder tonight. The road, the bills and the weather are exactly as loud as they were.',
      'Somebody new is standing in the doorway. Same ground, same water, same pass. Twice the reason to keep it.',
    ]),
  },
  {
    prefix: 'partner-winter',
    due: (h) => (h.family.started && h.family.partner && isWinter(h) ? 1 : 0),
    line: (h) => ((h.firewood || 0) > 0
      ? 'Your first winter with two of you in it and wood in the stack. The cold is weather this year instead of a problem.'
      : 'Your first winter with two of you in it and an empty stack. There is still daylight, and there is still wood on this mountain.'),
  },
  {
    // one line per child reaching FAMILY.childGrowDays, which is the same fact `familyLabour`
    // uses to release harvest capacity. Indexed by the count, so the numeral in the sentence is
    // the numeral in the state; the last entry is the fallback if maxChildren is ever raised.
    prefix: 'grown',
    due: (h) => h.family.children.filter((c) => h.day - c.bornDay >= FAMILY.childGrowDays).length,
    line: (h) => {
      const n = h.family.children.filter((c) => h.day - c.bornDay >= FAMILY.childGrowDays).length;
      const beds = familyLabour(h);
      if (n <= 1) {
        return `They carry the eggs in without being sent. ${beds} beds now come in on the hands of this household, and the kitchen calls it errands.`;
      }
      if (n === 2) {
        return 'Two pairs of boots out on the ground. The beds get in earlier than the plan says, and nobody mentions it, which is how you know it is normal.';
      }
      if (n === 3) {
        return 'Three of them working the same hill you started alone. There is a sound a mountain makes when one person is not carrying it, and you hear it at harvest.';
      }
      return 'More than one pair of boots on the ground now, and the harvest does not wait for you on its own.';
    },
  },
  {
    // the food-security gate, kept rather than passed: FAMILY.mouthEatKg x FAMILY.storeDays per
    // mouth is exactly what readiness asks for, so this is readiness lived for a month.
    prefix: 'store-month',
    due: (h) => (h.family.dependents > 0
      && (h.produce || 0) >= mouths(h) * FAMILY.mouthEatKg * FAMILY.storeDays ? 1 : 0),
    line: (h) => `${FAMILY.storeDays} days of food in the store and every kg of it grew here. `
      + `${mouths(h)} of you eat without the shop being part of the week.`,
  },
];

/** How many of this fact the voice has already put in the log. */
function recorded(fv, prefix) {
  return fv.seen.filter((k) => k.startsWith(`${prefix}-`)).length;
}

/** The milestone waiting to be spoken, or null. Pure: reads, writes nothing. */
export function familyMilestone(h) {
  const f = h && h.family;
  if (!f || !f.started) return null;
  // an empty local ledger when ensureVoice has not run: a read never creates state
  const fv = h.familyVoice || { seen: [], lastNoteDay: null };
  for (const m of MILESTONES) {
    let due = 0;
    try { due = m.due(h) || 0; } catch { due = 0; }   // a save with a hole in it stays silent
    if (due > recorded(fv, m.prefix)) return { key: `${m.prefix}-${due}`, text: m.line(h) };
  }
  return null;
}

/** The brother's throttle, plus one rule with a DIRECTION worth naming. The check reads `h.log`
 *  as it stands when the day turns, so it blocks the case where the SIM SPOKE TODAY and this
 *  module would speak on that same day (verb-today / milestone-tonight). It cannot block the
 *  reverse -- a milestone stamped for tomorrow is written before tomorrow's verb exists -- so a
 *  verb landing the morning after a milestone does get both lines on one day. That pairing is two
 *  different facts (a birth happened; the house notices the family), not the same news twice.
 *  Measured 2026-11-16 over a 431-day family life: 1 such same-day pairing, 0 identical sentences
 *  and 0 shared opening clauses between the two emitters (`_tmp/family-msg-collision.mjs`, run at
 *  `ad16ec2`). Widening the guard is deliberately NOT done: a milestone that waited on a verb that
 *  has not happened would lose its day to nothing, and counted-not-windowed is what this ledger is
 *  built on. */
function mayWrite(h, fv) {
  if (fv.lastNoteDay === h.day) return false;
  return !(h.log || []).some((e) => e.day === h.day && e.event === 'family');
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
 * The day's family-voice line, or null. Called by homestead.endDay after the day has turned.
 *
 * Two writers share one ledger and one day:
 *   1. a Slice 4 MILESTONE, for any household with a started family. It waits until its own fact
 *      outnumbers what the ledger already recorded, so losing a day to the sim's family event or
 *      to the brother does not lose the line; a milestone is never repeated and never throttled
 *      for a month, because a child growing does not stay news for thirty days.
 *   2. the BROTHER, unchanged: once per line, at most once every NOTE_EVERY_DAYS. He keeps his
 *      throttle exactly, and the only new thing that can delay him is a milestone taking the
 *      day, which happens a handful of times in a whole life.
 * Nothing writes twice on one day, and nothing writes on a day whose `family` event line is
 * ALREADY in the log when the day turns. That second clause is one-directional and accepted as
 * such: it covers verb-today / milestone-tonight, not a verb that arrives the morning AFTER a
 * milestone (see `mayWrite()`), which is the pairing the instrument measured once in 431 days.
 */
export function maybeFamilyNote(h) {
  if (!h || !Array.isArray(h.log)) return null;
  const f = h.family;
  if (f && f.started) {
    ensureVoice(h);
    const fv = h.familyVoice;
    const mile = familyMilestone(h);
    if (mile && mayWrite(h, fv)) {
      fv.seen.push(mile.key);
      fv.lastNoteDay = h.day;
      const entry = { day: h.day, text: mile.text };
      h.log.push(entry);
      return entry;
    }
  }
  initFamilyVoice(h);
  if (!hasBrother(h)) return null;
  const pick = current(h);
  if (!pick) return null;
  const fv = h.familyVoice;
  if (fv.seen.includes(pick.key)) return null;
  if (fv.lastNoteDay != null && h.day - fv.lastNoteDay < NOTE_EVERY_DAYS) return null;
  if (!mayWrite(h, fv)) return null;
  fv.seen.push(pick.key);
  fv.lastNoteDay = h.day;
  const entry = { day: h.day, text: `Your brother: "${pick.text}"` };
  h.log.push(entry);
  return entry;
}
