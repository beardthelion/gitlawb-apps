// Pure-JS SHA-256. Needed because the iCaptcha proof of work wants ~1M hashes per
// solve and crypto.subtle.digest is async per call, which is far too slow at that
// volume. This runs in a Web Worker in the browser and directly in node.
//
// Returns the digest as bytes. The PoW only reads the leading bytes, so there is
// no hex encoding on the hot path.

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

// Scratch buffers reused across calls. The PoW loop calls this a million times,
// so allocating per call would dominate the runtime.
const W = new Uint32Array(64);
const H = new Uint32Array(8);
const BLOCK = new Uint8Array(128);
const OUT = new Uint8Array(32);

/**
 * SHA-256 of `bytes` (Uint8Array), written into a reused 32-byte buffer.
 * The returned array is overwritten by the next call. Copy it if you keep it.
 */
export function sha256(bytes) {
  const len = bytes.length;
  // Message must fit two blocks for our inputs (challenge id + ":" + nonce is
  // well under 64 bytes). Guard rather than silently truncate.
  if (len > 111) throw new Error("sha256: input too long for this fast path");

  const blocks = len + 9 > 64 ? 2 : 1;
  const total = blocks * 64;
  BLOCK.fill(0, 0, total);
  BLOCK.set(bytes, 0);
  BLOCK[len] = 0x80;
  const bitLen = len * 8;
  BLOCK[total - 4] = (bitLen >>> 24) & 0xff;
  BLOCK[total - 3] = (bitLen >>> 16) & 0xff;
  BLOCK[total - 2] = (bitLen >>> 8) & 0xff;
  BLOCK[total - 1] = bitLen & 0xff;

  H[0] = 0x6a09e667; H[1] = 0xbb67ae85; H[2] = 0x3c6ef372; H[3] = 0xa54ff53a;
  H[4] = 0x510e527f; H[5] = 0x9b05688c; H[6] = 0x1f83d9ab; H[7] = 0x5be0cd19;

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (BLOCK[j] << 24) | (BLOCK[j + 1] << 16) | (BLOCK[j + 2] << 8) | BLOCK[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15];
      const b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  for (let i = 0; i < 8; i++) {
    OUT[i * 4] = (H[i] >>> 24) & 0xff;
    OUT[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    OUT[i * 4 + 2] = (H[i] >>> 8) & 0xff;
    OUT[i * 4 + 3] = H[i] & 0xff;
  }
  return OUT;
}

/** Hex digest, for tests and debugging. Not on the PoW hot path. */
export function sha256hex(bytes) {
  const d = sha256(bytes);
  let s = "";
  for (let i = 0; i < 32; i++) s += d[i].toString(16).padStart(2, "0");
  return s;
}
