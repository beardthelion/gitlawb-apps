// Live mode's rules, run rather than reasoned.
//
//   node probe/test-live.mjs
//
// The bug this feature invites is one specific bug: a poll that failed rendering
// as a network where nothing happened. The proxy answers a denial with
// {"error": "..."}, which is an object, so every field the page wanted reads as
// undefined and a `?? 0` anywhere turns a 502 into "0 new events". That is
// indistinguishable from the common case, because the common case really is
// nothing happening: 2 repositories moved in the last 15 minutes.
//
// So the error and degenerate paths below are weighted at least as heavily as
// the happy path, and several of them (a repos page whose timestamps went
// backwards, the first poll of a session, a counter that dropped) are cases the
// live node will produce on its own without anybody attacking the page.

import {
  POLL_MS, REPOS_MIN_INTERVAL_MS, MAX_BACKOFF_MS,
  repoKey, validatePayload, diffStats, diffRepos, shouldFetchRepos,
  formatAge, nextBackoffMs, toMs,
} from "../lib/live.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const T0 = Date.parse("2026-08-06T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const row = (name, owner, at, stars = 0) => ({ name, owner, updated_at: iso(at), stars });

const STATS = { agents: 4088, pushes: 44069, repos: 3150, version: "0.7.0" };

// --- the error body, for every payload kind -------------------------------
// The single most important block in this file. Each of these is a real proxy
// response: 404 for a path off the allowlist, 405 for a non-GET, 502 for an
// upstream that answered wrong, 504 for one that did not answer.
{
  const bodies = [
    ["not found", { error: "not found" }],
    ["method not allowed", { error: "method not allowed" }],
    ["upstream returned 500", { error: "upstream returned 500" }],
    ["upstream timed out", { error: "upstream timed out" }],
    ["upstream unreachable", { error: "upstream unreachable" }],
  ];
  for (const [label, body] of bodies) {
    for (const kind of ["stats", "repos", "peers"]) {
      const v = validatePayload(kind, body);
      check(`error body "${label}" is rejected as ${kind}`, v.ok, false);
      check(`error body "${label}" as ${kind} carries the reason`, v.reason, label);
      check(`error body "${label}" as ${kind} exposes no data`, v.data, undefined);
    }
  }

  // The exact failure this suite exists to prevent: an error body must not read
  // as a valid-but-empty answer anywhere.
  const v = validatePayload("repos", { error: "upstream timed out" });
  check("an error body is not an empty repos list", Array.isArray(v.data), false);
  check("an error body never reports ok", v.ok, false);
  const s = validatePayload("stats", { error: "not found" });
  check("an error stats body yields no counters to diff", s.data, undefined);
  check("diffing against a rejected stats body reports no movement", diffStats(STATS, s.data).moved, false);
  check("diffing a rejected body against nothing reports no movement", diffStats(null, s.data).moved, false);
  check("a rejected repos body produces no changes", diffRepos([row("a", "did:key:z1", T0)], v.data).changed.length, 0);

  // An error key that is not a string is still not data.
  check("a non-string error key is still rejected", validatePayload("stats", { error: 500 }).ok, false);
  check("a non-string error key reports a reason", validatePayload("stats", { error: 500 }).reason, "upstream error");
}

// --- valid JSON, wrong shape ----------------------------------------------
{
  const cases = [
    ["null", null, "empty response"],
    ["undefined", undefined, "empty response"],
    ["an array where an object is expected", [1, 2, 3], "expected an object"],
    ["an empty array", [], "expected an object"],
    ["a bare string", "ok", "expected an object"],
    ["a bare number", 200, "expected an object"],
    ["true", true, "expected an object"],
  ];
  for (const [label, body, reason] of cases) {
    const v = validatePayload("stats", body);
    check(`stats rejects ${label}`, v.ok, false);
    check(`stats rejects ${label} with a reason`, v.reason, reason);
  }

  check("stats rejects a missing pushes field",
    validatePayload("stats", { agents: 1, repos: 2 }).reason, "missing or non-numeric pushes");
  check("stats rejects a null counter",
    validatePayload("stats", { agents: 1, repos: 2, pushes: null }).reason, "missing or non-numeric pushes");
  check("stats rejects a string counter",
    validatePayload("stats", { agents: 1, repos: 2, pushes: "44069" }).reason, "missing or non-numeric pushes");
  check("stats rejects NaN",
    validatePayload("stats", { agents: 1, repos: 2, pushes: NaN }).ok, false);
  check("stats accepts the measured 61 byte body", validatePayload("stats", STATS).ok, true);
  check("stats keeps the version string through validation",
    validatePayload("stats", STATS).data.version, "0.7.0");

  check("repos rejects an object where an array is expected",
    validatePayload("repos", { rows: [] }).reason, "expected an array of rows");
  check("repos rejects null", validatePayload("repos", null).reason, "empty response");
  check("repos accepts an empty list", validatePayload("repos", []).ok, true);
  check("repos accepts an empty list as empty", validatePayload("repos", []).data.length, 0);

  // The proxy writes null into name when upstream had none. One unusable row is
  // dropped; the poll is not thrown away over it.
  const mixed = validatePayload("repos", [
    row("good", "did:key:z1", T0), { name: null, owner: "d", updated_at: iso(T0) },
    null, "nope", { owner: "d" }, { name: "", owner: "d", updated_at: iso(T0) },
  ]);
  check("repos with one bad row is still usable", mixed.ok, true);
  check("repos drops the unusable rows", mixed.data.length, 1);
  check("repos keeps the usable row", mixed.data[0].name, "good");

  check("peers rejects an array", validatePayload("peers", []).reason, "expected an object");
  check("peers rejects a body with no peers array",
    validatePayload("peers", { count: 3 }).reason, "missing the peers array");
  check("peers accepts the real shape",
    validatePayload("peers", { count: 2, reachable: 1, peers: [{ did: "d", reachable: true }] }).ok, true);

  check("an unknown payload kind is rejected", validatePayload("agents", STATS).ok, false);
}

// --- the counters ---------------------------------------------------------
{
  const first = diffStats(null, STATS);
  check("the first poll reports no movement", first.moved, false);
  check("the first poll reports no new pushes", first.pushes, 0);
  check("the first poll is flagged as the first", first.first, true);

  const moved = diffStats(STATS, { ...STATS, pushes: 44071, repos: 3151 });
  check("a burst of two pushes is counted", moved.pushes, 2);
  check("a new repo is counted", moved.repos, 1);
  check("an unchanged counter contributes nothing", moved.agents, 0);
  check("movement is reported", moved.moved, true);
  check("forward movement is not backwards", moved.backwards, false);

  const still = diffStats(STATS, { ...STATS });
  check("twelve still intervals report no movement", still.moved, false);
  check("a still interval reports zero pushes", still.pushes, 0);

  // A node restored from a backup, or a replica behind the one polled a moment
  // ago. Neither should put "-3 pushes" on screen.
  const back = diffStats(STATS, { ...STATS, pushes: 44066, agents: 4080 });
  check("a counter going backwards never yields a negative push delta", back.pushes, 0);
  check("a counter going backwards never yields a negative agent delta", back.agents, 0);
  check("a counter going backwards is still movement", back.moved, true);
  check("a counter going backwards is flagged", back.backwards, true);
  check("every delta stays non-negative",
    [back.pushes, back.repos, back.agents].every((v) => v >= 0), true);

  check("a missing counter on one side is skipped rather than read as zero",
    diffStats(STATS, { agents: 4088, repos: 3150 }).pushes, 0);
  check("a missing counter on one side does not fake movement",
    diffStats(STATS, { agents: 4088, repos: 3150 }).moved, false);
  check("an undefined next body reports no movement", diffStats(STATS, undefined).moved, false);
  check("two nulls report no movement", diffStats(null, null).moved, false);
}

// --- the repositories -----------------------------------------------------
{
  const before = [
    row("gamma", "did:key:z2", T0 - 3 * 60_000),
    row("beta", "did:key:z1", T0 - 10 * 60_000),
    row("alpha", "did:key:z1", T0 - 60 * 60_000),
  ];

  // First poll of the session. Thirty rows spanning a day and a half, none of
  // them news.
  const baseline = diffRepos(null, before);
  check("the first poll reports nothing as just changed", baseline.changed.length, 0);
  check("the first poll adds nothing", baseline.added.length, 0);
  check("the first poll updates nothing", baseline.updated.length, 0);
  check("the first poll is flagged as the baseline", baseline.baseline, true);
  // It still learns when the newest thing happened, which is what the age
  // readout needs on the very first frame.
  check("the first poll still learns the newest timestamp", baseline.newest, T0 - 3 * 60_000);
  check("an undefined previous page is also a baseline", diffRepos(undefined, before).baseline, true);

  const after = [
    row("delta", "did:key:z3", T0),
    row("beta", "did:key:z1", T0 - 30_000),
    row("gamma", "did:key:z2", T0 - 3 * 60_000),
    row("alpha", "did:key:z1", T0 - 60 * 60_000),
  ];
  const d = diffRepos(before, after);
  check("a repository never seen before is an addition", d.added.length, 1);
  check("the addition is the new repository", d.added[0].name, "delta");
  check("the addition is flagged as new", d.added[0].isNew, true);
  check("a repository whose timestamp advanced is an update", d.updated.length, 1);
  check("the update is the pushed repository", d.updated[0].name, "beta");
  check("an update is not flagged as new", d.updated[0].isNew, false);
  check("an unchanged repository is neither", d.changed.length, 2);
  check("changes are ordered newest first", d.changed.map((c) => c.name).join(","), "delta,beta");
  check("a change carries its owner", d.changed[0].owner, "did:key:z3");
  check("a change carries a parsed timestamp", d.changed[0].at, T0);
  check("the newest timestamp is the newest row", d.newest, T0);
  check("a real diff is not a baseline", d.baseline, false);

  // Clock skew upstream, or a node restored from a backup. Neither is an event.
  const backwards = [
    row("beta", "did:key:z1", T0 - 40 * 60_000),
    row("gamma", "did:key:z2", T0 - 3 * 60_000),
    row("alpha", "did:key:z1", T0 - 60 * 60_000),
  ];
  const b = diffRepos(before, backwards);
  check("a timestamp that went backwards is not an update", b.updated.length, 0);
  check("a timestamp that went backwards is not an addition", b.added.length, 0);
  check("a timestamp that went backwards produces no change at all", b.changed.length, 0);

  // Identical pages, which is what the great majority of polls look like.
  const same = diffRepos(before, before.slice());
  check("an unchanged page reports nothing", same.changed.length, 0);
  check("an unchanged page still reports the newest timestamp", same.newest, T0 - 3 * 60_000);

  // Empty and degenerate pages.
  check("an empty page against a baseline reports nothing", diffRepos(null, []).changed.length, 0);
  check("an empty page has no newest timestamp", diffRepos(null, []).newest, null);
  check("an empty page against a full one reports nothing", diffRepos(before, []).changed.length, 0);
  check("a full page against an empty one reports every row as new",
    diffRepos([], before).added.length, 3);
  check("a non-array next page yields nothing", diffRepos(before, null).changed.length, 0);
  check("a non-array next page yields no newest", diffRepos(before, null).newest, null);

  // Two owners can hold the same repository name; identity is owner plus name.
  const nameClash = diffRepos(
    [row("app", "did:key:z1", T0 - 60_000)],
    [row("app", "did:key:z2", T0 - 60_000), row("app", "did:key:z1", T0 - 60_000)],
  );
  check("the same name under a different owner is a different repository", nameClash.added.length, 1);
  check("the clashing addition keeps its own owner", nameClash.added[0].owner, "did:key:z2");
  check("repoKey joins owner and name", repoKey("did:key:z1", "app"), "did:key:z1/app");

  // Unparseable timestamps must not sort to the top of the feed or count as
  // movement in either direction.
  const junk = diffRepos(
    [{ name: "x", owner: "d", updated_at: "not a date" }],
    [{ name: "x", owner: "d", updated_at: "still not a date" }, row("y", "d", T0)],
  );
  check("an unparseable timestamp is not an update", junk.updated.length, 0);
  check("a new row alongside it is still an addition", junk.added.length, 1);
  check("the dated row sorts above the undated one", junk.changed[0].name, "y");
  check("toMs rejects a non-date string", toMs("not a date"), null);
  check("toMs rejects an empty string", toMs(""), null);
  check("toMs passes a number through", toMs(T0), T0);
  check("toMs parses an ISO string", toMs(iso(T0)), T0);
}

// --- the poll decision ----------------------------------------------------
// This is what keeps an idle tab at 61 bytes per 30s instead of 4.8KB.
{
  const base = { statsAtLastFetch: STATS, lastReposFetchAt: T0 - 10 * 60_000, now: T0 };

  check("no previous repos page at all: fetch the baseline",
    shouldFetchRepos({ statsAtLastFetch: null, nextStats: STATS, lastReposFetchAt: null, now: T0 }), true);
  check("the baseline is fetched even though nothing moved",
    shouldFetchRepos({ statsAtLastFetch: STATS, nextStats: { ...STATS }, lastReposFetchAt: null, now: T0 }), true);

  check("counters unchanged: no repos fetch",
    shouldFetchRepos({ ...base, nextStats: { ...STATS } }), false);
  check("counters unchanged after an hour idle: still no repos fetch",
    shouldFetchRepos({ ...base, nextStats: { ...STATS }, lastReposFetchAt: T0 - 3_600_000 }), false);

  check("counters moved and the floor has passed: fetch",
    shouldFetchRepos({ ...base, nextStats: { ...STATS, pushes: 44070 } }), true);
  check("counters moved but inside the 60s floor: no fetch",
    shouldFetchRepos({ ...base, nextStats: { ...STATS, pushes: 44070 }, lastReposFetchAt: T0 - 30_000 }), false);
  check("counters moved exactly at the floor: fetch",
    shouldFetchRepos({ ...base, nextStats: { ...STATS, pushes: 44070 }, lastReposFetchAt: T0 - REPOS_MIN_INTERVAL_MS }), true);
  check("counters moved one millisecond inside the floor: no fetch",
    shouldFetchRepos({ ...base, nextStats: { ...STATS, pushes: 44070 }, lastReposFetchAt: T0 - REPOS_MIN_INTERVAL_MS + 1 }), false);

  check("a counter going backwards outside the floor still fetches",
    shouldFetchRepos({ ...base, nextStats: { ...STATS, pushes: 44060 } }), true);
  check("only the agent counter moving still fetches",
    shouldFetchRepos({ ...base, nextStats: { ...STATS, agents: 4089 } }), true);

  check("a rejected stats body never triggers a repos fetch",
    shouldFetchRepos({ ...base, nextStats: undefined }), false);
  check("a rejected stats body does not even trigger the baseline",
    shouldFetchRepos({ statsAtLastFetch: null, nextStats: undefined, lastReposFetchAt: null, now: T0 }), false);
  check("an error stats body never triggers a repos fetch",
    shouldFetchRepos({ ...base, nextStats: validatePayload("stats", { error: "not found" }).data }), false);
  check("no arguments at all is not a fetch", shouldFetchRepos(), false);

  // A burst that lands inside the floor is not lost. This one was found by
  // driving the real page against a scripted burst: the counter moved on the
  // poll 30s after the baseline, the floor held the fetch back, and comparing
  // the next poll against the poll before it (rather than against the counters
  // as of the last fetch) made the movement disappear. The panel then sat on
  // "the counters moved" with an empty list forever.
  check("a burst inside the floor is still fetched on the next poll",
    shouldFetchRepos({
      statsAtLastFetch: STATS,
      nextStats: { ...STATS, pushes: 44071 },
      lastReposFetchAt: T0 - REPOS_MIN_INTERVAL_MS,
      now: T0,
    }), true);
  check("a burst inside the floor is not fetched while the floor holds",
    shouldFetchRepos({
      statsAtLastFetch: STATS,
      nextStats: { ...STATS, pushes: 44071 },
      lastReposFetchAt: T0 - 30_000,
      now: T0,
    }), false);

  // The measured shape of the network, replayed: thirteen 30s intervals, the
  // counter moving in one of them and jumping by 2. A repos fetch on every poll
  // would be 13 x 4,722 bytes; the rule allows exactly one after the baseline.
  {
    let pushes = 44069;
    let atLastFetch = null;
    let lastFetch = null;
    let fetches = 0;
    for (let i = 0; i < 13; i++) {
      const now = T0 + i * POLL_MS;
      if (i === 7) pushes += 2;
      const next = { ...STATS, pushes };
      if (shouldFetchRepos({ statsAtLastFetch: atLastFetch, nextStats: next, lastReposFetchAt: lastFetch, now })) {
        fetches++;
        lastFetch = now;
        atLastFetch = next;
      }
    }
    check("a measured 7 minute idle window costs one baseline plus one change fetch", fetches, 2);
  }

  // The same window with the burst landing one poll after the baseline, where
  // the floor is still holding. It has to cost one more fetch, not zero more.
  {
    let pushes = 44069;
    let atLastFetch = null;
    let lastFetch = null;
    let fetches = 0;
    for (let i = 0; i < 6; i++) {
      const now = T0 + i * POLL_MS;
      if (i === 1) pushes += 2;
      const next = { ...STATS, pushes };
      if (shouldFetchRepos({ statsAtLastFetch: atLastFetch, nextStats: next, lastReposFetchAt: lastFetch, now })) {
        fetches++;
        lastFetch = now;
        atLastFetch = next;
      }
    }
    check("a burst 30s after the baseline is still fetched, once", fetches, 2);
  }
}

// --- ages -----------------------------------------------------------------
{
  check("zero seconds is just now", formatAge(T0, T0), "just now");
  check("one second is just now", formatAge(T0 - 1000, T0), "just now");
  check("59 seconds is just now", formatAge(T0 - 59_000, T0), "just now");
  check("59.999 seconds is just now", formatAge(T0 - 59_999, T0), "just now");
  check("exactly 60 seconds is one minute", formatAge(T0 - 60_000, T0), "1 minute ago");
  check("119 seconds is one minute", formatAge(T0 - 119_000, T0), "1 minute ago");
  check("two minutes is plural", formatAge(T0 - 120_000, T0), "2 minutes ago");
  // The case the whole readout exists for.
  check("six minutes of silence says so", formatAge(T0 - 6 * 60_000, T0), "6 minutes ago");
  check("59 minutes is still minutes", formatAge(T0 - 59 * 60_000, T0), "59 minutes ago");
  check("exactly 60 minutes is one hour", formatAge(T0 - 3_600_000, T0), "1 hour ago");
  check("90 minutes rounds down to one hour", formatAge(T0 - 90 * 60_000, T0), "1 hour ago");
  check("two hours is plural", formatAge(T0 - 2 * 3_600_000, T0), "2 hours ago");
  check("23 hours is still hours", formatAge(T0 - 23 * 3_600_000, T0), "23 hours ago");
  check("exactly 24 hours is one day", formatAge(T0 - 86_400_000, T0), "1 day ago");
  check("two days is plural", formatAge(T0 - 2 * 86_400_000, T0), "2 days ago");

  // Clock skew between the node and the browser. Never a negative age.
  check("a timestamp one second in the future is just now", formatAge(T0 + 1000, T0), "just now");
  check("a timestamp an hour in the future is just now", formatAge(T0 + 3_600_000, T0), "just now");
  check("an ISO timestamp works the same as a number", formatAge(iso(T0 - 4 * 60_000), T0), "4 minutes ago");

  check("no timestamp is unknown, not just now", formatAge(null, T0), "unknown");
  check("an undefined timestamp is unknown", formatAge(undefined, T0), "unknown");
  check("an unparseable timestamp is unknown", formatAge("soon", T0), "unknown");
  check("an unknown now is unknown", formatAge(T0, null), "unknown");
}

// --- backoff --------------------------------------------------------------
{
  check("no failures polls at the normal interval", nextBackoffMs(0), POLL_MS);
  check("the first failure waits one interval", nextBackoffMs(1), 30_000);
  check("the second failure doubles", nextBackoffMs(2), 60_000);
  check("the third failure doubles again", nextBackoffMs(3), 120_000);
  check("the fifth failure is capped", nextBackoffMs(5), MAX_BACKOFF_MS);
  check("a tab left open overnight still retries within the cap", nextBackoffMs(500), MAX_BACKOFF_MS);
  check("backoff never returns a non-number", Number.isFinite(nextBackoffMs(NaN)), true);
  check("backoff never returns zero", nextBackoffMs(-3) > 0, true);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
