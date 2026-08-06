// One shard of the proof-of-work search.
//
// Searches nonces start, start+stride, start+2*stride, ... in slices so it can
// report progress and so the main thread can kill it promptly when another shard
// wins. Any satisfying nonce is valid, so shards need no coordination.

// Path is relative to this file's served URL (/beat-the-bot/pow-worker.js), so
// "../lib/" would escape the mount and 404. See the lib mount in dev-server.mjs
// and the dist/ layout that build.mjs produces.
import { solvePowFast } from "./lib/pow-fast.js";

const SLICE = 50_000;

self.onmessage = (e) => {
  const { challenge, difficulty, start, stride } = e.data;
  let cursor = start;
  let searched = 0;

  for (;;) {
    const found = solvePowFast(challenge, difficulty, {
      start: cursor,
      stride,
      budget: SLICE,
    });
    if (found) {
      self.postMessage({ type: "solved", nonce: found.nonce, searched: searched + found.iterations });
      return;
    }
    searched += SLICE;
    cursor += SLICE * stride;
    self.postMessage({ type: "progress", searched });
  }
};
