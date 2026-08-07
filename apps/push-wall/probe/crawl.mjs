// Crawl node.gitlawb.com once and write the whole network as a single snapshot.
//
//   node probe/crawl.mjs [--out path] [--base url]
//
// This is a build-time crawl rather than a browser fetch for two measured
// reasons: the node sends no CORS headers at all, and /api/v1/agents ignores
// limit/offset and answers with every agent in one ~960KB response. Both of
// those are fine on a server and unacceptable on a page load.
//
// The output is deliberately ugly to read and cheap to ship. Repos are positional
// arrays, not objects, and dates are integer day offsets from day_base, so the
// page can bucket 3,150 repos into a time-lapse without parsing 3,150 RFC3339
// strings in the main thread.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, "..", "web", "data", "snapshot.json");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = arg("--base", "https://node.gitlawb.com").replace(/\/+$/, "");
const OUT = arg("--out", DEFAULT_OUT);

const PAGE = 200;          // the repos endpoint clamps limit here regardless of what we ask
const MAX_PAGES = 100;     // a server that ignored offset would otherwise loop forever
const TIMEOUT_MS = 30_000; // the agents payload is ~960KB, so this is not a generous budget
const DAY_MS = 86_400_000;

// One retry, then give up loudly. A snapshot that is missing a page of repos but
// still reports stats.repos = 3150 is worse than no snapshot, so every caller
// below treats a throw here as fatal.
async function getJson(path) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`GET ${path} failed twice: ${lastErr?.message ?? lastErr}`);
}

const die = (err) => { console.error(`crawl failed: ${err?.message ?? err}`); process.exit(1); };

// Timestamps arrive as RFC3339 with nanosecond precision (...695429908+00:00).
// Date accepts them and truncates to milliseconds, which is confirmed rather
// than assumed; anything unparseable comes back null so callers can decide.
const ms = (s) => {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const utcMidnight = (t) => Math.floor(t / DAY_MS) * DAY_MS;
const isoDay = (t) => new Date(utcMidnight(t)).toISOString().slice(0, 10);

// --- crawl ---------------------------------------------------------------

console.log(`crawling ${BASE}`);

const stats = await getJson("/api/v1/stats").catch(die);
if (!stats || typeof stats.repos !== "number") die("stats did not return a repo count");
console.log(`  stats: ${stats.repos} repos, ${stats.agents} agents, ${stats.pushes} pushes, v${stats.version}`);

// The repo list is ordered by updated_at descending, so a push landing mid-crawl
// reshuffles the pages under us and can duplicate or skip a row. Dedupe by id and
// report the drift rather than pretending the count is exact.
const byId = new Map();
let pages = 0;
let complete = false;
for (let offset = 0; pages < MAX_PAGES; offset += PAGE) {
  const rows = await getJson(`/api/v1/repos?limit=${PAGE}&offset=${offset}`).catch(die);
  if (!Array.isArray(rows)) die(`repos offset=${offset} did not return an array`);
  pages++;
  for (const r of rows) if (r && r.id) byId.set(r.id, r);
  if (rows.length < PAGE || byId.size >= stats.repos) { complete = true; break; }
}
if (!complete) die(`hit the ${MAX_PAGES} page cap; offset is probably being ignored`);
const repoRows = [...byId.values()];
console.log(`  repos: ${repoRows.length} unique over ${pages} pages`);
if (repoRows.length !== stats.repos) {
  console.log(`  note: ${repoRows.length} crawled vs ${stats.repos} in stats (drift ${repoRows.length - stats.repos})`);
}

const agentsBody = await getJson("/api/v1/agents").catch(die);
const agentRows = Array.isArray(agentsBody?.agents) ? agentsBody.agents : [];
if (!agentRows.length) die("agents endpoint returned no rows");
console.log(`  agents: ${agentRows.length}`);

const peersBody = await getJson("/api/v1/peers").catch(die);
const peerRows = Array.isArray(peersBody?.peers) ? peersBody.peers : [];
console.log(`  peers: ${peerRows.length}`);

const eventsBody = await getJson("/api/v1/events/ref-updates?limit=200").catch(die);
const rawEvents = Array.isArray(eventsBody?.events) ? eventsBody.events : [];
console.log(`  events: ${rawEvents.length} raw`);

// --- day base ------------------------------------------------------------

const repoCreated = repoRows.map((r) => ms(r.created_at)).filter((t) => t !== null);
if (!repoCreated.length) die("no repo carried a parseable created_at");

// The first agent registered 15 minutes before the first repo existed, on the
// same UTC day, so today a repo-only day axis happens to work. That is luck, not
// a property: any agent or peer timestamp landing a day earlier would push its
// index negative. Everything that can produce a day index folds into the minimum
// instead of being clamped, and the crawl says so when the base moves.
const agentRegistered = agentRows.map((a) => ms(a.registered_at)).filter((t) => t !== null);
const peerSeen = peerRows.map((p) => ms(p.last_seen)).filter((t) => t !== null);
const earliestRepo = Math.min(...repoCreated);
const baseMs = utcMidnight(Math.min(earliestRepo, ...agentRegistered, ...peerSeen));
if (baseMs !== utcMidnight(earliestRepo)) {
  console.log(`  day_base pulled back to ${isoDay(baseMs)} (earliest repo is ${isoDay(earliestRepo)})`);
}

const generatedAt = Date.now();
const dayCount = Math.floor((utcMidnight(generatedAt) - baseMs) / DAY_MS) + 1;
const dayIdx = (t) => Math.floor((utcMidnight(t) - baseMs) / DAY_MS);

// --- owners --------------------------------------------------------------

// Ordered by repo count descending so the page can slice the top N owners
// straight off the front without counting anything itself.
const ownerCounts = new Map();
for (const r of repoRows) ownerCounts.set(r.owner_did, (ownerCounts.get(r.owner_did) ?? 0) + 1);
const owners = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([did]) => did);
const ownerIndex = new Map(owners.map((did, i) => [did, i]));

// --- repos ---------------------------------------------------------------

// Sorted by creation day so the time-lapse walks the array in order and never
// has to sort 3,150 rows in the browser.
const repos = repoRows
  .map((r) => {
    const created = ms(r.created_at);
    const updated = ms(r.updated_at) ?? created;
    return [
      String(r.name ?? ""),
      ownerIndex.get(r.owner_did) ?? 0,
      dayIdx(created),
      dayIdx(updated),
      Number(r.star_count) || 0,
      r.forked_from ? 1 : 0,
    ];
  })
  .sort((a, b) => a[2] - b[2]);

// --- agents --------------------------------------------------------------

const dailyMap = new Map();
const capMap = new Map();
const statusMap = new Map();
for (const a of agentRows) {
  const t = ms(a.registered_at);
  if (t !== null) {
    const d = dayIdx(t);
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
  }
  for (const c of Array.isArray(a.capabilities) ? a.capabilities : []) {
    capMap.set(c, (capMap.get(c) ?? 0) + 1);
  }
  const s = a.status ?? "unknown";
  statusMap.set(s, (statusMap.get(s) ?? 0) + 1);
}
const byCountDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

// --- peers ---------------------------------------------------------------

// A peer with a missing or malformed http_url still counts toward the mesh, so
// it keeps its row and falls back to a truncated DID as its label.
const peers = peerRows.map((p) => {
  let label;
  try { label = new URL(p.http_url).hostname; } catch { label = String(p.did ?? "unknown").slice(-12); }
  const seen = ms(p.last_seen);
  return [label, p.reachable ? 1 : 0, seen === null ? null : dayIdx(seen)];
});

// --- events --------------------------------------------------------------

// Gossip can deliver the same push more than once, so dedupe on the event id
// before anything downstream counts these as distinct pushes.
const seenIds = new Set();
const events = [];
for (const e of rawEvents) {
  if (e?.id && seenIds.has(e.id)) continue;
  if (e?.id) seenIds.add(e.id);
  const t = ms(e.timestamp) ?? ms(e.received_at);
  events.push([
    String(e.repo ?? ""),
    String(e.pusher_did ?? "").slice(-8),
    String(e.ref_name ?? ""),
    /^0+$/.test(String(e.old_sha ?? "")) ? 1 : 0,
    t === null ? null : new Date(t).toISOString(),
  ]);
}

// --- write ---------------------------------------------------------------

const snapshot = {
  generated_at: new Date(generatedAt).toISOString(),
  source: BASE,
  day_base: isoDay(baseMs),
  day_count: dayCount,
  stats: { agents: stats.agents, pushes: stats.pushes, repos: stats.repos, version: stats.version },
  owners,
  repos,
  agents: {
    total: agentRows.length,
    daily: [...dailyMap.entries()].sort((a, b) => a[0] - b[0]),
    capabilities: byCountDesc(capMap),
    statuses: byCountDesc(statusMap),
  },
  peers: {
    count: peerRows.length,
    reachable: peerRows.filter((p) => p.reachable).length,
    rows: peers,
  },
  events,
};

// No indentation: this file ships to the browser. Trailing newline so it behaves
// in a text editor and in git.
mkdirSync(dirname(OUT), { recursive: true });
const body = JSON.stringify(snapshot) + "\n";
writeFileSync(OUT, body);

console.log(`\nwrote ${OUT}`);
console.log(`  ${repos.length} repos, ${owners.length} owners, ${snapshot.agents.total} agents, ` +
  `${snapshot.peers.count} peers (${snapshot.peers.reachable} reachable), ${events.length} events`);
console.log(`  day_base ${snapshot.day_base}, day_count ${dayCount}, ${body.length} bytes`);
