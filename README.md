# gitlawb-apps

Small apps built on the [Gitlawb](https://gitlawb.com) stack.

**Live: [apps.beardthelion.dev/beat-the-bot/](https://apps.beardthelion.dev/beat-the-bot/)**
and [apps.beardthelion.dev/deep-field/](https://apps.beardthelion.dev/deep-field/)

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

## Deep Field

A public git network exists that almost nobody has looked at: 3,150 repositories,
4,088 agents, 43,736 pushes, 73 peers, all built in the five months since March 2026.
This page shows it, and then replays it being built.

The name is the Hubble Deep Field: point a telescope at a patch of sky that looks empty,
hold the shutter open long enough, and thousands of galaxies appear. Same trick, aimed at
a git network where only machines are working.

The page leads with the replay rather than a live feed, and the reason is worth writing
down because the first version of it was wrong. The gossip feed at
`/api/v1/events/ref-updates` carries about six events a day, which is what made a live
firehose look impossible. But that feed is only what this node overheard from its peers.
The node's own counter moves about 0.5 pushes per minute, measured across a day, and 6
distinct repositories were touched in the last hour when this was written. So live is
viable after all; it is just bursty enough that a 7 minute window can show nothing at
all. The replay still comes first, because watching five months build is what makes the
live view mean anything.

The replay's clock is the interesting part. Activity is violently bursty: one day added
978 repositories and many days added none. Giving every day equal time spends a third of
the run on empty calendar; giving every arrival equal time hands that one day a third of
the replay. Each day gets `1 + sqrt(arrivals)` of the budget instead, which keeps the
shape without letting either extreme own the screen.

The data is crawled once and committed, not fetched by the browser. The node sends no
CORS headers, and its agents endpoint ignores pagination and answers with all 4,088 rows
in a single 960KB response. Both are fine on a server and unacceptable on a page load.

```sh
node apps/deep-field/probe/crawl.mjs      # refresh the snapshot from the live node
```

A scheduled job re-crawls daily and commits the result when the network actually
moved, so the page does not quietly age into a picture of March. It refuses a
candidate whose counts went backwards: repositories, owners, agents and pushes
are creations the node does not delete, so a crawl that returns fewer of them is
a broken crawl, and replacing a good snapshot with a worse one is the failure
worth guarding against. Deploying stays manual, so a refreshed snapshot reaches
the site on the next `wrangler deploy`.

Two things the page says out loud, because both are easy to misread. The push count is
the node's own tally, while the ref-update list is a separate gossip feed of 200 rows
spanning a month, so it is not the network's recent activity. And repository owner DIDs
have no names: `/api/v1/resolve` answers only for peers and nodes, so the page truncates
the identifier rather than inventing a label.

## Running it

```sh
node dev-server.mjs        # http://localhost:5173/beat-the-bot/ and /deep-field/
node api/lib/leaderboard.test.mjs
node apps/beat-the-bot/probe/test-pow-fast.mjs
node apps/beat-the-bot/probe/test-sha256.mjs
node apps/deep-field/probe/test-snapshot.mjs
node apps/deep-field/probe/test-derive.mjs
node apps/deep-field/probe/test-timelapse.mjs
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
| `GET /api/net/*` | Same-origin proxy to the Gitlawb node (four routes allowlisted, 30s cache). |

The proxy exists because the gate sends no CORS headers, so a browser cannot call it
directly from another origin.

## Layout

```
apps/beat-the-bot/web/     the page
apps/beat-the-bot/lib/     proof-of-work solver, shared by page and terminal runners
apps/beat-the-bot/probe/   terminal runners, benchmarks, tests
apps/deep-field/web/       the page, plus the committed snapshot under data/
apps/deep-field/lib/       snapshot derivations and the replay clock (pure, tested)
apps/deep-field/probe/     the crawler and its tests
api/lib/                   proxy, proof verification, leaderboard rules (pure, tested)
worker/                    Cloudflare entry point
migrations/                ordered schema changes
```

## License

MIT
