// legacy.js — what the mountain comes to.
//
// There is no victory screen. The design says "no win, two losses", so the endgame is a
// HORIZON, not a trophy: two ways to stop being squeezed, both of which change the world
// and neither of which ends the game.
//
//   BUY IN    — save enough to take the company, and become the thing you opposed.
//   ALTERNATIVE — build enough beds on intact forest that their land is worth less to
//                 them than it is to you, and they go.
//
// Both are visible from the first day, so the player knows what they are walking towards.

import { ACCOM } from './tourism.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

export const LEGACY = {
  buyInCost: 900000,
  buyInDividend: 15000,        // a month, once you own it
  altCapacity: 6,              // guest beds
  altForest: 75,               // forest health on your own ground
  altDays: 500,                // about seventeen months
};

// Settlement texts — NARRATIVE-BIBLE §7, verbatim. They appear once, in the morning
// report slot, on the morning the state flips. Neither ends the game.
const BUY_IN_TEXT = 'The trucks are parked. Not gone — parked. The men who cut the blocks '
  + 'nearest the village are the men you now sign the schedules for, and the schedule says '
  + 'the mountain rests. The dividend lands on the 1st, like the bond used to. '
  + 'You stopped the logging by becoming the logger. The mist does not care which.';
const ALTERNATIVE_TEXT = 'The sale went through in King William\u2019s Town. Your beds and the '
  + 'standing forest were worth more than the pine was, and somebody finally did that '
  + 'arithmetic. The chainsaws are quiet. The road will still need patching. The bills still '
  + 'come on the 1st. The mountain did not get saved. It got outvoted — by six guest beds '
  + 'and a hundred years of trees.';

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

export function initLegacy(h) {
  h.legacy = h.legacy || { path: null, boughtIn: false, alternative: false, dividends: 0 };
  return h;
}

/** Beds you can actually sell. */
export function guestCapacity(h) {
  return (h.accom || []).filter((a) => a.built).reduce((n, a) => n + ACCOM[a.kind].capacity, 0);
}

/** How far along the alternative path you are, 0-1, as the weakest of the three. */
export function alternativeProgress(h) {
  initLegacy(h);
  const cap = Math.min(1, guestCapacity(h) / LEGACY.altCapacity);
  const forest = Math.min(1, (h.forest == null ? 100 : h.forest) / LEGACY.altForest);
  const time = Math.min(1, h.day / LEGACY.altDays);
  return Math.min(cap, forest, time);
}

export function buyInProgress(h) {
  initLegacy(h);
  return Math.min(1, h.cash / LEGACY.buyInCost);
}

/** Take the company. You now own the thing that was cutting the mountain. */
export function buyIn(h) {
  initLegacy(h);
  if (h.legacy.boughtIn) return err('you already own it');
  if (h.legacy.alternative) return err('the company has already left');
  if (h.cash < LEGACY.buyInCost) {
    return err(`a controlling stake is ${money(LEGACY.buyInCost)} — you have ${money(Math.round(h.cash))}`);
  }
  h.cash -= LEGACY.buyInCost;
  h.legacy.boughtIn = true;
  h.legacy.path = 'buy-in';
  h.company.relation = 'owner';
  h.contract.state = 'declined';
  h.log.push({
    day: h.day,
    text: `You bought the company. −${money(LEGACY.buyInCost)}. ${BUY_IN_TEXT}`,
  });
  return ok('bought in', { cost: LEGACY.buyInCost });
}

/** Called daily. Checks the alternative, and pays the dividend once you own the company. */
export function tickLegacy(h) {
  initLegacy(h);

  if (h.legacy.boughtIn && h.date.day === 1) {
    h.cash += LEGACY.buyInDividend;
    h.legacy.dividends += LEGACY.buyInDividend;
    h.log.push({ day: h.day, text: `Dividend from the company. +${money(LEGACY.buyInDividend)}` });
  }

  if (!h.legacy.alternative && !h.legacy.boughtIn) {
    const p = alternativeProgress(h);
    if (p >= 1) {
      h.legacy.alternative = true;
      h.legacy.path = 'alternative';
      h.company.relation = 'left';
      h.contract.state = 'declined';
      h.log.push({
        day: h.day,
        text: `The company has sold up and gone. ${ALTERNATIVE_TEXT}`,
      });
    }
  }
  return null;
}

export function legacySummary(h) {
  initLegacy(h);
  const cap = guestCapacity(h);
  return {
    path: h.legacy.path,
    boughtIn: h.legacy.boughtIn,
    alternative: h.legacy.alternative,
    buyInCost: LEGACY.buyInCost,
    buyInProgress: Math.round(buyInProgress(h) * 100),
    alternativeProgress: Math.round(alternativeProgress(h) * 100),
    capacity: cap,
    altCapacity: LEGACY.altCapacity,
    forest: Math.round(h.forest == null ? 100 : h.forest),
    altForest: LEGACY.altForest,
    days: h.day,
    altDays: LEGACY.altDays,
    dividends: h.legacy.dividends,
    settled: h.legacy.boughtIn || h.legacy.alternative,
  };
}
