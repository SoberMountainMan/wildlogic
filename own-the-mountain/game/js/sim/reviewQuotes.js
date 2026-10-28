// reviewQuotes.js — the guest's own words, per factor, per rung.
//
// NARRATIVE-BIBLE §13. The review engine (tourism.reviewNight) already scores the night
// per factor and hands back a terse `quote`; that field is the engine's contract and it is
// pinned by the gate, so this module never touches it. What lives here is the *sentence*
// the guest actually writes — the one that goes into the log as a review.
//
// Two rules, both from the bible and the level seat's agreement (§13.1):
//   1. The pool is picked by the factor, the TIER by the rung the guest paid for. "Income
//      up, tolerance down": a camper who is cold gets the mild line, a cabin guest who is
//      cold gets the harsh one. Same plumbing, different sentence.
//   2. `value` is tiered on OVERSHOOT ALONE. The level seat measured the old spec — "rate
//      >15% over market AND the night scores under 4" — and it produced zero quotes in 300
//      days at 1.5× market, because a well-run property's nights score 4 or better. The
//      price grumble cannot wait for a bad night: a guest who paid over market says so.
//
// No RNG. The pick is a hash of the night's own coordinates, so a replay writes the same
// review forever and the voice/booking streams are untouched.

/** Bible §13.2, keyed by pool. `harsh` is what a cottage-and-up guest writes; `mid` is
 *  what a camping guest writes about the same fault. */
export const REVIEW_POOLS = {
  road: {
    harsh: [
      'The last two kays took forty minutes. Our backs are still in first gear.',
      'Do not come in a sedan. Just do not.',
      'Potholes with their own postcode. The place is lovely — the road is a gauntlet.',
    ],
    mid: [
      'Gravel most of the way. Doable, slow, and your paintwork pays for it.',
      'Ten minutes of gravel is a small price for this quiet — but it is a long ten minutes.',
    ],
  },
  driveway: {
    harsh: [
      'We got stuck at the gate and walked the last 400 metres. With the cooler box.',
      'The van sank to the axles in the rain. Recovery cost more than the night.',
    ],
    mid: [
      'Driveway is a mud bath after rain. Park at the road and accept the walk.',
      'Fine in the dry. In the wet, bring boots and a friend with a tow rope.',
    ],
  },
  warmth: {
    harsh: [
      'For this rate there should be a fire laid. There was not.',
      'Ice on the INSIDE of the windows. Beautiful, but no.',
      'The fireplace smoked us out. We slept in our clothes.',
    ],
    mid: [
      'Bring jerseys. Then bring more.',
      'Heater gave up by midnight. We were warm enough. Just.',
    ],
  },
  power: {
    harsh: [
      'Power went at six and came back at ten. Cold dinner by candlelight. Romantic once.',
      'They advertise a generator. It did not work. It kept tripping.',
    ],
    mid: [
      'Load shedding took the kettle and the plans with it.',
      'Lights went out mid-braai. We finished by torch and it was almost fun.',
    ],
  },
  wifi: {
    harsh: [
      'Wifi is a rumour here. Two bars, downstairs, one device at a time.',
      'Advertised wifi. What we got was a rumour with a password.',
    ],
    mid: ['Wifi works, if your definition of works is generous.'],
  },
  braai: {
    harsh: [
      'No braai. In South Africa. We made a plan with rocks and it shows in the photos.',
      'A Hogsback stay with no braai is a hotel room with a view.',
    ],
    mid: ['Braai is a grid on two bricks. It cooked. Mostly.'],
  },
  cleanliness: {
    harsh: [
      'We cleaned before we slept.',
      'Hairs in the bath. First and last visit.',
    ],
    mid: ['Not dirty. Not clean either. Somewhere in the honest middle.'],
  },
  weeds: {
    harsh: [
      'The garden has gone to wattle. The photos are old.',
      'Weeds to the stoep. You earn the view here, with a slasher.',
    ],
    mid: ['Garden is winning, but you can see the path.'],
  },
  bathroom: {
    // There is no `harsh` tier here, on purpose: the engine only charges `ablution` to camp
    // and caravan (tourism.js: `!f.ablution && (kind==='camp'||kind==='caravan')`), and both
    // of those draw `mid` first — so a harsh-tier bathroom line was unreachable copy. The
    // two strongest sentences in the pool were therefore never heard. They live here now,
    // with the van guest who wrote them. Bible §20.4.
    mid: [
      'Ablutions are basic and cold. Manageable for two nights, not for four.',
      'The ablutions were not fit to use. We drove to the village.',
      'One working tap for the whole site. In the cold.',
    ],
  },
  value: {
    harsh: [
      'Nice enough. Not at that price.',
      'City rates for a dirt road. The maths is off.',
      'Half the amenities, twice the rate. Choose one.',
    ],
    mid: [
      'Fair for the setting, steep for what is actually here.',
      'We have paid less for more, and more for less. This sat wrong.',
    ],
  },
  // §16.2, the "experience" guest: the airbnb-flavoured complaint. It rides the value
  // pool's harsh tier, because that is the guest who came for a curated experience.
  experience: {
    harsh: [
      'The listing promised an experience. We got a grumpy donkey and excellent firewood. Three stars, and the donkey knows why.',
      'The "experience" was mostly mud and a rooster at four. Charge for the rooster next time.',
    ],
    mid: ['Rustic is one word for it. The listing used several better ones.'],
  },
};

/**
 * Review-factor → pool (bible §13.1, agreed with the level seat). Every key here is a
 * `PENALTY` key from tourism.js — no invented factors, no parallel vocabulary.
 * `oak` and `repair` are deliberately absent: those two already have their own pinned
 * sentences and the village's opinion is not a review cliché.
 */
export const POOL_OF = {
  road: 'road',
  driveway: 'driveway',
  mud: 'driveway',
  cold: 'warmth',
  firewood: 'warmth',
  power: 'power',
  noise: 'power',
  wifi: 'wifi',
  braai: 'braai',
  cleaning: 'cleanliness',
  weeds: 'weeds',
  ablution: 'bathroom',
  value: 'value',
};

/** The rung's tolerance, in tier order. Campers forgive; cabins do not; the top rung
 *  never draws the mild line at all (bible §13.1). */
const MID_RUNGS = new Set(['camp', 'caravan']);
const TOP_RUNGS = new Set(['cabin']);

export function tiersFor(kind) {
  if (MID_RUNGS.has(kind)) return ['mid', 'harsh'];
  if (TOP_RUNGS.has(kind)) return ['harsh'];
  return ['harsh', 'mid'];
}

/** FNV-1a over a short string. Deterministic, tiny, and no stream to disturb. */
function hash(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x;
}

/** How far over market the guest was charged, as a fraction (0.5 = 50% over). */
export function overshoot(h, unit) {
  const mult = (h.rates && h.rates[unit.kind]) || 1;
  return Math.max(0, Number(mult) - 1);
}

/**
 * The review this guest writes, or '' when the bank has nothing for the night.
 * @param {object} h household
 * @param {object} unit the rung that was let
 * @param {object} review the engine's own reviewNight() result (score, worst)
 */
export function guestReview(h, unit, review) {
  if (!review) return '';
  let key = review.worst;
  // the price leads when the guest paid over market — see rule 2 at the top of the file
  if (overshoot(h, unit) > 0.15) key = 'value';
  if (!key) return '';

  const pool = REVIEW_POOLS[POOL_OF[key] || key];
  if (!pool) return '';

  // the experience guest only exists at the top of the price range
  const wantExperience = overshoot(h, unit) >= 0.4 && REVIEW_POOLS.experience;
  const table = wantExperience && key === 'value' ? REVIEW_POOLS.experience : pool;

  for (const tier of tiersFor(unit.kind)) {
    const list = table[tier];
    if (!list || !list.length) continue;
    return list[hash(`${h.day}|${unit.id || unit.kind}|${key}|${tier}`) % list.length];
  }
  return '';
}
