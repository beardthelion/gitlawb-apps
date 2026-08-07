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
  peakDay, ownerCounts, topOwners, topCapabilities, sortedPeers, recentEvents,
  splitRepoId,
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
  peers: {
    count: 3,
    reachable: 1,
    rows: [["zeta.example", 0, 4], ["alpha.example", 0, 3], ["mid.example", 1, 4]],
  },
  events: [
    ["did:key:zOwner/repo-old", "aaaa1111", "refs/heads/main", 0, "2026-03-14T00:00:00.000Z"],
    ["did:key:zOwner/repo-new", "bbbb2222", "refs/heads/feature", 1, "2026-03-16T00:00:00.000Z"],
  ],
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

// --- peers ---------------------------------------------------------------
{
  const p = sortedPeers(FIX);
  check("all peers kept", p.length, 3);
  check("reachable peer sorts first", p[0].label, "mid.example");
  check("reachable flag decoded", p[0].reachable, true);
  check("unreachable peers sorted by label", p[1].label, "alpha.example");
  check("last unreachable peer", p[2].label, "zeta.example");
}
check("peers on an empty snapshot", sortedPeers({}).length, 0);

// --- events --------------------------------------------------------------
{
  const e = recentEvents(FIX, 5);
  check("events newest first", e[0].repo, "did:key:zOwner/repo-new");
  check("create flag decoded", e[0].created, true);
  check("update is not a create", e[1].created, false);
  check("ref name preserved", e[0].ref, "refs/heads/feature");
}
check("events respect N", recentEvents(FIX, 1).length, 1);
check("events on an empty snapshot", recentEvents({}, 5).length, 0);
check("zero events requested", recentEvents(FIX, 0).length, 0);
check("a lone event still carries a count", recentEvents(FIX, 5)[0].count, 1);

// Collapsing. The real feed is 200 rows over 10 repos, so this is the path that
// decides what the page actually shows.
{
  const at = (h) => `2026-03-16T0${h}:00:00.000Z`;
  const run = (repo, ref, created, h) => [`did:key:zOwner/${repo}`, "cccc3333", ref, created, at(h)];
  const S = { events: [run("a", "refs/heads/main", 0, 1), run("a", "refs/heads/main", 0, 2), run("a", "refs/heads/main", 0, 3)] };
  const got = recentEvents(S, 5);
  check("a run of the same repo and ref becomes one row", got.length, 1);
  check("the row counts the whole run", got[0].count, 3);
  check("the run keeps its newest timestamp", got[0].at, at(3));
  check("the run keeps its oldest timestamp", got[0].since, at(1));

  // Same repo, different ref: two branches moving is not one event.
  const R = { events: [run("a", "refs/heads/main", 0, 2), run("a", "refs/heads/work", 0, 1)] };
  check("a different ref breaks the run", recentEvents(R, 5).length, 2);

  // A create and an update on the same ref are different facts.
  const C = { events: [run("a", "refs/heads/main", 0, 2), run("a", "refs/heads/main", 1, 1)] };
  check("a create does not merge into updates", recentEvents(C, 5).length, 2);

  // Quiet, then back. Merging across the gap would erase the only shape this
  // feed has, so the collapse is consecutive-only.
  const G = {
    events: [run("a", "refs/heads/main", 0, 3), run("b", "refs/heads/main", 0, 2), run("a", "refs/heads/main", 0, 1)],
  };
  const gaps = recentEvents(G, 5);
  check("a repo that returns after a gap gets its own row", gaps.length, 3);
  check("no collapsed row spans the gap", gaps.every((r) => r.count === 1), true);

  // N counts collapsed rows, so the cap is on what is shown, not on what is read.
  const many = { events: Array.from({ length: 9 }, (_, i) => run(`r${i % 3}`, "refs/heads/main", 0, i)) };
  check("N applies after collapsing", recentEvents(many, 2).length, 2);
}

check("repo id splits on the first slash", splitRepoId("did:key:zAbc/my-repo").name, "my-repo");
check("repo id owner half", splitRepoId("did:key:zAbc/my-repo").owner, "did:key:zAbc");
check("repo name keeps later slashes", splitRepoId("owner/a/b").name, "a/b");
check("repo id with no slash", splitRepoId("bare").name, "bare");
check("non-string repo id", splitRepoId(null).name, "");

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
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
