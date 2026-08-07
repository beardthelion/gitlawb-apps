// Live mode's arithmetic and its decisions, kept away from the DOM.
//
// Nothing here fetches, draws, sets a timer, or reads the clock: every function
// that needs "now" is handed it. That is not tidiness for its own sake. The
// hard part of this feature is not drawing a dot, it is deciding whether an
// unchanged screen means a quiet network or a broken poll, and that decision is
// arithmetic over two responses and two timestamps. Arithmetic can be run in a
// test; a canvas polling a live node cannot.
//
// The numbers the rules below are built on, measured against node.gitlawb.com:
//
//   the push counter moves about 0.5/minute, but bursty: a 7 minute poll at 30s
//   intervals saw it move in 1 of 13 intervals, then jump by 2.
//   distinct repos touched: 2 in 15 minutes, 6 in an hour, 13 in a day.
//   GET /api/net/stats is 61 bytes. GET /api/net/repos?limit=30 is 4,722.
//
// So the common case, by a wide margin, is that nothing has happened. Six
// minutes of no events is normal and the page has to say so in a way that does
// not read as a hung request.

export const POLL_MS = 30_000;

// The whole reason the poll is split in two. Stats alone is 61 bytes, so an idle
// tab costs 61 bytes per 30s; repos is 77x that. Fetching repos only when the
// counters moved, and at most once a minute, keeps an idle tab at the small
// number without ever missing a change: the counters are what move first.
export const REPOS_MIN_INTERVAL_MS = 60_000;

export const MAX_BACKOFF_MS = 300_000;

/** Stable identity for a repository across polls. The node's own is owner+name. */
export function repoKey(owner, name) {
  return `${owner ?? ""}/${name ?? ""}`;
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// The proxy answers a denial or an upstream failure with {"error": "..."} and a
// 404/405/502/504. That body is JSON, and it is an object, and every field the
// page wanted is simply absent, so anything that reads it with `?? 0` renders a
// failed poll as a network where nothing is happening. Those two states have to
// stay distinguishable, so the error shape is checked before the payload shape
// and it is checked for every kind, including the ones whose success shape is
// not an object.
function errorReason(body) {
  if (!isObject(body)) return null;
  if (typeof body.error === "string" && body.error) return body.error;
  // An error key that is not a string is still not data.
  if ("error" in body) return "upstream error";
  return null;
}

const SHAPES = {
  // {agents, pushes, repos, version}. All three counters are required: a stats
  // body missing `pushes` cannot answer "did anything move", and treating the
  // gap as 0 would report a drop of 44,069 pushes.
  stats(body) {
    if (!isObject(body)) return "expected an object";
    for (const k of ["agents", "pushes", "repos"]) {
      if (!isNum(body[k])) return `missing or non-numeric ${k}`;
    }
    return null;
  },
  // An array of {name, owner, updated_at, stars}. A single unusable row is
  // dropped rather than failing the poll; a body that is not an array at all is
  // a different answer to a different question and is rejected.
  repos(body) {
    if (!Array.isArray(body)) return "expected an array of rows";
    return null;
  },
  peers(body) {
    if (!isObject(body)) return "expected an object";
    if (!Array.isArray(body.peers)) return "missing the peers array";
    return null;
  },
};

/**
 * Decide whether a parsed proxy body is usable data of `kind`.
 * Returns {ok:true, data} or {ok:false, reason}. Never throws.
 */
export function validatePayload(kind, body) {
  const shape = Object.prototype.hasOwnProperty.call(SHAPES, kind) ? SHAPES[kind] : null;
  if (!shape) return { ok: false, reason: `unknown payload kind ${kind}` };
  if (body === undefined || body === null) return { ok: false, reason: "empty response" };
  const err = errorReason(body);
  if (err) return { ok: false, reason: err };
  const bad = shape(body);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, data: kind === "repos" ? body.filter(isUsableRow) : body };
}

const isUsableRow = (r) => isObject(r) && typeof r.name === "string" && r.name !== "";

// --- counters -------------------------------------------------------------

/**
 * What moved between two validated stats bodies. `prev` is null on the first
 * poll, which is not a change: a first reading has nothing to be different from,
 * and reporting 44,069 new pushes on page load would be a lie.
 *
 * Deltas never go negative. The counter can drop for reasons that are not the
 * network losing pushes (a node restore, a replica behind the one polled a
 * moment ago), and "-3 pushes" on screen reads as a bug in the page. The drop is
 * still reported through `backwards` so the caller can treat it as an event
 * rather than silently showing nothing.
 */
export function diffStats(prev, next) {
  const zero = { pushes: 0, repos: 0, agents: 0, moved: false, backwards: false, first: !prev };
  if (!isObject(next)) return { ...zero, first: false };
  if (!isObject(prev)) return zero;
  let moved = false;
  let backwards = false;
  const out = { pushes: 0, repos: 0, agents: 0, moved: false, backwards: false, first: false };
  for (const k of ["pushes", "repos", "agents"]) {
    const a = isNum(prev[k]) ? prev[k] : null;
    const b = isNum(next[k]) ? next[k] : null;
    if (a === null || b === null) continue;
    if (b !== a) moved = true;
    if (b < a) backwards = true;
    out[k] = Math.max(0, b - a);
  }
  out.moved = moved;
  out.backwards = backwards;
  return out;
}

// --- repositories ---------------------------------------------------------

// The node sends ISO timestamps. Anything unparseable is treated as no
// timestamp, which keeps a garbage row from sorting to the top of the feed.
export function toMs(v) {
  if (isNum(v)) return v;
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const rowsByKey = (rows) => {
  const m = new Map();
  if (!Array.isArray(rows)) return m;
  for (const r of rows) {
    if (!isUsableRow(r)) continue;
    m.set(repoKey(r.owner, r.name), { row: r, at: toMs(r.updated_at) });
  }
  return m;
};

/**
 * Which repositories moved between two validated repos pages, newest first.
 *
 * `prev` null means this is the baseline fetch. Everything in the response is
 * "new to this page" and none of it is new to the network, so the change list is
 * empty. Without that case the first live frame would drop thirty dots and claim
 * thirty pushes that happened over the previous day and a half.
 *
 * A timestamp that went backwards is not an update. Upstream clock skew and a
 * node restored from a backup both produce it, and both would otherwise show as
 * activity that did not happen.
 */
export function diffRepos(prev, next) {
  const nextMap = rowsByKey(next);
  let newest = null;
  for (const { at } of nextMap.values()) {
    if (at !== null && (newest === null || at > newest)) newest = at;
  }

  if (!Array.isArray(prev)) {
    return { added: [], updated: [], changed: [], newest, baseline: true };
  }

  const prevMap = rowsByKey(prev);
  const added = [];
  const updated = [];
  for (const [key, { row, at }] of nextMap) {
    const before = prevMap.get(key);
    const entry = { key, name: row.name, owner: row.owner ?? null, at, isNew: !before };
    if (!before) {
      added.push(entry);
      continue;
    }
    if (at === null || before.at === null) continue;
    if (at > before.at) updated.push(entry);
  }

  // Newest first. Rows with no usable timestamp sort last, then by key, so the
  // order is the same on every machine and every run.
  const byRecency = (a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  added.sort(byRecency);
  updated.sort(byRecency);
  return { added, updated, changed: [...added, ...updated].sort(byRecency), newest, baseline: false };
}

// --- the poll decision ----------------------------------------------------

/**
 * Whether this poll should also pull the 4.7KB repos page.
 *
 * Two rules and one exception. Only fetch when a counter moved, because when
 * nothing moved there is by construction nothing new to list. Never more often
 * than REPOS_MIN_INTERVAL_MS, because a burst (the counter jumping by 2 after
 * twelve still intervals) would otherwise pull the page on consecutive polls for
 * one event. The exception is the baseline: with no previous repos page there is
 * nothing to diff against and no last-event time to show, so the first one is
 * fetched unconditionally. It happens once per live session.
 *
 * `statsAtLastFetch` is the counters as they read when the repos page was last
 * pulled, NOT the previous poll's. Comparing against the previous poll drops
 * events: the counter jumps during the floor window, the next poll finds it
 * equal to the one before it, and the repositories behind the jump are never
 * fetched. Driven in a browser against a scripted burst, that is exactly what
 * happened, and the panel sat on "the counters moved" forever.
 */
export function shouldFetchRepos({
  statsAtLastFetch = null,
  nextStats = null,
  lastReposFetchAt = null,
  now = 0,
  minIntervalMs = REPOS_MIN_INTERVAL_MS,
} = {}) {
  if (!isObject(nextStats)) return false;
  if (!isNum(lastReposFetchAt)) return true;
  if (now - lastReposFetchAt < minIntervalMs) return false;
  return diffStats(statsAtLastFetch, nextStats).moved;
}

// --- ages -----------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "just now", "4 minutes ago", "2 hours ago". This is the sentence that makes a
 * quiet network legible: a page showing 44,069 pushes and nothing else cannot be
 * told apart from a page whose poll died, and "last event 6 minutes ago" can.
 *
 * A timestamp in the future reads as "just now" rather than as a negative age.
 * The node's clock and the browser's are not the same clock, and a couple of
 * seconds of skew is normal.
 */
export function formatAge(ts, now) {
  const t = toMs(ts);
  if (t === null || !isNum(now)) return "unknown";
  const d = Math.max(0, now - t);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${plural(Math.floor(d / MINUTE), "minute")} ago`;
  if (d < DAY) return `${plural(Math.floor(d / HOUR), "hour")} ago`;
  return `${plural(Math.floor(d / DAY), "day")} ago`;
}

/**
 * How long to wait after a failed poll. Doubling from the normal interval and
 * capped at five minutes: a node that is down must not receive one request per
 * 30 seconds per open tab, and a tab left open overnight against a dead node
 * must still notice within five minutes when it comes back.
 */
export function nextBackoffMs(failures, base = POLL_MS, max = MAX_BACKOFF_MS) {
  if (!isNum(failures) || failures <= 0) return base;
  const n = Math.min(Math.floor(failures), 20);
  return Math.min(max, base * 2 ** (n - 1));
}
