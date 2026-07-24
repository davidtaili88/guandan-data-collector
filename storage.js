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
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

export function githubEnabled() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

async function ensureDirs() {
  await fs.mkdir(GAMES_DIR, { recursive: true });
}

export async function saveGame(game) {
  await ensureDirs();
  const file = path.join(GAMES_DIR, `${game.gameId}.json`);
  const json = JSON.stringify(game, null, 2);
  await fs.writeFile(file, json, 'utf8');

  // Flatten to one line per turn — convenient for pandas/duckdb later.
  const lines = [];
  for (const p of game.players) {
    for (const t of p.turns) {
      lines.push(JSON.stringify({
        gameId: game.gameId,
        playerCount: game.playerCount,
        rankCard: game.rankCard,
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
      github = await pushToGithub(game, json);
    } catch (err) {
      github = { ok: false, error: err.message };
    }
  }
  return { file, turnCount: lines.length, github };
}

async function pushToGithub(game, json) {
  const repoPath = `games/${game.gameId}.json`;
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
      message: `Add game ${game.gameId} (${game.playerCount}p, rank ${game.rankCard})`,
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
