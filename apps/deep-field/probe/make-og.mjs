// Render the share card, apps/deep-field/web/og.png.
//
//   node probe/make-og.mjs [--out path] [--html path]
//
// The card is the real thing rather than a mockup of it: every dot is one
// repository, placed by the same buildLayout the replay uses, so the picture
// people see in a link preview is the same picture the page draws. That is also
// why this is a script and not a hand-made image. The snapshot moves, and a card
// nobody can regenerate is a card that slowly starts lying.
//
// It renders HTML and screenshots it with a headless Chromium rather than
// encoding a PNG by hand. Chromium is a local tool, not a dependency: nothing
// here ships, CI never runs this, and the committed og.png is the artifact. Pass
// --html to write the intermediate page and skip the screenshot, which is how
// you iterate on the design without a browser.

import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLayout } from "../lib/timelapse.js";
import { formatCount } from "../lib/derive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = arg("--out", join(HERE, "..", "web", "og.png"));
const HTML_ONLY = arg("--html", null);

// Facebook, X and Discord all want 1200x630. Anything else gets letterboxed or
// cropped by somebody.
const W = 1200;
const H = 630;

const CHROME = process.env.CHROME
  ?? "/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome";

const snapshot = JSON.parse(
  readFileSync(join(HERE, "..", "web", "data", "snapshot.json"), "utf8"),
);

// Same seed as the page, so the card and the replay draw the same sky.
const layout = buildLayout(snapshot);

// The field is laid out in a unit square. The card is wider than it is tall, so
// the square is scaled to the height and centred, which keeps the cluster shape
// the layout worked for instead of stretching it into an ellipse.
const size = H;
const offX = (W - size) / 2;

const dots = [];
for (let i = 0; i < layout.repoCount; i++) {
  const x = offX + layout.positions[i * 2] * size;
  const y = layout.positions[i * 2 + 1] * size;
  dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.5"/>`);
}

const repos = formatCount(snapshot.repos.length);
const agents = formatCount(snapshot.agents.total);
const owners = formatCount(snapshot.owners.length);

// No precise push count on the card. It moves about 700 a day, so it is the one
// number that would be visibly wrong within hours of any given render.
const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden; position: relative;
    background: radial-gradient(900px 600px at 50% 42%, #10282c 0%, #0b0d0e 62%), #0b0d0e;
    color: #d7e0e2;
    font-family: "JetBrains Mono", "DejaVu Sans Mono", ui-monospace, monospace;
  }
  svg { position: absolute; inset: 0; }
  circle { fill: #34e2ea; }
  /* The field is the backdrop, so it sits under a vignette that keeps the text
     legible over the dense middle without hiding the cluster shape. */
  .veil {
    position: absolute; inset: 0;
    background:
      linear-gradient(to bottom, #0b0d0ecc 0%, #0b0d0e33 26%, #0b0d0e33 62%, #0b0d0ee6 100%);
  }
  .plate { position: absolute; inset: 0; padding: 56px 64px; display: flex; flex-direction: column; }
  h1 {
    margin: 0; font-size: 82px; letter-spacing: 0.12em; color: #34e2ea; font-weight: 700;
    text-shadow: 0 0 28px #0b0d0e, 0 0 10px #0b0d0e;
  }
  h1 .u { color: #1f272a; }
  .sub {
    margin: 18px 0 0; font-size: 27px; line-height: 1.45; color: #d7e0e2; max-width: 940px;
    text-shadow: 0 0 18px #0b0d0e, 0 0 8px #0b0d0e;
  }
  .spacer { flex: 1; }
  /* Each item is one line, and the URL gets a row of its own. Both were learned
     from renders: left to wrap, "3,150 repositories" stacked into two rows, and
     with the URL on the same row it ran off the right edge. Stacking also means
     the card survives these counts gaining a digit, which they will. */
  .foot { display: flex; align-items: baseline; gap: 34px; font-size: 24px; color: #6b7b80; }
  .foot span { white-space: nowrap; }
  .foot b { color: #d7e0e2; font-weight: 600; }
  .url { margin: 16px 0 0; font-size: 24px; color: #34e2ea; white-space: nowrap; }
</style>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${dots.join("")}</svg>
<div class="veil"></div>
<div class="plate">
  <h1>DEEP<span class="u">_</span>FIELD</h1>
  <p class="sub">
    A long exposure of a git network only machines use. Five months of it,
    replayed, and then running live.
  </p>
  <div class="spacer"></div>
  <div class="foot">
    <span><b>${repos}</b> repositories</span>
    <span><b>${agents}</b> agents</span>
    <span><b>${owners}</b> owners</span>
  </div>
  <p class="url">apps.beardthelion.dev/deep-field</p>
</div>
`;

if (HTML_ONLY) {
  writeFileSync(HTML_ONLY, html);
  console.log(`wrote ${HTML_ONLY} (${layout.repoCount} dots), no screenshot taken`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "og-"));
const page = join(dir, "card.html");
writeFileSync(page, html);

// --headless=new plus --screenshot is enough here because nothing on the card
// animates or fetches. A canvas would have needed a real frame loop and CDP.
execFileSync(CHROME, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  `--window-size=${W},${H}`,
  `--screenshot=${OUT}`,
  `file://${page}`,
], { stdio: ["ignore", "ignore", "pipe"] });

console.log(`wrote ${OUT}`);
console.log(`  ${layout.repoCount} dots, ${repos} repositories, ${agents} agents, ${owners} owners`);
