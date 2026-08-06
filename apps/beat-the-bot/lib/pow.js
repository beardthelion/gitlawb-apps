// iCaptcha proof of work.
//
// Find a nonce such that sha256("{challenge}:{nonce}") has at least `difficulty`
// leading zero bits. Two details are load-bearing and neither is in the public
// iCaptcha repo: the nonce is lowercase hex, and the separator is a literal colon.
// Getting either wrong returns "proof-of-work missing or insufficient" with no hint.
// Reference implementation: gitlawb-audit/crates/icaptcha-client/src/pow.rs.

import { sha256 } from "./sha256.js";

export const ALGORITHM = "sha256-leading-zero-bits";

// 2^26 matches the Rust client's cap. A 20-bit target needs ~1M hashes on
// average, so this bounds the worst case if the service ever raises difficulty
// without us noticing, instead of hanging the tab.
const MAX_ITERS = 1 << 26;

const enc = new TextEncoder();

function leadingZeroBits(d) {
  let bits = 0;
  for (let i = 0; i < d.length; i++) {
    const b = d[i];
    if (b === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

/**
 * Solve a PoW challenge. Returns {nonce, iterations, ms}, or null if the
 * algorithm is unknown or the iteration cap is hit.
 *
 * `onProgress(iterations)` is called periodically so a UI can show the work
 * happening rather than freezing on a spinner.
 */
export function solvePow(pow, onProgress) {
  if (pow.algorithm !== ALGORITHM) return null;
  const started = Date.now();
  if (pow.difficulty === 0) return { nonce: "0", iterations: 0, ms: 0 };

  const prefix = pow.challenge + ":";
  for (let i = 0; i < MAX_ITERS; i++) {
    const nonce = i.toString(16);
    if (leadingZeroBits(sha256(enc.encode(prefix + nonce))) >= pow.difficulty) {
      return { nonce, iterations: i, ms: Date.now() - started };
    }
    if (onProgress && (i & 0x3ffff) === 0x3ffff) onProgress(i);
  }
  return null;
}
