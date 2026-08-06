// Assemble dist/ for deployment.
//
// URL paths must match the dev server exactly (/<app>/... for the page,
// /<app>/lib/... for the shared modules) so that a thing verified locally is the
// same thing that ships.

import { cp, rm, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const APPS = join(ROOT, "apps");
const DIST = join(ROOT, "dist");
// Files served from the origin root, e.g. llms.txt, which agents look for there
// by convention rather than under an app path.
const ROOT_ASSETS = join(ROOT, "root");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

try {
  if ((await stat(ROOT_ASSETS)).isDirectory()) {
    await cp(ROOT_ASSETS, DIST, { recursive: true });
    for (const f of await readdir(ROOT_ASSETS)) console.log(`built /${f}`);
  }
} catch { /* no root assets */ }

const entries = await readdir(APPS, { withFileTypes: true });
let count = 0;

for (const e of entries) {
  if (!e.isDirectory()) continue;
  const web = join(APPS, e.name, "web");
  try {
    if (!(await stat(web)).isDirectory()) continue;
  } catch {
    continue; // no web/ dir, not a deployable app
  }

  await cp(web, join(DIST, e.name), { recursive: true });

  const lib = join(APPS, e.name, "lib");
  try {
    if ((await stat(lib)).isDirectory()) {
      await cp(lib, join(DIST, e.name, "lib"), { recursive: true });
    }
  } catch { /* app has no lib/ */ }

  count++;
  console.log(`built /${e.name}/`);
}

if (count === 0) {
  console.error("no apps found under apps/*/web — refusing to ship an empty dist");
  process.exit(1);
}
console.log(`\n${count} app(s) -> dist/`);
