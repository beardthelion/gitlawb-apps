// How long does one iCaptcha proof of work take with the pure-JS hasher?
//
// This decides whether the browser design works. 20 leading zero bits means ~1M
// hashes on average, and the solve sits between the player answering and the
// service grading, so it is dead time in the run. Budget: under ~2s typical.
//
// The distribution matters more than the mean: solve time is geometric, so the
// tail is long. p90 is what a player actually feels.

import { sha256 } from "../lib/sha256.js";
import { solvePow } from "../lib/pow.js";

const enc = new TextEncoder();
const DIFFICULTY = 20;
const RUNS = 25;

// Raw throughput.
{
  const N = 300_000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) sha256(enc.encode(`bench:${i.toString(16)}`));
  const ms = Date.now() - t0;
  console.log(`throughput: ${Math.round(N / (ms / 1000)).toLocaleString()} hashes/sec`);
}

// Real solves against distinct challenge ids, since a fixed id would reuse one
// lucky (or unlucky) nonce and hide the variance entirely.
const times = [];
const iters = [];
for (let r = 0; r < RUNS; r++) {
  const challenge = `bench${r}${Math.random().toString(16).slice(2, 10)}`;
  const res = solvePow({ algorithm: "sha256-leading-zero-bits", challenge, difficulty: DIFFICULTY });
  times.push(res.ms);
  iters.push(res.iterations);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
const mean = times.reduce((a, b) => a + b, 0) / times.length;

console.log(`\n${RUNS} solves at difficulty ${DIFFICULTY}:`);
console.log(`  mean   ${Math.round(mean)} ms`);
console.log(`  p50    ${pct(0.5)} ms`);
console.log(`  p90    ${pct(0.9)} ms`);
console.log(`  max    ${times[times.length - 1]} ms`);
console.log(`  iterations mean ${Math.round(iters.reduce((a, b) => a + b, 0) / iters.length).toLocaleString()}`);
console.log(`\nnode ${process.version}. A browser on the same machine runs the same V8,`);
console.log(`so treat this as a floor: Safari and Firefox, and any phone, will be slower.`);
