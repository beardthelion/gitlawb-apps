// The guard on the unattended daily refresh, run rather than reasoned.
//
//   node probe/test-snapshot-diff.mjs
//
// snapshot-diff.mjs is the only thing standing between a broken crawl and a
// committed, deployed, broken snapshot. Nobody is watching when it runs, so
// every branch is exercised here: the skip, the accept, and each way a candidate
// gets refused.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "snapshot-diff.mjs");
const DIR = mkdtempSync(join(tmpdir(), "snapdiff-"));

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const base = () => ({
  generated_at: "2026-08-07T03:35:26.299Z",
  day_base: "2026-03-12",
  day_count: 149,
  stats: { agents: 4088, pushes: 43736, repos: 3150, version: "0.7.0" },
  owners: ["did:key:z1", "did:key:z2"],
  repos: [["a", 0, 0, 0, 0, 0], ["b", 1, 1, 1, 0, 0]],
  agents: { total: 4088, daily: [[0, 4088]], capabilities: [], statuses: [] },
  peers: { count: 1, reachable: 1, rows: [["a.example", 1, 0]] },
  events: [],
});

// Returns { code, out, err } instead of throwing, because the exit code is the
// contract the workflow reads.
const run = (prev, next) => {
  const p = join(DIR, "prev.json");
  const n = join(DIR, "next.json");
  writeFileSync(p, JSON.stringify(prev));
  writeFileSync(n, JSON.stringify(next));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, p, n], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
};

const field = (out, key) => {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(out);
  return m ? m[1] : null;
};

// --- the skip ------------------------------------------------------------
// The common case: the crawl ran, nothing on the network moved, and only the
// timestamp is new. Committing this every day is the noise the job must not make.
{
  const prev = base();
  const next = base();
  next.generated_at = "2026-08-08T03:35:26.299Z";
  const r = run(prev, next);
  check("a timestamp-only difference exits 0", r.code, 0);
  check("a timestamp-only difference is not a change", field(r.out, "changed"), "false");
  // The summary is the commit-message body, so it must not describe a change
  // that the same output just said did not happen.
  check("an unchanged candidate has no change to summarise", field(r.out, "summary"), "unchanged");
}

// --- the accept ----------------------------------------------------------
{
  const prev = base();
  const next = base();
  next.generated_at = "2026-08-08T03:35:26.299Z";
  next.repos.push(["c", 0, 2, 2, 0, 0]);
  next.stats.repos = 3151;
  next.stats.pushes = 43800;
  next.day_count = 150;
  const r = run(prev, next);
  check("growth exits 0", r.code, 0);
  check("growth is a change", field(r.out, "changed"), "true");
  check("the summary names what moved", field(r.out, "summary"), "+1 repos, +64 pushes, +1 days");
}

// A content change with no count moving still has to commit: a repo renamed, a
// star count moved, a peer that stopped answering. Otherwise the page can sit on
// a stale mesh forever while the totals happen to hold still.
{
  const prev = base();
  const next = base();
  next.generated_at = "2026-08-08T03:35:26.299Z";
  next.peers.rows = [["a.example", 0, 1]];
  next.peers.reachable = 0;
  const r = run(prev, next);
  check("a content change with no count moving is a change", field(r.out, "changed"), "true");
  check("and it exits 0", r.code, 0);
}

// --- the refusals --------------------------------------------------------
// Each of these is a plausible bad crawl, not a hypothetical: a node restoring
// from backup, a paginated fetch that lost a page, an API that changed shape.
for (const [name, wreck] of [
  ["repos", (s) => { s.repos = [["a", 0, 0, 0, 0, 0]]; }],
  ["owners", (s) => { s.owners = ["did:key:z1"]; }],
  ["agents", (s) => { s.agents.total = 4000; }],
  ["pushes", (s) => { s.stats.pushes = 43000; }],
  ["days", (s) => { s.day_count = 148; }],
]) {
  const prev = base();
  const next = base();
  next.generated_at = "2026-08-08T03:35:26.299Z";
  wreck(next);
  const r = run(prev, next);
  check(`${name} going backwards exits nonzero`, r.code, 1);
  check(`${name} going backwards is refused, not committed`, field(r.out, "changed"), "false");
  check(`${name} going backwards says why`, /REGRESSION/.test(r.err), true);
}

// A moved day_base rewrites every day index in the file, so the whole history
// changes meaning at once. Growth alongside it must not launder it through.
{
  const prev = base();
  const next = base();
  next.generated_at = "2026-08-08T03:35:26.299Z";
  next.day_base = "2026-03-01";
  next.repos.push(["c", 0, 2, 2, 0, 0]);
  next.stats.pushes = 43800;
  const r = run(prev, next);
  check("a moved day_base is refused", r.code, 1);
  check("a moved day_base is refused even alongside growth", field(r.out, "changed"), "false");
}

// --- bad input -----------------------------------------------------------
// A crawl that half-wrote its output must not read as "nothing changed", which
// would silently skip the commit and look like a quiet day.
{
  const p = join(DIR, "prev.json");
  const n = join(DIR, "broken.json");
  writeFileSync(p, JSON.stringify(base()));
  writeFileSync(n, "{ not json");
  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT, p, n], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    code = err.status;
  }
  check("unparseable candidate exits 2, not 0", code, 2);
}
{
  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    code = err.status;
  }
  check("missing arguments exit 2", code, 2);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
