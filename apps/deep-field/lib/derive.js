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
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
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

// --- repository names ----------------------------------------------------

// Repo names on this network are generated, and the same generated idea shows up
// many times with an instance marker bolted on: my-project, my-project2,
// e2e-20260318233658, guest-preview-preview-0aa3047e1f. Grouping on the stem is
// what makes the repetition visible at all.
//
// The whole value of the section this feeds is that it does not over-merge, so
// the rule is deliberately narrow: fold the case, then strip AT MOST ONE trailing
// suffix. Nothing splits on the first separator, which is what would collapse
// code-tutor and code-review into "code". Measured on the committed snapshot
// (3,150 repos): 1,597 families, 1,399 of them a single repo.
//
// The three transforms, each kept only because it earns its place on the real
// data:
//
//   case fold      merges 13 real pairs (hello-world/Hello-World, test/TEST,
//                  myProject/myproject) and merges nothing else.
//   hex suffix     -a1b2c3d4 style instance ids. Required to contain a digit,
//                  because [0-9a-f]{6,} with no digit also matches English words
//                  (facade, decade, deface). Costs nothing on this snapshot: all
//                  20 hits carry digits.
//   numeric suffix -1785947444, 2, -03, and the -v2 / -v4 version form, which is
//                  checked first so image-gen-v4 lands on image-gen rather than
//                  on the stray stem image-gen-v.
//
// One strip, not a loop. Looping would pull e2e-run2-20260318 down to e2e-run and
// covid19 down to covid, eating digits that are part of the name rather than an
// instance marker. So e2e-run2 stays its own family and does not join e2e's 25.
export function repoFamily(name) {
  const s = (typeof name === "string" ? name : "").trim().toLowerCase();
  // First match wins and returns, which is what makes this one strip rather than
  // two: e2e-run2-20260318 stops at e2e-run2 instead of falling through to
  // e2e-run.
  const hex = s.match(/^(.*[^-_.])[-_.]([0-9a-f]{6,})$/);
  if (hex && /\d/.test(hex[2])) return hex[1];
  // Non-greedy on the version branch so the `v` is consumed, greedy on the plain
  // branch so only the final run of digits goes. The plain branch also requires a
  // non-digit before the suffix, which is what leaves an all-digit name (a bare
  // 1785947444) and an empty name alone instead of reducing them to nothing.
  const m = s.match(/^(.+?)[-_.]v\d+$/) || s.match(/^(.*[^-_.\d])[-_.]?\d+$/);
  return m && m[1] ? m[1] : s;
}

// Every family, biggest first. Ties break on the family name so a snapshot
// refresh does not shuffle the rows around: 13 families are level at 17 on the
// current crawl, which is more than enough to make an unstable sort visible.
export function repoFamilies(snapshot) {
  const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : [];
  const counts = new Map();
  // Distinct owners per family, because the count on its own cannot tell the two
  // cases apart: code-tutor is 17 repos from 17 separate owners, while
  // guest-preview-preview is 17 from one, and the second is just one account's
  // tooling. Owners alone are not enough to call the first one convergence
  // though, which is what the day count below is for.
  const owners = new Map();
  // Distinct creation days per family, and this is the one that decides what the
  // section is allowed to claim. Measured on the current crawl: of the 81
  // families holding five or more repos, 65 appeared entirely on a single day.
  // volunteer-match, carbon-footprint, music-teacher, history-guide and
  // sleep-quality are 18 or 19 repos each from as many separate owners, and
  // every one of them was created on 13 Mar 2026. Separate owners on one day is
  // a batch, not agents independently arriving at the same idea. The families
  // that really do recur are the dull ones: my-first-repo spans 47 days.
  const days = new Map();
  for (const r of repos) {
    const key = repoFamily(Array.isArray(r) ? r[0] : "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(Array.isArray(r) ? r[1] : undefined);
    if (!days.has(key)) days.set(key, new Set());
    const d = Array.isArray(r) ? r[2] : undefined;
    if (Number.isInteger(d)) days.get(key).add(d);
  }
  const families = [...counts].map(([name, count]) => ({
    name, count, owners: owners.get(name).size, days: days.get(name).size,
  }));
  families.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  return {
    families,
    total: repos.length,
    familyCount: families.length,
    // A family of one is one repo, so this is both a family count and a repo
    // count. It is the shape of the network: most names occur exactly once.
    singletons: families.reduce((n, f) => n + (f.count === 1 ? 1 : 0), 0),
  };
}

// The top N as display rows, plus what is left over. The tail has to be reported
// rather than dropped: the interesting claim is that a few ideas repeat, and that
// only means something next to the size of the pile they repeat against.
export function topFamilies(snapshot, n = 12, repeatAt = 10) {
  const { families, total, familyCount, singletons } = repoFamilies(snapshot);
  const top = families.slice(0, Math.max(0, n));
  const tail = families.slice(Math.max(0, n));
  const max = top.length ? top[0].count : 0;
  return {
    top: top.map((f) => ({
      name: f.name,
      count: f.count,
      owners: f.owners,
      days: f.days,
      fraction: max > 0 ? f.count / max : 0,
    })),
    tailFamilies: tail.length,
    // Sums with the top counts back to `total`, by construction.
    tailRepos: tail.reduce((a, f) => a + f.count, 0),
    total,
    familyCount,
    singletons,
    // How many ideas got built repeatedly, at whatever bar the caller sets. 71
    // families reach 10 on the current snapshot and 36 reach 15, so the
    // repetition is not just the two onboarding names at the top.
    repeated: families.reduce((n2, f) => n2 + (f.count >= repeatAt ? 1 : 0), 0),
    repeatAt,
  };
}

// --- activity: weekday by hour -------------------------------------------

// Row order is getUTCDay() order, so index 0 is Sunday. Short forms because the
// row gutter of a 24 column grid is about three characters wide at 360px.
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const weekdayLabel = (d) => WEEKDAY_LABELS[d] ?? "";
export const weekdayName = (d) => WEEKDAY_NAMES[d] ?? "";

// "15:00". Always two digits and always UTC, since the grid has no other zone in
// it and a bare "15" next to a weekday reads as a date.
export function hourLabel(h) {
  if (!Number.isInteger(h) || h < 0 || h > 23) return "";
  return `${String(h).padStart(2, "0")}:00`;
}

// "2026-03-13T01" -> "13 Mar 2026, 01:00 UTC". The crawler writes the key as an
// hour-truncated ISO string, which Date.parse reads as UTC only once the minutes
// are back on it: "2026-03-13T01" alone is not a form Date.parse must accept.
export function batchLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(typeof key === "string" ? key : "");
  if (!m) return typeof key === "string" ? key : "";
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00Z`);
  if (!Number.isFinite(t)) return key;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${m[4]}:00 UTC`;
}

// Only a snapshot carrying a full 7x24 integer grid is usable. Anything else
// returns null so the caller can skip the section rather than render a lattice of
// NaN, which is the failure a heatmap hides best.
export function activityGrid(snapshot) {
  const g = snapshot?.activity?.grid;
  if (!Array.isArray(g) || g.length !== 7) return null;
  for (const row of g) {
    if (!Array.isArray(row) || row.length !== 24) return null;
    for (const v of row) if (!Number.isInteger(v) || v < 0) return null;
  }
  return g;
}

// Column sums: repos created in each hour of the day across every weekday.
export function hourTotals(grid) {
  const out = new Array(24).fill(0);
  if (!Array.isArray(grid)) return out;
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (let h = 0; h < 24; h++) if (Number.isFinite(row[h])) out[h] += row[h];
  }
  return out;
}

// Row sums, one per weekday, Sunday first.
export function weekdayTotals(grid) {
  if (!Array.isArray(grid)) return new Array(7).fill(0);
  return grid.map((row) => (Array.isArray(row) ? row.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0) : 0));
}

// Biggest and smallest cell. Ties go to the earliest weekday then the earliest
// hour, so a re-crawl does not move the annotation between two level cells.
export function gridExtremes(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return null;
  let peak = null;
  let trough = null;
  for (let d = 0; d < grid.length; d++) {
    const row = grid[d];
    if (!Array.isArray(row)) continue;
    for (let h = 0; h < row.length; h++) {
      const count = Number.isFinite(row[h]) ? row[h] : 0;
      if (!peak || count > peak.count) peak = { day: d, hour: h, count };
      if (!trough || count < trough.count) trough = { day: d, hour: h, count };
    }
  }
  return peak ? { peak, trough } : null;
}

// Largest and smallest entry of a series, as {index, value}. Used on the hour
// column sums, where the ratio between the two is the whole claim: the daily
// rhythm is only visible if the busy hours are a multiple of the quiet ones.
export function seriesExtremes(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[hi]) hi = i;
    if (values[i] < values[lo]) lo = i;
  }
  return {
    max: { index: hi, value: values[hi] },
    min: { index: lo, value: values[lo] },
    // 0 rather than Infinity on an empty trough, so the caller branches on a
    // number instead of printing "Infinity times".
    ratio: values[lo] > 0 ? values[hi] / values[lo] : 0,
  };
}

// Cell count -> a drawing intensity in 0..1, and the floor is the point. A linear
// count/max puts the median cell (11 against a peak of 48) at 0.23, which renders
// as almost nothing; sqrt lifts it to 0.48 without reordering any two cells,
// because sqrt is monotonic. An empty cell still gets 0, so absence stays visible
// as absence.
export function cellIntensity(count, max) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.sqrt(Math.min(count, max) / max);
}

// Everything the punchcard section prints, from the snapshot's activity block.
// Null when the snapshot predates the block or carries a malformed grid.
//
// weekday/weekend are means per day rather than totals, because there are five
// weekdays and two weekend days and the totals would show a gap that is mostly
// just the count of days.
export function activitySummary(snapshot) {
  const grid = activityGrid(snapshot);
  if (!grid) return null;
  const a = snapshot.activity;
  const hours = hourTotals(grid);
  const weekdays = weekdayTotals(grid);
  const cells = gridExtremes(grid);
  const hourSwing = seriesExtremes(hours);
  const batches = (Array.isArray(a.batches) ? a.batches : [])
    .filter((b) => Array.isArray(b) && typeof b[0] === "string" && Number.isInteger(b[1]));
  const workdaySum = weekdays[1] + weekdays[2] + weekdays[3] + weekdays[4] + weekdays[5];
  return {
    grid,
    hours,
    weekdays,
    max: cells ? cells.peak.count : 0,
    peakCell: cells ? cells.peak : null,
    troughCell: cells ? cells.trough : null,
    busiestHour: hourSwing ? { hour: hourSwing.max.index, count: hourSwing.max.value } : null,
    quietestHour: hourSwing ? { hour: hourSwing.min.index, count: hourSwing.min.value } : null,
    swing: hourSwing ? hourSwing.ratio : 0,
    weekdayMean: workdaySum / 5,
    weekendMean: (weekdays[0] + weekdays[6]) / 2,
    // How many of the 168 slots never saw a repository. The trough cell is a
    // tie among all of them once any cell is zero, so quoting the trough on its
    // own would present one arbitrary slot as if it were special.
    emptyCells: grid.reduce((n, row) => n + row.reduce((m, v) => m + (v === 0 ? 1 : 0), 0), 0),
    counted: Number.isInteger(a.counted) ? a.counted : 0,
    excluded: Number.isInteger(a.excluded) ? a.excluded : 0,
    batches,
  };
}

// Stars, forks, and repos never touched after the day they appeared.
//
// `updated` and `created` are day indexes, not timestamps (see crawl.mjs), so
// "untouched" here means no activity on a LATER day. A repo created and pushed to
// twice within its first day reads as untouched. That biases the number upward,
// and the direction matters when the page quotes it: the true never-touched-again
// count is at most this one. It was 1,050 of 3,150 on the committed snapshot.
export function repoActivity(snapshot) {
  const repos = Array.isArray(snapshot?.repos) ? snapshot.repos : [];
  let starred = 0;
  let forked = 0;
  let untouched = 0;
  for (const r of repos) {
    if (!Array.isArray(r)) continue;
    if (Number.isFinite(r[4]) && r[4] > 0) starred++;
    if (r[5] === 1) forked++;
    if (Number.isInteger(r[2]) && r[3] === r[2]) untouched++;
  }
  return { total: repos.length, starred, forked, untouched };
}
