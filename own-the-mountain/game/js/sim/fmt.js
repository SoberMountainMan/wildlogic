// fmt.js — the one money formatter the sim is allowed to use (lead, 2026-10-23).
//
// WHY THIS EXISTS
// The player sees two money styles at once. The interface prints `H$243 520`
// (`plot.html`'s `money`), and the simulation's own log lines print `H$243520` —
// including the very first sentence a new player reads, the identity line. The narrative
// seat filed it on the board and the lead mis-routed it to the UI seat, because the
// string is in `homestead.js`, not in a page.
//
// WHY IT IS A LEAF MODULE
// `homestead.js` already imports `tourism.js`, `weather.js` and friends, so a formatter
// exported from any of them would either create an import cycle or tie a display helper to
// a gameplay module. This file imports NOTHING, so anything can use it, including a page,
// and the Godot port can read it as a string rule rather than as code.
//
// THE SPACE IS NOT A THOUSANDS COMMA. `toLocaleString('en-ZA')` emits a narrow no-break or
// a plain space depending on engine and locale data, which is why the repo already prints
// `H$243 520` with a space rather than `H$243,520`: South African convention groups with a
// space, and a comma reads as a decimal point to half the village. The formatter is pinned
// to that in tests so an engine update cannot quietly change the game's money.
//
// THE SWEEP IS DELIBERATELY NOT DONE HERE. Every log line in `tourism.js`, `siteworks.js`,
// `bank.js` and `legacy.js` interpolates raw numbers today; converting all of them in one
// night, while four seats are writing, is churn. The identity line is the one a player
// cannot avoid, so it moved first. The rest is a board task.

/** H$ + grouped digits, negative shown with a real minus sign: -H$1 240. */
export function money(n) {
  const v = Math.round(Number(n) || 0);
  const sign = v < 0 ? '−' : '';
  return `${sign}H$${Math.abs(v).toLocaleString('en-ZA')}`;
}

/** The same, for a delta that should always say which way it went. */
export function signedMoney(n) {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '−' : '+'}H$${Math.abs(v).toLocaleString('en-ZA')}`;
}
