// saves.js — the one place a household's save key is derived, and the only way a page asks
// "does this life already have a run, and is it still going?".
//
// plot.html used to build the key inline (`'otm-home-' + life + (site ? '-' + site.id : '')`)
// and the life picker needed the same answer to label its cards Play / Continue / Restart. Two
// copies of a key formula is how a picker ends up offering "Continue" on a save it cannot find
// - the duplicated-fact class this folder keeps paying for (rung labels, money formats, the
// bed's flat rule). So the rule lives here and both pages read it.
//
// UI-side only: nothing in this module is in the sim's path, nothing a golden hash can see.

/** The stored prefix every household run shares. */
export const SAVE_PREFIX = 'otm-home-';

/**
 * The key one run is stored under. One save per life AND per site: buying different ground is
 * a different run (owner ruling, plot.html).
 * @param {string} lifeKey the START_OPTIONS key, e.g. 'homesteader'
 * @param {string} [siteId] a sites.js id, or nothing for the canonical ground
 */
export function saveKey(lifeKey, siteId) {
  return SAVE_PREFIX + lifeKey + (siteId ? '-' + siteId : '');
}

/** Every stored key for one life, whatever ground it bought. Prefix match, not substring:
    'homestead' must not collect 'homesteaders-ward'. */
export function saveKeysFor(lifeKey, store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s || !lifeKey) return [];
  const stem = SAVE_PREFIX + lifeKey;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (!k || !k.startsWith(stem)) continue;
    if (k.length === stem.length || k[stem.length] === '-') out.push(k);
  }
  return out;
}

/**
 * What the picker needs to say about a life: 'none' (never played or cleared), 'living' (a run
 * that can be continued), or 'dead' (the run is over, so the card offers a restart).
 * A run that cannot be read is treated as no run at all - the card falls back to "Play as",
 * which is always a true statement, rather than promising a Continue it cannot deliver.
 * @returns {{status: string, key: string|null, day: number, cash: number, reason: string}}
 */
export function lifeStatus(lifeKey, store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  const none = { status: 'none', key: null, day: 0, cash: 0, reason: '' };
  const keys = saveKeysFor(lifeKey, s);
  if (!keys.length) return none;
  let living = null, dead = null;
  for (const k of keys) {
    let j = null;
    try { j = JSON.parse(s.getItem(k)); } catch { continue; }
    if (!j || !Number.isFinite(j.day)) continue;
    const rec = { status: j.ended ? 'dead' : 'living', key: k, day: j.day,
      cash: Number.isFinite(j.cash) ? j.cash : 0,
      reason: j.ended && typeof j.ended.reason === 'string' ? j.ended.reason : '' };
    // the freshest run wins: the one that has progressed furthest is the one the player
    // left, and a life can only be in one run at a time
    if (rec.status === 'living' && (!living || rec.day > living.day)) living = rec;
    if (rec.status === 'dead' && (!dead || rec.day > dead.day)) dead = rec;
  }
  return living || dead || none;
}
