// Shape and invariant guard for the crawled snapshot.
//
//   node probe/test-snapshot.mjs [path]
//
// The snapshot is a positional-array format with no field names and no dates, so
// a wrong column or a lost sort is invisible by eye and would show up as a
// silently wrong time-lapse. Every property the page is allowed to assume is
// asserted here against the committed file, including the two the crawler builds
// rather than copies: the repo sort by creation day, and the owner ordering.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = process.argv[2] ?? join(HERE, "..", "web", "data", "snapshot.json");

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const s = JSON.parse(readFileSync(PATH, "utf8"));

// --- headline ------------------------------------------------------------
check("day_count is a positive integer", Number.isInteger(s.day_count) && s.day_count > 0, true);
check("generated_at parses", Number.isFinite(Date.parse(s.generated_at)), true);
check("day_base parses", Number.isFinite(Date.parse(s.day_base)), true);
check("day_base is not after generated_at", Date.parse(s.day_base) <= Date.parse(s.generated_at), true);

// --- repos ---------------------------------------------------------------
check("repo count over 3000", s.repos.length > 3000, true);
// The list is ordered by updated_at, so a push landing between page 1 and page 16
// can shuffle a row across a page boundary and cost or duplicate it. Five rows is
// the slack for that race; anything larger is a crawl bug, not concurrency.
check("repo count matches stats within 5", Math.abs(s.repos.length - s.stats.repos) <= 5, true);

check("every repo row has 6 elements", s.repos.every((r) => Array.isArray(r) && r.length === 6), true);
check("repo names are strings", s.repos.every((r) => typeof r[0] === "string"), true);
check("owner indexes are in range",
  s.repos.every((r) => Number.isInteger(r[1]) && r[1] >= 0 && r[1] < s.owners.length), true);
check("created day indexes are in range",
  s.repos.every((r) => Number.isInteger(r[2]) && r[2] >= 0 && r[2] < s.day_count), true);
check("updated day indexes are in range",
  s.repos.every((r) => Number.isInteger(r[3]) && r[3] >= 0 && r[3] < s.day_count), true);
check("star counts are non-negative", s.repos.every((r) => Number.isInteger(r[4]) && r[4] >= 0), true);
check("fork flags are 0 or 1", s.repos.every((r) => r[5] === 0 || r[5] === 1), true);

check("repos sorted ascending by created day",
  s.repos.every((r, i) => i === 0 || s.repos[i - 1][2] <= r[2]), true);

// --- owners --------------------------------------------------------------
check("owners are unique", new Set(s.owners).size, s.owners.length);
{
  const counts = new Array(s.owners.length).fill(0);
  for (const r of s.repos) counts[r[1]]++;
  check("every owner holds at least one repo", counts.every((n) => n > 0), true);
  check("owners ordered by repo count descending",
    counts.every((n, i) => i === 0 || counts[i - 1] >= n), true);
}

// --- agents --------------------------------------------------------------
check("agent total over 4000", s.agents.total > 4000, true);
check("agent total matches stats", s.agents.total, s.stats.agents);
check("daily registrations sum to the total",
  s.agents.daily.reduce((a, [, n]) => a + n, 0), s.agents.total);
check("daily day indexes ascending and unique",
  s.agents.daily.every(([d], i) => i === 0 || s.agents.daily[i - 1][0] < d), true);
check("daily day indexes in range",
  s.agents.daily.every(([d]) => Number.isInteger(d) && d >= 0 && d < s.day_count), true);
// The histogram is sparse by contract: a zero-count day would mean it was padded
// out, which would make the cumulative curve look like it stalls on days that
// simply are not in the data.
check("daily counts are all positive", s.agents.daily.every(([, n]) => Number.isInteger(n) && n > 0), true);
check("capability counts are positive", s.agents.capabilities.every(([c, n]) => typeof c === "string" && n > 0), true);
check("status counts sum to the total",
  s.agents.statuses.reduce((a, [, n]) => a + n, 0), s.agents.total);

// --- peers ---------------------------------------------------------------
check("peer rows length equals count", s.peers.rows.length, s.peers.count);
check("reachable does not exceed count", s.peers.reachable <= s.peers.count, true);
check("reachable matches the rows", s.peers.rows.filter((r) => r[1] === 1).length, s.peers.reachable);
check("peer rows have 3 elements", s.peers.rows.every((r) => r.length === 3 && typeof r[0] === "string"), true);
check("peer last-seen days are null or in range",
  s.peers.rows.every((r) => r[2] === null || (Number.isInteger(r[2]) && r[2] >= 0 && r[2] < s.day_count)), true);

// --- events --------------------------------------------------------------
check("events capped at 200", s.events.length <= 200, true);
check("event rows have 5 elements", s.events.every((e) => e.length === 5), true);
check("event create flags are 0 or 1", s.events.every((e) => e[3] === 0 || e[3] === 1), true);
check("pusher short ids are at most 8 chars", s.events.every((e) => e[1].length <= 8), true);
check("no duplicate repo+timestamp event",
  new Set(s.events.map((e) => `${e[0]}@${e[4]}`)).size, s.events.length);

console.log(fail === 0
  ? `\nall passed: ${s.repos.length} repos, ${s.owners.length} owners, ${s.agents.total} agents, ${s.peers.count} peers, ${s.events.length} events over ${s.day_count} days`
  : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
