import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)
// bank.js — the debt has a face.
//
// Animal Crossing's Tom Nook, taken seriously: the person you owe money to should be a
// person, and there should be something you can do about it besides fail. Here it is a
// bank manager who will restructure — once, twice, at a price — because that is what
// actually happens when a smallholder falls behind.
//
// Tone decision (deliberate): friendly, firm, and never cruel. The threat is real, but
// she is not a villain. A grim version was rejected: the game already has weather.

export const BANK = {
  manager: 'Mrs Naidoo',
  branch: 'Raymond Mhlaba',
  restructureStep: 400,     // added to the monthly bond each time you restructure
  maxRestructures: 3,
};

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

export function initBank(h) {
  h.bank = h.bank || { restructures: 0 };
  return h;
}

/** Can she help you this month? */
export function canRestructure(h) {
  initBank(h);
  return h.arrears > 0 && h.bank.restructures < BANK.maxRestructures && h.bond.monthly > 0;
}

/**
 * She will carry you for a month, and the bond goes up. Only the bond: a household with
 * no bond has nothing to restructure, and she says so.
 */
export function restructure(h) {
  initBank(h);
  if (h.arrears <= 0) return err(`${BANK.manager} cannot help with a bill you have already paid`);
  if (h.bond.monthly <= 0) return err('there is no bond to restructure');
  if (h.bank.restructures >= BANK.maxRestructures) {
    return err(`${BANK.manager} has run out of ways to help`);
  }
  h.bank.restructures += 1;
  h.arrears = 0;
  h.bond.monthly += BANK.restructureStep;
  h.log.push({
    day: h.day,
    text: `${BANK.manager} carried you for a month — the bond is ${money(h.bond.monthly)} now. `
      + `Do not make me good at this. (${h.bank.restructures} of ${BANK.maxRestructures} favours used.)`,
  });
  return ok('restructured', { monthly: h.bond.monthly, used: h.bank.restructures });
}

/** A line for the HUD, in her voice. NARRATIVE-BIBLE §5.2 — friendly, firm, never cruel.
    Every branch is deterministic from state; nothing here touches the RNG streams. */
export function bankLine(h) {
  initBank(h);
  if (h.bond.monthly <= 0) return 'No bond. Nothing owed to the bank.';
  if (h.arrears === 0) {
    if (h.date.month === 12) {
      return `${BANK.manager}: "December rates are the same as any month. The mountain does not celebrate."`;
    }
    return `${BANK.manager}: "All square this month. ${money(h.bond.monthly)} again on the 1st."`;
  }
  if (canRestructure(h)) {
    if (h.bank.restructures === 1) {
      return `${BANK.manager}: "Second time. I will not pretend I am not counting."`;
    }
    return `${BANK.manager}: "You are behind. I can carry you once — it puts ${money(BANK.restructureStep)} `
      + `on the bond."`;
  }
  return `${BANK.manager}: "I have done what I can. The next month is yours to fix."`;
}

export function bankSummary(h) {
  initBank(h);
  return {
    manager: BANK.manager,
    monthly: h.bond.monthly,
    arrears: h.arrears,
    restructures: h.bank.restructures,
    canRestructure: canRestructure(h),
    line: bankLine(h),
  };
}
