import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)
// market.js — one shop, one village, a fixed appetite.
//
// The supermarket is the only bulk buyer in Hogsback. It will take about a village's
// worth of vegetables a day at the going price, a bit more at a discount, and then it
// simply stops. You cannot plant forty beds and sell them all to the same counter.
//
// Pure logic, no DOM.

export const SHOP = {
  vegCapacity: 30,        // kg a day at full price
  honeyCapacity: 5,       // kg a day at full price
  overFactor: 0.6,        // what the excess is worth
  maxMultiple: 3,         // beyond 3x capacity it will not take it at all
  vegPrice: 10,           // R per kg
  honeyPrice: 150,        // R per kg
};

/** Season moves the price. Tourists in December, scarcity in June. */
export function vegPrice(date) {
  if (date.month === 12) return SHOP.vegPrice * 1.3;
  if (date.month === 1) return SHOP.vegPrice * 1.2;
  if (date.month === 6) return SHOP.vegPrice * 1.15;
  return SHOP.vegPrice;
}

export function honeyPrice(date) {
  // honey is out of season in the cold months, and so is the price
  return (date.month >= 5 && date.month <= 8) ? SHOP.honeyPrice * 0.6 : SHOP.honeyPrice;
}

/**
 * What the shop will pay for a load today, and what it will not take.
 * @returns {{zar, vegSold, honeySold, vegRefused, honeyRefused, detail: string[]}}
 */
export function quote(h, veg, honey) {
  const capV = SHOP.vegCapacity, capH = SHOP.honeyCapacity;
  const pv = vegPrice(h.date), ph = honeyPrice(h.date);

  const sellV = Math.min(veg, capV * SHOP.maxMultiple);
  const fullV = Math.min(sellV, capV);
  const overV = Math.max(0, sellV - capV);
  const zarV = fullV * pv + overV * pv * SHOP.overFactor;

  const sellH = Math.min(honey, capH * SHOP.maxMultiple);
  const fullH = Math.min(sellH, capH);
  const overH = Math.max(0, sellH - capH);
  const zarH = fullH * ph + overH * ph * SHOP.overFactor;

  const detail = [];
  if (fullV > 0) detail.push(`${Math.round(fullV)} kg veg at ${money(pv.toFixed(2))}`);
  if (overV > 0) detail.push(`${Math.round(overV)} kg veg at ${money((pv * SHOP.overFactor).toFixed(2))} (they only wanted ${capV})`);
  if (veg > sellV) detail.push(`${Math.round(veg - sellV)} kg left over — the shop will not take it`);
  if (fullH > 0) detail.push(`${fullH.toFixed(1)} kg honey at ${money(ph.toFixed(0))}`);
  if (overH > 0) detail.push(`${overH.toFixed(1)} kg honey at ${money((ph * SHOP.overFactor).toFixed(0))}`);
  if (honey > sellH) detail.push(`${(honey - sellH).toFixed(1)} kg honey left over`);

  return {
    zar: Math.round(zarV + zarH),
    vegSold: Math.round(sellV * 10) / 10,
    honeySold: Math.round(sellH * 100) / 100,
    vegRefused: Math.round((veg - sellV) * 10) / 10,
    honeyRefused: Math.round((honey - sellH) * 100) / 100,
    detail,
  };
}

/** How much the village can absorb in a day, for the HUD. */
export function appetite(date) {
  return {
    veg: SHOP.vegCapacity,
    honey: SHOP.honeyCapacity,
    vegPrice: Math.round(vegPrice(date) * 100) / 100,
    honeyPrice: Math.round(honeyPrice(date)),
  };
}
