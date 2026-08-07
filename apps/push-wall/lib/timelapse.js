// The time-lapse: a clock and a layout, both pure and both deterministic.
//
// Nothing here touches the DOM, a canvas, requestAnimationFrame, or the wall
// clock, and nothing here calls Math.random. Two reasons. The first is that the
// interesting half of a replay is arithmetic (which day is on screen at 12
// seconds in, how many repos exist by then, where a given repo sits) and
// arithmetic can be tested; a canvas cannot. The second is that a replay that
// draws a different picture on every reload is not a picture of anything, so
// every position below comes out of a seeded integer hash and is identical on
// every machine and every run.
//
// The renderer imports this, asks it what the world looks like at a progress
// value in 0..1, and draws. It owns no numbers of its own.

import { dailyNewRepos, dailyFromPairs, cumulative } from "./derive.js";

export const DEFAULT_DURATION_MS = 35_000;

// --- the clock -----------------------------------------------------------
//
// The network is extremely bursty: 149 days hold 3,150 repos, and one day holds
// 978 of them. That leaves three ways to spend playback time and two of them are
// unwatchable.
//
//   uniform per day        every day gets 235ms. The 978-repo day is over in a
//                          quarter of a second and roughly a third of the run is
//                          spent on days where nothing happens at all.
//   proportional to events  the busiest day alone eats 31% of the replay while
//                          most days get under 10ms, which is under one frame,
//                          so the calendar visibly teleports.
//
// So: weight each day by FLOOR + sqrt(activity). The square root is the
// compromise. It keeps the ordering (a busy day is always longer than a quiet
// one) while compressing the ratio hard: 978 events against 1 event is a 978x
// difference in arrivals but only about a 30x difference in screen time. The
// FLOOR is what stops a quiet day collapsing below a frame, so the date readout
// keeps ticking through the empty stretches instead of appearing frozen or
// jumping a fortnight between frames.
//
// Measured on the committed snapshot at the default 35s: an empty day gets 38ms
// (about two frames at 60Hz, so it is seen), the busiest day gets 1.23s. That is
// the shape wanted, a run that lingers where the work happened without ever
// stopping.
const FLOOR_WEIGHT = 1;

export function buildSchedule(snapshot, durationMs = DEFAULT_DURATION_MS) {
  const dayCount = Number.isInteger(snapshot?.day_count) && snapshot.day_count > 0
    ? snapshot.day_count
    : 0;
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_DURATION_MS;

  const dailyRepos = dailyNewRepos(snapshot?.repos, dayCount);
  const dailyAgents = dailyFromPairs(snapshot?.agents?.daily, dayCount);
  const cumRepos = cumulative(dailyRepos);
  const cumAgents = cumulative(dailyAgents);

  const weights = new Array(dayCount);
  const starts = new Array(dayCount);
  let total = 0;
  for (let d = 0; d < dayCount; d++) {
    starts[d] = total;
    weights[d] = FLOOR_WEIGHT + Math.sqrt(dailyRepos[d] + dailyAgents[d]);
    total += weights[d];
  }

  return {
    dayCount,
    durationMs: duration,
    totalWeight: total,
    weights,
    starts,
    dailyRepos,
    dailyAgents,
    cumRepos,
    cumAgents,
    totalRepos: dayCount > 0 ? cumRepos[dayCount - 1] : 0,
    totalAgents: dayCount > 0 ? cumAgents[dayCount - 1] : 0,
  };
}

// Playback progress in 0..1 -> day index. Binary search over the cumulative
// weights, so it stays cheap enough to call every frame.
export function dayAt(schedule, progress) {
  const n = schedule.dayCount;
  if (n <= 0) return 0;
  const p = clamp01(progress);
  if (p >= 1) return n - 1;
  const target = p * schedule.totalWeight;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (schedule.starts[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// How much of the run a single day occupies, in milliseconds. Exposed because
// "the busy day gets more time than the empty one" is the whole point of the
// schedule and a test should be able to put a number on it.
export function dayDurationMs(schedule, dayIndex) {
  if (schedule.dayCount <= 0 || !(dayIndex >= 0) || dayIndex >= schedule.dayCount) return 0;
  if (!(schedule.totalWeight > 0)) return 0;
  return (schedule.weights[dayIndex] / schedule.totalWeight) * schedule.durationMs;
}

// --- the layout ----------------------------------------------------------

// splitmix32. A small integer hash, seeded per owner, so a repo's position is a
// pure function of the snapshot and never of when the page happened to load.
export function splitmix32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MARGIN = 0.045;          // keeps every dot off the canvas edge
const SPREAD_BASE = 0.0105;    // cluster radius per sqrt(repo)
const SPREAD_MAX = 0.15;
const CENTRE_JITTER = 0.09;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const clampUnit = (v) => Math.min(1 - MARGIN, Math.max(MARGIN, v));

// Deterministic positions for every repo in a unit square, clustered by owner.
//
// Owner centres go on a phyllotaxis spiral rather than at random points, because
// 1,357 random centres in a unit square collide constantly and the eye reads
// overlapping clusters as one blob. The spiral is even by construction. It also
// puts the snapshot's ordering to work: `owners` is sorted by repo count
// descending, so the large holders land near the middle and the long tail of
// one-repo owners fans out around them, which is the actual shape of the
// network.
//
// Within a cluster the repos take a second, smaller spiral whose radius grows
// with sqrt(count). Linear growth would make the 114-repo owner a solid disc
// fourteen times the width of a two-repo owner; sqrt keeps its density
// comparable to everyone else's, so it reads as a big cluster rather than an
// unreadable smear. Jitter comes off the seeded hash so the result is a cloud
// and not visibly a machine-drawn spiral.
export function buildLayout(snapshot, seed = 0x5eed1e) {
  const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : [];
  const owners = Array.isArray(snapshot?.owners) ? snapshot.owners : [];
  const ownerCount = owners.length;

  const counts = new Array(ownerCount).fill(0);
  for (const r of repos) {
    const i = Array.isArray(r) ? r[1] : undefined;
    if (Number.isInteger(i) && i >= 0 && i < ownerCount) counts[i]++;
  }

  // Owner centres.
  const centres = new Float64Array(Math.max(0, ownerCount) * 2);
  const radius = 0.5 - MARGIN;
  for (let i = 0; i < ownerCount; i++) {
    const rnd = splitmix32(seed ^ Math.imul(i + 1, 0x9e3779b1));
    const t = (i + 0.5) / ownerCount;
    const rr = Math.sqrt(t) * radius * (1 - CENTRE_JITTER / 2 + CENTRE_JITTER * rnd());
    const ang = i * GOLDEN_ANGLE + (rnd() - 0.5) * 0.35;
    centres[i * 2] = clampUnit(0.5 + rr * Math.cos(ang));
    centres[i * 2 + 1] = clampUnit(0.5 + rr * Math.sin(ang));
  }

  // Repo positions, in snapshot order so index i is snapshot.repos[i].
  const positions = new Float64Array(repos.length * 2);
  const placed = new Array(ownerCount).fill(0);
  // A repo whose owner index is missing or out of range still has to go
  // somewhere, so it gets its own centre from the same spiral, one ring past the
  // known owners. Dropping it would make the dot count disagree with the totals.
  let orphan = 0;
  for (let i = 0; i < repos.length; i++) {
    const row = repos[i];
    const oi = Array.isArray(row) ? row[1] : undefined;
    const known = Number.isInteger(oi) && oi >= 0 && oi < ownerCount;
    let cx;
    let cy;
    let count;
    let k;
    if (known) {
      cx = centres[oi * 2];
      cy = centres[oi * 2 + 1];
      count = counts[oi];
      k = placed[oi]++;
    } else {
      const rnd = splitmix32(seed ^ Math.imul(orphan + 1, 0x85ebca6b));
      const ang = orphan * GOLDEN_ANGLE;
      cx = clampUnit(0.5 + radius * Math.cos(ang) * (0.9 + 0.1 * rnd()));
      cy = clampUnit(0.5 + radius * Math.sin(ang) * (0.9 + 0.1 * rnd()));
      count = 1;
      k = 0;
      orphan++;
    }

    if (count <= 1) {
      positions[i * 2] = cx;
      positions[i * 2 + 1] = cy;
      continue;
    }

    const rnd = splitmix32(seed ^ Math.imul((known ? oi : ownerCount + orphan) + 1, 0xc2b2ae35) ^ Math.imul(k + 1, 0x27d4eb2f));
    const spread = Math.min(SPREAD_MAX, SPREAD_BASE * Math.sqrt(count));
    const rr = spread * Math.sqrt((k + 0.5) / count) * (0.8 + 0.4 * rnd());
    const ang = k * GOLDEN_ANGLE + (rnd() - 0.5) * 0.9;
    positions[i * 2] = clampUnit(cx + rr * Math.cos(ang));
    positions[i * 2 + 1] = clampUnit(cy + rr * Math.sin(ang));
  }

  return { positions, centres, counts, ownerCount, repoCount: repos.length, margin: MARGIN };
}

// --- the two put together ------------------------------------------------

// Repos arrive in day order, so the renderer only ever needs "the ones between
// the last frame and this one". That is a slice of a fixed ordering, which is
// what `order` is: repo indices sorted by creation day, stable within a day.
// The snapshot already ships in that order, but sorting here means a snapshot
// that does not cannot silently produce a replay where dots appear before their
// day.
function arrivalOrder(repos) {
  const n = Array.isArray(repos) ? repos.length : 0;
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    const da = dayOf(repos[a]);
    const db = dayOf(repos[b]);
    return da - db || a - b;
  });
  return order;
}

const dayOf = (row) => {
  const d = Array.isArray(row) ? row[2] : undefined;
  return Number.isInteger(d) ? d : 0;
};

export function createTimelapse(snapshot, { durationMs = DEFAULT_DURATION_MS, seed = 0x5eed1e } = {}) {
  const schedule = buildSchedule(snapshot, durationMs);
  const layout = buildLayout(snapshot, seed);
  const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : [];
  const order = arrivalOrder(repos);

  // Within a day, arrivals spread across that day's slot instead of landing in
  // one frame. On the 978-repo day that is the difference between a wall of dots
  // appearing at once and watching it fill.
  const partial = (progress, daily, cum) => {
    const n = schedule.dayCount;
    if (n <= 0) return 0;
    const p = clamp01(progress);
    if (p >= 1) return cum[n - 1];
    const d = dayAt(schedule, p);
    const before = d > 0 ? cum[d - 1] : 0;
    const w = schedule.weights[d];
    if (!(w > 0)) return before;
    const f = clamp01((p * schedule.totalWeight - schedule.starts[d]) / w);
    return before + Math.floor(f * daily[d]);
  };

  const stateAt = (progress) => {
    const p = clamp01(progress);
    const dayIndex = dayAt(schedule, p);
    return {
      progress: p,
      dayIndex,
      repos: partial(p, schedule.dailyRepos, schedule.cumRepos),
      agents: partial(p, schedule.dailyAgents, schedule.cumAgents),
    };
  };

  // Indices into snapshot.repos for everything that arrived in (from, to]. The
  // renderer draws exactly these and leaves the rest of the canvas alone, which
  // is what keeps a frame cheap when 3,150 dots are already on screen.
  const arrivalsBetween = (from, to) => {
    const a = partial(from, schedule.dailyRepos, schedule.cumRepos);
    const b = partial(to, schedule.dailyRepos, schedule.cumRepos);
    if (b <= a) return [];
    return order.slice(a, b);
  };

  return {
    schedule,
    layout,
    order,
    durationMs: schedule.durationMs,
    dayCount: schedule.dayCount,
    totalRepos: schedule.totalRepos,
    totalAgents: schedule.totalAgents,
    stateAt,
    arrivalsBetween,
    // Position of a repo by its snapshot index, in the unit square.
    positionOf: (i) => (i >= 0 && i < layout.repoCount
      ? { x: layout.positions[i * 2], y: layout.positions[i * 2 + 1] }
      : { x: 0.5, y: 0.5 }),
    nameOf: (i) => {
      const row = repos[i];
      const name = Array.isArray(row) && typeof row[0] === "string" ? row[0] : "";
      return name.slice(0, 48);
    },
  };
}
