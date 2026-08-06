// Verification of iCaptcha proofs.
//
// A proof is "<base64url(claims)>.<base64url(ed25519 signature over the claims
// bytes)>", signed by the key published at /v1/pubkey as a JWKS. Verified here
// rather than by calling the service's /v1/verify-proof so that a leaderboard
// submission costs one local signature check instead of a network round trip per
// proof, and so the check cannot be skipped by an upstream outage.

const DEFAULT_UPSTREAM = "https://icaptcha.gitlawb.com";

let cachedKey = null;
let cachedAt = 0;
const KEY_TTL_MS = 60 * 60 * 1000;

const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function getVerifyKey(upstream = DEFAULT_UPSTREAM) {
  if (cachedKey && Date.now() - cachedAt < KEY_TTL_MS) return cachedKey;
  const res = await fetch(`${upstream}/v1/pubkey`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`pubkey fetch failed: ${res.status}`);
  const jwks = await res.json();
  const jwk = jwks?.keys?.find((k) => k.crv === "Ed25519" && k.x);
  if (!jwk) throw new Error("no Ed25519 key in JWKS");
  cachedKey = await crypto.subtle.importKey(
    "raw", b64urlToBytes(jwk.x), { name: "Ed25519" }, false, ["verify"],
  );
  cachedAt = Date.now();
  return cachedKey;
}

/** Testing seam: drop the cached key so a test can swap the upstream. */
export function resetKeyCache() {
  cachedKey = null;
  cachedAt = 0;
}

/**
 * Verify one proof. Returns its claims, or null if the signature is bad or the
 * token is malformed. Does NOT check sub/level/time; that is the caller's policy
 * and lives in leaderboard.js.
 */
export async function verifyProof(proof, key) {
  if (typeof proof !== "string") return null;
  const parts = proof.split(".");
  if (parts.length !== 2) return null;
  const [head, sig] = parts;

  let ok;
  try {
    ok = await crypto.subtle.verify(
      { name: "Ed25519" }, key, b64urlToBytes(sig), new TextEncoder().encode(head),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(head)));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}
