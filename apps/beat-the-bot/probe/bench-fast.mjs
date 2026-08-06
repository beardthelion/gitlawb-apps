import { solvePowFast } from "../lib/pow-fast.js";
import { randomBytes } from "node:crypto";
const D = 20, RUNS = 25;
{
  const N = 1_000_000, t0 = Date.now();
  solvePowFast("aaaaaaaaaaaaaaaaaaaaaaaa", 32, { budget: N });
  const ms = Date.now() - t0;
  console.log(`throughput: ${Math.round(N / (ms / 1000)).toLocaleString()} hashes/sec`);
}
const t = [];
for (let r = 0; r < RUNS; r++) t.push(solvePowFast(randomBytes(12).toString("hex"), D).ms);
t.sort((a, b) => a - b);
const p = (x) => t[Math.min(t.length - 1, Math.floor(t.length * x))];
console.log(`single thread d=${D}: mean ${Math.round(t.reduce((a,b)=>a+b,0)/t.length)}ms  p50 ${p(0.5)}ms  p90 ${p(0.9)}ms  max ${t[t.length-1]}ms`);
console.log(`cores available: ${(await import("node:os")).cpus().length}`);
