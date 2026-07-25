// Persistence for collected games.
//
// Two sinks, both optional-safe:
//   1. Local disk  — ./data/games/<gameId>.json plus an append-only turns.jsonl.
//                    Persistent when running locally; EPHEMERAL on Render (lost
//                    on redeploy/restart), which is why sink 2 exists.
//   2. GitHub      — commits each finished game to a repo via the contents API.
//                    Enabled only when GITHUB_TOKEN and GITHUB_REPO are set, so
//                    the app runs fine before you set that up.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const GAMES_DIR = path.join(DATA_DIR, 'games');
const JSONL_PATH = path.join(DATA_DIR, 'turns.jsonl');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Collected games live on a dedicated DATA BRANCH of this same repo, so the code
// history on main stays free of "Add game" commits. Defaults target this repo;
// override with env vars if you fork or rename.
const GITHUB_REPO = process.env.GITHUB_REPO || 'davidtaili88/guandan-data-collector';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'data';

// ---- Manual counter override ------------------------------------------------
// The nth game of a variant is normally counted from the data repo automatically
// (see nextGameNumber). If that count is ever wrong — e.g. files were deleted, or
// you want to start a fresh series — force the starting n here, or set the
// GAMENO_OVERRIDE env var as "4:12,6:3" meaning "next 4-player game is 4.12,
// next 6-player is 6.3". Local edits here win over the env var.
const GAMENO_OVERRIDE = {
  // 4: 12,   // uncomment to force the next 4-player game to be 4.12
  // 6: 3,
};

function parseEnvOverride() {
  const raw = process.env.GAMENO_OVERRIDE;
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(',')) {
    const [variant, n] = part.split(':').map((s) => Number(s.trim()));
    if (variant && n) out[variant] = n;
  }
  return out;
}

export function githubEnabled() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

async function ensureDirs() {
  await fs.mkdir(GAMES_DIR, { recursive: true });
}

// Resolve the next sequence number n for a variant (4 or 6), producing "4.n".
// Priority: manual override (local const, then env var) > count from GitHub data
// repo > count from local disk. The data repo is authoritative because Render's
// local disk is wiped on redeploy.
async function nextGameNumber(playerCount) {
  const override = { ...parseEnvOverride(), ...GAMENO_OVERRIDE };
  if (override[playerCount]) {
    // Override sets the exact n to use for THIS game; bump it so a second game
    // in the same process doesn't collide.
    const n = override[playerCount];
    GAMENO_OVERRIDE[playerCount] = n + 1;
    return n;
  }

  return (await countVariant(playerCount)) + 1;
}

async function countVariant(playerCount) {
  if (githubEnabled()) {
    try {
      return await countVariantInGithub(playerCount);
    } catch {
      return await countVariantLocal(playerCount); // fall back if API fails
    }
  }
  return countVariantLocal(playerCount);
}

// Predicted gameNo for a variant, WITHOUT reserving it. For live display only —
// the real number is assigned atomically at save time and may differ if another
// game saves in between. Returns e.g. "4.7".
export async function previewGameNumber(playerCount) {
  const override = { ...parseEnvOverride(), ...GAMENO_OVERRIDE };
  const n = override[playerCount] ?? (await countVariant(playerCount)) + 1;
  return `${playerCount}.${n}`;
}

async function countVariantLocal(playerCount) {
  await ensureDirs();
  const files = await fs.readdir(GAMES_DIR);
  return files.filter((f) => f.startsWith(`${playerCount}.`) && f.endsWith('.json')).length;
}

async function countVariantInGithub(playerCount) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/games?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'guandan-data-collector',
    },
  });
  if (res.status === 404) return 0; // games/ folder doesn't exist yet
  if (!res.ok) throw new Error(`GitHub list ${res.status}`);
  const items = await res.json();
  return items.filter(
    (it) => it.type === 'file' && it.name.startsWith(`${playerCount}.`) && it.name.endsWith('.json'),
  ).length;
}

// Serialize all saves through a single promise chain. Counting the next gameNo
// and then writing the file must be atomic: without this, two saves that start
// close together both read the same count and both claim e.g. "4.1". Since one
// Node process handles every save, chaining them is a complete fix.
let saveChain = Promise.resolve();
export function saveGame(game) {
  const run = saveChain.then(() => _saveGameImpl(game));
  // Keep the chain alive even if this save throws, so one failure doesn't wedge
  // all future saves.
  saveChain = run.catch(() => {});
  return run;
}

async function _saveGameImpl(game) {
  await ensureDirs();

  // Assign the variant sequence number: "4.n" or "6.n". gameId (a timestamp)
  // remains the collision-proof unique key; gameNo is the human-friendly label
  // and the filename. Counting + writing are serialized (see saveGame) so no two
  // games can claim the same n; the "-<suffix>" fallback below is a belt-and-
  // braces guard against a stale count from the remote data branch.
  const n = await nextGameNumber(game.playerCount);
  game.gameNo = `${game.playerCount}.${n}`;

  // Filename is the gameNo; append a short timestamp suffix only if that name is
  // already taken locally, so a bad count can't silently overwrite a prior game.
  let baseName = game.gameNo;
  let file = path.join(GAMES_DIR, `${baseName}.json`);
  if (await exists(file)) {
    baseName = `${game.gameNo}-${game.gameId.slice(-4)}`;
    file = path.join(GAMES_DIR, `${baseName}.json`);
  }
  game.fileName = `${baseName}.json`;

  const json = JSON.stringify(game, null, 2);
  await fs.writeFile(file, json, 'utf8');

  // Flatten to one line per turn — convenient for pandas/duckdb later.
  const lines = [];
  for (const p of game.players) {
    for (const t of p.turns) {
      lines.push(JSON.stringify({
        gameId: game.gameId,
        gameNo: game.gameNo,
        playerCount: game.playerCount,
        rankCard: game.rankCard,
        startedAt: game.startedAt,
        seat: p.seat,
        name: p.name,
        ...t,
      }));
    }
  }
  if (lines.length) await fs.appendFile(JSONL_PATH, lines.join('\n') + '\n', 'utf8');

  let github = null;
  if (githubEnabled()) {
    try {
      github = await pushToGithub(game, json, baseName);
    } catch (err) {
      github = { ok: false, error: err.message };
    }
  }
  return { file, gameNo: game.gameNo, turnCount: lines.length, github };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function pushToGithub(game, json, baseName) {
  const repoPath = `games/${baseName}.json`;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'guandan-data-collector',
  };

  // A same-named file only exists if this game was saved before; carry its sha
  // so the commit updates rather than 409s.
  let sha;
  const existing = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers });
  if (existing.ok) sha = (await existing.json()).sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Add game ${game.gameNo} (${game.playerCount}p, rank ${game.rankCard})`,
      content: Buffer.from(json, 'utf8').toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true, path: repoPath };
}

export async function listGames() {
  await ensureDirs();
  const files = await fs.readdir(GAMES_DIR);
  return files.filter((f) => f.endsWith('.json')).sort().reverse();
}

export async function readAllGames() {
  await ensureDirs();
  const files = await listGames();
  const games = [];
  for (const f of files) {
    try {
      games.push(JSON.parse(await fs.readFile(path.join(GAMES_DIR, f), 'utf8')));
    } catch {
      // Skip unreadable/partial files rather than failing the whole export.
    }
  }
  return games;
}
