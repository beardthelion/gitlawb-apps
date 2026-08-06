// Correctness check for the pure-JS SHA-256 against node's native crypto, plus
// the two published test vectors. A wrong hash would show up as "PoW rejected"
// with no other signal, so this is worth having before anything else is built.

import { createHash, randomBytes } from "node:crypto";
import { sha256hex } from "../lib/sha256.js";
import { solvePow } from "../lib/pow.js";

const enc = new TextEncoder();
let fail = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      got  ${got}\n      want ${want}`);
}

check(
  'vector ""',
  sha256hex(enc.encode("")),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);
check(
  'vector "abc"',
  sha256hex(enc.encode("abc")),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);

// Random inputs across the length boundary where the message needs a second
// block (len + 9 > 64), which is the one place this implementation branches.
for (const len of [0, 1, 54, 55, 56, 63, 64, 65, 90, 111]) {
  const buf = randomBytes(len);
  check(
    `random len=${len}`,
    sha256hex(new Uint8Array(buf)),
    createHash("sha256").update(buf).digest("hex"),
  );
}

// Oversize input must throw rather than silently truncate.
try {
  sha256hex(new Uint8Array(112));
  check("len=112 throws", "no throw", "throws");
} catch {
  check("len=112 throws", "throws", "throws");
}

// A solved PoW must actually satisfy the difficulty, and the digest that proves
// it is recomputed with node's native crypto so the check does not rely on the
// implementation under test.
const chal = "670f4daec3ee42cf572d3654";
for (const difficulty of [8, 16, 20]) {
  const r = solvePow({ algorithm: "sha256-leading-zero-bits", challenge: chal, difficulty });
  const digest = createHash("sha256").update(`${chal}:${r.nonce}`).digest();
  let bits = 0;
  for (const b of digest) {
    if (b === 0) { bits += 8; continue; }
    bits += Math.clz32(b) - 24;
    break;
  }
  check(`pow difficulty=${difficulty} (nonce=${r.nonce}, ${r.iterations} iters)`,
    bits >= difficulty, true);
}

// Unknown algorithm must refuse rather than mis-solve.
check("unknown algorithm returns null",
  solvePow({ algorithm: "blake3-nonsense", challenge: chal, difficulty: 8 }), null);

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
