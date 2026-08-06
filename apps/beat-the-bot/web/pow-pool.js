// Pool of proof-of-work workers.
//
// The whole point of solving in a pool, and of starting the moment a challenge
// arrives rather than when the player submits, is that the work overlaps with the
// player reading and typing. Measured single-threaded p90 is 2.0s and 4-way is
// 468ms, but if the solve starts ~5 seconds before the player hits enter, the
// perceived cost is zero either way.

const WORKER_URL = new URL("./pow-worker.js", import.meta.url);

export class PowPool {
  constructor(size) {
    // navigator.hardwareConcurrency lies on some browsers (Safari reports a
    // capped value) and is absent on others. Clamp rather than trust it.
    const cores = Number(navigator.hardwareConcurrency) || 4;
    this.size = size ?? Math.max(2, Math.min(8, cores));
    this.workers = [];
    this.active = null;
  }

  #spawn() {
    this.#killAll();
    for (let i = 0; i < this.size; i++) {
      this.workers.push(new Worker(WORKER_URL, { type: "module" }));
    }
  }

  #killAll() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  /**
   * Solve a PoW challenge. Returns a promise for {nonce, ms, searched}.
   * Calling this again cancels any solve still in flight.
   *
   * `onProgress(hashes)` reports total hashes searched across all shards.
   */
  solve(pow, onProgress) {
    this.cancel();
    const started = performance.now();
    this.#spawn();

    const perShard = new Array(this.workers.length).fill(0);

    const promise = new Promise((resolve, reject) => {
      let settled = false;
      this.workers.forEach((w, k) => {
        w.onmessage = (e) => {
          if (settled) return;
          if (e.data.type === "progress") {
            perShard[k] = e.data.searched;
            onProgress?.(perShard.reduce((a, b) => a + b, 0));
            return;
          }
          settled = true;
          const searched = perShard.reduce((a, b) => a + b, 0) + e.data.searched;
          this.#killAll();
          resolve({ nonce: e.data.nonce, ms: Math.round(performance.now() - started), searched });
        };
        w.onerror = (err) => {
          if (settled) return;
          settled = true;
          this.#killAll();
          reject(err);
        };
        w.postMessage({
          challenge: pow.challenge,
          difficulty: pow.difficulty,
          start: k,
          stride: this.workers.length,
        });
      });
    });

    this.active = promise;
    return promise;
  }

  cancel() {
    this.#killAll();
    this.active = null;
  }
}
