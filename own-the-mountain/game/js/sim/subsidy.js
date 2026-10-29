import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)
import { tickGoals } from './goals.js';   // gate 2: the subsidy goal ticks on the answer
// subsidy.js — the village pays for a road it needs.
//
// Transport Tycoon's local authority subsidies, moved to Hogsback: in November the
// ratepayers' association offers to pay you to keep the road open through December,
// because that is when the visitors come and the school bus still has to run.
//
// Money tied to a place and a date, not to a price table.

export const SUBSIDY = {
  offerMonth: 11,     // offered on 1 November
  runMonth: 12,       // judged through December
  threshold: 60,      // road condition you must hold
  pay: 15000,
  partial: 0.5,       // what a mostly-good December is worth
  partialAt: 0.8,     // fraction of days that still earns the partial
};

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

export function initSubsidy(h) {
  h.subsidy = h.subsidy || { state: 'none', days: 0, daysOk: 0, paid: 0, year: null };
  return h;
}

/** Offer it on the first of November, once a year. */
export function maybeOffer(h) {
  initSubsidy(h);
  const s = h.subsidy;
  if (h.date.month !== SUBSIDY.offerMonth || h.date.day !== 1) return null;
  if (s.state === 'offered' || s.state === 'accepted') return null;
  if (s.year === h.date.year) return null;   // already settled this year
  s.state = 'offered';
  s.days = 0;
  s.daysOk = 0;
  s.year = h.date.year;
  h.log.push({
    day: h.day,
    text: `The ratepayers' association will pay ${money(SUBSIDY.pay)} if the road holds above `
      + `${SUBSIDY.threshold}% every day in December.`,
  });
  return s;
}

export function acceptSubsidy(h) {
  initSubsidy(h);
  if (h.subsidy.state !== 'offered') return err('there is no offer to accept');
  h.subsidy.state = 'accepted';
  h.log.push({ day: h.day, text: 'You took the December road subsidy.' });
  tickGoals(h);
  return ok('accepted');
}

export function declineSubsidy(h) {
  initSubsidy(h);
  if (h.subsidy.state !== 'offered') return err('there is no offer to decline');
  h.subsidy.state = 'declined';
  h.log.push({ day: h.day, text: 'You turned the subsidy down.' });
  return ok('declined');
}

/** Called each day before the calendar turns. */
export function tickSubsidy(h) {
  initSubsidy(h);
  const s = h.subsidy;
  if (s.state !== 'accepted') return null;
  if (h.date.month !== SUBSIDY.runMonth) return null;
  s.days += 1;
  if (h.road.condition >= SUBSIDY.threshold) s.daysOk += 1;
  return null;
}

/** Called after the calendar turns: settle when January arrives. */
export function settleSubsidy(h) {
  initSubsidy(h);
  const s = h.subsidy;
  if (s.state !== 'accepted') return null;
  if (!(h.date.month === 1 && h.date.day === 1)) return null;

  const frac = s.days ? s.daysOk / s.days : 0;
  if (frac >= 1) {
    h.cash += SUBSIDY.pay;
    s.paid = SUBSIDY.pay;
    s.state = 'done';
    h.log.push({ day: h.day, text: `The road held. The association paid ${money(SUBSIDY.pay)}.` });
  } else if (frac >= SUBSIDY.partialAt) {
    const part = Math.round(SUBSIDY.pay * SUBSIDY.partial);
    h.cash += part;
    s.paid = part;
    s.state = 'done';
    h.log.push({ day: h.day, text: `The road mostly held (${Math.round(frac * 100)}% of days). They paid ${money(part)}.` });
  } else {
    s.state = 'failed';
    s.paid = 0;
    h.log.push({ day: h.day, text: `The road did not hold (${Math.round(frac * 100)}% of days). No subsidy.` });
  }
  return { frac, paid: s.paid };
}

export function subsidySummary(h) {
  initSubsidy(h);
  const s = h.subsidy;
  return {
    state: s.state,
    days: s.days,
    daysOk: s.daysOk,
    paid: s.paid,
    threshold: SUBSIDY.threshold,
    pay: SUBSIDY.pay,
    frac: s.days ? Math.round((s.daysOk / s.days) * 100) : null,
  };
}
