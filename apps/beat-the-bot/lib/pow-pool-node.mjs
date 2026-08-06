// Sharded proof-of-work for node, matching what the browser does.
//
// This exists for fairness, not speed. The page solves across N Web Workers, so a
// terminal runner solving on one thread would post a slower time for the same
// thinking. That would make the leaderboard partly a hardware benchmark. Both
// sides now stride the same nonce space across all available cores.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { solvePowFast } from "./pow-fast.js";

const SELF = fileURLToPath(import.meta.url);
const SLICE = 50_000;

if (!isMainThread && workerData?.powShard) {
  const { challenge, difficulty, start, stride } = workerData;
  let cursor = start;
  for (;;) {
    const r = solvePowFast(challenge, difficulty, { start: cursor, stride, budget: SLICE });
    if (r) { parentPort.postMessage(r.nonce); break; }
    cursor += SLICE * stride;
  }
}

/** Resolve to a valid nonce, searched across `n` threads. */
export function solveSharded(pow, n = Math.max(1, cpus().length)) {
  if (!pow) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const workers = [];
    let settled = false;
    for (let k = 0; k < n; k++) {
      const w = new Worker(SELF, {
        workerData: { powShard: true, challenge: pow.challenge, difficulty: pow.difficulty, start: k, stride: n },
      });
      workers.push(w);
      w.on("message", (nonce) => {
        if (settled) return;
        settled = true;
        for (const x of workers) x.terminate();
        resolve(nonce);
      });
      w.on("error", (err) => {
        if (settled) return;
        settled = true;
        for (const x of workers) x.terminate();
        reject(err);
      });
    }
  });
}
