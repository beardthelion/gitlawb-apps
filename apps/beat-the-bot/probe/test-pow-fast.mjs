// The optimized solver rewrote the hash loop, the nonce encoding, and the
// padding by hand. Any of those going subtly wrong produces a nonce the service
// rejects with no diagnostic, so every branch is checked here against node's
// native crypto rather than against the other JS implementation.

import { createHash, randomBytes } from "node:crypto";
import { solvePow } from "../lib/pow.js";
import { solvePowFast } from "../lib/pow-fast.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${got} want ${want}`}`);
};

const zeroBits = (buf) => {
  let bits = 0;
  for (const b of buf) {
    if (b === 0) { bits += 8; continue; }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
};
const verify = (challenge, nonce, difficulty) =>
  zeroBits(createHash("sha256").update(`${challenge}:${nonce}`).digest()) >= difficulty;

// 1. Solved nonces are genuinely valid, across difficulties and challenge ids.
for (const difficulty of [0, 1, 4, 8, 12, 16, 20]) {
  for (let t = 0; t < 3; t++) {
    const challenge = randomBytes(12).toString("hex");
    const r = solvePowFast(challenge, difficulty);
    check(`valid d=${difficulty} ${challenge.slice(0, 6)} nonce=${r.nonce}`,
      verify(challenge, r.nonce, difficulty), true);
  }
}

// 2. Same answer as the reference implementation when searching the same order.
//    Catches nonce-encoding drift, which is exactly the bug that cost an hour
//    against the live service.
for (let t = 0; t < 5; t++) {
  const challenge = randomBytes(12).toString("hex");
  const a = solvePow({ algorithm: "sha256-leading-zero-bits", challenge, difficulty: 16 });
  const b = solvePowFast(challenge, 16);
  check(`fast matches reference (${challenge.slice(0, 6)})`, b.nonce, a.nonce);
}

// 3. Nonce is lowercase hex with no leading zeros, matching Number.toString(16),
//    which is what the Rust client and therefore the service expect.
for (let t = 0; t < 200; t++) {
  const n = Math.floor(Math.random() * 0xfffffff);
  const challenge = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const r = solvePowFast(challenge, 0, { start: n });
  if (r.nonce !== n.toString(16)) {
    check(`nonce encoding n=${n}`, r.nonce, n.toString(16));
    break;
  }
}
check("nonce encoding across 200 values", true, true);

// 4. Striding: every shard finds a valid nonce, and shards disagree (they are
//    genuinely searching different space, not all returning the same answer).
{
  const challenge = randomBytes(12).toString("hex");
  const STRIDE = 4;
  const results = [];
  for (let k = 0; k < STRIDE; k++) {
    results.push(solvePowFast(challenge, 12, { start: k, stride: STRIDE }));
  }
  check("all shards valid", results.every((r) => r && verify(challenge, r.nonce, 12)), true);
  check("shards searched different space", new Set(results.map((r) => r.nonce)).size > 1, true);
}

// 5. Budget exhaustion returns null instead of looping or lying.
check("budget exhausted returns null",
  solvePowFast(randomBytes(12).toString("hex"), 28, { budget: 500 }), null);

// 6. Difficulty past what the single-word check can see must throw, not
//    silently mint an under-checked nonce.
for (const d of [33, 64, -1]) {
  let threw = false;
  try { solvePowFast("aaaaaaaaaaaaaaaaaaaaaaaa", d, { budget: 10 }); } catch { threw = true; }
  check(`difficulty ${d} throws`, threw, true);
}

// 7. An over-long challenge must throw rather than overflow the single block.
{
  let threw = false;
  try { solvePowFast("a".repeat(60), 8, { budget: 10 }); } catch { threw = true; }
  check("over-long challenge throws", threw, true);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
