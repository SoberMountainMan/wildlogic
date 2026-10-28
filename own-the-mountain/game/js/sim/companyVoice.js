// companyVoice.js — Mr P.J. van Wyk, the face of Amatola Forestry.
//
// NARRATIVE-BIBLE §5.3. Third-generation forester; his grandfather dug the sawpits by
// the Big Tree. He is the only mouth the Company gets: the buyout offer, the monthly
// quota, and (if you buy in) your own payroll. Friendly, firm, never cruel — his
// arguments are history, wages and law, in that order, and he believes all three.
//
// Built like bank.js: constants, init, a state-triggered line, a summary. Every line
// is deterministic from state; nothing here touches the RNG streams. The raw line
// carries no name prefix — companyVoiceSummary adds `Van Wyk: "…"` for the HUD.

import { COMPANY } from './company.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

export const VANWYK = {
  name: 'Mr P.J. van Wyk',
};

/** One-time lines say once, then the ongoing state takes over. Not in snap() (the
 *  golden whitelist picks named fields), so the traces do not move. */
export function initCompanyVoice(h) {
  h.vanWyk = h.vanWyk || { seenOffer: false, saidSigned: false };
  return h;
}

/** His current line, raw. Silence ('') is allowed — he is not a filler voice. */
export function vanWykLine(h) {
  initCompanyVoice(h);
  const rel = h.company.relation;
  if (rel === 'owner') {
    return 'You own it now. Same trucks, different signature. I work for whoever signs.';
  }
  if (rel === 'left') {
    return 'They sold me the bakkie. I will still see you at the shop.';
  }
  if (rel === 'opposed') {
    return 'You are with the ratepayers now. That is your right. The mountain is big and my schedule is longer than your opinion.';
  }
  if (h.contract.state === 'active') {
    if (!h.vanWyk.saidSigned) {
      // the day the ink dries — then the ongoing quota line takes over
      h.vanWyk.saidSigned = true;
      return 'Good. You will hear the trucks before you see them. Everyone does.';
    }
    return 'The quota does not care about your bookings. That is not cruelty. It is a schedule.';
  }
  if (h.contract.state === 'offered') {
    const dueIn = Math.max(0, h.contract.dueDay - h.day);
    return `${h.contract.m3} cubic metres in ${dueIn} days. ${money(COMPANY.contractPay)}. Your trees, your timing, our trucks.`;
  }
  if (h.company.offer && !h.company.taken && !h.company.refused) {
    if (!h.vanWyk.seenOffer) {
      // the day the offer lands — the paperwork on the table speaks after that
      h.vanWyk.seenOffer = true;
      return `Morning. My grandfather dug the sawpits by the Big Tree. Those pines on your ground are worth ${money(h.company.offer.zar)} standing. I have the cheque with me.`;
    }
    return '';
  }
  if (h.company.refused) {
    return 'Fair enough. It stays on the table for no one. The offer dies today, not tomorrow.';
  }
  return '';
}

/** HUD layer: the spoken line, named and quoted. Silence stays empty. */
export function companyVoiceSummary(h) {
  initCompanyVoice(h);
  const raw = vanWykLine(h);
  return { line: raw ? `Van Wyk: "${raw}"` : '' };
}
