// voices.js — what the guests actually say.
//
// Borrowed from RollerCoaster Tycoon: the player should not have to read a number to
// know the road is bad. Someone says it to them. Every line is triggered by real state,
// so the complaints are a diagnostic, not decoration.
//
// Uses its own RNG stream (h.voiceRng) so adding a quote never shifts the booking
// sequence — the economy must stay reproducible.

export const VOICES = {
  road: [
    'The road up here is a disgrace. Forty minutes from the tar.',
    'Lost a tyre on the way in. Nobody warned us.',
    'Beautiful place, terrible road. Would not try it in a sedan again.',
    'Potholes the size of a bathtub.',
    'We nearly turned back at the second cattle grid.',
  ],
  forest: [
    'We came for the forest. Where is it?',
    'The hill behind the cottage is bare. A plantation, apparently.',
    'You can hear the chainsaws from the stoep.',
    'This is not the indigenous forest the photos promised.',
    'Lovely, but the view is stumps.',
  ],
  cold: [
    'No heater and no hot water. Four degrees outside.',
    'Beautiful in the mist, freezing in the bed.',
    'Bring a hot water bottle. Two.',
    'The fireplace smoked us out. We slept in our clothes.',
  ],
  water: [
    'The tank ran dry on the second morning.',
    'Cold showers only after the third guest.',
    'Lovely stay, but we rationed the kettle.',
  ],
  power: [
    'Load shedding took the fridge and the wifi with it.',
    'Candles were charming the first night. Not the third.',
    'No power, no coffee. We left early.',
  ],
  good: [
    'Woke up above the mist. Worth every pothole.',
    'Saw all three peaks from the bed.',
    'The honey at breakfast was the best we have had.',
    'Quiet. Actually quiet.',
    'A porcupine on the lawn at dusk. The kids will never forget it.',
    'Best weekend we have had in years. We will be back in December.',
  ],
  // Bible §13.2 — the good-night pool. Same night, a guest who reads their own stay
  // rather than the brochure. Fires on the same gate as good[] (rating ≥ 4.5).
  praise: [
    'A loerie in the yellowwoods at breakfast. The kids are still talking about it.',
    'We heard the loeries before we saw them. Then we saw them.',
    'Woke up inside a cloud. Would not change a thing.',
    'No town glow. The Milky Way, plainly, from the stoep.',
    'The generator was silent because there is no generator. Solar, and the frogs, and sleep.',
    'Best night of a three-week trip. We extended on the spot.',
  ],
  // Bible §16.3 — snow is a draw. The disappointment is the road, never the mountain.
  snow: [
    'Snow on the Hogsback. We booked the moment the forecast said so, and the photos do not lie.',
    'Drove up for the snow and got it. The pass was the adventure, the snow was the prize.',
    'Snow to the gate, wood on the fire, nowhere to be. December can keep its beaches.',
  ],
  // Bible §16.2 — the archetypes that ride real state: the forest is why the birders came,
  // and the camp rung is why the hikers came. No invented traveller types here.
  birder: [
    'Up at four for the forest. Worth it. Our list grew by eleven and we saw the loerie twice.',
    'They said "just follow the knysna call". We did. Wet, thrilled, back by seven.',
    'Four hours in the forest and one lifer. My knees are finished and I do not care.',
  ],
  hiker: [
    'Left early, came back muddy, slept like the dead. Exactly as advertised.',
    'Falls before breakfast, mist by noon. The map they gave us was hand-drawn and better than the app.',
    'Six hours up, one cold beer, no signal. That is the whole review.',
  ],
  // Bible §16.2 — the family. Unlocked by L5's `party` (2026-10-23): an open pitch gets a
  // family or a group, which is the first state that ever knew a child was on the plot.
  family: [
    "The children named every chicken. We now owe a hen's name to a five-year-old's memory. We will be back to check.",
    'Porcupine at dusk, frogs at night, no signal at all. The kids cried when we left. So did my wife, quietly.',
    'Two days, three muddy children, one bath. We would do it again tomorrow.',
  ],
  // Bible §16.2 — the privacy couple. Mist is the point: they came to disappear, and the
  // weather that empties the view is the weather they booked.
  privacy: [
    'Saw no one but the mist and one hadeda. Perfect.',
    'We told people we were going to Knysna. We were here. It was better.',
    'Three days and we spoke to two people, both of them each other. Exactly the plan.',
  ],
  neutral: [
    'Lovely spot, a bit far from the village.',
    'Fine for the price. Bring warm socks.',
    'Good base for the falls. The road is what it is.',
    'Simple, clean, and very quiet.',
  ],
  // Bible §5.8 — the December regular: one unnamed guest, same room, every December.
  // Exactly three lines, in strict rotation, a pure function of the repeat count.
  // A fixture of the year, not a character study. Never picked by pickVoice.
  decemberRegular: [
    'Same room as last December. We did not have to ask.',
    'The mist was here before us. It always is, this month.',
    'Same room next December. No need to write it down.',
  ],
};

const MOOD = {
  road: 'bad', forest: 'bad', cold: 'bad', water: 'bad', power: 'bad',
  good: 'good', neutral: 'neutral',
};

export function initVoices(h) {
  h.voiceRng = h.voiceRng || 777001;
  h.voices = h.voices || [];
  return h;
}

function rnd(h) {
  h.voiceRng = (Math.imul(1664525, h.voiceRng >>> 0) + 1013904223) >>> 0;
  return h.voiceRng / 4294967296;
}

function pick(list, h) { return list[Math.floor(rnd(h) * list.length) % list.length]; }

/** Choose what this guest would say, from the state of the place. */
export function pickVoice(h) {
  initVoices(h);
  const roll = rnd(h);
  const winter = h.date.month >= 5 && h.date.month <= 8;

  if (h.road.condition < 40 && roll < 0.62) return cat('road', h);
  if ((h.forest == null ? 100 : h.forest) < 50 && roll < 0.55) return cat('forest', h);
  if (winter && roll < 0.38) return cat('cold', h);
  if (!h.water.tank && !h.water.stream && roll < 0.5) return cat('water', h);
  if (h.rating >= 4.5 && roll < 0.55) return cat('good', h);
  return cat('neutral', h);
}

/**
 * Which praise pool a satisfied guest draws from. State in, pool out — it takes no draw
 * of its own, so the voice stream keeps exactly one number per night, as before.
 * Order is the guest's own: **who is here** (L5's `party` — the strongest fact about a
 * night), then the weather they came for, then the forest they came for, then the rung
 * they paid for, then the night they had.
 */
function goodPool(h) {
  const kind = h.weather && h.weather.kind;
  const party = h.lastParty;
  if (party === 'family') return VOICES.family;
  if (party === 'couple' && kind === 'mist') return VOICES.privacy;
  if (kind === 'snow') return VOICES.snow;
  if ((h.forest == null ? 100 : h.forest) >= 75) return VOICES.birder;
  const built = (h.accom || []).filter((a) => a.built).map((a) => a.kind);
  if (built.length && built.every((k) => k === 'camp' || k === 'caravan')) return VOICES.hiker;
  if ((h.rating || 0) >= 4.5) return VOICES.praise;
  return VOICES.good;
}

function cat(name, h) {
  const pool = name === 'good' ? goodPool(h) : VOICES[name];
  return { cat: name, mood: MOOD[name], text: pick(pool, h) };
}

/** Record a voice for a night that was sold. Returns it. */
export function recordVoice(h, unitId) {
  const v = pickVoice(h);
  h.voices.push({ day: h.day, unit: unitId, ...v });
  if (h.voices.length > 60) h.voices.shift();
  return v;
}

/** The last few, newest first, for the HUD. */
export function recentVoices(h, n = 5) {
  initVoices(h);
  return h.voices.slice(-n).reverse();
}

/**
 * The December regular (bible §5.8). One unnamed guest who books the same room every
 * December. The first-ever December let only remembers the unit and year — they are
 * just a guest yet. A let on the SAME unit in a LATER year speaks one line, in
 * rotation, a pure function of the repeat count: no RNG, ever. A different unit is
 * not them, and changes nothing. Non-December nights never touch the memory.
 * Call once per let night, from the booking path in tourism.js.
 */
export function decemberRegular(h, unitId, events) {
  if (h.date.month !== 12) return null;
  h.december = h.december || { unit: null, year: null, count: 0 };
  if (h.december.unit === unitId) {
    if (h.date.year <= h.december.year) return null;   // already spoke this December
    h.december.count += 1;
    h.december.year = h.date.year;
    const text = VOICES.decemberRegular[Math.min(h.december.count, 3) - 1];
    events.push(`"${text}"`);
    return text;
  }
  if (h.december.unit == null) { h.december.unit = unitId; h.december.year = h.date.year; }
  return null;
}
