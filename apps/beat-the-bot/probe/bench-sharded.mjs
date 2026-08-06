// Does splitting the nonce search across workers actually pay off?
//
// The browser will run N Web Workers, each striding a disjoint slice of the nonce
// space (worker k takes start=k, stride=N). node's worker_threads has the same
// shape, so this measures the real speedup rather than assuming it divides.
//
// Any satisfying nonce is valid, so the shards need no coordination beyond "first
// one to find it wins, everyone else stops."

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { randomBytes } from "node:crypto";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { solvePowFast } from "../lib/pow-fast.js";

const SELF = fileURLToPath(import.meta.url);

if (!isMainThread) {
  const { challenge, difficulty, start, stride } = workerData;
  // Search in slices so a shard that is not going to win can be cancelled
  // promptly instead of running its full budget.
  let cursor = start;
  const SLICE = 50_000;
  for (;;) {
    const r = solvePowFast(challenge, difficulty, { start: cursor, stride, budget: SLICE });
    if (r) { parentPort.postMessage(r.nonce); break; }
    cursor += SLICE * stride;
  }
} else {
  const solveSharded = (challenge, difficulty, n) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const workers = [];
      let done = false;
      for (let k = 0; k < n; k++) {
        const w = new Worker(SELF, { workerData: { challenge, difficulty, start: k, stride: n } });
        workers.push(w);
        w.on("message", (nonce) => {
          if (done) return;
          done = true;
          for (const x of workers) x.terminate();
          resolve({ nonce, ms: Date.now() - t0 });
        });
      }
    });

  const D = 20, RUNS = 15;
  const N = Math.max(1, cpus().length);
  console.log(`sharding across ${N} workers, ${RUNS} solves at difficulty ${D}\n`);

  const t = [];
  for (let r = 0; r < RUNS; r++) {
    const res = await solveSharded(randomBytes(12).toString("hex"), D, N);
    t.push(res.ms);
  }
  t.sort((a, b) => a - b);
  const p = (x) => t[Math.min(t.length - 1, Math.floor(t.length * x))];
  console.log(`mean ${Math.round(t.reduce((a, b) => a + b, 0) / t.length)}ms`);
  console.log(`p50  ${p(0.5)}ms`);
  console.log(`p90  ${p(0.9)}ms`);
  console.log(`max  ${t[t.length - 1]}ms`);
  console.log(`\n(includes worker spawn cost each run, which the browser pays once at page load)`);
  process.exit(0);
}
