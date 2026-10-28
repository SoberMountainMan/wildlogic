// handyman.js — things break, and the guests are arriving.
//
// The village handyman is cheap and may not come; the outside company costs double and
// always does. That is the whole decision (GUEST-LADDER.md, "Building is not instant"),
// and it only bites once there are guests using the plumbing.
//
// Own RNG stream (`h.repairRng`), like voices and weather, so a breakage never shifts
// the booking sequence. Pure logic, no DOM.

import { mulberry32, seedOf } from './plotmap.js';
import { money } from './fmt.js';   // one money formatter for every log line (fmt.js)

/**
 * The fault table. `days` is the deadline: the guest-facing grace before the next
 * guest night takes a review hit. Costs are what the village handyman charges; the
 * outside company is double.
 */
export const FAULTS = {
  toiletLock: {
    id: 'toiletLock', text: 'The toilet lock is jammed.', days: 1, cost: 400,
    severity: 'normal',
  },
  plumbing: {
    id: 'plumbing', text: 'A pipe burst under the house in the frost.', days: 1, cost: 2200,
    severity: 'high',   // no water: no guest can be let while this is open
  },
  geyser: {
    id: 'geyser', text: 'The geyser is tripping.', days: 2, cost: 1500,
    severity: 'normal',
  },
  fence: {
    id: 'fence', text: 'A fence post is down by the gate.', days: 3, cost: 600,
    severity: 'low',
  },
};

/** Fixed order — the pick must be reproducible from the stream alone. */
const ORDER = ['toiletLock', 'plumbing', 'geyser', 'fence'];
const WET = new Set(['rain', 'storm', 'snow']);
const BREAK_CHANCE = 0.025;          // per day, doubled when it is wet
const NO_SHOW = 0.25;                // village handyman, dry day
const NO_SHOW_WET = 0.4;             // village handyman, rain or snow
const PENALTY = 1.5;                 // stars off the next guest night

const ok = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const err = (msg) => ({ ok: false, msg });

const COMPLAINTS = {
  toiletLock: '"The toilet door would not lock. We did not feel safe."',
  plumbing: '"No water. We carried buckets up from the stream in the dark."',
  geyser: '"Two days with no hot water. It is Hogsback in winter."',
  fence: '"A fence post is down by the gate — we nearly put the car through it."',
};

/**
 * The excuse pool (bible §16.1, owner GO). A no-show used to be silent, and a mechanic
 * that takes the player's day and says nothing is a defect. Picked by the no-show count,
 * never by a dice roll — the repair stream has exactly the draws it had before this pool
 * existed (tests/34 pins it). Seven lines, so a repeat needs seven no-shows: "no repeats
 * inside 7 days" holds by construction.
 * Entry 0 must keep the words "did not come" — the gate quotes them.
 */
const EXCUSES = [
  'The handyman did not come. Something about the municipality. It is always something about the municipality.',
  'No handyman. A voice message says "tomorrow". It is the third "tomorrow".',
  'The handyman sends his regards and a reason. The reason involves rain, a funeral, and a bakkie that nearly died.',
  'No handyman today. Word is he is on another job — one that pays, he said, which stung.',
  'No sign of him. His dog came by instead, alone, apologetic.',
  'No handyman. He is waiting on a part, the part is waiting on a bakkie, and the bakkie is in Alice.',
  'No handyman. His phone is off, which up here can mean three things and none of them are good.',
];

/** The excuse for this no-show. Pure: state in, string out. */
export function handymanExcuse(h) {
  const n = Math.max(1, (h.handyman && h.handyman.noShows) || 1);
  return EXCUSES[(n - 1) % EXCUSES.length];
}

export function initHandyman(h) {
  h.handyman = h.handyman || { booked: null, noShows: 0, broken: [] };
  h.repairs = h.repairs || [];
  if (typeof h.repairRng !== 'function') h.repairRng = stream(h);
  // derived views for the HUD — the jobs themselves are the truth
  h.handyman.broken = h.repairs.map((j) => j.fault);
  const next = h.repairs.find((j) => j.booked);
  h.handyman.booked = next
    ? { jobId: next.id, day: next.booked.day, outside: next.booked.outside, cost: next.booked.cost }
    : null;
  return h;
}

const rr = (h) => h.repairRng();
const wet = (h) => WET.has(h.weather && h.weather.kind);

/**
 * The seeded stream, with a draw counter on the household: a save is JSON and cannot
 * carry the closure, so a reload replays the same number of draws and continues rather
 * than restarting the fault sequence.
 */
function stream(h) {
  const base = mulberry32(seedOf(h.key + ':repairs'));
  for (let i = 0; i < (h.handyman.draws || 0); i++) base();
  return () => {
    h.handyman.draws = (h.handyman.draws || 0) + 1;
    return base();
  };
}

function note(h, text) {
  h.log.push({ day: h.day, text });
}

/** Is the water off? Plumbing is the one fault that stops a let outright. */
export function waterOut(h) {
  initHandyman(h);
  return h.repairs.some((j) => j.fault === 'plumbing');
}

/**
 * Once a day, after the night. Only a household with guests wears anything out, and
 * not in the first three weeks — the tutorial must not open with a burst pipe.
 * Returns the new job, or null.
 */
export function maybeBreak(h) {
  initHandyman(h);
  if (!(h.day > 20) || !(h.nights > 0)) return null;
  const chance = BREAK_CHANCE * (wet(h) ? 2 : 1);
  if (rr(h) >= chance) return null;

  const open = new Set(h.repairs.map((j) => j.fault));
  const snow = h.weather && h.weather.kind === 'snow';
  const eligible = ORDER.filter((k) => !open.has(k) && (k !== 'plumbing' || snow));
  if (!eligible.length) return null;

  const key = eligible[Math.floor(rr(h) * eligible.length)];
  const def = FAULTS[key];
  const seq = h.repairs.reduce((m, j) => Math.max(m, Number(String(j.id).slice(1)) || 0), 0) + 1;
  const job = {
    id: 'r' + seq,
    fault: key,
    text: def.text,
    day: h.day,
    deadline: h.day + def.days,
    severity: def.severity,
    booked: null,
  };
  h.repairs.push(job);
  note(h, def.text + (key === 'plumbing' ? ' No water until it is fixed.' : ''));
  initHandyman(h);
  return job;
}

/**
 * Call the handyman. The village man is cheap and may not turn up; the outside company
 * costs double, comes tomorrow, and never lets you down. Paid at booking either way.
 */
export function bookRepair(h, jobId, { outside = false } = {}) {
  initHandyman(h);
  const job = h.repairs.find((j) => j.id === jobId);
  if (!job) return err('no such job');
  if (job.booked) return err('that job is already booked');
  const def = FAULTS[job.fault];
  const cost = outside ? def.cost * 2 : def.cost;
  if (h.cash < cost) return err(`the repair costs ${money(cost)} — you have ${money(Math.round(h.cash))}`);
  h.cash -= cost;
  job.booked = { day: h.day + 1, outside, cost };
  note(h, outside
    ? `An outside company will be here tomorrow. −${money(cost)}. A receipt, a warranty, and no conversation at all.`
    : `The village handyman says tomorrow. −${money(cost)}.`);
  initHandyman(h);
  return ok('repair booked', { jobId: job.id, cost, day: job.booked.day, outside });
}

/**
 * Resolve today's bookings. Called before maybeBreak, so a fix lands before a new fault.
 * A no-show costs the day, not the money — the job goes back one day.
 */
export function tickHandyman(h) {
  initHandyman(h);
  const fixed = [];
  let noShows = 0;

  for (const job of h.repairs.slice()) {
    if (!job.booked || job.booked.day > h.day) continue;

    if (!job.booked.outside && rr(h) < (wet(h) ? NO_SHOW_WET : NO_SHOW)) {
      job.booked.day = h.day + 1;
      h.handyman.noShows += 1;
      noShows += 1;
      note(h, handymanExcuse(h));
      continue;
    }

    h.repairs = h.repairs.filter((j) => j !== job);
    fixed.push(job.id);
    note(h, job.booked.outside
      ? `Fixed by the company: ${job.text} ${money(job.booked.cost)}, paid when booked. `
        + 'Both facts are reassuring and a little sad.'
      : `Fixed: ${job.text} ${money(job.booked.cost)}, paid when booked. `
        + 'Not beautifully — but fixed, and he cleaned the tiles after, which nobody asked for.');
  }

  initHandyman(h);
  return { fixed, noShows };
}

/**
 * The review engine's hook. 1.5 stars off the next guest night while a fault is past
 * its deadline in a household that is letting. Pure: no mutation, no RNG — the lead
 * applies it and logs repairComplaint(h).
 */
export function repairPenalty(h) {
  initHandyman(h);
  if (!(h.nights > 0)) return 0;
  return h.repairs.some((j) => h.day > j.deadline) ? PENALTY : 0;
}

/** The quoted complaint that goes with the penalty, or '' when there is none. */
export function repairComplaint(h) {
  initHandyman(h);
  if (!(h.nights > 0)) return '';
  const overdue = h.repairs.find((j) => h.day > j.deadline);
  return overdue ? COMPLAINTS[overdue.fault] : '';
}
