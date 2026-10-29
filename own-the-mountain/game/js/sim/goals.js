// goals.js — what to do next, without a tutorial.
//
// The game opens on nine buttons and no instruction. Rather than a coach that talks at
// the player, this is a short list that ticks itself off: it only ever says the next
// thing, and it stops saying anything once you are running.
//
// Goals are checks over the household, not flags you have to set. That means a player
// who works it out on their own still gets the tick.

export const GOALS = [
  {
    id: 'water',
    text: 'Get water onto the plot',
    hint: 'You last three days without it. A stream counts; otherwise build a tank.',
    check: (h) => h.water.stream || h.water.tank,
  },
  {
    id: 'bed',
    text: 'Plant something',
    hint: 'Crops differ: greens are in after 12 days, potato after 32 and worth three times as much. Home-grown beats the shop at H$70 a day.',
    check: (h) => (h.beds || []).length > 0,
  },
  {
    id: 'sale',
    text: 'Take a load to the shop',
    hint: 'Little and often beats one big dump.',
    check: (h) => (h.sold || 0) > 0,
  },
  {
    id: 'tree',
    text: 'Decide about the trees',
    hint: 'Sell them to the company, or turn them down.',
    // L7 (narrative seat's find, fixed 2026-10-23): the old check was
    // `!h.company.offer || taken || refused`, and `offer` is null on day ONE — so the goal
    // ticked itself before the player had been asked anything. Now it ticks when the offer
    // was actually ANSWERED, or when there is nothing to decide because the plot carries no
    // pine at all (the LD-08 trap: a goal that can never be reached is worse than no goal).
    check: (h) => {
      const c = h.company || {};
      if (c.taken || c.refused) return true;
      const trees = (h.plot && h.plot.trees) || [];
      return trees.length > 0 && !trees.some((t) => t.kind === 'pine');
    },
  },
  {
    id: 'bills',
    // narrative audit 26: there is no pay verb - monthlyBills deducts on the 1st and
    // billsPaid increments if the cash was there. The old text promised an action that
    // does not exist; this one names what the check rewards.
    text: 'See the first bills through',
    hint: 'They come off the cash on the 1st — have it in hand.',
    check: (h) => (h.billsPaid || 0) > 0,
  },
  {
    id: 'unit',
    text: 'Build somewhere to let',
    hint: 'A spare room, a garden room, then a cabin.',
    check: (h) => (h.accom || []).some((a) => a.built),
  },
  {
    id: 'guest',
    text: 'Have your first guest',
    hint: 'Bookings need a road worth driving.',
    check: (h) => (h.nights || 0) > 0,
  },
  {
    id: 'month',
    text: 'Survive a month',
    hint: 'Thirty days in.',
    check: (h) => h.day >= 30,
  },
  {
    id: 'hire',
    // narrative audit 26: the check is beds > 12, not a hire. The old text was a mood;
    // this is the condition, and the hint keeps LD-08's verb and rate.
    text: 'Plant more beds than you can harvest',
    hint: 'Past twelve beds you cannot harvest alone — hire a casual for the day (H$180, six more beds in).',
    // LD-08 (level-designer): checking casualsHired>0 stranded the goal under optimal
    // play — staggered planting never needs a casual in 540 days. The real milestone
    // is the moment labour starts to matter: holding more beds than you can harvest.
    check: (h) => (h.beds || []).length > 12,
  },
  {
    id: 'wood',
    text: 'Cut the aliens out of your bush',
    // LD-10 (level-designer, measured; owner GO 2026-10-22). The old goal was "Stack
    // firewood before winter", which taught the side payment: on a 96-stem clearing the
    // wood was worth H$48,800 while the guest income from a cleaner bush was H$75,557
    // (weeds 14% → 7%, +61 nights). The axe is swung to clear the wattle, and the
    // firewood is what it leaves behind.
    hint: 'A dozen stems of any alien kind. Wattle and blackwood burn; pine pays at the mill.',
    check: (h) => ((h.plot && h.plot.felled) || 0) >= 12,
  },
  {
    id: 'subsidy',
    // narrative audit 26: the check ticks on accepted OR done OR failed - the old text
    // named a win and the check celebrated a decision (and a loss). This text is what
    // the check measures; the stake stays in the hint and promises nothing.
    text: "Take the ratepayers' road deal",
    hint: 'H$15 000 if the road never drops below 60% through December.',
    check: (h) => !!(h.subsidy && (h.subsidy.state === 'accepted' || h.subsidy.state === 'done' || h.subsidy.state === 'failed')),
  },
  {
    id: 'winter-night',
    text: 'Let a room in winter',
    hint: 'Any winter month counts — May to August. The road decides it.',
    check: (h) => (h.nights || 0) > 0 && h.date.month >= 5 && h.date.month <= 8,
  },
  {
    id: 'land',
    text: 'Buy the land next door',
    hint: 'Half a hectare at a time.',
    check: (h) => !!(h.holding && h.holding.bought > 0),
  },
  {
    id: 'year',
    text: 'See a full year through',
    hint: 'Winter is the test.',
    check: (h) => h.day >= 365,
  },
];

export function initGoals(h) {
  h.goals = h.goals || { done: [] };
  return h;
}

/** Mark anything newly complete. Returns the goals that just ticked. */
export function tickGoals(h) {
  initGoals(h);
  const fresh = [];
  for (const g of GOALS) {
    if (h.goals.done.includes(g.id)) continue;
    let ok = false;
    try { ok = !!g.check(h); } catch { ok = false; }
    if (ok) {
      h.goals.done.push(g.id);
      fresh.push(g);
      h.log.push({ day: h.day, text: `✓ ${g.text}` });
    }
  }
  return fresh;
}

/** The next few things worth doing. Empty once you are running. */
export function nextGoals(h, n = 3) {
  initGoals(h);
  return GOALS.filter((g) => !h.goals.done.includes(g.id)).slice(0, n);
}

export function goalSummary(h) {
  initGoals(h);
  return {
    done: h.goals.done.length,
    total: GOALS.length,
    next: nextGoals(h, 3).map((g) => ({ id: g.id, text: g.text, hint: g.hint })),
  };
}
