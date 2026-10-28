// grapevine.js — the village talking about you, and the mountain not talking at all.
//
// NARRATIVE-BIBLE §16.4 (the grapevine) and §15.5 (ambience). Both are the same thing in
// the game's structure: a line that fills the director's FLAVOUR slot. L9 (2026-10-23)
// opened the seam — `setFlavourHook(fn)` fires AFTER the director's own RNG draws, so a
// registered hook cannot change the village's rhythm, and with none registered the village
// speaks exactly as it always did.
//
// The rule that shapes this file: **a line only fires on state that is true.** The pothole
// is raised at the ratepayers' meeting when the road is actually bad; the honey line needs
// hives and mist; the gate gets photographed once somebody has actually stayed. The four
// ambience lines are the only ones with no condition, because a bushbuck does not need the
// player to have done anything.
//
// No RNG. The pick is a hash of the day, so a replay says the same thing on the same day
// and the director's stream is untouched.

import { setFlavourHook } from './director.js';

/** State-gated lines first — they are about something the player did. */
export const GRAPEVINE = [
  {
    id: 'pothole',
    when: (h) => !!h.road && h.road.condition < 40,
    text: "Your pothole was raised at the ratepayers' meeting. By name. The pothole's, not yours.",
  },
  {
    id: 'honey-mist',
    when: (h) => (h.hives || []).length > 0 && (h.honey || 0) > 0
      && h.weather && h.weather.kind === 'mist',
    text: 'Somebody at the market asked if your honey is the reason for the mist. You said yes.',
  },
  {
    id: 'taxi-road',
    when: (h) => !!h.road && h.road.condition < 50,
    text: 'The taxi driver has given your road a name. It is not polite, and it is accurate.',
  },
  {
    id: 'ahead-of-bank',
    // `lastNights`, not `nights`: the grapevine is talking about a place that has guests IN
    // it this week. A lifetime counter is a memory, not a condition, and it made this line
    // evergreen — see the measured note at grapevineLine().
    when: (h) => (h.lastNights || 0) > 0 && (h.rating || 0) >= 4,
    text: 'The grapevine says you are doing well. The grapevine is ahead of your bank balance, but let it run.',
  },
  {
    id: 'gate-photo',
    when: (h) => (h.lastNights || 0) > 0,
    text: 'A visitor photographed your gate. Nobody knows why. The gate is pleased.',
  },
  // Two more conditions the village actually reacts to. They exist because the measurement
  // said so: with five lines and one of them true on almost every speaking night, the
  // gate photograph was 11 of 23 lines in a year. A village with a short vocabulary
  // repeats itself, so the fix is more true things to say, not a weighting.
  {
    id: 'arrears',
    when: (h) => (h.arrears || 0) > 0,
    // no mechanic claim in the sentence: the village's manners are the village's, and the
    // bank's arithmetic is the one the sim actually keeps (three months and the plot goes)
    text: 'You have missed a month. The village knows inside a week, and it has decided to keep saying good morning.',
  },
  {
    id: 'subsidy-held',
    when: (h) => !!(h.subsidy && h.subsidy.state === 'accepted'),
    text: "The ratepayers mention your road at the meetings now. Always kindly. Always twice.",
  },
  // Three facts the lead landed after the selection fix (2d25e1f, 485d9ac, a252c2b).
  // `roof-up` and `first-cold` started in this table and MOVED to NEWS below: measured, a
  // one-day fact has about a 1-in-21 chance of being true on the morning a three-weekly clock
  // speaks, so as standing gates they were correct copy that never fired. Only what can be
  // true on the day the village happens to open its mouth belongs here.
  {
    id: 'bad-review',
    // the worst night of the day (a252c2b), not the last one — so this is the review the
    // rating inertia is keyed to. It carries the guest's OWN sentence now that the engine
    // attaches it, which is the difference between the village repeating a number and
    // repeating what was actually said. Falls back to the stars when there is no quote.
    when: (h) => !!h.lastReview && h.lastReview.day === h.day && h.lastReview.score < 3,
    text: (h) => {
      const stars = (Math.round(h.lastReview.score * 10) / 10).toFixed(1);
      const said = h.lastReview.quote ? ` "${String(h.lastReview.quote).replace(/[.?!]+$/, '')}"` : '';
      return `Somebody left ${stars} stars on your place${said} where the village could read it. `
        + 'Nobody is offended on your behalf, and nobody is surprised.';
    },
  },
];

/* ---- news: the events the village hears about the day they happen --------------------
   Ruled by the lead 2026-10-23 (bible §21.3) after this seat measured the arithmetic: on a
   21 +/- 5 day clock, `roof-up`, `first-cold` and `honey-mist` were 0 of 12 village lines in
   a played year that certainly contained all three. The clock is his; the queue is mine.

   FOUR CONSTRAINTS FROM THAT RULE, all four honoured here:
   1. **Carry the event, do not re-roll it.** The queue holds ids and the day each was seen.
      Nothing in this section draws a number or reads `voiceRng` or any other stream.
   2. **No new field inside `snap()`.** The state this file keeps is `h.grapevineNews` (the
      queue) and `h.grapevineTold` (the ids already spent — without it an event whose state
      stays true is re-queued every morning). Neither key is read by `snap()`, which is a
      whitelist (day/cash/beds/goals/weather.kind/...) — proved
      the hard way (`golden-home.mjs --write`, then `git diff tests/golden/` empty), not
      argued. If the whitelist ever grows a field this file writes, stop and take it to the
      lead.
   3. **One line a day maximum, and news must not starve the standing gates.** Preference on
      a speaking morning: **newest queued news > a standing condition about the player
      (`GRAPEVINE`) > ambience.** News beats a condition because it is the thing that just
      happened to you; a condition beats animals because it is still about you. A spoken item
      leaves the queue, and the clock only advances when the slot was already due — so a news
      day buys the village no free pass, and the standing gates keep every other morning.
   4. **Age it out.** See NEWS_TTL_DAYS. A three-week-old piece of news is not news.
   ------------------------------------------------------------------------------------------- */

/**
 * How long a piece of news stays news: one mean cadence (`EVERY_DAYS`), which is also the
 * longest a household normally goes without a regular remark. Older than this and it is
 * dropped unheard — the village repeating last month's roof is worse than silence. Do not
 * "improve" the number without re-running the played year in `tools/narrative-probe.mjs`:
 * shorter and the events go unsaid again, longer and the village gossips about a dam you cut
 * in spring.
 */
export const NEWS_TTL_DAYS = 21;

/** The queue cap: the village hears about the last few things, not the whole season. */
const NEWS_CAP = 5;

/**
 * The events. Every `when` is READ from state that carries its own date or its own first-day
 * marker, which is why no other module has to call anything: the roof is `a.doneDay` (the
 * PROMISED day, not the `built` flag — that flips inside `tickTourism`), the cold snap and
 * the snow are `h.weather.run === 1` (485d9ac), the dam is `p.damTiles` existing at all.
 */
export const NEWS = [
  {
    id: 'roof-up',
    // promises shelter and NOTHING else: RULINGS A3 (what a house does) is unruled, so there
    // is no warmth, no rate and no spare room in this sentence until the owner picks
    when: (h) => (h.accom || []).some((a) => a.kind === 'house'
      && a.doneDay != null && h.day - a.doneDay >= 0 && h.day - a.doneDay <= NEWS_TTL_DAYS),
    text: 'The village heard a house went up on your ground. People will look at it for a month and say something kind about the roof.',
  },
  {
    id: 'first-cold',
    // "of the year" was dropped: the queue dedupes by id, so this is told once per GAME, and
    // a line that promises an annual first would be a lie in year two
    when: (h) => !!h.weather && h.weather.kind === 'cold' && h.weather.run === 1,
    text: 'The first cold snap. The village pulled its chairs in and the dogs stopped arguing. Your beds are next.',
  },
  {
    id: 'first-snow',
    // the owner's ruling stands and is not being re-litigated: snow brings people up
    when: (h) => !!h.weather && h.weather.kind === 'snow' && h.weather.run === 1,
    text: 'It snowed on the mountain and the village woke up to a full road. Somebody has always driven up for this.',
  },
  {
    id: 'dam-dug',
    // the dig already tells the PLAYER it struck water; what the village adds is that a wet
    // land on your ground is noticed — the conservation choice being seen, not rewarded
    when: (h) => !!h.plot && (h.plot.damTiles || []).length > 0,
    text: 'You cut something into the ground that is holding water. Two old men walked down to look at it and said nothing, which is the highest compliment on this mountain.',
  },
];

/** Bible §15.5 — the free ones. No condition: the animals were here before the player. */
export const AMBIENCE = [
  'A bushbuck crossed the clearing at dusk and pretended you are not there.',
  'The loeries are raiding the apple tree again. Everyone pretends it is charming.',
  'Baboons on the far ridge at sunrise — you can hear the troop argue its way along the krantz.',
  'Duiker prints by the water tank in the mud. The night shift was here.',
];

/** FNV-1a. Deterministic, tiny, and no stream to disturb. */
function hash(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x;
}

/**
 * The village's line for today, or null to let the built-in pool speak.
 *
 * **A line about you outranks a line about the mountain.** The state-gated pool is tried
 * first and ambience only fills a day when nothing true is happening to the player. The
 * old policy drew from one merged pool, which measured (2026-10-23, four played years in
 * `tools/narrative-probe.mjs`) at 19 of 23 lines being animals — the cadence was fixed at
 * 21 +/- 5 days and the village still barely mentioned you. Bible §19.3's "the writing is
 * correct and almost never heard" was about frequency; the residue is selection, and this
 * is the half of it that belongs to the strings.
 *
 * No RNG either way. The pick is a hash of the day.
 */
export function grapevineLine(h) {
  if (!h) return null;
  // `text` is a string or a function of the household — a function so a line can carry the
  // number it is about (the star count) rather than a paraphrase of it
  const said = GRAPEVINE.filter((g) => {
    try { return !!g.when(h); } catch { return false; }
  }).map((g) => (typeof g.text === 'function' ? g.text(h) : g.text));
  const pool = said.length ? said : AMBIENCE;
  if (!pool.length) return null;
  return pool[hash(`grapevine|${h.day || 0}`) % pool.length];
}

/* ---- how often the village speaks (owner GO 2026-10-23) --------------------------
   It used to ride the director's FLAVOUR slot alone. That slot is 18-25% of the director's
   picks, and the director fires ~26 times in 400 days — so the whole village measured
   FOUR lines in 400 days: one every hundred days, which no player would ever notice.

   The grapevine now has its own rhythm, deliberately independent of the pressure events.
   Texture must not compete with cost/gain for the same slots: a village that only speaks
   when the game has something to charge you for is a village that only ever complains.
   21 days +/- 5 is roughly one line every three weeks — present, not a chatterbox.

   No RNG: the gap jitters off a hash of the day, so a replay says the same thing on the
   same day and no golden trace can move. */
export const EVERY_DAYS = 21;
export const JITTER = 5;

const jitterOf = (day) => (hash(`grapevine-gap|${day}`) % (JITTER * 2 + 1)) - JITTER;

/**
 * Read the queue from state, drop what is too old to be news, and spend the newest item.
 * Returns the sentence, or null when nothing is waiting.
 *
 * Filled by READING (`when`), never by an emitter call — that is why no other module had to
 * change for this to work, and why the roof line survives the `built` flag flipping in
 * whatever order `endDay` happens to call things.
 *
 * Newest first: a queue that speaks oldest-first tells you about the dam you cut three weeks
 * ago before mentioning the house that went up yesterday, and the village does not work that
 * way. The cost is honest and it is the TTL's: an event that never gets a morning dies
 * unheard rather than arriving stale.
 */
function takeNews(h) {
  if (!Array.isArray(h.grapevineNews)) h.grapevineNews = [];
  if (!Array.isArray(h.grapevineTold)) h.grapevineTold = [];
  for (const n of NEWS) {
    // `told`, not just the queue: an event whose state stays true (a house keeps standing,
    // a dam keeps holding water) would otherwise be re-queued every morning and the village
    // would talk about nothing else. Cap it at the handful of ids this file knows.
    if (h.grapevineTold.includes(n.id) || h.grapevineNews.some((x) => x.id === n.id)) continue;
    let on = false;
    try { on = !!n.when(h); } catch { on = false; }
    if (on) h.grapevineNews.push({ id: n.id, day: h.day });
  }
  const fresh = h.grapevineNews
    .filter((x) => h.day - x.day <= NEWS_TTL_DAYS)
    .sort((a, b) => b.day - a.day)
    .slice(0, NEWS_CAP);
  h.grapevineNews = fresh;
  const top = fresh[0];
  if (!top) return null;
  const n = NEWS.find((x) => x.id === top.id);
  if (!n) return null;
  h.grapevineNews = fresh.slice(1);                             // spent
  h.grapevineTold.push(top.id);
  if (h.grapevineTold.length > NEWS.length) h.grapevineTold = [...new Set(h.grapevineTold)];
  return typeof n.text === 'function' ? n.text(h) : n.text;
}

/** Speak, if today is a speaking day or the village has heard something. Returns the line.
 *  Called from homestead.endDay — this is the village's own voice, not an event cue, so the
 *  line carries NO `event` name: it is speech, and plot.html only plays cues for entries
 *  that name one.
 *
 *  One line a day, maximum, in either path. A news day does NOT advance the clock unless the
 *  clock was already due, so news cannot buy the village a free pass and the standing gates
 *  keep every other speaking morning (constraint 3 of the lead's rule). */
export function tickGrapevine(h) {
  if (!h || h.ended) return null;
  // the first line lands early — the village should exist before it has opinions
  if (h.grapevineNext == null) {
    h.grapevineNext = 5 + (hash(`grapevine-start|${h.key || ''}`) % 9);
  }
  const due = h.day >= h.grapevineNext;
  const text = takeNews(h) || (due ? grapevineLine(h) : null);
  if (due) h.grapevineNext = h.day + EVERY_DAYS + jitterOf(h.day);
  if (!text) return null;
  h.log.push({ day: h.day, text });
  if (h.log.length > 200) h.log.shift();
  return text;
}

/** Register the hook. Exported so a page can re-register if something clears it. */
export function installGrapevine() { setFlavourHook(grapevineLine); }

// Registered once, at import: the seam is a policy, not per-household state. Doing it here
// rather than inside newHomestead keeps "no hook registered" a state a test can actually
// reach — tests/50 nulls the hook to prove the built-in pool still speaks, and a
// registration that ran on every newHomestead would quietly overwrite that null.
installGrapevine();

