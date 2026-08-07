// The time-lapse clock and layout, run rather than reasoned.
//
//   node probe/test-timelapse.mjs
//
// This is the load-bearing guard for P2. The renderer cannot be tested here, so
// everything that decides what the replay actually shows lives in lib/timelapse.js
// and is asserted below: the final frame equals the snapshot totals exactly, the
// counts never go backwards, no busy day is skipped at a real frame rate, the
// empty stretches really are compressed (with numbers, not a hand-wave), and
// every dot lands in bounds near its owner.
//
// Small fixtures first, where the arithmetic can be checked by eye, then the
// committed snapshot, checked against its own independent fields rather than
// against numbers copied out of one particular crawl.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DURATION_MS, buildSchedule, buildLayout, dayAt, dayDurationMs,
  splitmix32, createTimelapse,
} from "../lib/timelapse.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// An optional path argument, matching test-snapshot.mjs, so a candidate snapshot
// can be checked before it is committed. Nothing below pins an absolute value out
// of this crawl: those live in test-snapshot.mjs alone, and every assertion here
// compares the replay against a field of the snapshot it did not come from.
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP_PATH = process.argv[2] ?? join(HERE, "..", "web", "data", "snapshot.json");
const SNAP = JSON.parse(readFileSync(SNAP_PATH, "utf8"));

// The busiest day and the biggest owner, tallied straight off the rows so the
// assertions that name them move with a refreshed crawl instead of reddening.
// Ties go to the earlier day, matching the scan the schedule assertions use.
const ACTIVITY = new Array(SNAP.day_count).fill(0);
for (const r of SNAP.repos) if (r[2] >= 0 && r[2] < SNAP.day_count) ACTIVITY[r[2]]++;
for (const [d, n] of SNAP.agents.daily) if (d >= 0 && d < SNAP.day_count) ACTIVITY[d] += n;
let BUSIEST_DAY = 0;
for (let d = 1; d < ACTIVITY.length; d++) if (ACTIVITY[d] > ACTIVITY[BUSIEST_DAY]) BUSIEST_DAY = d;

const OWNER_TALLY = new Array(SNAP.owners.length).fill(0);
for (const r of SNAP.repos) OWNER_TALLY[r[1]]++;
const BIGGEST_OWNER_COUNT = OWNER_TALLY.reduce((m, v) => Math.max(m, v), 0);

// A five-day fixture. Day 1 is the burst, day 2 and day 3 are empty, day 4 is
// the final index and carries arrivals, so "the last day gets played" is a real
// question here and not a formality.
const repo = (name, ownerIdx, created) => [name, ownerIdx, created, created, 0, 0];
const FIX = {
  day_base: "2026-03-12",
  day_count: 5,
  owners: ["did:key:zOwnerA", "did:key:zOwnerB", "did:key:zOwnerC"],
  repos: [
    repo("a", 0, 0),
    repo("b", 0, 1), repo("c", 0, 1), repo("d", 1, 1), repo("e", 1, 1),
    repo("f", 2, 4), repo("g", 0, 4),
  ],
  agents: { daily: [[0, 2], [1, 6], [4, 1]] },
};

// --- the seeded hash -----------------------------------------------------
{
  const a = splitmix32(1234);
  const b = splitmix32(1234);
  check("splitmix32 is deterministic for a seed", a() === b(), true);
  check("splitmix32 stays in 0..1", [0, 0, 0, 0, 0].every(() => { const v = a(); return v >= 0 && v < 1; }), true);
  check("splitmix32 differs across seeds", splitmix32(1)() === splitmix32(2)(), false);
}

// --- the schedule --------------------------------------------------------
{
  const s = buildSchedule(FIX, 10_000);
  check("schedule keeps the day count", s.dayCount, 5);
  check("schedule keeps the duration", s.durationMs, 10_000);
  check("daily repos are dense over the range", s.dailyRepos.join(","), "1,4,0,0,2");
  check("daily agents are dense over the range", s.dailyAgents.join(","), "2,6,0,0,1");
  check("cumulative repos end at the total", s.totalRepos, FIX.repos.length);
  check("cumulative agents end at the total", s.totalAgents, 9);
  check("an empty day still carries the floor weight", s.weights[2], 1);
  check("the busiest day weighs more than an empty one", s.weights[1] > s.weights[2], true);
  check("day slots sum to the whole duration",
    Math.round([0, 1, 2, 3, 4].reduce((a, d) => a + dayDurationMs(s, d), 0)), 10_000);

  check("progress 0 is day 0", dayAt(s, 0), 0);
  check("progress 1 is the last day", dayAt(s, 1), 4);
  check("progress past 1 clamps to the last day", dayAt(s, 5), 4);
  check("negative progress clamps to day 0", dayAt(s, -1), 0);
  check("day index is never negative", dayAt(s, 0.5) >= 0, true);
}

// --- the clock, sampled at a real frame rate ------------------------------
// 60Hz over the default 35s. This is the check that matters: a schedule can look
// fine as a formula and still skip a day between two frames.
{
  const tl = createTimelapse(SNAP);
  const frames = Math.round(DEFAULT_DURATION_MS / (1000 / 60));
  const seen = new Set();
  let lastDay = -1;
  let lastRepos = -1;
  let lastAgents = -1;
  let backwardsDay = 0;
  let backwardsRepos = 0;
  let backwardsAgents = 0;
  for (let f = 0; f <= frames; f++) {
    const st = tl.stateAt(f / frames);
    if (st.dayIndex < lastDay) backwardsDay++;
    if (st.repos < lastRepos) backwardsRepos++;
    if (st.agents < lastAgents) backwardsAgents++;
    lastDay = st.dayIndex;
    lastRepos = st.repos;
    lastAgents = st.agents;
    seen.add(st.dayIndex);
  }
  check("day index never goes backwards across the run", backwardsDay, 0);
  check("repo count never goes backwards across the run", backwardsRepos, 0);
  check("agent count never goes backwards across the run", backwardsAgents, 0);

  const active = [];
  for (let d = 0; d < tl.schedule.dayCount; d++) {
    if (tl.schedule.dailyRepos[d] + tl.schedule.dailyAgents[d] > 0) active.push(d);
  }
  check("the snapshot has active days to skip", active.length > 100, true);
  check("no active day is skipped at 60fps", active.filter((d) => !seen.has(d)).length, 0);
  // The empty days matter too: the calendar must not appear frozen or jump.
  check("every day in the range is reached at 60fps", seen.size, tl.schedule.dayCount);
}

// --- the compression, in milliseconds -------------------------------------
// Numbers, not an inequality. Uniform-per-day would give every day 235ms;
// proportional-to-events would give the busiest day 10.9s and the quietest under
// 10ms. The sqrt compromise has to sit between those, visibly.
{
  const s = buildSchedule(SNAP, DEFAULT_DURATION_MS);
  let busiest = 0;
  let quietest = 0;
  for (let d = 0; d < s.dayCount; d++) {
    const act = s.dailyRepos[d] + s.dailyAgents[d];
    if (act > s.dailyRepos[busiest] + s.dailyAgents[busiest]) busiest = d;
    if (act < s.dailyRepos[quietest] + s.dailyAgents[quietest]) quietest = d;
  }
  const busyMs = dayDurationMs(s, busiest);
  const quietMs = dayDurationMs(s, quietest);
  const uniformMs = DEFAULT_DURATION_MS / s.dayCount;
  console.log(`      busiest day ${busiest} = ${busyMs.toFixed(0)}ms, quietest = ${quietMs.toFixed(0)}ms, uniform would be ${uniformMs.toFixed(0)}ms`);

  // Two independent scans of the same fact: this one walks the schedule the code
  // built, ACTIVITY walks the snapshot rows directly.
  check("the busiest day of the schedule is the busiest day in the rows", busiest, BUSIEST_DAY);
  check("the quietest day has no activity at all", s.dailyRepos[quietest] + s.dailyAgents[quietest], 0);
  check("the busiest day gets over a second", busyMs > 1000, true);
  check("the busiest day does not eat the run", busyMs < 0.10 * DEFAULT_DURATION_MS, true);
  check("an empty day is compressed below a tenth of the uniform share", quietMs < uniformMs / 5, true);
  check("an empty day still spans more than one frame at 60fps", quietMs > 1000 / 60, true);
  check("the busiest day outlasts an empty one by at least 20x", busyMs / quietMs > 20, true);
  check("the busiest day is not proportional to its events", busyMs / quietMs < 200, true);
}

// --- the final frame ------------------------------------------------------
// The plan's stated verification for this phase.
{
  const tl = createTimelapse(SNAP);
  const end = tl.stateAt(1);
  // The replay's totals come out of the per-day histograms; repos.length and the
  // stats block are two other fields entirely, one a row count and one a counter
  // the crawler copied off the node's API. Comparing them is still a cross-check,
  // it just no longer hardcodes which crawl is loaded.
  check("final frame repos equal the row count", end.repos, SNAP.repos.length);
  check("final frame agents equal the node's own counter", end.agents, SNAP.stats.agents);
  check("final frame is the last day", end.dayIndex, SNAP.day_count - 1);
  // Not an equality: a push landing between crawl pages can cost or duplicate a
  // row, and 5 is the slack test-snapshot.mjs allows for that same race.
  check("the snapshot's own repo counter agrees with the replay",
    Math.abs(SNAP.stats.repos - end.repos) <= 5, true);
  // Coverage is asserted separately from the totals on purpose. The snapshot's
  // final day happens to be empty, so a schedule that stopped a day short would
  // still end on 3,150 and 4,088 and look correct. The day count is what catches
  // it here; the fixture below, whose last day does carry arrivals, catches it
  // through the totals.
  check("the schedule covers every day in the snapshot", tl.schedule.dayCount, SNAP.day_count);

  // Played frame by frame, every repo arrives exactly once and none is left
  // behind by a rounding error in the last slot.
  const frames = Math.round(DEFAULT_DURATION_MS / (1000 / 60));
  const arrived = new Set();
  let prev = 0;
  let duplicates = 0;
  for (let f = 1; f <= frames; f++) {
    const p = f / frames;
    for (const i of tl.arrivalsBetween(prev, p)) {
      if (arrived.has(i)) duplicates++;
      arrived.add(i);
    }
    prev = p;
  }
  check("every repo arrives exactly once over a full replay", arrived.size, SNAP.repos.length);
  check("no repo arrives twice", duplicates, 0);
  check("the first arrival is the first repo in day order", tl.order[0], 0);
  check("arrivals over the whole run equal the totals", tl.arrivalsBetween(0, 1).length, SNAP.repos.length);
  check("no arrivals when progress does not move", tl.arrivalsBetween(0.5, 0.5).length, 0);
}

// --- the layout -----------------------------------------------------------
{
  const l = buildLayout(SNAP);
  check("a position for every repo", l.repoCount, SNAP.repos.length);
  check("positions array is two per repo", l.positions.length, SNAP.repos.length * 2);

  let outOfBounds = 0;
  for (let i = 0; i < l.positions.length; i++) {
    const v = l.positions[i];
    if (!(v >= 0 && v <= 1)) outOfBounds++;
  }
  check("every coordinate is inside 0..1", outOfBounds, 0);

  let outsideMargin = 0;
  for (let i = 0; i < l.positions.length; i++) {
    const v = l.positions[i];
    if (v < l.margin - 1e-9 || v > 1 - l.margin + 1e-9) outsideMargin++;
  }
  check("every coordinate respects the margin", outsideMargin, 0);

  // Determinism across two independent calls.
  const l2 = buildLayout(SNAP);
  let differing = 0;
  for (let i = 0; i < l.positions.length; i++) if (l.positions[i] !== l2.positions[i]) differing++;
  check("layout is identical across two calls", differing, 0);
  check("an exact position is reproducible", l.positions[0], l2.positions[0]);
  check("a different seed moves the layout", buildLayout(SNAP, 99).positions[0] === l.positions[0], false);

  // Clustering. This is what separates a layout from a scatter plot: mean
  // distance from a repo to its own owner's centre has to be small next to the
  // canvas, and small next to the distance to a stranger's centre.
  let sum = 0;
  let worst = 0;
  for (let i = 0; i < SNAP.repos.length; i++) {
    const oi = SNAP.repos[i][1];
    const dx = l.positions[i * 2] - l.centres[oi * 2];
    const dy = l.positions[i * 2 + 1] - l.centres[oi * 2 + 1];
    const d = Math.hypot(dx, dy);
    sum += d;
    if (d > worst) worst = d;
  }
  const mean = sum / SNAP.repos.length;
  console.log(`      mean distance to owner centre ${mean.toFixed(4)}, worst ${worst.toFixed(4)}`);
  check("a repo sits near its owner's centre", mean < 0.03, true);
  check("no repo strays far from its owner", worst < 0.2, true);

  // The same measure against a shuffled owner assignment, which is what an
  // owner-blind layout would look like. If clustering is real this is an order
  // of magnitude worse.
  let shuffled = 0;
  for (let i = 0; i < SNAP.repos.length; i++) {
    const oi = SNAP.repos[(i + 1571) % SNAP.repos.length][1];
    shuffled += Math.hypot(l.positions[i * 2] - l.centres[oi * 2], l.positions[i * 2 + 1] - l.centres[oi * 2 + 1]);
  }
  const shuffledMean = shuffled / SNAP.repos.length;
  console.log(`      mean distance to a stranger's centre ${shuffledMean.toFixed(4)}`);
  check("clusters are far apart relative to their own size", shuffledMean / mean > 8, true);

  // The biggest owner (114 repos in the committed crawl) must be a readable
  // cluster, not a point and not a smear.
  let biggest = 0;
  for (let i = 1; i < l.counts.length; i++) if (l.counts[i] > l.counts[biggest]) biggest = i;
  check("the biggest owner cluster holds every repo that owner has",
    l.counts[biggest], BIGGEST_OWNER_COUNT);
  let bigWorst = 0;
  for (let i = 0; i < SNAP.repos.length; i++) {
    if (SNAP.repos[i][1] !== biggest) continue;
    bigWorst = Math.max(bigWorst, Math.hypot(
      l.positions[i * 2] - l.centres[biggest * 2],
      l.positions[i * 2 + 1] - l.centres[biggest * 2 + 1],
    ));
  }
  check("the biggest owner spreads out rather than stacking", bigWorst > 0.05, true);
  check("the biggest owner does not take over the canvas", bigWorst < 0.2, true);
}

// --- the fixture, checked by eye ------------------------------------------
{
  const tl = createTimelapse(FIX, { durationMs: 1000 });
  check("fixture final repos", tl.stateAt(1).repos, 7);
  check("fixture final agents", tl.stateAt(1).agents, 9);
  check("fixture starts empty", tl.stateAt(0).repos, 0);
  check("fixture order is by creation day", tl.order.map((i) => FIX.repos[i][0]).join(""), "abcdefg");
  check("a single-repo owner sits exactly on its centre",
    tl.layout.positions[10], tl.layout.centres[4]);
  check("repo name is readable back", tl.nameOf(0), "a");
  check("an out-of-range repo name is empty", tl.nameOf(99), "");
  check("an out-of-range position falls back to the middle", tl.positionOf(99).x, 0.5);
}

// --- a snapshot that does not arrive pre-sorted ---------------------------
// Every other fixture here, and the committed snapshot, already ship in creation
// order, so the sort inside arrivalOrder is invisible to them: deleting it left
// all three suites green. These rows are deliberately shuffled, and without the
// sort the replay draws a dot on a day earlier than the repo's own.
{
  const OUT = {
    day_base: "2026-03-12",
    day_count: 4,
    owners: ["did:key:zOwnerA"],
    repos: [repo("late", 0, 3), repo("early", 0, 0), repo("mid", 0, 2), repo("first", 0, 0)],
    agents: { daily: [] },
  };
  const tl = createTimelapse(OUT, { durationMs: 1000 });
  check("shuffled repos replay in day order",
    tl.order.map((i) => OUT.repos[i][0]).join(","), "early,first,mid,late");
  check("a same-day pair keeps snapshot order",
    tl.order.indexOf(1) < tl.order.indexOf(3), true);
  check("no arrival day precedes the one before it",
    tl.order.every((v, k) => k === 0 || OUT.repos[tl.order[k - 1]][2] <= OUT.repos[v][2]), true);
}

// --- a creation day outside the range -------------------------------------
// dailyNewRepos drops a repo whose created day is not an integer in
// [0, day_count), so the arrival order has to drop the same rows or the two stop
// agreeing and arrivalsBetween slices a list of one length against counts of
// another. Both cases below were reproduced against the unfixed code: day_count 3
// with a repo on day 5 ended the replay showing 2 of 3 dots, and a repo on day -1
// painted the wrong dots and never painted the last real repo.
{
  const cases = [
    ["a day past the last", [repo("a", 0, 0), repo("b", 0, 1), repo("x", 0, 5)]],
    ["a negative day", [repo("x", 0, -1), repo("a", 0, 0), repo("b", 0, 1)]],
  ];
  for (const [name, repos] of cases) {
    const snap = {
      day_base: "2026-03-12", day_count: 3, owners: ["did:key:zOwnerA"],
      repos, agents: { daily: [] },
    };
    const tl = createTimelapse(snap, { durationMs: 1000 });
    const painted = tl.arrivalsBetween(0, 1);
    const inRange = (i) => Number.isInteger(repos[i][2]) && repos[i][2] >= 0 && repos[i][2] < 3;
    check(`${name}: the final frame counts only what the histogram kept`, tl.stateAt(1).repos, 2);
    check(`${name}: the arrival order is exactly that long`, tl.order.length, tl.stateAt(1).repos);
    check(`${name}: the replay paints as many dots as the final frame claims`,
      painted.length, tl.stateAt(1).repos);
    check(`${name}: no index in the order is a repo the histogram dropped`,
      tl.order.every(inRange), true);
    check(`${name}: the last in-range repo still gets painted`,
      painted.includes(repos.findIndex((r) => r[0] === "b")), true);
  }
}

// --- degenerate inputs ----------------------------------------------------
// None of these can throw or divide by zero. A snapshot mid-write, a brand new
// network, and a one-day network are all real states.
{
  const cases = [
    ["no repos", { day_base: "2026-03-12", day_count: 5, owners: [], repos: [], agents: { daily: [] } }],
    ["one repo", { day_base: "2026-03-12", day_count: 5, owners: ["did:key:z1"], repos: [repo("solo", 0, 2)], agents: { daily: [] } }],
    ["one day", { day_base: "2026-03-12", day_count: 1, owners: ["did:key:z1"], repos: [repo("solo", 0, 0)], agents: { daily: [[0, 3]] } }],
    ["day_count 0", { day_base: "2026-03-12", day_count: 0, owners: ["did:key:z1"], repos: [repo("solo", 0, 0)], agents: { daily: [] } }],
    ["day_count missing", { owners: [], repos: [], agents: {} }],
    ["nothing at all", {}],
    ["null snapshot", null],
    ["repos with an unknown owner index", { day_count: 2, owners: [], repos: [repo("x", 7, 0), repo("y", 7, 1)], agents: { daily: [] } }],
    ["malformed repo rows", { day_count: 2, owners: ["did:key:z1"], repos: [null, "nope", [1, 2, 3]], agents: { daily: "no" } }],
  ];
  for (const [name, snap] of cases) {
    let threw = null;
    let finite = true;
    try {
      const tl = createTimelapse(snap, { durationMs: 500 });
      for (const p of [-1, 0, 0.25, 0.5, 0.999, 1, 2, NaN]) {
        const st = tl.stateAt(p);
        if (!Number.isFinite(st.repos) || !Number.isFinite(st.agents) || !Number.isFinite(st.dayIndex)) finite = false;
      }
      tl.arrivalsBetween(0, 1);
      for (let i = 0; i < tl.layout.positions.length; i++) {
        if (!Number.isFinite(tl.layout.positions[i])) finite = false;
      }
      dayDurationMs(tl.schedule, 0);
    } catch (err) {
      threw = err?.message ?? String(err);
    }
    check(`degenerate: ${name} does not throw`, threw, null);
    check(`degenerate: ${name} stays finite`, finite, true);
  }

  const one = createTimelapse({ day_count: 1, owners: ["did:key:z1"], repos: [repo("solo", 0, 0)], agents: { daily: [[0, 3]] } }, { durationMs: 500 });
  check("one-day network still ends at its totals", `${one.stateAt(1).repos}/${one.stateAt(1).agents}`, "1/3");
  check("one-day network stays on day 0", one.stateAt(0.5).dayIndex, 0);
  const none = createTimelapse({ day_count: 0, repos: [], owners: [], agents: { daily: [] } });
  check("an empty schedule reports no time for day 0", dayDurationMs(none.schedule, 0), 0);
  check("an empty schedule ends at zero", none.stateAt(1).repos, 0);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
