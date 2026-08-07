// Agent-track runner driven by a real model, in-process.
//
//   node probe/llm-run.mjs --model x-ai/grok-4-5 --operator Beard \
//     [--base https://apps.beardthelion.dev] [--label "Grok 4.5"]
//
// This is the honest agent number. The stepwise CLI (play.mjs) measures whatever
// harness is typing the answers, which for me is one process per level plus tool
// latency, so it reported 88s for a run a model does in seconds. Here the model
// answers inline and the only overhead is the API round trip and the proof of work.
//
// Key: $AIMLAPI_API_KEY, else ~/.config/aimlapi/key, matching the convention in
// gitlawb-audit/.claude/scripts/adversarial-review.py.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { solveSharded } from "../lib/pow-pool-node.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const BASE = arg("base", "http://localhost:8899");
const MODEL = arg("model", "x-ai/grok-4-5");
const OPERATOR = arg("operator", null);
const LABEL = arg("label", MODEL);
const MAX_LEVEL = 10;
const API_URL = "https://api.aimlapi.com/v1/chat/completions";

function apiKey() {
  const env = process.env.AIMLAPI_API_KEY;
  if (env) return env.trim();
  try {
    return readFileSync(join(homedir(), ".config", "aimlapi", "key"), "utf8").trim();
  } catch {
    console.error("no API key: set AIMLAPI_API_KEY or write ~/.config/aimlapi/key");
    process.exit(1);
  }
}
const KEY = apiKey();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Set for the duration of a run so gate calls can be charged to it. The worker
// subtracts that latency, so the score is thinking time, not the gate's mood.
let currentRunId = null;

// Three runs back to back is three times the load on the gate, and it answers 429
// under burst. Losing a whole session to a transient rate limit would make the
// board a measure of luck, so absorb it here with backoff.
const post = async (path, body, attempt = 0) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(currentRunId ? { "x-btb-run": currentRunId } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** attempt;
    console.log(`    rate limited, waiting ${(waitMs / 1000).toFixed(1)}s`);
    await sleep(waitMs);
    return post(path, body, attempt + 1);
  }
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// One shot, no chain of thought, because the score is time. The prompt is
// deliberately strict about output shape: a model that explains its reasoning
// loses on the clock even when it is right.
async function ask(prompt) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content:
          "You are solving a timed proof-of-intelligence challenge. Reply with ONLY the answer: "
          + "a number, a single word, or 'yes'/'no'. No explanation, no punctuation, no units." },
        { role: "user", content: prompt },
      ],
      max_tokens: 3000,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`aimlapi ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return text.trim().replace(/^["'`]+|["'`.]+$/g, "").split("\n").pop().trim();
}

// The agent board ranks a session of SESSION_RUNS runs by its best, because one
// run is noisy: this same model posted 38.3s and 18.9s back to back.
const SESSION_RUNS = Number(arg("runs", 3));
const sessionId = `s-${Math.random().toString(36).slice(2, 12)}`;
console.log(`session ${sessionId} — ${LABEL}${OPERATOR ? ` operated by ${OPERATOR}` : ""}, best of ${SESSION_RUNS}\n`);

// A run can be lost to the gate rather than the model: 10% of the anagram pool
// has another valid English answer and the gate accepts only one. Spend up to
// MAX_ATTEMPTS to land SESSION_RUNS finishes.
const MAX_ATTEMPTS = Number(arg("max-attempts", 5));
const results = [];
for (let attempt = 1; attempt <= MAX_ATTEMPTS && results.length < SESSION_RUNS; attempt++) {
  const outcome = await playOne(attempt);
  if (outcome === null) {
    if (attempt < MAX_ATTEMPTS && results.length < SESSION_RUNS) {
      console.log(`  (attempt ${attempt} lost, ${MAX_ATTEMPTS - attempt} left)\n`);
      await sleep(Number(arg("gap", 15000)));
    }
    continue;
  }
  results.push(outcome);
  // Breathe between runs. The gate is a shared service and a session is the one
  // place this client deliberately hammers it. At 2s the gate started answering
  // 429 and stretching challenge requests from 250ms to 16s, which put more noise
  // in the score than the model contributed.
  if (results.length < SESSION_RUNS) {
    const gapMs = Number(arg("gap", 15000));
    console.log(`  (pausing ${(gapMs / 1000).toFixed(0)}s before the next run)\n`);
    await sleep(gapMs);
  }
}

if (results.length) {
  const times = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const median = times[Math.floor((times.length - 1) / 2)];
  console.log(`\nsession ${sessionId}: ${results.length}/${SESSION_RUNS} runs`);
  console.log(`  times  ${times.map((t) => (t / 1000).toFixed(2) + "s").join(", ")}`);
  console.log(`  best   ${(times[0] / 1000).toFixed(2)}s   median ${(median / 1000).toFixed(2)}s`);
  const serverSaid = results[results.length - 1]?.session;
  if (serverSaid) console.log(`  ${serverSaid.next}`);
  else console.log(`  NOT ranked: a session needs ${SESSION_RUNS} finished runs to appear on the board`);
}

async function playOne(attempt) {
const requesterId = `llm-${Math.random().toString(36).slice(2, 10)}`;
const started = await post("/api/runs/start", {
  track: "agent", requesterId, label: LABEL, model: MODEL, operator: OPERATOR, sessionId,
});
if (started.status !== 200) {
  console.error("could not start a run:", started.status, JSON.stringify(started.json));
  process.exit(1);
}
currentRunId = started.json.runId;
console.log(`attempt ${attempt} — run ${results.length + 1}/${SESSION_RUNS} (${started.json.runId})`);

const proofs = [];
const t0 = Date.now();
let powMs = 0, llmMs = 0;

for (let level = 1; level <= MAX_LEVEL; level++) {
  const levelStart = Date.now();
  const chalStart = Date.now();
  const c = await post("/api/ic/v1/challenge", { requesterId, requiredLevel: level, maxAttempts: 1 });
  const chalMs = Date.now() - chalStart;
  if (c.status !== 200 || !c.json.token) {
    console.error(`  level ${level}: challenge request failed (${c.status})`);
    return null;
  }

  // Solve the proof of work while the model is thinking. Neither waits on the other.
  const powStart = Date.now();
  const powPromise = solveSharded(c.json.pow);

  const llmStart = Date.now();
  let answer;
  try {
    answer = await ask(c.json.prompt);
  } catch (err) {
    console.error(`  level ${level}: model call failed: ${err.message}`);
    return null;
  }
  llmMs += Date.now() - llmStart;

  const nonce = await powPromise;
  const powWaitMs = Date.now() - powStart - (Date.now() - llmStart >= 0 ? 0 : 0);
  powMs += Date.now() - powStart;
  const powExtraMs = Math.max(0, powWaitMs - (Date.now() - llmStart));

  const ansStart = Date.now();
  const r = await post("/api/ic/v1/answer", { token: c.json.token, answer, powNonce: nonce ?? undefined });
  const ansMs = Date.now() - ansStart;
  const ok = r.json.status === "passed";
  console.log(`  L${level} [${c.json.type.padEnd(10)}] "${answer}" ${ok ? "OK" : `MISS (${r.json.reason ?? r.json.status})`}`
    + `  (level ${((Date.now() - levelStart) / 1000).toFixed(1)}s = challenge ${chalMs}ms + think/pow ${Date.now() - llmStart - ansMs}ms + answer ${ansMs}ms)`);
  if (!ok) {
    console.log(`  stopped at level ${level}, cleared ${level - 1}/${MAX_LEVEL}, not submitted`);
    console.log(`  prompt was: ${c.json.prompt}`);
    return null;
  }
  proofs.push(r.json.proof);
}

const done = await post("/api/runs/finish", { runId: started.json.runId, proofs });
if (done.status !== 200) {
  console.error("  submission rejected:", done.status, JSON.stringify(done.json));
  return null;
}

const sec = (ms) => (ms / 1000).toFixed(2);
console.log(`  CLEARED: scored ${sec(done.json.elapsedMs)}s `
  + `(${sec(done.json.wallClockMs)}s wall clock minus ${sec(done.json.gateMs)}s the gate spent), `
  + `model ${sec(llmMs)}s, run #${done.json.number}`);
// Report the server's view of the session, not a local tally. A local count said
// "ranked" after one run while the board required three, which is exactly the
// confusion two outside agents hit.
console.log(done.json.session ? `  ${done.json.session.next}\n` : "");
currentRunId = null;
return { elapsedMs: done.json.elapsedMs, wallClockMs: done.json.wallClockMs, gateMs: done.json.gateMs,
  number: done.json.number, llmMs, session: done.json.session };
}
