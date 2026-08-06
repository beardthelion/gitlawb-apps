// Play one Beat the Bot run against the live iCaptcha service.
//
// Two-step CLI so a human or an agent can be the intelligence:
//
//   node probe/play.mjs start            begin a run, print level 1's challenge
//   node probe/play.mjs answer "12"      solve the PoW, submit, print the next challenge
//   node probe/play.mjs status           show where the run stands
//
// Run rules (see plans/beat-the-bot.md): each level is requested with
// maxAttempts 1, so a miss ends the run. Clearing a level bumps requiredLevel by
// one. Level 10 is the ceiling, so clearing it clears the board.
//
// This doubles as the agent-track runner: it is the same program a terminal agent
// would drive, which is how the Human vs Agent comparison gets its second column.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { solvePowFast } from "../lib/pow-fast.js";

// Challenges go through the app's own proxy, the same path the browser uses, so
// this runner exercises the deployed surface rather than a parallel one.
const APP = process.env.BTB_BASE ?? "http://localhost:8899";
const BASE = `${APP}/api/ic`;
const MAX_LEVEL = 10;
const STATE = join(dirname(fileURLToPath(import.meta.url)), ".state.json");

const read = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null);
const write = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

// Charged to the run so the worker can subtract gate latency from the score.
let currentRunId = null;

async function postTo(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function showChallenge(c, level) {
  console.log(`\n  LEVEL ${level}/${MAX_LEVEL}   [${c.type}, difficulty ${c.difficulty}]`);
  console.log(`\n  ${c.prompt}\n`);
  console.log(`  answer with:  node probe/play.mjs answer "<your answer>"`);
}

async function requestChallenge(state) {
  const { status, json } = await post("/v1/challenge", {
    requesterId: state.requesterId,
    requiredLevel: state.level,
    maxAttempts: 1,
  });
  if (status !== 200 || !json.token) {
    console.error(`challenge request failed (${status}):`, JSON.stringify(json));
    process.exit(1);
  }
  state.token = json.token;
  state.challenge = json;
  write(state);
  showChallenge(json, state.level);
}

function decodeProof(proof) {
  try {
    const [head] = proof.split(".");
    return JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const cmd = process.argv[2];

if (cmd === "start") {
  const idArg = process.argv.indexOf("--id");
  const lvlArg = process.argv.indexOf("--level");
  const labelArg = process.argv.indexOf("--label");
  const trackArg = process.argv.indexOf("--track");
  const state = {
    requesterId: idArg > -1 ? process.argv[idArg + 1] : `btb-${Date.now().toString(36)}`,
    level: lvlArg > -1 ? Number(process.argv[lvlArg + 1]) : 1,
    track: trackArg > -1 ? process.argv[trackArg + 1] : "agent",
    label: labelArg > -1 ? process.argv[labelArg + 1] : null,
    startedAt: Date.now(),
    cleared: [],
    proofs: [],
    runId: null,
    powMs: 0,
    over: false,
  };

  // Open the run on the board first, so the official time is the server's.
  // A board that is down is not a reason to refuse to play.
  const started = await postTo(`${APP}/api/runs/start`,
    { track: state.track, requesterId: state.requesterId, label: state.label });
  if (started.status === 200) {
    state.runId = started.json.runId;
    currentRunId = state.runId;
    console.log(`run ${state.runId} on the ${state.track} board as "${state.label ?? "anonymous"}"`);
  } else {
    console.log(`(board unavailable: ${started.status} ${JSON.stringify(started.json)}. Playing unranked.)`);
  }

  console.log(`${state.requesterId} starting at level ${state.level}`);
  await requestChallenge(state);
} else if (cmd === "answer") {
  const state = read();
  if (!state) { console.error("no run in progress. run: node probe/play.mjs start"); process.exit(1); }
  currentRunId = state.runId ?? null;
  if (state.over) { console.error("this run is over. start a new one."); process.exit(1); }

  const answer = process.argv.slice(3).join(" ");
  if (!answer) { console.error('usage: node probe/play.mjs answer "<your answer>"'); process.exit(1); }

  const pow = state.challenge.pow;
  let powNonce;
  if (pow) {
    const solved = solvePowFast(pow.challenge, pow.difficulty);
    if (!solved) { console.error("could not solve proof of work"); process.exit(1); }
    powNonce = solved.nonce;
    state.powMs += solved.ms;
    console.log(`  proof of work: ${solved.iterations.toLocaleString()} hashes in ${solved.ms}ms`);
  }

  const { status, json } = await post("/v1/answer", { token: state.token, answer, powNonce });
  if (status !== 200) { console.error(`answer failed (${status}):`, JSON.stringify(json)); process.exit(1); }

  if (json.status === "passed") {
    state.cleared.push(state.level);
    console.log(`  CORRECT. level ${state.level} cleared.`);
    if (json.proof) {
      const claims = decodeProof(json.proof);
      console.log(`  proof: level ${claims?.level}, sub ${claims?.sub}, expires ${new Date(claims.exp * 1000).toISOString()}`);
      state.lastProof = json.proof;
      state.proofs.push(json.proof);
    }
    if (state.level >= MAX_LEVEL) {
      state.over = true;
      write(state);
      const secs = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      console.log(`\n  BOARD CLEARED. all ${MAX_LEVEL} levels, ${secs}s total, ${state.powMs}ms of it proof of work.`);

      if (state.runId) {
        const done = await postTo(`${APP}/api/runs/finish`, { runId: state.runId, proofs: state.proofs });
        if (done.status === 200) {
          console.log(`  submitted: ${(done.json.elapsedMs / 1000).toFixed(2)}s server-measured, ` +
            `faster than ${done.json.percentile}% of ${done.json.total} ${done.json.track} runs.`);
        } else {
          console.log(`  submission rejected (${done.status}): ${JSON.stringify(done.json)}`);
        }
      }
    } else {
      state.level += 1;
      await requestChallenge(state);
    }
  } else if (json.status === "continue") {
    // Only reachable if the service allots more than one attempt despite
    // maxAttempts:1. Treat the run as over so scoring stays honest, but show
    // what the escalated challenge was.
    state.over = true;
    write(state);
    console.log(`  WRONG. run over at level ${state.level}.`);
    console.log(`  (service escalated to difficulty ${json.challenge?.difficulty} instead of failing outright)`);
  } else if (json.status === "failed") {
    if (String(json.reason ?? "").includes("proof-of-work")) {
      console.error(`  proof of work rejected: ${json.reason}. run not consumed, try again.`);
      process.exit(1);
    }
    state.over = true;
    write(state);
    const secs = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    console.log(`  WRONG (${json.reason ?? "no reason given"}). run over at level ${state.level}.`);
    console.log(`\n  score: cleared ${state.cleared.length}/${MAX_LEVEL} levels in ${secs}s.`);
  } else {
    console.log("  unexpected response:", JSON.stringify(json));
  }
} else if (cmd === "status") {
  const state = read();
  if (!state) { console.log("no run in progress"); process.exit(0); }
  console.log(JSON.stringify({
    requesterId: state.requesterId, level: state.level, cleared: state.cleared,
    over: state.over, powMs: state.powMs,
  }, null, 2));
  if (state.challenge && !state.over) showChallenge(state.challenge, state.level);
} else if (cmd === "reset") {
  if (existsSync(STATE)) unlinkSync(STATE);
  console.log("state cleared");
} else {
  console.log(`usage:
  node probe/play.mjs start [--level N] [--id NAME]
  node probe/play.mjs answer "<your answer>"
  node probe/play.mjs status
  node probe/play.mjs reset`);
}
