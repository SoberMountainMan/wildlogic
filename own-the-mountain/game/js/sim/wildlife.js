// wildlife.js — the animals, as STATE EVENTS (bible §15; names frozen in §17.6).
//
// The narrative seat wrote the lines and the audio seat built the cues; both have been
// waiting on the sim to say WHEN. This module is that voice. It decides from state alone
// — no dice — so a raid is reproducible from the day's numbers, exactly like the review
// engine ("the night's state decides, not a roll").
//
// THE NAMES ARE A CONTRACT. Text and sound key off one string, so a quote and its cue can
// never drift. Do not rename without telling both seats:
//
//   baboon-raid · samango-raid · snake-scare · toad · loerie
//
// `loerie` deliberately has NO event of its own: it rides the praise pool in voices.js.
// A bird that sings when things are going well does not need its own state.
//
// Every line is written into the log with `event` set, so the UI can play the cue from the
// same entry it prints — one source, not two.
//
// Pure logic, no DOM: the gate imports this directly.

export const WILDLIFE = {
  // Baboons work a garden on a rhythm, not at random — and the fence is the whole answer.
  // Owner, 2026-10-21: "Fence your property for better security, gonna cost you." This is
  // where that promise is paid: fenced ground is never raided, so the H$180 a post buys
  // something a player can feel.
  baboonEvery: 14,         // days between visits while the crop is worth taking
  baboonMinKg: 6,          // standing produce that is worth the climb
  baboonTake: 0.35,        // share of the standing crop...
  baboonMaxKg: 12,         // ...but a troop carries what it can eat. Without a cap a
                           // raid on a full store takes 125 kg and reads as a tax, not an animal.

  // Samangos come through the trees, so a fence is not the answer — the hives are.
  // They take honey, not vegetables, which keeps the two raids from being one event twice.
  samangoEvery: 16,
  samangoMinKg: 1.5,
  samangoTake: 0.3,
  samangoMaxKg: 2,         // same reason: monkeys take a meal, not the season

  // A puff adder is a real Hogsback hazard, and the cost is the DAY: nobody works that
  // ground. This is the one event allowed to say the quiet part — the nearest doctor is an
  // hour away and an ambulance is two.
  snakeEvery: 25,          // about one bad day a month in the warm months
  snakeMonths: [11, 12, 1, 2, 3],   // Nov–Mar
};

const round1 = (n) => Math.round(n * 10) / 10;

/** The day's wildlife, decided from state. Returns the event names it emitted. */
export function tickWildlife(h) {
  if (!h || h.ended) return [];
  const w = h.wildlife || (h.wildlife = { baboon: 0, samango: 0, snake: 0, wetland: false });
  const p = h.plot || {};
  const fenced = Array.isArray(p.fence) && p.fence.length > 0;
  const out = [];

  // --- baboons: the garden, when the crop is worth taking and the ground is open ---
  if (!fenced && (h.produce || 0) >= WILDLIFE.baboonMinKg
    && h.day - (w.baboon || 0) >= WILDLIFE.baboonEvery) {
    const took = Math.min(WILDLIFE.baboonMaxKg, round1(h.produce * WILDLIFE.baboonTake));
    h.produce = round1(h.produce - took);
    w.baboon = h.day;
    out.push('baboon-raid');
    // bible §15.1, with the number this sim actually takes: a troop carries what it can
    // eat (baboonMaxKg), so "the standing crop is gone" would be a lie on a full store.
    note(h, `Baboons came through the garden before first light — ${took} kg gone. `
      + 'They were calm about it, which is worse. A fence would have stopped them.', 'baboon-raid');
  }

  // --- samangos: the hives, through the trees, fence or no fence ---
  if ((h.hives || []).length && (h.honey || 0) >= WILDLIFE.samangoMinKg
    && h.day - (w.samango || 0) >= WILDLIFE.samangoEvery) {
    const took = Math.min(WILDLIFE.samangoMaxKg, round1(h.honey * WILDLIFE.samangoTake));
    h.honey = round1(h.honey - took);
    w.samango = h.day;
    out.push('samango-raid');
    // bible §15.2 — the quiet professionals. The canopy sentence is the mechanic (a fence
    // is not the answer here), so it stays welded to the joke rather than beside it.
    note(h, `Samango worked the hives overnight — ${took} kg of honey gone. `
      + 'They come through the canopy, so the fence does not help; they are professionals too.',
      'samango-raid');
  }

  // --- the snake: warm months, and only where there was work to do ---
  if (WILDLIFE.snakeMonths.includes(h.date.month) && (h.beds || []).length
    && h.day - (w.snake || 0) >= WILDLIFE.snakeEvery) {
    w.snake = h.day;
    h.lostDay = h.day;          // harvest() refuses while this is today
    out.push('snake-scare');
    // bible §15.3 — the one event allowed to say the quiet part. Understatement carries it:
    // no drama, no sting, and the constraint stated as a fact rather than a threat.
    note(h, 'A puff adder in the beds. Nobody bitten — the rest of the day was spent being '
      + 'sure. There is no doctor up here and the ambulance is two hours. '
      + 'The scare is the cheap outcome.', 'snake-scare');
  }

  // --- toad: the wetland exists the night the dug dam fills ---
  // Not a stream plot: a stream was always there. This is the dam the player dug, the one
  // the audit says is a money-loser — so the reward for digging it is a place, not a profit.
  const dam = Array.isArray(p.damTiles) && p.damTiles.length > 0;
  if (dam && h.water && h.water.stream && !w.wetland) {
    w.wetland = true;
    out.push('toad');
    // bible §15.4, the protected branch. The dam is the audit's money-loser, so the reward
    // for digging it is a place rather than a profit — and the village is the one counting.
    note(h, 'The damp corner is holding water. Somewhere in it a very rare toad is '
      + 'unimpressed but alive, and the village counts that your way.', 'toad');
  }

  return out;
}

/** A log line with its event name attached. Kept here so every wildlife line is written
 *  the same way — the audio seat reads `entry.event`, the player reads `entry.text`. */
function note(h, text, event) {
  h.log.push({ day: h.day, text, event });
  if (h.log.length > 200) h.log.shift();
}
