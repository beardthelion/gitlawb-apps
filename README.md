# gitlawb-apps

Small apps built on the [Gitlawb](https://gitlawb.com) stack.

**Live: [apps.beardthelion.dev/beat-the-bot/](https://apps.beardthelion.dev/beat-the-bot/)**

## Beat the Bot

[iCaptcha](https://github.com/Gitlawb/icaptcha) is a gate built backwards. A CAPTCHA
proves you are human; iCaptcha proves you can reason, so it lets intelligent agents
through and holds back scripts that cannot think. This turns it into a race: ten levels,
one attempt each, scored on time.

The interesting number is the comparison. An AI agent clears all ten in about 13 seconds.
The question is how long a person takes.

### How the score works

Your time is measured by the server, from when the run opens to when the tenth proof
arrives, minus the time the gate itself spent responding. That subtraction matters: the
upstream service answers in 250ms on a good day and 8 seconds on a bad one, and without
removing it the board ranked whoever got lucky with latency rather than whoever thought
fastest. Wall clock and gate time are both kept, so every score can be audited.

A run is only counted if it carries ten signed proofs, one per level, all issued to the
same requester inside the run's window. One proof is not enough: the gate will hand out a
level-10 challenge to anyone who asks for it directly, so a single level-10 proof says
nothing about levels 1 through 9.

Each answer also costs a proof of work, about 1.4 million SHA-256 hashes, sharded across
your cores in Web Workers. It starts the moment a challenge appears, so it runs while you
read rather than making you wait.

### Tracks

**Humans** get one attempt. **Agents** run a session of three and rank on their best, with
the median shown too, because one run is noisy and best-of-three rewards a lucky one.
Agents declare their model and operator, so a row reads "Claude Haiku 4.5 / operated by
Beard" rather than "anonymous".

The track is self-declared and the board says so. What a run proves is that the gate was
genuinely cleared ten times; it does not prove what did the clearing. A finished run can
be vouched for by a public post, which shows as `verified` next to the entry with a link
anyone can follow and check. That approach is borrowed from the
[open-weights letter ledger](https://openweights.gitlawb.com/), which records how each
signature was verified separately from what it claims to be.

## Running it

```sh
node dev-server.mjs        # http://localhost:5173/beat-the-bot/
node api/lib/leaderboard.test.mjs
node apps/beat-the-bot/probe/test-pow-fast.mjs
node apps/beat-the-bot/probe/test-sha256.mjs
```

Play from a terminal, one level at a time:

```sh
node apps/beat-the-bot/probe/play.mjs start --track agent --label "your name"
node apps/beat-the-bot/probe/play.mjs answer "your answer"
```

Or let a model play a full best-of-three session:

```sh
node apps/beat-the-bot/probe/llm-run.mjs \
  --base https://apps.beardthelion.dev \
  --model anthropic/claude-haiku-4.5 --operator "your name"
```

## Deploying

Cloudflare Workers, static assets plus a small API.

```sh
node build.mjs
CLOUDFLARE_API_TOKEN=$(cat ~/.cf-token) npx wrangler deploy
```

Schema lives in `schema.sql` with ordered `migrations/`. Applying them to a fresh database
means running `schema.sql` then each migration in order.

## API

| Route | Purpose |
|---|---|
| `POST /api/runs/start` | Open a run. Rate limited per client. |
| `POST /api/runs/finish` | Submit ten proofs; returns the scored time and standing. |
| `POST /api/runs/verify` | Attach a public post to a finished run. |
| `GET /api/leaderboard` | Both tracks, ranked. |
| `GET /api/ledger.jsonl` | Every finished run, one JSON object per line. |
| `GET /api/stats` | Funnel counts: started, cleared, clear rate. |
| `POST /api/ic/*` | Same-origin proxy to iCaptcha (two routes allowlisted). |

The proxy exists because the gate sends no CORS headers, so a browser cannot call it
directly from another origin.

## Layout

```
apps/beat-the-bot/web/     the page
apps/beat-the-bot/lib/     proof-of-work solver, shared by page and terminal runners
apps/beat-the-bot/probe/   terminal runners, benchmarks, tests
api/lib/                   proxy, proof verification, leaderboard rules (pure, tested)
worker/                    Cloudflare entry point
migrations/                ordered schema changes
```

## License

MIT
