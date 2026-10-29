// arrivalVoice.js — the mountain's first lines, on the day you arrive.
//
// NARRATIVE-BIBLE §18 (N6, owner GO 2026-10-22). The boot flow had no opening beat: the
// first thing a new player read was `The Homesteader: 1 September, H$243520 in hand.`, an
// operational water warning, then a goal list. Nothing on day one said what the ground is,
// that the road is the hidden bill, or that a month of bills is already booked. The cards
// on start.html promise a "First problem" line and the game never repeats it after the
// player clicks one.
//
// So this is the missing first page: three lines, not a cutscene (§9 — no cutscenes, no
// invented landmarks, no quest-log fiction). Every line is read out of state that already
// exists when newHomestead reaches it: the plot's own hectares, slope and distance, the
// road the tourism module has just built, the bill list the homestead module has just
// computed. Nothing is typed in and asserted, so nothing can drift. Buy a life onto ground
// with a stream and the water clause changes itself, because it was never claimed — it was
// read. The road and bills lines fire for any household with a road and a bill, which means
// a life this module has never heard of still gets the explanation.
//
// Built like familyVoice.js and companyVoice.js: constants, state-derived lines, one
// writer. Deterministic from state. No RNG stream (voiceRng belongs to the guests and
// stays theirs), no new household field, no counter invented to make a line fire.
// Log-only, so the goldens cannot move: snap() excludes h.log (tools/golden-home.mjs),
// and this module touches no goal, no cash, no date.
//
// Nobody is named (§2 pillar 6, law 5). The player's own name never reaches this module —
// §12 keeps it in localStorage, display-side — so every line reads correctly with a name
// above it in the log and with no name at all.

import { roadFactor, ACCOM } from './tourism.js';
import { inFirewoodSeason, FIREWOOD } from './firewood.js';
import { money } from './fmt.js';   // the sim's one money formatter (leaf, imports nothing)

/* Currency comes from fmt.js, not from a local copy: the same formatter prints the identity
   line, the cards and these sentences, so the first page of the game cannot disagree with
   itself about whether H$45 000 has a space in it. (fmt.js documents why that separator is a
   space and not a comma, and is pinned in the gate.) */

/** Above this the slope is worth a sentence of its own. A copy threshold, not a sim
 *  constant: nothing in the build reads it, and it charges nobody anything. */
const STEEP_SAYING = 25;

/** How much of this ground is pine and how much is forest, counted off the plot itself. */
function forestCount(p) {
  let pine = 0;
  let forest = 0;
  for (const t of p.trees || []) {
    if (t.kind === 'pine') pine += 1;
    else if (t.kind === 'indigenous') forest += 1;
  }
  return { pine, forest };
}

/** The bush clause, from that count — so bought ground describes itself, not the life. */
function forestClause({ pine, forest }) {
  if (!pine && !forest) return 'no standing forest yet';
  if (pine && !forest) return 'mostly pine';
  if (forest && !pine) return 'forest that was here before the houses';
  return pine > forest ? 'mostly pine, with old forest still standing'
    : 'forest, with pine planted up the slopes';
}

/**
 * The place line: one entry per life. `h.key` is real household state (familyVoice.js
 * already keys the brother off it) and it only chooses the emphasis — every fact in the
 * sentence is read off the plot, the household or the bond, so a life moved onto bought
 * ground gets its own sentence. The wet-site probe run is the proof: the same homesteader
 * says "a stream on the ground" and stops claiming dry ground.
 *
 * Deliberately ONE entry, not two: plot.html replays only the last six log lines on boot
 * (`h.log.slice(-6)`), and a site purchase plus the day-one goal ticks already eat that
 * window. A four-line opening pushed the arrival line off the screen.
 */
function lifeLine(h) {
  const p = h.plot || {};
  const bond = h.bond || {};
  const km = p.kmFromShop != null ? p.kmFromShop : (h.road && h.road.km);
  const dist = km != null ? `${km} km to the shop` : 'a walk to the shop';
  const ha = p.ha != null ? `${p.ha} ha` : 'this ground';
  const trees = forestCount(p);
  const forest = forestClause(trees);
  // the water clause is read off the household, never from the life name
  const water = h.water && h.water.stream
    ? 'a stream on the ground'
    : (h.services && h.services.water ? 'a municipal tap' : 'no water on it');
  const slope = p.slope == null ? ''
    // only the genuinely steep ground gets the extra clause, and what it says is the verb
    // the player has to reach for first (siteworks grade/flatten; builds need flat tiles)
    : (p.slope > STEEP_SAYING ? `${p.slope}% slope, so the grading comes before the building`
      : `${p.slope}% slope`);
  const house = (p.buildings || []).some((b) => b.kind === 'house');

  if (h.key === 'homesteader') {
    const help = bond.monthly > 0 ? '' : ' Outright, and unhelped — nothing here gets fixed by somebody else.';
    return [ha, forest, water, slope, dist].filter(Boolean).join(', ') + '.' + help;
  }
  if (h.key === 'incomer') {
    const debt = bond.principal > 0
      ? ` The bank holds ${money(bond.principal)} of it, and three months of missed bills hands the plot to them.`
      : ' The best ground on the mountain, bought outright, which nobody around here will forget.';
    return [ha, forest, water, slope, dist].filter(Boolean).join(', ') + '.' + debt;
  }
  if (h.key === 'stayed') {
    // the house stands because he never left it (lead ruling, plotmap.js makePlot); on
    // bought ground there is no house yet, and the line says so because it reads for it
    // §5.4: the trees are the family argument — and only ever when there are pines
    const claim = ' and a share, not the whole, of the claim';
    const argument = trees.pine > 0
      ? ' The trees are the argument: some were planted for the family, the rest are what the guests came for.'
      : '';
    return (house ? 'A house already stands here. ' : '')
      + [ha, forest, water, slope, dist].filter(Boolean).join(', ') + ',' + claim + '.' + argument;
  }
  return '';
}

/**
 * The road line. Guests key off condition, wear keys off distance, and the far plot pays
 * both ways (tourism.js roadDecay: 0.5 + km/2). This is the mechanic that quietly decides
 * whether a new player has a season, and day one is where it belongs.
 */
function roadLine(h) {
  const road = h.road || {};
  if (road.condition == null || road.km == null) return '';
  // "the top of the scale" is tourism's own verdict, not a number copied from it
  const top = roadFactor(road.condition) >= 1 ? ', the best it is ever going to get' : '';
  return `The road in is ${road.km} km at ${road.condition}%${top}. Guests read the percentage; the tar reads the distance.`;
}

/**
 * The bills line, quoted from the list the homestead module is about to charge. `bills` is
 * passed in by the caller instead of imported: homestead.js owns that maths and this module
 * will not keep a second copy of the numbers to fall out of date.
 */
function billsLine(bills) {
  if (!bills || !bills.items || !bills.items.length || !(bills.total > 0)) return '';
  const labels = bills.items.map((i) => String(i.label).toLowerCase()).join(', ');
  return `Bills come to ${money(bills.total)} on the 1st (${labels}). The first one is a month away.`;
}

/**
 * Does this household have a roof of its own? Two ways to have one, and both are read:
 * the standing family house on the plot's scenery layer (`p.buildings`, the One Who
 * Stayed — lead ruling, plotmap.js makePlot), or a finished `house` ACCOM, which is what
 * the two arriving lives build (tourism.ACCOM.house: H$45 000, 30 days, capacity 0, never
 * listed — a home, not a rung).
 *
 * Exported because the sim has no other way to ask. Nothing in `game/js/sim` reads a
 * built house today, which is the finding behind this section — see bible §20.1.
 */
export function hasRoof(h) {
  if (!h) return false;
  const plot = h.plot || {};
  if ((plot.buildings || []).some((b) => b.kind === 'house')) return true;
  return (h.accom || []).some((a) => a.kind === 'house' && a.built);
}

/**
 * The roof line, day one, for the two lives that arrive with nothing over their heads.
 * Every number is read off ACCOM.house, so the sentence cannot go stale when the build is
 * repriced. The One Who Stayed never sees it — the life line already says a house stands.
 *
 * NOTE for whoever wires the verb: this names a build the sim has always allowed
 * (`buildAccom(h, 'house', x, y)`) and the UI has never offered. If the button slips, the
 * sentence is ahead of the game by one line — bible §20.1.
 */
function roofLine(h) {
  if (hasRoof(h)) return '';
  const def = ACCOM.house;
  return `Nothing here has a roof but the trees. A house is a build like any other: `
    + `${money(def.cost)}, ${def.buildDays} days, flat ground only.`;
}

/**
 * The winter cold-house alarm, both variants. homestead.js owns the charge and the number;
 * this only says the true thing about who is standing in the weather. The current line
 * reads "the house goes cold" for a household with no house — bible §20.1 files it.
 */
export function coldHouseLine(h) {
  const cost = FIREWOOD.coldHouseNight;
  if (hasRoof(h)) {
    return `The wood stack is empty in the cold months — the house goes cold. `
      + `−${money(cost)} a night for paraffin until you stack wood.`;
  }
  return `The wood stack is empty in the cold months, and there is no roof of yours on this `
    + `ground yet. −${money(cost)} a night for paraffin until you stack wood.`;
}

/** FNV-1a, the same discipline as the review bank and the grapevine: no stream to disturb. */
function hash(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x;
}

/**
 * The first morning of a weather spell. `run` is the lead's field (485d9ac): days this kind
 * has held, 1 on the day it starts. Guarded, because a household built without rolling has
 * no `run` at all and must not crash a copy selector.
 */
const spellStart = (h) => !!h.weather && h.weather.kind != null && h.weather.run === 1;

/**
 * The first week (bible §20.2). Days 2-7, one line a day at most, picked by a hash of the
 * day out of the lines that are TRUE today — no draw, no field, no memory. The arrival
 * block owns day one; this is the part of the game that used to be silence: the week
 * between "here is your ground" and "here is your first bill".
 *
 * **Every `when` here is true for exactly one day.** That is the discipline, not a
 * preference: the first draft had a `beds.length > 0` line and it said itself four times in
 * six days, which is worse than saying nothing. A standing fact is not an event, so either
 * the state carries the day it happened (beds do: `planted`; a build does: `doneDay`;
 * counters do while the value is 1) or the line does not ship.
 *
 * **The two weather lines were cut last round and are back this round.** They were cut because
 * a weather *spell* is not an event: `kind === 'mist'` holds for three days and the bank said
 * the same sentence three times (measured). The lead then landed `h.weather.run` (485d9ac),
 * which makes "the first morning of the mist" a one-day fact, and both lines are in below —
 * `first-mist` and `first-rain-mud`. Note the bank's own window still applies: these speak in
 * the first week, which is when a new player needs to be told what the mountain is doing to
 * them. After day 7 the weather belongs to the HUD line and to the guests, not the narrator.
 *
 * `text` is a function so the sentence can carry the number it is about.
 */
export const FIRST_WEEK = [
  {
    id: 'september',
    // The game opens on 1 September and the cuckoo line only fires on a month ROLL, so a
    // first-year player never hears spring announced at all. This is that announcement,
    // pinned to the first morning so it cannot repeat inside the week.
    when: (h) => h.day === 2 && h.date && h.date.month === 9,
    text: () => 'September. Everything that grows on this mountain starts growing this month, and it does not wait for a cleared plot.',
  },
  {
    id: 'first-bed-morning',
    // beds carry their own `planted` day, so "the morning after" is exact and needs no field
    when: (h) => (h.beds || []).length > 0 && h.beds[0].planted + 1 === h.day,
    text: () => 'The first beds were cut yesterday. From here they are a matter of water and patience, which are the two things this mountain rations.',
  },
  {
    id: 'thirst',
    // the countdown is the sim's own: thirst increments on a day with no water, so === 1
    // is exactly one morning
    when: (h) => !!h.water && h.water.thirst === 1,
    text: () => 'One day of water gone. The tap is not coming up the mountain for anybody, and neither is the rain this month.',
  },
  {
    id: 'first-mist',
    // 485d9ac: `run` is how many days this kind has held, so run === 1 is the one morning a
    // spell starts. The mist is not a penalty (tourism's guestMult is 1.0) — the line says
    // what the player sees out of the window, and the privacy the mist buys is the joke.
    when: (h) => spellStart(h) && h.weather.kind === 'mist',
    text: () => 'The mist came in before breakfast and made the mountain a wall. Nobody saw the view today, and nobody saw you.',
  },
  {
    id: 'first-rain-mud',
    // mud is the cheap drive (siteworks.MUD) and the stuck roll is mud and slope; the line
    // only exists on a plot that actually laid mud, and only on the morning it gets wet
    when: (h) => spellStart(h) && (h.weather.kind === 'rain' || h.weather.kind === 'storm')
      && !!h.plot && (h.plot.mud || []).length > 0,
    text: () => 'Rain on the mud below the gate. Whoever drives up today is choosing between the track and the tow rope.',
  },
  {
    id: 'quiet-week',
    // day 7 is an exact window; the gate is what keeps the sentence honest.
    // BUG-010 (playtest 2026-10-26): there are TWO geysers and this gate used to respect only
    // one. The handyman's breakages land in `h.repairs` (handyman.js) and were counted; the
    // DIRECTOR's un-chosen cash events bypass `h.repairs` entirely and land in `h.lastHit`
    // (director.js: `{ day, amount, why }`) — so a −H$4 500 geyser on day 6 was followed by
    // "nothing has broken" on day 7. `lastHit` carries either sign (the director also pays
    // out), and either sign makes this sentence false: a bill means something broke, a payout
    // means somebody HAS paid you. The window is the week the line describes.
    when: (h) => h.day === 7 && !(h.repairs || []).length && !h.sold && !(h.nights > 0)
      && !(h.lastHit && h.lastHit.day >= h.day - 6 && h.lastHit.day <= h.day),
    text: () => 'A week in. Nothing has broken, nobody has paid you, and the mountain is entirely itself. Every life here starts on this stage.',
  },
  {
    id: 'first-trip',
    when: (h) => h.day === 7 && (h.sold || 0) > 0,
    text: (h) => {
      const km = h.plot && h.plot.kmFromShop != null ? `${h.plot.kmFromShop} km` : 'uphill';
      return `A week in, and you have been to the shop and back. That is the whole economy so far — ${km} of it, every trip.`;
    },
  },
  {
    id: 'first-guest',
    // h.nights is guest-nights sold, so === 1 is the one morning it is news
    when: (h) => h.nights === 1,
    text: () => 'Somebody paid to sleep on this mountain last night. The booking is small. The fact is not.',
  },
];

/**
 * The first night under your own roof (bible §20.1). Fires exactly once: a build flips
 * `built` on the day it reaches `doneDay`, so `h.day === a.doneDay` is a one-day window
 * with no memory field. The winter variant is the true one — a roof keeps the rain off and
 * does nothing about the cold; the wood stack is what the sim charges for that.
 */
export const FIRST_ROOF = [
  'Your house is finished. Nothing on the mountain changed; the rain now falls on a roof instead of your head.',
  (h) => `Your house is finished after ${ACCOM.house.buildDays} days of flat ground and paperwork. The door shuts. That is the whole review.`,
  'A roof of your own, up. The road is still yours and the wattle is still growing, but you are out of the weather.',
];

/** The roof line for the day it completes, or '' for every other day. */
function firstRoofLine(h) {
  // keyed on `doneDay === h.day`, NOT on `built`: the flag flips inside tickTourism, so a
  // trigger that reads it can miss depending on where in endDay it is called. The date the
  // build promised is true from whichever side of the tick you look at it.
  const finished = (h.accom || []).find((a) => a.kind === 'house' && a.doneDay === h.day);
  if (!finished) return '';
  if (inFirewoodSeason(h.date) && (h.firewood || 0) <= 0) {
    return 'Your house is finished in the cold months with an empty wood stack. A roof is the first half of a warm night; the second half is cut and stacked.';
  }
  const bank = FIRST_ROOF.map((x) => (typeof x === 'function' ? x(h) : x));
  return bank[hash(`roof|${h.day}|${finished.id}`) % bank.length];
}

/** The first week's line for today, or '' when nothing true is happening. */
function weekOneLine(h) {
  if (h.day < 2 || h.day > 7) return '';
  const trueNow = FIRST_WEEK.filter((w) => {
    try { return !!w.when(h); } catch { return false; }
  });
  if (!trueNow.length) return '';
  const pick = trueNow[hash(`week|${h.day}`) % trueNow.length];
  return pick.text(h);
}

/* ---- BUG-004: the one idle prompt (owner-prioritised, shape specified) ---------------
   Measured 2026-10-26 before writing: fourteen `endDay`s with no player action on the
   Incomer produce twelve log lines, and the ONLY one containing an action is this module's
   day-one roof clause. Days 2-14 are two mists, a -H$4 500 geyser the player did nothing to
   cause, and a loerie. The goals panel nudges from the HUD, but the game's own voice never
   speaks to a player who is standing still.

   The owner's shape: ONE prompt after several inactive days, not a reminder loop - it names
   an available action and why it matters, with numbers from the sim's own state.

   The BUG-010 discipline, applied: the gate enumerates the record-keepers of the claim it
   makes, and "nothing planted" is checked against all of them -
     no beds planted            (h.beds)
     nothing being built        (h.accom / h.facilityBuilds, in progress or standing)
     nothing sold               (h.sold)
     no guest ever hosted       (h.nights)
   A player who built a cabin but never planted has still not planted, and the line says
   exactly that and nothing more - it does not claim the player did nothing.

   Fires once per game, on a stamp (`h.idleNudge`) that sits outside `snap()`'s whitelist,
   same as `grapevineNews`. The "activity resets it" rule is the gate itself: the only
   activity that matters to THIS line is planting, and a bed persists, so the moment the
   player acts the condition is false forever - a lifetime stamp cannot outlive its stretch.
   If a later prompt wants a second stretch (build something, sell something), it gets its
   own condition and its own stamp, not a shared one.
   -------------------------------------------------------------------------------------- */

/** The first day the silence is worth breaking. A copy threshold, not a sim constant:
 *  nothing else reads it. Day 10 is the owner's own example and lands after the first-week
 *  bank has gone quiet (days 2-7) with three clear days of nothing in between. */
const IDLE_AFTER_DAY = 10;

/**
 * The idle prompt, or '' on any day it must not speak. The numbers are the sim's own: the
 * day is `h.day`, the bond is `h.bond.monthly`. "Three weeks" is WORDS on purpose - the
 * constant lives in `homestead.js` (`BED.growDays`), and importing it would be this repo's
 * first sim-module cycle, which `tourism.js`'s header forbids for testability. The goals
 * panel already says "A bed takes three weeks" as shipped copy, so this line repeats the
 * game's own words rather than typing a digit that can drift. If the owner wants the number
 * as digits, the caller passes `BED` in (same pattern as `monthlyBills`) and this becomes
 * `${BED.growDays} days` in one edit.
 */
function idleLine(h) {
  if (h.idleNudge != null || h.day < IDLE_AFTER_DAY) return '';
  if ((h.beds || []).length > 0) return '';
  if ((h.accom || []).length > 0 || (h.facilityBuilds || []).length > 0) return '';
  if (h.sold || (h.nights || 0) > 0) return '';
  h.idleNudge = h.day;
  const bill = h.bond && h.bond.monthly > 0
    ? `The bank takes ${money(h.bond.monthly)} on the 1st whether or not anything grows.`
    : 'The shop buys greens, not intentions.';
  // NO DURATION IN THIS SENTENCE, deliberately. It said "Greens are three weeks out" for one
  // release; then FARMING-SPEC Part 2 landed (greens 12 days, herbs 20, potato 32) and the
  // line was quietly wrong - the exact drift the §21.2 words-not-digits hedge was supposed to
  // avoid. Words drift too, and `CROPS` sits behind the same would-be cycle as `BED`. So the
  // prompt states the fact and the clock and nothing that can go stale; the goal card carries
  // the crop numbers, where they are checked against the table.
  return `Day ${h.day} and nothing planted. Nothing you grow is growing yet, and ${bill.charAt(0).toLowerCase()}${bill.slice(1)}`;
}

/**
/**
 * The arrival voice's daily tick: the first roof if it completed today, else the first week,
 * else — after ten days of a household that has done nothing at all — the one idle prompt.
 * At most one log line a day. Log-only — `snap()` excludes `h.log`, so no trace can move,
 * and the idle stamp lives outside the whitelist too.
 *
 * Wired since the lead's `2d25e1f`: called from `endDay`, beside `tickGrapevine(h)`.
 */
export function tickArrival(h) {
  if (!h || h.ended) return null;
  const text = firstRoofLine(h) || weekOneLine(h) || idleLine(h);
  if (!text) return null;
  const entry = { day: h.day, text };
  h.log.push(entry);
  if (h.log.length > 200) h.log.shift();
  return entry;
}

/** The day-one opening, in reading order. Empty for any household past day one. */
export function arrivalLines(h, bills) {
  if (!h || h.day !== 1 || !Array.isArray(h.log)) return [];
  const out = [];
  const place = lifeLine(h);
  if (place) out.push(place);
  const roof = roofLine(h);
  if (roof) out.push(roof);
  const road = roadLine(h);
  if (road) out.push(road);
  const b = billsLine(bills);
  if (b) out.push(b);
  return out;
}

/**
 * Write the opening into the day log and return the entries it wrote (three, or fewer if
 * there is nothing true to say). Call once, from newHomestead. There is no `seen` array
 * and no field on the household, because day one only happens in a new game, and a new
 * game has no past.
 */
export function pushArrivalNotes(h, bills) {
  const entries = arrivalLines(h, bills).map((text) => ({ day: h.day, text }));
  for (const e of entries) h.log.push(e);
  return entries;
}
