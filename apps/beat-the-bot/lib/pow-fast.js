// Optimized iCaptcha PoW solver.
//
// The generic path (lib/pow.js + lib/sha256.js) measured ~554k hashes/sec, which
// puts a 20-bit solve at p50 2.0s and p90 5.1s on a server-class machine. That is
// too slow to sit between the player's answer and the grade.
//
// Two things dominated: a TextEncoder allocation per iteration, and re-zeroing a
// 128-byte buffer per iteration. This version specializes for the shape iCaptcha
// actually sends. The message is "{challengeId}:{nonceHex}", and a challenge id
// is 24 hex chars, so the message is always under 55 bytes and therefore always a
// single 64-byte block. That removes the multi-block loop, the padding recompute,
// and every allocation from the hot path.
//
// Correctness is checked against node's native crypto in probe/test-pow-fast.mjs.
// The generic implementation stays as the readable reference.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";
const W = new Uint32Array(64);
const MSG = new Uint8Array(64);

/**
 * Search nonces `start, start+stride, start+2*stride, ...` for one whose
 * sha256("{challenge}:{nonce}") has >= `difficulty` leading zero bits.
 *
 * Striding exists so N workers can split one search with no coordination: worker
 * k runs start=k, stride=N. Any satisfying nonce is valid, so the split needs no
 * agreement about who owns which range.
 *
 * Returns {nonce, iterations, ms} or null if `budget` iterations are exhausted.
 */
export function solvePowFast(challenge, difficulty, opts = {}) {
  const { start = 0, stride = 1, budget = 1 << 26, onProgress } = opts;
  const started = Date.now();

  // Only the first digest word is examined, so a difficulty past 32 would be
  // silently under-checked and mint an invalid nonce. Refuse instead. The
  // service uses 20; this is a guard against it changing under us.
  if (!(difficulty >= 0 && difficulty <= 32)) {
    throw new Error(`pow-fast: difficulty ${difficulty} out of supported range 0..32`);
  }

  // Constant prefix bytes, written once. Challenge ids are hex, so ASCII.
  const prefixLen = challenge.length + 1;
  if (prefixLen + 12 > 55) throw new Error("pow-fast: challenge too long for single-block path");
  for (let i = 0; i < challenge.length; i++) MSG[i] = challenge.charCodeAt(i);
  MSG[challenge.length] = 0x3a; // ':'

  let tried = 0;
  for (let n = start; tried < budget; n += stride, tried++) {
    // Write the nonce as lowercase hex, no allocation. Digits emit
    // most-significant first, matching Number.prototype.toString(16).
    let len = prefixLen;
    if (n === 0) {
      MSG[len++] = 0x30;
    } else {
      let shift = 28;
      while (shift >= 0 && ((n >>> shift) & 0xf) === 0) shift -= 4;
      for (; shift >= 0; shift -= 4) MSG[len++] = HEX.charCodeAt((n >>> shift) & 0xf);
    }

    // Padding: 0x80, zeros, then the 64-bit length. Only the bytes that can
    // change need clearing, so the whole buffer is never re-zeroed.
    MSG[len] = 0x80;
    for (let i = len + 1; i < 56; i++) MSG[i] = 0;
    const bitLen = len << 3;
    MSG[56] = 0; MSG[57] = 0; MSG[58] = 0; MSG[59] = 0;
    MSG[60] = (bitLen >>> 24) & 0xff;
    MSG[61] = (bitLen >>> 16) & 0xff;
    MSG[62] = (bitLen >>> 8) & 0xff;
    MSG[63] = bitLen & 0xff;

    for (let i = 0; i < 16; i++) {
      const j = i << 2;
      W[i] = (MSG[j] << 24) | (MSG[j + 1] << 16) | (MSG[j + 2] << 8) | MSG[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15];
      const y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }

    let a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
    let e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    // Only the first word of the digest is needed: 20 bits of zeros cannot reach
    // past it, and difficulty is capped at 32 for that reason.
    //
    // The shift is written as two steps because JS shift counts are taken mod 32,
    // so `h0 >>> 32` would evaluate to `h0` and difficulty 0 would never match
    // even though every nonce satisfies it.
    const h0 = (0x6a09e667 + a) | 0;
    if (difficulty === 0 || h0 >>> (32 - difficulty) === 0) {
      let nonce = "";
      for (let i = prefixLen; i < len; i++) nonce += String.fromCharCode(MSG[i]);
      return { nonce, iterations: tried, ms: Date.now() - started };
    }

    if (onProgress && (tried & 0x3ffff) === 0x3ffff) onProgress(tried);
  }
  return null;
}
