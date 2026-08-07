// Every derivation the page and the time-lapse depend on, run rather than
// reasoned.
//
//   node probe/test-derive.mjs
//
// The assertions run against hand-built fixtures small enough to check by eye,
// because a test that only asserts against the 213KB snapshot proves the code
// agrees with itself and nothing more. The boundaries are the point: empty
// input, day 0, the last day, and a zero-arrival day in the middle of the range,
// since a cumulative series that resets or that drops absent days looks
// plausible on a chart and is wrong everywhere. The real snapshot appears once
// at the end, compared only against its own independent fields; the absolute
// values of this particular crawl are pinned in test-snapshot.mjs and nowhere
// else, so refreshing the snapshot does not red this file.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DAY_MS, formatCount, dayBaseMs, dayDate, dayLabel, formatUtc, truncateDid,
  dailyNewRepos, dailyFromPairs, cumulative, cumulativeRepos, cumulativeAgents,
  peakDay, ownerCounts, topOwners, topCapabilities,
  repoFamily, repoFamilies, topFamilies, repoActivity,
  weekdayLabel, weekdayName, hourLabel, batchLabel,
  activityGrid, hourTotals, weekdayTotals, gridExtremes, seriesExtremes,
  cellIntensity, activitySummary,
  batchDayIndex, seedingDays, spanBucketKey, SIZE_BUCKETS,
  ownerLifetimes, ownerLifetimeSummary,
} from "../lib/derive.js";

// An optional path argument, matching test-snapshot.mjs, so a candidate snapshot
// can be checked before it is committed.
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = process.argv[2] ?? join(HERE, "..", "web", "data", "snapshot.json");

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// A five-day network. Day 0 has arrivals (the first boundary), day 2 has none
// (the middle-of-range gap), day 4 is the final index.
const BASE = "2026-03-12";
const DAYS = 5;
const repo = (name, ownerIdx, created) => [name, ownerIdx, created, created, 0, 0];
const FIX = {
  generated_at: "2026-03-16T09:05:00.000Z",
  day_base: BASE,
  day_count: DAYS,
  owners: ["did:key:z6MkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAowner1",
           "did:key:z6MkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBowner2",
           "did:key:z6MkCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCowner3"],
  repos: [
    repo("a", 0, 0), repo("b", 0, 0), repo("c", 1, 1),
    repo("d", 0, 3), repo("e", 2, 4), repo("f", 0, 4),
  ],
  agents: {
    total: 9,
    daily: [[0, 2], [3, 3], [4, 4]],
    capabilities: [["git:push", 7], ["git:fetch", 5], ["pr:open", 1], ["repo:create", 1]],
    statuses: [["active", 9]],
  },
};

// --- numbers -------------------------------------------------------------
check("formatCount groups thousands", formatCount(43736), "43,736");
check("formatCount below a thousand", formatCount(999), "999");
check("formatCount at exactly a thousand", formatCount(1000), "1,000");
check("formatCount millions", formatCount(1234567), "1,234,567");
check("formatCount zero", formatCount(0), "0");
check("formatCount NaN", formatCount(NaN), "n/a");
check("formatCount undefined", formatCount(undefined), "n/a");

// --- dates ---------------------------------------------------------------
// The whole day axis is UTC-bucketed, so every helper below has to read UTC no
// matter where the page is opened. Left to the ambient zone these assertions
// prove nothing on CI, which runs UTC: a getDate() where getUTCDate() was meant
// would pass there and slide every label by a day for half the world. So the zone
// is set explicitly and the block runs once per zone.
//
// Both signs are needed and this was measured, not assumed. day_base is UTC
// midnight, so east of Greenwich local time is later the same day: under
// Pacific/Kiritimati (UTC+14) a local-time dayLabel still prints the right date
// and the suite stayed green with getUTCDate swapped for getDate. West of
// Greenwich the same midnight is the previous day, which is what Etc/GMT+12
// (UTC-12, sign inverted in the name by POSIX convention) catches. The positive
// zone earns its place on the clock helpers instead, where the hour moves either
// way.
const dateChecks = (tz) => {
  check(`[${tz}] day base parses to UTC midnight`, dayBaseMs(BASE), Date.UTC(2026, 2, 12));
  check(`[${tz}] bad day base is null`, dayBaseMs("not-a-date"), null);
  check(`[${tz}] day 0 is the base itself`, dayDate(BASE, 0).toISOString(), "2026-03-12T00:00:00.000Z");
  check(`[${tz}] final day index`, dayDate(BASE, DAYS - 1).toISOString(), "2026-03-16T00:00:00.000Z");
  check(`[${tz}] day index steps one day`, dayDate(BASE, 1) - dayDate(BASE, 0), DAY_MS);
  check(`[${tz}] day label at 0`, dayLabel(BASE, 0), "12 Mar 2026");
  check(`[${tz}] day label at the last day`, dayLabel(BASE, DAYS - 1), "16 Mar 2026");
  // 148 days from 12 Mar lands in August, which crosses three month boundaries
  // and a 31/30-day mix, so it catches naive month arithmetic.
  check(`[${tz}] day label crosses months`, dayLabel(BASE, 148), "7 Aug 2026");
  check(`[${tz}] day label with a bad base`, dayLabel("nope", 3), "");
  check(`[${tz}] timestamp renders as UTC`, formatUtc("2026-08-07T03:35:26.299Z"), "2026-08-07 03:35 UTC");
  check(`[${tz}] timestamp pads single digits`, formatUtc("2026-01-02T03:04:00.000Z"), "2026-01-02 03:04 UTC");
  check(`[${tz}] unparseable timestamp`, formatUtc("later"), "unknown");
  check(`[${tz}] missing timestamp`, formatUtc(undefined), "unknown");
};
for (const tz of ["UTC", "Etc/GMT+12", "Pacific/Kiritimati"]) {
  process.env.TZ = tz;
  dateChecks(tz);
}
// Everything after this point is timezone-free, but leaving the process in
// UTC+14 would be a trap for whoever adds the next assertion.
process.env.TZ = "UTC";

// --- DIDs ----------------------------------------------------------------
check("did truncated head and tail",
  truncateDid("did:key:z6MkAAAAAAAAAAAAAAAAAAAAAAAAtail99"), "did:key:z6Mk...tail99");
check("short did is left alone", truncateDid("did:key:z"), "did:key:z");
check("empty did", truncateDid(""), "");
check("non-string did", truncateDid(null), "");

// --- daily series --------------------------------------------------------
{
  const daily = dailyNewRepos(FIX.repos, DAYS);
  check("daily new repos", daily.join(","), "2,1,0,1,2");
  check("daily length equals day_count", daily.length, DAYS);
  check("day 0 counted", daily[0], 2);
  check("empty middle day is zero, not absent", daily[2], 0);
  check("final day counted", daily[DAYS - 1], 2);
}
check("empty repo list still yields a dense series", dailyNewRepos([], 4).join(","), "0,0,0,0");
check("no repos and no days", dailyNewRepos([], 0).length, 0);
check("non-array repos", dailyNewRepos(null, 3).join(","), "0,0,0");
check("out-of-range day is dropped", dailyNewRepos([repo("x", 0, 99)], 3).join(","), "0,0,0");
check("negative day is dropped", dailyNewRepos([repo("x", 0, -1)], 3).join(","), "0,0,0");
// Same reason as the pairs case below: the join alone cannot see out[-1], so the
// guard here was equally deletable until this line went in.
check("a negative day leaves no stray property behind",
  Object.keys(dailyNewRepos([repo("x", 0, -1)], 3)).join(","), "0,1,2");

{
  const daily = dailyFromPairs(FIX.agents.daily, DAYS);
  check("agent daily from sparse pairs", daily.join(","), "2,0,0,3,4");
  check("agent daily sums to the total", daily.reduce((a, b) => a + b, 0), FIX.agents.total);
}
check("empty pairs", dailyFromPairs([], 3).join(","), "0,0,0");
check("non-array pairs", dailyFromPairs(undefined, 2).join(","), "0,0");
check("pair past the range dropped", dailyFromPairs([[9, 5]], 3).join(","), "0,0,0");
// The sibling of "negative day is dropped" above: without it the d >= 0 guard in
// dailyFromPairs could be deleted with all three suites staying green. Note which
// assertion does the work. A negative index writes out[-1] as a named property,
// not an element, so join, reduce and length all read exactly the same with the
// guard gone; the key list is the only place the stray write shows up.
check("pair with a negative day dropped", dailyFromPairs([[-1, 5]], 3).join(","), "0,0,0");
check("a negative pair leaves no stray property behind",
  Object.keys(dailyFromPairs([[-1, 5]], 3)).join(","), "0,1,2");
check("a negative pair does not disturb the days that are in range",
  dailyFromPairs([[-1, 5], [1, 2]], 3).join(","), "0,2,0");

// --- cumulative ----------------------------------------------------------
{
  const c = cumulativeRepos(FIX);
  check("cumulative repos", c.join(","), "2,3,3,4,6");
  check("cumulative starts at day 0's count", c[0], 2);
  check("cumulative holds flat over an empty day", c[2] === c[1], true);
  check("cumulative never decreases", c.every((v, i) => i === 0 || v >= c[i - 1]), true);
  check("cumulative ends at the true repo total", c[c.length - 1], FIX.repos.length);
}
{
  const c = cumulativeAgents(FIX);
  check("cumulative agents", c.join(","), "2,2,2,5,9");
  check("cumulative agents never decreases", c.every((v, i) => i === 0 || v >= c[i - 1]), true);
  check("cumulative agents ends at the true total", c[c.length - 1], FIX.agents.total);
}
check("cumulative of nothing", cumulative([]).length, 0);
check("cumulative of a non-array", cumulative(null).length, 0);
check("cumulative of a single day", cumulative([7]).join(","), "7");
check("cumulative ignores holes", cumulative([1, undefined, 2]).join(","), "1,1,3");
check("cumulative over an all-zero range", cumulative([0, 0, 0]).join(","), "0,0,0");

// --- peak day ------------------------------------------------------------
check("peak day index", peakDay([1, 5, 2]).index, 1);
check("peak day count", peakDay([1, 5, 2]).count, 5);
check("peak at index 0", peakDay([9, 1]).index, 0);
check("peak at the last index", peakDay([1, 2, 9]).index, 2);
check("peak ties take the earlier day", peakDay([4, 4]).index, 0);
check("no arrivals means no peak", peakDay([0, 0, 0]), null);
check("empty series has no peak", peakDay([]), null);
check("non-array has no peak", peakDay(null), null);

// --- owners --------------------------------------------------------------
check("owner counts", ownerCounts(FIX).join(","), "4,1,1");
check("owner counts sum to the repo total",
  ownerCounts(FIX).reduce((a, b) => a + b, 0), FIX.repos.length);
check("owner counts on an empty snapshot", ownerCounts({}).length, 0);
{
  const top = topOwners(FIX, 2);
  check("top owners respects N", top.length, 2);
  check("biggest owner first", top[0].count, 4);
  check("top owner did", top[0].did, FIX.owners[0]);
  check("top owner is truncated for display", top[0].short.includes("..."), true);
  check("biggest owner bar is full width", top[0].fraction, 1);
  check("share is of all repos", top[0].share, 4 / 6);
  check("second bar is relative to the biggest", top[1].fraction, 0.25);
  check("top owners sorted descending", top[0].count >= top[1].count, true);
}
check("asking for more owners than exist", topOwners(FIX, 99).length, FIX.owners.length);
check("asking for zero owners", topOwners(FIX, 0).length, 0);
check("top owners on an empty snapshot", topOwners({}, 5).length, 0);
check("top owners on a snapshot with owners but no repos",
  topOwners({ owners: ["did:key:z1"], repos: [] }, 5)[0].fraction, 0);

// --- capabilities --------------------------------------------------------
{
  const c = topCapabilities(FIX.agents.capabilities, 2);
  check("top capabilities respects N", c.top.length, 2);
  check("first capability", c.top[0].name, "git:push");
  check("first capability bar is full", c.top[0].fraction, 1);
  check("second capability bar is relative", c.top[1].fraction, 5 / 7);
  check("tail counted by kind, not listed", c.tailKinds, 2);
  check("tail claims summed", c.tailClaims, 2);
}
check("no tail when N covers everything", topCapabilities(FIX.agents.capabilities, 10).tailKinds, 0);
check("empty capabilities", topCapabilities([], 5).top.length, 0);
check("non-array capabilities", topCapabilities(null, 5).tailKinds, 0);
check("malformed capability rows are dropped",
  topCapabilities([["ok", 3], "bad", [null, 2], ["x", "y"]], 5).top.length, 1);

// --- repo name families --------------------------------------------------
// This is a heuristic over attacker-chosen strings, and a heuristic rots without
// anyone noticing, so both directions are pinned: what must fold together, and
// what must stay apart. The must-not cases are the load-bearing half. A rule that
// merges more is trivially easy to write and produces a confident, wrong finding
// ("code" was built 40 times) rather than a visible failure.
check("plain name is its own family", repoFamily("volunteer-match"), "volunteer-match");
check("trailing digits glued on", repoFamily("my-project2"), "my-project");
check("trailing digits after a dash", repoFamily("my-project-03"), "my-project");
check("a long numeric instance id", repoFamily("e2e-1785947444"), "e2e");
check("an underscore separator", repoFamily("my_project_7"), "my_project");
check("a hex instance id", repoFamily("guest-preview-preview-0aa3047e1f"), "guest-preview-preview");
check("a short hex id", repoFamily("agent-f5616d3c"), "agent");
check("a version suffix", repoFamily("image-gen-v4"), "image-gen");
check("case is folded", repoFamily("My-First-Repo"), "my-first-repo");
check("surrounding space is trimmed", repoFamily("  test-repo  "), "test-repo");
check("non-string name", repoFamily(null), "");

// Must NOT merge. Everything here shares a leading token with something else, so
// any rule that cuts at the first separator instead of at the suffix reds this
// block and nothing else.
check("different ideas sharing a first token stay apart",
  repoFamily("code-tutor") === repoFamily("code-review"), false);
check("code-tutor keeps its whole name", repoFamily("code-tutor"), "code-tutor");
check("a longer word is not the shorter one", repoFamily("testing"), "testing");
check("test and testing are different families",
  repoFamily("test") === repoFamily("testing"), false);
check("a hex-looking suffix with no digit is a word, not an id",
  repoFamily("wall-facade"), "wall-facade");
check("only the last suffix goes", repoFamily("e2e-run2-20260318"), "e2e-run2");
check("digits inside the name survive", repoFamily("covid19-tracker"), "covid19-tracker");

// Degenerate names. A repo name is whatever an agent typed, so these exist.
check("an all-digit name is left whole", repoFamily("1785947444"), "1785947444");
check("an empty name", repoFamily(""), "");
check("a name that is only a suffix", repoFamily("-42"), "-42");
check("a name that is only separators", repoFamily("---"), "---");

{
  // 4 x alpha, 2 x beta, 2 x gamma (level, so the tie-break shows), 1 x delta.
  // The owner indexes differ per family on purpose: alpha is three owners
  // building the same thing, gamma is one owner building it twice, and those two
  // shapes are the difference between a finding and one account's tooling.
  const named = (n, owner = 0, day = 0) => [n, owner, day, day, 0, 0];
  const FAMS = {
    repos: [
      named("alpha", 0), named("alpha2", 1), named("alpha-07", 1), named("ALPHA-a1b2c3d4", 2),
      named("gamma", 0), named("gamma-9", 0),
      named("beta", 0), named("beta-1785947444", 1),
      named("delta", 0),
    ],
  };
  const all = repoFamilies(FAMS);
  check("families counted", all.familyCount, 4);
  check("family counts sum to the repo total",
    all.families.reduce((a, f) => a + f.count, 0), FAMS.repos.length);
  check("biggest family first", all.families[0].name, "alpha");
  check("biggest family count", all.families[0].count, 4);
  // Deterministic tie-break, or a refresh reshuffles rows that did not change.
  // The real snapshot has 13 families level at 17, so this is not hypothetical.
  check("level families break the tie on name", all.families[1].name, "beta");
  check("the other level family follows", all.families[2].name, "gamma");
  check("smallest family last", all.families[3].name, "delta");
  check("single-repo families counted", all.singletons, 1);
  check("a family built by several owners counts them", all.families[0].owners, 3);
  check("a family built twice by one owner counts one", all.families[2].owners, 1);
  check("owners never exceed repos in a family",
    all.families.every((f) => f.owners <= f.count), true);

  // The day spread is what separates a batch from a habit, and getting it wrong
  // is what put a false claim on the page: five families of 18 repos from 18
  // separate owners read as independent convergence until you notice all 18
  // landed on 13 Mar. Separate owners on one day is one batch.
  {
    const SPREAD = {
      repos: [
        // A burst: three owners, one day.
        named("burst", 0, 4), named("burst2", 1, 4), named("burst-3", 2, 4),
        // A habit: three owners, three days.
        named("habit", 0, 1), named("habit2", 1, 5), named("habit-3", 2, 9),
        // One owner returning on two days is still two days.
        named("solo", 0, 2), named("solo2", 0, 7),
      ],
    };
    const fams = repoFamilies(SPREAD).families;
    const by = (n) => fams.find((f) => f.name === n);
    check("a family built in one burst spans one day", by("burst").days, 1);
    check("the burst still has its separate owners", by("burst").owners, 3);
    check("a family built over time spans those days", by("habit").days, 3);
    check("one owner returning later still spans two days", by("solo").days, 2);
    check("days never exceed repos in a family",
      fams.every((f) => f.days <= f.count), true);
    check("every family has at least one day", fams.every((f) => f.days >= 1), true);
  }

  // A non-integer day must not inflate the spread, since the page reads a low
  // day count as evidence of a batch.
  {
    const BAD = { repos: [["x", 0, 3, 3, 0, 0], ["x2", 0, null, 0, 0, 0], ["x-3", 0, 3, 3, 0, 0]] };
    check("an unusable creation day is not counted as a day",
      repoFamilies(BAD).families[0].days, 1);
  }

  const t = topFamilies(FAMS, 2);
  check("top families respects N", t.top.length, 2);
  check("biggest family bar is full width", t.top[0].fraction, 1);
  check("second bar is relative to the biggest", t.top[1].fraction, 0.5);
  check("tail families counted", t.tailFamilies, 2);
  check("tail repos counted", t.tailRepos, 3);
  // The whole point of reporting a tail: shown plus unshown is everything.
  check("shown plus tail is every repo",
    t.top.reduce((a, f) => a + f.count, 0) + t.tailRepos, t.total);
  check("total is the repo count", t.total, FAMS.repos.length);
  check("repeated families at a threshold of 2", topFamilies(FAMS, 2, 2).repeated, 3);
  check("repeated families at a threshold of 4", topFamilies(FAMS, 2, 4).repeated, 1);
  check("asking for more families than exist", topFamilies(FAMS, 99).tailFamilies, 0);
  check("asking for zero families", topFamilies(FAMS, 0).top.length, 0);
  check("a zero-N tail is still the whole network", topFamilies(FAMS, 0).tailRepos, 9);
}
check("families on an empty snapshot", repoFamilies({}).familyCount, 0);
check("top families on an empty snapshot", topFamilies({}, 5).top.length, 0);
check("an empty snapshot has no tail to report", topFamilies({}, 5).tailRepos, 0);

// --- repo activity -------------------------------------------------------
{
  // [name, owner, created, updated, stars, fork]
  const A = {
    repos: [
      ["a", 0, 3, 3, 0, 0],   // untouched
      ["b", 0, 3, 9, 2, 0],   // starred, touched later
      ["c", 0, 1, 1, 0, 1],   // untouched fork
      ["d", 0, 0, 4, 0, 0],
    ],
  };
  const act = repoActivity(A);
  check("activity total", act.total, 4);
  check("only repos with a star count", act.starred, 1);
  check("forks counted", act.forked, 1);
  // Day resolution, not timestamps: same-day equality is the whole test.
  check("untouched means the update day equals the creation day", act.untouched, 2);
}
check("activity on an empty snapshot", repoActivity({}).total, 0);
check("activity ignores malformed rows", repoActivity({ repos: ["x", null] }).starred, 0);

// --- activity punchcard --------------------------------------------------
// A hand-built 7x24 grid, empty except for cells whose position is the assertion.
// Row 2 (Tuesday) hour 15 is the peak, row 0 (Sunday) hour 3 is a mid value, and
// everything else is zero, so a helper that transposed the axes or read the rows
// in Monday-first order lands on a different number rather than a plausible one.
{
  const blank = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
  const g = blank();
  g[2][15] = 40;   // Tuesday 15:00, the peak cell
  g[2][3] = 10;    // same row, quiet hour
  g[0][3] = 6;     // Sunday 03:00
  g[5][15] = 20;   // Friday 15:00, same column as the peak
  const SNAP = {
    activity: { grid: g, batches: [["2026-03-13T01", 971], ["2026-04-16T03", 102]], counted: 76, excluded: 1073 },
  };

  check("labels are Sunday first", weekdayLabel(0), "Sun");
  check("weekday label at the end of the row order", weekdayLabel(6), "Sat");
  check("weekday label out of range", weekdayLabel(7), "");
  check("weekday name is the long form", weekdayName(3), "Wednesday");
  check("hour label pads and marks the hour", hourLabel(5), "05:00");
  check("hour label at the end of the day", hourLabel(23), "23:00");
  check("hour label rejects hour 24", hourLabel(24), "");
  check("hour label rejects a negative hour", hourLabel(-1), "");

  check("batch key renders as a date and hour", batchLabel("2026-03-13T01"), "13 Mar 2026, 01:00 UTC");
  check("batch key keeps the hour it was given", batchLabel("2026-04-16T03"), "16 Apr 2026, 03:00 UTC");
  check("batch key that is not an hour key comes back unchanged", batchLabel("nonsense"), "nonsense");

  check("a well formed grid is accepted", activityGrid(SNAP), g);
  check("a snapshot with no activity block is rejected", activityGrid({}), null);
  check("a grid with the wrong number of rows is rejected",
    activityGrid({ activity: { grid: [new Array(24).fill(0)] } }), null);
  check("a row with the wrong number of hours is rejected",
    activityGrid({ activity: { grid: blank().map((r, i) => (i === 4 ? r.slice(1) : r)) } }), null);
  check("a negative cell is rejected",
    activityGrid({ activity: { grid: blank().map((r, i) => (i === 1 ? [-1, ...r.slice(1)] : r)) } }), null);
  check("a fractional cell is rejected",
    activityGrid({ activity: { grid: blank().map((r, i) => (i === 1 ? [0.5, ...r.slice(1)] : r)) } }), null);

  const hours = hourTotals(g);
  check("hour totals have one entry per hour", hours.length, 24);
  check("hour 15 sums both rows that hold it", hours[15], 60);
  check("hour 3 sums both rows that hold it", hours[3], 16);
  check("an hour nobody used is zero", hours[9], 0);
  check("hour totals sum to the grid", hours.reduce((a, b) => a + b, 0), 76);

  const wd = weekdayTotals(g);
  check("weekday totals have one entry per day", wd.length, 7);
  check("Tuesday holds both of its cells", wd[2], 50);
  check("Sunday holds its one cell", wd[0], 6);
  check("a weekday nobody used is zero", wd[1], 0);
  check("weekday totals sum to the grid", wd.reduce((a, b) => a + b, 0), 76);

  const ex = gridExtremes(g);
  check("peak cell weekday", ex.peak.day, 2);
  check("peak cell hour", ex.peak.hour, 15);
  check("peak cell count", ex.peak.count, 40);
  check("trough cell count", ex.trough.count, 0);
  // Ties on a grid that is mostly zeros: the trough has to be the first zero in
  // row order, Sunday 00:00, or the annotation moves between crawls.
  check("trough ties go to the earliest weekday", ex.trough.day, 0);
  check("trough ties go to the earliest hour", ex.trough.hour, 0);
  check("extremes of an empty grid", gridExtremes([]), null);
  // A second cell level with the peak, later in row order. Without a tie-break the
  // annotation on the page moves between two equally true answers whenever the
  // crawl nudges one of them, so the earliest wins and this is what says so.
  {
    const tied = blank();
    tied[2][15] = 40;
    tied[4][2] = 40;
    const t = gridExtremes(tied);
    check("peak ties go to the earliest weekday", t.peak.day, 2);
    check("peak ties go to the earliest hour", t.peak.hour, 15);
  }

  const se = seriesExtremes([4, 9, 2, 9]);
  check("series max index takes the first of a tie", se.max.index, 1);
  check("series max value", se.max.value, 9);
  check("series min index", se.min.index, 2);
  check("series ratio", se.ratio, 4.5);
  // A zero trough would make the ratio Infinity, which prints as "Infinity times
  // quieter" on the page.
  check("series ratio with a zero minimum is zero, not Infinity", seriesExtremes([0, 5]).ratio, 0);
  check("series extremes of an empty array", seriesExtremes([]), null);

  // sqrt, so the median cell is visible rather than a smudge, and monotonic, so
  // no two cells swap order.
  check("intensity is 1 at the maximum", cellIntensity(40, 40), 1);
  check("intensity is 0 at zero", cellIntensity(0, 40), 0);
  check("intensity lifts a quarter-height cell above a quarter", cellIntensity(10, 40), 0.5);
  check("intensity is monotonic", cellIntensity(20, 40) > cellIntensity(10, 40), true);
  check("intensity with no maximum is 0", cellIntensity(5, 0), 0);
  check("intensity clamps a count above the maximum", cellIntensity(80, 40), 1);

  const sum = activitySummary(SNAP);
  check("summary peak cell", `${sum.peakCell.day}/${sum.peakCell.hour}/${sum.peakCell.count}`, "2/15/40");
  check("summary max is the peak count", sum.max, 40);
  check("summary busiest hour is a column, not a cell", sum.busiestHour.hour, 15);
  check("summary busiest hour count is the column sum", sum.busiestHour.count, 60);
  check("summary quietest hour", sum.quietestHour.count, 0);
  check("summary carries the counted total", sum.counted, 76);
  check("summary carries the excluded total", sum.excluded, 1073);
  check("summary keeps both batch hours", sum.batches.length, 2);
  check("summary counts the empty slots", sum.emptyCells, 168 - 4);
  // Means per day, not row totals: five weekdays against two weekend days.
  check("weekday mean is over five days", sum.weekdayMean, 70 / 5);
  check("weekend mean is over two days", sum.weekendMean, 6 / 2);
  check("summary of a snapshot without the block", activitySummary({}), null);
  check("summary drops a malformed batch entry",
    activitySummary({ activity: { grid: g, batches: [["2026-03-13T01", 971], "junk", ["x", 1.5]], counted: 76, excluded: 971 } }).batches.length, 1);
}

// --- owner lifetime ------------------------------------------------------
// The section this feeds makes two claims that boundaries decide: which span
// bucket an owner falls into, and which owners the return-rate table drops. Both
// are pinned in both directions below.

// The batch keys are clock-hours and the repo rows are day indexes, so the fold
// from one to the other is the joint between two different units and the place a
// silent off-by-one would hide. These are the two hours the committed snapshot
// carries.
check("a batch hour early in a day folds to that day", batchDayIndex("2026-03-12", "2026-03-13T01"), 1);
check("a batch hour a month later folds to its day", batchDayIndex("2026-03-12", "2026-04-16T03"), 35);
check("the day base itself is day 0", batchDayIndex("2026-03-12", "2026-03-12T00"), 0);
// floor, not round. 23:00 is still the same day, and a rounding fold would push
// every hour after noon onto the next one.
check("the last hour of a day is still that day", batchDayIndex("2026-03-12", "2026-03-12T23"), 0);
check("an hour before the day base is negative", batchDayIndex("2026-03-12", "2026-03-11T05"), -1);
check("a batch key that is not an hour key", batchDayIndex("2026-03-12", "nonsense"), null);
check("a batch key with a bad day base", batchDayIndex("nope", "2026-03-13T01"), null);
check("a non-string batch key", batchDayIndex("2026-03-12", null), null);

check("seeding days come off the batch list",
  seedingDays({ day_base: "2026-03-12", activity: { batches: [["2026-03-13T01", 971], ["2026-04-16T03", 102]] } }).join(","),
  "1,35");
// Two batch hours on one calendar day are one excluded day, not two.
check("two batch hours on one day collapse to one",
  seedingDays({ day_base: "2026-03-12", activity: { batches: [["2026-03-13T01", 9], ["2026-03-13T14", 9]] } }).join(","),
  "1");
check("seeding days are sorted",
  seedingDays({ day_base: "2026-03-12", activity: { batches: [["2026-04-16T03", 1], ["2026-03-13T01", 1]] } }).join(","),
  "1,35");
check("a snapshot with no batches excludes nothing",
  seedingDays({ day_base: "2026-03-12", activity: { batches: [] } }).length, 0);
check("a snapshot with no activity block excludes nothing", seedingDays({}).length, 0);
check("a malformed batch entry is dropped, not counted as a day",
  seedingDays({ day_base: "2026-03-12", activity: { batches: ["junk", ["2026-03-13T01", 1], [null, 2]] } }).join(","),
  "1");
check("a batch before the day base is not an excluded day",
  seedingDays({ day_base: "2026-03-12", activity: { batches: [["2026-03-11T01", 1]] } }).length, 0);

check("span 0 is the same-day bucket", spanBucketKey(0), "same");
// The six boundaries. Every bound is inclusive and the next bucket starts at
// bound + 1, so these six lines are what a widened or narrowed bucket reds.
check("span of exactly 7 is within a week", spanBucketKey(7), "week");
check("span of exactly 8 is one to four weeks", spanBucketKey(8), "weeks");
check("span of exactly 30 is one to four weeks", spanBucketKey(30), "weeks");
check("span of exactly 31 is one to three months", spanBucketKey(31), "months");
check("span of exactly 90 is one to three months", spanBucketKey(90), "months");
check("span of exactly 91 is over three months", spanBucketKey(91), "longer");
check("span of 1 is within a week", spanBucketKey(1), "week");
check("a negative span has no bucket", spanBucketKey(-1), null);
check("a non-numeric span has no bucket", spanBucketKey(null), null);

{
  // Ten owners, each one a case. Day 1 is the seeding day, set from the batch
  // list rather than written into the fixture as a number.
  const life = (name, owner, day) => [name, owner, day, day, 0, 0];
  const LIFE = {
    day_base: "2026-03-12",
    activity: { batches: [["2026-03-13T01", 2]] },
    repos: [
      life("solo", 0, 0),                                        // one repo
      life("burst1", 1, 2), life("burst2", 1, 2), life("burst3", 1, 2), // several, one day
      life("wk-a", 2, 2), life("wk-b", 2, 9),                    // span 7
      life("m4-a", 3, 0), life("m4-b", 3, 8),                    // span 8
      life("m30-a", 4, 0), life("m30-b", 4, 30),                 // span 30
      life("m31-a", 5, 0), life("m31-b", 5, 31),                 // span 31
      life("q90-a", 6, 0), life("q90-b", 6, 90),                 // span 90
      life("q91-a", 7, 0), life("q91-b", 7, 91),                 // span 91
      // Out of day order in the array, which is how the crawl actually pages
      // them: an updated_at ordering is not a created ordering. A first/last
      // that trusted array order would read 5 and 3 here and report span -2.
      life("ooo-a", 8, 5), life("ooo-b", 8, 1), life("ooo-c", 8, 3),
      // Exists only because of the seeding day.
      life("seed-a", 9, 1), life("seed-b", 9, 1),
      // Unusable rows. A null day would make `first` null, and every later
      // comparison against null is false, which reads as a valid span of 0.
      ["bad-owner", null, 4, 4, 0, 0],
      ["bad-owner-float", 1.5, 4, 4, 0, 0],
      ["bad-day", 0, null, 0, 0, 0],
      ["bad-day-float", 0, 2.5, 2, 0, 0],
      "not-a-row",
    ],
  };
  const { owners } = ownerLifetimes(LIFE);
  const by = (i) => owners.find((o) => o.owner === i);
  check("one row per owner, malformed rows excluded", owners.length, 10);
  check("owner rows are in owner order", owners.every((o, i) => i === 0 || o.owner > owners[i - 1].owner), true);

  check("a single-repo owner has one repo", by(0).count, 1);
  check("a single-repo owner spans zero days", by(0).span, 0);
  check("a single-repo owner first and last are the same day", by(0).first === by(0).last, true);
  check("an unusable day does not attach to an owner", by(0).count, 1);

  check("several repos on one day still count", by(1).count, 3);
  check("several repos on one day span zero", by(1).span, 0);

  check("an owner who returns has the later day as last", by(2).last, 9);
  check("an owner who returns keeps the earlier day as first", by(2).first, 2);
  check("an owner who returns has a positive span", by(2).span, 7);

  check("out-of-order rows take the earliest day as first", by(8).first, 1);
  check("out-of-order rows take the latest day as last", by(8).last, 5);
  check("out-of-order rows produce a non-negative span", by(8).span, 4);
  check("out-of-order rows are all counted", by(8).count, 3);

  check("a seeding-only owner still holds their repos", by(9).count, 2);
  check("a seeding-only owner has nothing left off the seeding day", by(9).offSeed, 0);
  check("a seeding-day repo is not subtracted from the plain count", by(8).count, 3);
  check("the seeding day comes off the off-seed count", by(8).offSeed, 2);
  check("an owner with nothing on a seeding day is unchanged", by(2).offSeed, by(2).count);

  const m = ownerLifetimeSummary(LIFE);
  check("owner total", m.total, 10);
  check("one-day owners counted", m.oneDay, 3);
  check("returning owners are the rest", m.returning, 7);
  check("one-day share", m.oneDayShare, 0.3);
  check("owners holding exactly one repository", m.single, 1);

  check("span buckets", m.spanBuckets.map((b) => `${b.key}:${b.owners}`).join(","),
    "same:3,week:2,weeks:2,months:2,longer:1");
  // Every owner lands in exactly one span bucket, so the five counts are the
  // owner list re-partitioned and nothing else.
  check("span buckets partition the owners",
    m.spanBuckets.reduce((a, b) => a + b.owners, 0), m.total);
  check("the biggest span bucket draws a full bar",
    m.spanBuckets.find((b) => b.key === "same").fraction, 1);
  check("a small span bucket keeps its real proportion",
    m.spanBuckets.find((b) => b.key === "longer").fraction, 1 / 3);
  check("span bucket share is of all owners",
    m.spanBuckets.find((b) => b.key === "same").share, 0.3);

  // spans sorted: 0,0,0,4,7,8,30,31,90,91
  check("median span is the nearest-rank middle", m.medianSpan, 8);
  check("p90 span", m.p90Span, 91);
  check("max span", m.maxSpan, 91);

  check("return rate by size, every repo",
    m.bySize.map((b) => `${b.key}:${b.owners}/${b.returned}`).join(","),
    "one:1/0,few:9/7,some:0/0,many:0/0");
  check("size buckets partition the owners",
    m.bySize.reduce((a, b) => a + b.owners, 0), m.total);
  check("nobody is counted in two size buckets",
    m.bySize.every((b) => b.returned <= b.owners), true);
  check("an empty size bucket has a zero rate, not a division by zero",
    m.bySize.find((b) => b.key === "some").rate, 0);
  check("return rate is returned over owners", m.bySize.find((b) => b.key === "few").rate, 7 / 9);

  // The exclusion: owner 9 disappears entirely, owner 8 drops from 3 repos to 2
  // and so stays in the same bucket here. On the real snapshot this is the whole
  // difference between a non-monotonic table and a monotonic one.
  check("the seeding day drops the owners who only appeared on it", m.seedingOnlyOwners, 1);
  check("off-seed owner total", m.offSeedTotal, 9);
  check("return rate by size, seeding day excluded",
    m.bySizeOffSeed.map((b) => `${b.key}:${b.owners}/${b.returned}`).join(","),
    "one:1/0,few:8/7,some:0/0,many:0/0");
  check("off-seed size buckets partition the off-seed owners",
    m.bySizeOffSeed.reduce((a, b) => a + b.owners, 0), m.offSeedTotal);
  check("the excluded day is reported", m.seedingDays.join(","), "1");
  check("one-day owners among the off-seed owners", m.offSeedOneDay, 2);
  check("off-seed one-day share", m.offSeedOneDayShare, 2 / 9);
  // The exclusion must not touch first, last or span. An owner who only ever
  // appeared during the seeding run genuinely is a one-day owner.
  check("the headline still counts the seeding-only owners", m.oneDay > m.offSeedOneDay, true);

  // One owner per size bucket, so all four rows are exercised rather than the two
  // the fixture above happens to reach.
  const many = [];
  for (let i = 0; i < 11; i++) many.push(life(`many${i}`, 3, 0));
  const SIZES = {
    day_base: "2026-03-12",
    repos: [
      life("s1", 0, 0),
      life("s2a", 1, 0), life("s2b", 1, 0), life("s2c", 1, 0),
      ...Array.from({ length: 10 }, (_, i) => life(`s3-${i}`, 2, 0)),
      ...many,
    ],
  };
  const sizes = ownerLifetimeSummary(SIZES);
  check("every size bucket holds exactly its one owner",
    sizes.bySize.map((b) => b.owners).join(","), "1,1,1,1");
  check("ten repos is the top of the 4 to 10 bucket",
    sizes.bySize.find((b) => b.key === "some").owners, 1);
  check("eleven repos is the bottom of the 11 or more bucket",
    sizes.bySize.find((b) => b.key === "many").owners, 1);
  check("size buckets still partition with all four occupied",
    sizes.bySize.reduce((a, b) => a + b.owners, 0), sizes.total);
  check("size bucket ranges are contiguous with no gap",
    SIZE_BUCKETS.every((b, i) => i === 0 || b.min === SIZE_BUCKETS[i - 1].max + 1), true);
  check("no snapshot batches means no exclusion", sizes.seedingOnlyOwners, 0);
}

check("owner lifetimes on an empty repo list", ownerLifetimes({ repos: [] }).owners.length, 0);
check("owner lifetimes on an empty snapshot", ownerLifetimes({}).owners.length, 0);
check("summary of an empty snapshot has no owners", ownerLifetimeSummary({}).total, 0);
check("an empty snapshot reports a zero one-day share", ownerLifetimeSummary({}).oneDayShare, 0);
check("an empty snapshot still returns every span bucket",
  ownerLifetimeSummary({}).spanBuckets.length, 5);
check("an empty snapshot still returns every size bucket",
  ownerLifetimeSummary({}).bySize.length, 4);
check("an empty snapshot has a zero max span", ownerLifetimeSummary({}).maxSpan, 0);
check("a snapshot of nothing but malformed rows",
  ownerLifetimeSummary({ repos: [null, "x", [1, 2]] }).total, 0);

// --- the real snapshot ---------------------------------------------------
// One pass over the committed file. Nothing here is an absolute number any more:
// crawl.mjs exists to be re-run, and pinning 3,150 and 4,088 in three files meant
// a routine refresh reddened suites that have nothing to say about the totals.
// The pins live in test-snapshot.mjs, whose job is guarding this particular
// crawl. What stays here is the cross-check that made the real-snapshot pass
// worth running: the series below is derived from the per-repo rows and the
// per-day agent pairs, while stats.repos and stats.agents are counters the
// crawler copied straight off the node's own API and never computed from those
// rows. Two sources, still compared.
{
  const s = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const r = cumulativeRepos(s);
  const a = cumulativeAgents(s);
  check("snapshot cumulative repos ends at the row count", r[s.day_count - 1], s.repos.length);
  // Deliberately not an equality. The crawl pages an updated_at-ordered list, so
  // a push landing between pages can cost or duplicate a row; five is the same
  // slack test-snapshot.mjs allows for that race and the reason this cannot be
  // tightened to ===.
  check("snapshot cumulative repos agrees with the node's own counter",
    Math.abs(r[s.day_count - 1] - s.stats.repos) <= 5, true);
  check("snapshot cumulative agents ends at the node's own counter",
    a[s.day_count - 1], s.stats.agents);
  check("snapshot repo series is non-decreasing", r.every((v, i) => i === 0 || v >= r[i - 1]), true);
  check("snapshot agent series is non-decreasing", a.every((v, i) => i === 0 || v >= a[i - 1]), true);
  check("snapshot series length is day_count", r.length, s.day_count);

  // The family grouping against the real names, relationally only. An absolute
  // "my-first-repo appears 219 times" would red on every refresh, but these hold
  // for any snapshot and would catch a rule that merged everything into one
  // bucket or stopped merging at all.
  const f = topFamilies(s, 12);
  check("snapshot families do not exceed the repo count", f.familyCount <= s.repos.length, true);
  check("snapshot names actually repeat", f.familyCount < s.repos.length, true);
  check("snapshot shown plus tail is every repo",
    f.top.reduce((a, x) => a + x.count, 0) + f.tailRepos, s.repos.length);
  check("snapshot singletons cannot exceed the family count", f.singletons <= f.familyCount, true);
  check("snapshot family rows are sorted descending",
    f.top.every((x, i) => i === 0 || x.count <= f.top[i - 1].count), true);
  // The finding the page states: the biggest family is not a rounding error, and
  // the owner spread is what separates convergence from one account's tooling.
  check("snapshot has a family of at least ten", f.top[0].count >= 10, true);
  check("snapshot family owners never exceed the family size",
    f.top.every((x) => x.owners >= 1 && x.owners <= x.count), true);

  // The punchcard against the real file. Absolute values stay out (they belong to
  // one crawl), but the relationships hold on every crawl, and the swing is the
  // one the section's claim rests on: without it there is no rhythm to show.
  const pc = activitySummary(s);
  check("snapshot has a usable activity grid", pc !== null, true);
  check("snapshot hour totals sum to counted", hourTotals(pc.grid).reduce((a, b) => a + b, 0), pc.counted);
  check("snapshot weekday totals sum to counted", weekdayTotals(pc.grid).reduce((a, b) => a + b, 0), pc.counted);
  check("snapshot counted plus excluded is every repo", pc.counted + pc.excluded, s.repos.length);
  check("snapshot batch counts sum to excluded", pc.batches.reduce((a, b) => a + b[1], 0), pc.excluded);
  check("snapshot peak cell is the largest cell",
    pc.grid.every((r) => r.every((v) => v <= pc.peakCell.count)), true);
  check("snapshot daily swing is at least double", pc.swing >= 2, true);
  check("snapshot weekdays outpace weekends", pc.weekdayMean > pc.weekendMean, true);

  // Owner lifetime against the real file. Absolute counts stay out for the same
  // reason as everywhere else here, but the partitions and the exclusion's
  // direction hold on any crawl, and the monotonic climb is the claim the
  // section rests on: without it the by-size table says nothing.
  const life = ownerLifetimeSummary(s);
  check("snapshot lifetime owners match the owner list", life.total, s.owners.length);
  check("snapshot span buckets partition the owners",
    life.spanBuckets.reduce((a, b) => a + b.owners, 0), life.total);
  check("snapshot size buckets partition the owners",
    life.bySize.reduce((a, b) => a + b.owners, 0), life.total);
  check("snapshot off-seed size buckets partition the off-seed owners",
    life.bySizeOffSeed.reduce((a, b) => a + b.owners, 0), life.offSeedTotal);
  check("snapshot off-seed owners plus seeding-only owners is every owner",
    life.offSeedTotal + life.seedingOnlyOwners, life.total);
  check("snapshot one-day and returning owners are every owner",
    life.oneDay + life.returning, life.total);
  check("snapshot returns never exceed the bucket",
    life.bySize.every((b) => b.returned <= b.owners), true);
  check("snapshot spans are never negative", life.owners.every((o) => o.span >= 0), true);
  check("snapshot off-seed counts never exceed the plain counts",
    life.owners.every((o) => o.offSeed <= o.count), true);
  check("snapshot excluded days come from the batch list",
    life.seedingDays.length, seedingDays(s).length);
  // The finding: nine owners in ten never came back, and the return rate climbs
  // with size only once the seeding day is out.
  check("snapshot has most owners on a single day", life.oneDayShare > 0.9, true);
  check("snapshot headline survives the exclusion", life.offSeedOneDayShare > 0.9, true);
  check("snapshot return rate is monotonic once the seeding day is excluded",
    life.bySizeOffSeed.every((b, i) => i === 0 || b.rate >= life.bySizeOffSeed[i - 1].rate), true);
  // And that the exclusion is doing something, or the whole named choice is
  // dead code that nobody would notice rotting.
  check("snapshot seeding day actually removes owners", life.seedingOnlyOwners > 0, true);

  const act = repoActivity(s);
  check("snapshot activity total is the repo count", act.total, s.repos.length);
  check("snapshot starred cannot exceed the total", act.starred <= act.total, true);
  check("snapshot untouched cannot exceed the total", act.untouched <= act.total, true);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
