// weather.js — the mountain decides.
//
// Southern hemisphere: winter (Jun–Aug) is DRY — frost, cold snaps, the odd snow day.
// The rain belongs to summer, and December is the stormiest month of the year. June is
// cold and empty, not wet; December is full and raining. Weather is the thing that makes
// the year feel different in month three and month nine, not just a different season
// multiplier on bookings.
//
// Own RNG stream, like voices, so adding a weather type never shifts the booking
// sequence or the guest quotes.

export const WEATHER = {
  clear: { label: 'Clear', roadMult: 1.0, guestMult: 1.0, living: 0, cropMult: 1.0 },
  mist: { label: 'Mist', roadMult: 1.0, guestMult: 1.0, living: 0, cropMult: 1.0 },
  rain: { label: 'Rain', roadMult: 1.8, guestMult: 0.9, living: 0, cropMult: 1.0 },
  storm: { label: 'Heavy rain', roadMult: 3.0, guestMult: 0.6, living: 0, cropMult: 0.8 },
  cold: { label: 'Cold snap', roadMult: 1.2, guestMult: 0.8, living: 80, cropMult: 0.5 },
  snow: { label: 'Snow', roadMult: 2.5, guestMult: 1.0, living: 120, cropMult: 0.3 },
};

/** How likely each kind is, by month. Rows sum to 1.
    Hogsback year, southern hemisphere: wet summer (Dec the stormiest), drying autumn,
    DRY winter (rain ≤ 0.06, no storms — frost instead), wetting-up spring. */
export const CHANCES = {
  // Summer — wet, afternoon storms. December is the wettest, stormiest month.
  12: { clear: 0.42, mist: 0.08, rain: 0.34, storm: 0.16 },
  1: { clear: 0.47, mist: 0.08, rain: 0.32, storm: 0.13 },
  2: { clear: 0.48, mist: 0.1, rain: 0.3, storm: 0.12 },
  // Autumn — drying out; the first cold snap lands in May.
  3: { clear: 0.55, mist: 0.16, rain: 0.22, storm: 0.07 },
  4: { clear: 0.61, mist: 0.18, rain: 0.16, storm: 0.05 },
  5: { clear: 0.63, mist: 0.16, rain: 0.1, storm: 0.03, cold: 0.08 },
  // Winter — DRY. Frost nights are cold, not wet. July is the coldest, snowiest month.
  6: { clear: 0.5, mist: 0.08, rain: 0.05, storm: 0, cold: 0.32, snow: 0.05 },
  7: { clear: 0.48, mist: 0.08, rain: 0.04, storm: 0, cold: 0.34, snow: 0.06 },
  8: { clear: 0.49, mist: 0.1, rain: 0.06, storm: 0, cold: 0.3, snow: 0.05 },
  // Spring — wetting up towards the summer storms.
  9: { clear: 0.65, mist: 0.18, rain: 0.14, storm: 0.03 },
  10: { clear: 0.56, mist: 0.16, rain: 0.21, storm: 0.07 },
  11: { clear: 0.48, mist: 0.12, rain: 0.28, storm: 0.12 },
};

/** The named season for a month, for the HUD and anything that thinks in seasons. */
export const SEASON_LABEL = {
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
  spring: 'Spring',
};

export function seasonOf(month) {
  const m = ((Number(month) - 1) % 12 + 12) % 12 + 1;
  if (m === 12 || m <= 2) return 'summer';
  if (m <= 5) return 'autumn';
  if (m <= 8) return 'winter';
  return 'spring';
}

export function initWeather(h) {
  h.weatherRng = h.weatherRng || 314159;
  h.weather = h.weather || { kind: 'clear', label: 'Clear' };
  return h;
}

function rnd(h) {
  h.weatherRng = (Math.imul(1664525, h.weatherRng >>> 0) + 1013904223) >>> 0;
  return h.weatherRng / 4294967296;
}

/** Roll today's weather for the household's current month. */
export function rollWeather(h) {
  initWeather(h);
  const table = CHANCES[h.date.month] || CHANCES[3];
  let r = rnd(h);
  let kind = 'clear';
  for (const [k, p] of Object.entries(table)) {
    if (r < p) { kind = k; break; }
    r -= p;
  }
  const prior = h.weather || {};
  const prev = prior.kind || 'clear';
  h.weather = {
    kind,
    label: WEATHER[kind].label,
    // The spell fields the narrative seat needed (lead, 2026-10-23, bible §20.3). A spell
    // is not an event: a line gated on `kind === 'mist'` says itself every day of a
    // three-day mist, which is worse than silence. `prev` is yesterday's kind and `run` is
    // how many days this one has held, so a gate can be true for exactly one day
    // (`kind === 'mist' && run === 1`). Bookkeeping on the roll already made — no extra
    // draw, the RNG stream is untouched, and `snap()` reads `h.weather.kind` alone, so no
    // golden can see either field. `run` starts at 1 on the first rolled day even when the
    // placeholder was the same kind, because nobody experienced the placeholder.
    prev,
    run: (kind === prev && Number.isInteger(prior.run)) ? prior.run + 1 : 1,
  };
  return h.weather;
}

export function current(h) { return WEATHER[(h.weather && h.weather.kind) || 'clear']; }

/** Winter is a cost, not a mood. */
// Winter is May–July (owner, 2026-10-20): the cold-cost window, aligned to seasonOf.
export function isWinter(h) { return h.date.month >= 5 && h.date.month <= 7; }

export function livingExtra(h) {
  const w = current(h);
  return (w.living || 0) + (isWinter(h) ? 40 : 0);
}

export function roadWearMult(h) { return current(h).roadMult; }
export function guestMult(h) { return current(h).guestMult; }
export function cropMult(h) { return current(h).cropMult * (isWinter(h) ? 0.5 : 1); }

/** A one-line report for the HUD. Snow is a draw when the road can take it — the
    road-gated booking maths lives in tourism.occupancyChance.
    Copy: bible §16.3, owner ruling 2026-10-21 — SNOW IS AN ATTRACTION, never a
    cancellation. In snow the disappointment is the road, never the mountain, so the
    snow line never says "cancelling" and never blames the weather for an empty house. */
export function weatherLine(h) {
  const w = current(h);
  // the KIND lives on the household, not on the WEATHER row — reading it off the row
  // silently killed the old snow branch (found by probe, 2026-10-22)
  const kind = (h.weather && h.weather.kind) || 'clear';
  const goodRoad = !!(h.road && h.road.condition >= 50);

  // the four approved lines read as whole sentences — no "· winter rates" tail on them
  if (kind === 'snow') {
    return goodRoad
      ? 'Snow · the whole village is coming up the pass · the road decides'
      : 'Snow · they want to come and the road says no';
  }
  if (kind === 'cold') return 'Cold snap · today the fire is the amenity';
  if (kind === 'mist') return 'Mist · the valley has disappeared. It does that.';

  const bits = [w.label];
  if (w.roadMult > 1.2) bits.push('the road is taking a beating');
  if (w.guestMult < 0.9) bits.push('guests are thinning out');
  if (isWinter(h)) bits.push('winter rates');
  return bits.join(' · ');
}
