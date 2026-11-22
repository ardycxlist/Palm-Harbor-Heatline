// PALM HARBOR: HEATLINE — a gta6-01 entry (Node 22, standard library only).
//
// The game lives in this directory's game/ folder: plain static files a
// desktop browser loads with no network at all (game/index.html plus its
// classic scripts and the vendored three.js under game/vendor/). This
// program is only the hand-in step: it copies game/ and screenshots/ from
// beside this file into /output and writes /output/dossier.json — the
// summary the judge reads — using the vendored make.fun library.
//
// The game itself: a living open-world crime city. 720 citizens and 78
// vehicles on the streets, wanted stars with police cars, foot officers
// and helicopters, six story contracts, robberies, taxi fares, dusk shells,
// coast races, fuel and standing — all procedural, no assets, no network.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const target = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(target, { recursive: true });
cpSync(join(root, 'game'), join(target, 'game'), { recursive: true });
mkdirSync(join(target, 'screenshots'), { recursive: true });
if (existsSync(join(root, 'screenshots'))) {
  cpSync(join(root, 'screenshots'), join(target, 'screenshots'), { recursive: true });
}

// The scorer's own caps (from the kit's reference/gate.json): text_max_bytes
// shapes the dossier bytes; the rest refuse an entry the scorer would
// refuse anyway — more than 4 screenshots, or one over 256 KiB; more than
// 993 files in game/ or 48 MiB of game files in total; or any path under
// game/ longer than 1000 bytes. game/ counts against /output's own
// 1000-entry cap alongside screenshots/ and dossier.json.
writeFileSync(
  join(target, 'dossier.json'),
  buildDossier(target, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

// Read the dossier back so a truncated or failed write fails loudly here
// instead of silently shipping a broken entry to the scorer.
const dossierBytes = statSync(join(target, 'dossier.json')).size;
console.log(`dossier.json: ${dossierBytes} bytes -> ${target}`);
