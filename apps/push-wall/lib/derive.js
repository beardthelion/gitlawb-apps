// Derivations over the crawled snapshot. Pure, DOM-free, no fetch, no globals.
//
// The snapshot ships as positional arrays with integer day offsets (see
// probe/crawl.mjs), so every question the page asks ("how many repos existed on
// day 90", "who holds the most", "what does day 0 mean in real dates") needs a
// small amount of arithmetic first. That arithmetic lives here rather than in
// app.js because the time-lapse needs exactly the same numbers, and two copies
// of a cumulative series would eventually disagree by one.
//
// Everything below takes plain data and returns plain data. Nothing here formats
// markup; the caller decides how to put text on a page.

export const DAY_MS = 86_400_000;

// --- numbers, dates, identifiers -----------------------------------------

// Thousands separators, fixed locale. The page is one artifact showing one
// network's numbers, so a visitor's locale deciding whether 3,150 renders as
// 3.150 would only make the figures harder to compare with the API.
export function formatCount(n) {
  if (!Number.isFinite(n)) return "n/a";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// day_base is an ISO date string ("2026-03-12"), which Date.parse reads as UTC
// midnight. Returns null rather than an Invalid Date so callers can branch.
export function dayBaseMs(dayBase) {
  const t = Date.parse(dayBase);
  return Number.isFinite(t) ? t : null;
}

// Day index -> UTC midnight of that day. Index 0 is day_base itself.
export function dayDate(dayBase, dayIndex) {
  const base = dayBaseMs(dayBase);
  if (base === null || !Number.isFinite(dayIndex)) return null;
  return new Date(base + Math.round(dayIndex) * DAY_MS);
}

// "12 Mar 2026". Read in UTC, because the whole day axis is UTC-bucketed and a
// local-time render would slide every label by a day for half the world.
export function dayLabel(dayBase, dayIndex) {
  const d = dayDate(dayBase, dayIndex);
  if (!d) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "2026-08-07 03:35 UTC" from an RFC3339 timestamp.
export function formatUtc(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// DIDs are ~50 characters of base58 and there is no name behind them: the node's
// /api/v1/resolve endpoint only knows peer and node DIDs, not repo owners. So
// this shortens for display and nothing more. The tail is kept because the tail
// is what actually distinguishes two DIDs; the "did:key:z6Mk" prefix is shared
// by all of them.
export function truncateDid(did, head = 12, tail = 6) {
  const s = typeof did === "string" ? did : "";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// --- day series ----------------------------------------------------------

// Dense per-day counts of repos created, length dayCount, zeros included. The
// zeros matter: the snapshot's histograms are sparse, and a chart that skips
// absent days would compress quiet stretches and lie about the shape.
export function dailyNewRepos(repos, dayCount) {
  const n = Number.isInteger(dayCount) && dayCount > 0 ? dayCount : 0;
  const out = new Array(n).fill(0);
  if (!Array.isArray(repos)) return out;
  for (const r of repos) {
    const d = Array.isArray(r) ? r[2] : undefined;
    if (Number.isInteger(d) && d >= 0 && d < n) out[d]++;
  }
  return out;
}

// Same shape, from the [[dayIndex, count], ...] pairs the crawler writes for
// agent registrations.
export function dailyFromPairs(pairs, dayCount) {
  const n = Number.isInteger(dayCount) && dayCount > 0 ? dayCount : 0;
  const out = new Array(n).fill(0);
  if (!Array.isArray(pairs)) return out;
  for (const p of pairs) {
    if (!Array.isArray(p)) continue;
    const [d, c] = p;
    if (Number.isInteger(d) && d >= 0 && d < n && Number.isFinite(c)) out[d] += c;
  }
  return out;
}

// Running total. Non-decreasing by construction because every daily count is a
// non-negative arrival count, and the last element is the grand total.
export function cumulative(daily) {
  if (!Array.isArray(daily)) return [];
  const out = new Array(daily.length);
  let run = 0;
  for (let i = 0; i < daily.length; i++) {
    const v = Number.isFinite(daily[i]) ? daily[i] : 0;
    run += v;
    out[i] = run;
  }
  return out;
}

export const cumulativeRepos = (s) => cumulative(dailyNewRepos(s?.repos, s?.day_count));
export const cumulativeAgents = (s) => cumulative(dailyFromPairs(s?.agents?.daily, s?.day_count));

// The single biggest arrival day, for the one annotation the growth curve
// carries. Ties go to the earliest day, so the mark does not jump around
// between crawls when two days are level.
export function peakDay(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return null;
  let index = 0;
  let count = Number.isFinite(daily[0]) ? daily[0] : 0;
  for (let i = 1; i < daily.length; i++) {
    const v = Number.isFinite(daily[i]) ? daily[i] : 0;
    if (v > count) { index = i; count = v; }
  }
  if (count <= 0) return null;
  return { index, count };
}

// --- owners --------------------------------------------------------------

// Repo counts per owner index, then the top N as display-ready rows. The
// snapshot orders `owners` by count descending already, but the counts
// themselves are not stored, so they get recomputed here rather than assumed.
export function ownerCounts(snapshot) {
  const owners = Array.isArray(snapshot?.owners) ? snapshot.owners : [];
  const counts = new Array(owners.length).fill(0);
  for (const r of Array.isArray(snapshot?.repos) ? snapshot.repos : []) {
    const i = Array.isArray(r) ? r[1] : undefined;
    if (Number.isInteger(i) && i >= 0 && i < counts.length) counts[i]++;
  }
  return counts;
}

export function topOwners(snapshot, n = 12) {
  const owners = Array.isArray(snapshot?.owners) ? snapshot.owners : [];
  const counts = ownerCounts(snapshot);
  const total = counts.reduce((a, b) => a + b, 0);
  const rows = owners.map((did, i) => ({ did, count: counts[i] }));
  rows.sort((a, b) => b.count - a.count || (a.did < b.did ? -1 : 1));
  const top = rows.slice(0, Math.max(0, n));
  const max = top.length ? top[0].count : 0;
  return top.map((r) => ({
    did: r.did,
    short: truncateDid(r.did),
    count: r.count,
    // share of all repos, and width relative to the biggest holder. Two
    // different numbers: the bar is relative, the percentage is absolute.
    share: total > 0 ? r.count / total : 0,
    fraction: max > 0 ? r.count / max : 0,
  }));
}

// --- capabilities --------------------------------------------------------

// Top N capabilities plus a summary of the tail. Listing 27 strings where 21 of
// them are one-offs would bury the six that describe what these agents do.
export function topCapabilities(capabilities, n = 6) {
  const rows = (Array.isArray(capabilities) ? capabilities : [])
    .filter((c) => Array.isArray(c) && typeof c[0] === "string" && Number.isFinite(c[1]));
  const top = rows.slice(0, Math.max(0, n));
  const tail = rows.slice(Math.max(0, n));
  const max = top.length ? top[0][1] : 0;
  return {
    top: top.map(([name, count]) => ({
      name,
      count,
      fraction: max > 0 ? count / max : 0,
    })),
    tailKinds: tail.length,
    tailClaims: tail.reduce((a, c) => a + c[1], 0),
  };
}

// --- peers ---------------------------------------------------------------

// Reachable first, then by label, so the 16 that answer are not scattered
// through the 57 that do not.
export function sortedPeers(snapshot) {
  const rows = Array.isArray(snapshot?.peers?.rows) ? snapshot.peers.rows : [];
  return rows
    .map((r) => ({ label: String(r?.[0] ?? ""), reachable: r?.[1] === 1, lastSeenDay: r?.[2] ?? null }))
    .sort((a, b) => (b.reachable ? 1 : 0) - (a.reachable ? 1 : 0) || (a.label < b.label ? -1 : 1));
}

// --- events --------------------------------------------------------------

// Newest first, capped. The rows are gossip-received only, so this is a sample
// of what one node heard, never the network's push feed; the page has to say so
// and this function does not pretend otherwise.
//
// Runs of the same repo and ref collapse into one row carrying a count. The 200
// rows in the snapshot cover only 10 distinct repos, and one of them accounts
// for 163 of them, so an uncollapsed list is a dozen copies of the same line and
// says less about the network than four collapsed rows do. The count keeps it
// honest: nothing is dropped, it is summed.
export function recentEvents(snapshot, n = 12) {
  const rows = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const sorted = rows
    .map((e) => ({
      repo: String(e?.[0] ?? ""),
      pusher: String(e?.[1] ?? ""),
      ref: String(e?.[2] ?? ""),
      created: e?.[3] === 1,
      at: typeof e?.[4] === "string" ? e[4] : null,
      atMs: Date.parse(e?.[4] ?? "") || 0,
    }))
    .sort((a, b) => b.atMs - a.atMs);

  const out = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    // Deliberately consecutive-only. Merging across the whole list would hide
    // that a repo went quiet and came back, which is the one bit of shape this
    // feed actually carries.
    if (prev && prev.repo === e.repo && prev.ref === e.ref && prev.created === e.created) {
      prev.count++;
      prev.since = e.at;
      continue;
    }
    out.push({ ...e, count: 1, since: e.at });
  }
  return out.slice(0, Math.max(0, n));
}

// A repo id off the wire is "<owner-did>/<name>". Splitting it is display-only;
// both halves stay strings and are never interpreted.
export function splitRepoId(id) {
  const s = typeof id === "string" ? id : "";
  const i = s.indexOf("/");
  if (i < 0) return { owner: "", name: s };
  return { owner: s.slice(0, i), name: s.slice(i + 1) };
}
