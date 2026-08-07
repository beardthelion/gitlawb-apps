// Compare a freshly crawled snapshot against the committed one, and decide
// whether it is worth committing and safe to commit.
//
//   node probe/snapshot-diff.mjs <previous.json> <candidate.json>
//
// This exists because the daily refresh runs with nobody watching. Two things
// have to be decided without a human, and they are different questions.
//
// "Is it worth committing" is about noise. Every crawl writes a new
// generated_at, so a naive diff is never empty and the repo would collect a
// commit a day saying nothing happened. The network adds on the order of a
// dozen repos a day and some days none at all.
//
// "Is it safe to commit" is about damage. The counts here are creations that
// the node does not delete, so they can only rise. A snapshot that comes back
// smaller is a broken crawl (a node mid-restore, a truncated page, a changed
// API), and committing it would quietly replace a good snapshot with a worse
// one and deploy it. That is the failure this guard exists for, and it is worth
// more than the freshness the job buys.
//
// stdout carries key=value lines only, so a workflow can read it directly.
// Everything human goes to stderr.

import { readFileSync } from "node:fs";

const [prevPath, nextPath] = process.argv.slice(2);
if (!prevPath || !nextPath) {
  console.error("usage: snapshot-diff.mjs <previous.json> <candidate.json>");
  process.exit(2);
}

const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`cannot read ${p}: ${err.message}`);
    process.exit(2);
  }
};

const prev = read(prevPath);
const next = read(nextPath);

// Every count that can only go up. day_count is here too: it is measured from a
// fixed base to the crawl date, so it advances with the calendar even on a day
// the network is silent.
const MONOTONIC = [
  ["repos", (s) => s.repos?.length ?? 0],
  ["owners", (s) => s.owners?.length ?? 0],
  ["agents", (s) => s.agents?.total ?? 0],
  ["pushes", (s) => s.stats?.pushes ?? 0],
  ["days", (s) => s.day_count ?? 0],
];

let regressed = false;
const deltas = [];
for (const [name, of] of MONOTONIC) {
  const a = of(prev);
  const b = of(next);
  if (b < a) {
    console.error(`REGRESSION  ${name}: ${a} -> ${b}, a crawl cannot lose these`);
    regressed = true;
  } else if (b > a) {
    deltas.push(`+${b - a} ${name}`);
  }
}

// day_base moving means the crawler re-derived the whole day axis, so every day
// index in the file now means a different date. Not wrong on its own, but it
// rewrites the entire history rather than appending to it, so it is not a change
// to make unattended.
if (prev.day_base && next.day_base && prev.day_base !== next.day_base) {
  console.error(`REGRESSION  day_base moved ${prev.day_base} -> ${next.day_base}, every day index now means a different date`);
  regressed = true;
}

if (regressed) {
  console.log("changed=false");
  console.error("refusing the candidate; keeping the committed snapshot");
  process.exit(1);
}

// generated_at differs on every crawl by construction, so it is excluded from
// the comparison. If it were included, "changed" would always be true and the
// skip would never fire.
const strip = (s) => {
  const { generated_at, ...rest } = s;
  return JSON.stringify(rest);
};
const changed = strip(prev) !== strip(next);

// The summary describes the change, so it only means anything when there is
// one. Emitting the "no count moved" wording on an unchanged candidate reads as
// a contradiction next to changed=false, and it is the string that would end up
// in a commit message.
const summary = !changed
  ? "unchanged"
  : (deltas.length ? deltas.join(", ") : "content changed without a count moving");

console.log(`changed=${changed}`);
console.log(`summary=${summary}`);

console.error(changed
  ? `candidate accepted: ${deltas.length ? deltas.join(", ") : "no count moved, but the content did"}`
  : "candidate is identical apart from its timestamp, nothing to commit");
