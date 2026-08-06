import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
// Single source of truth for card logic — lives under public/ so the browser
// can import the exact same module, keeping client preview and server-recorded
// classification identical.
import { classify } from './public/guandan.js';
import { saveGame, readAllGames, listGames, githubEnabled, previewGameNumber, verifyGithubAccess } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump when the saved game format changes in a way analysis must distinguish
// (new/renamed fields, different card encoding, second-deck wildcard rules, …).
// Every saved game carries this so old and new records stay tellable apart.
//   1 — initial: single deck, per-player turn streams, combo cached at record time
const SCHEMA_VERSION = 1;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// rooms[roomId] = { settings, players, hostId, startedAt, gameId }
// players = { socketId -> { seat, name, turns: [], connected } }
// Each player owns an independent turn stream: their Nth action is turn N,
// regardless of what other seats did. There is no global trick ordering.
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      settings: null, // { playerCount, rankCard } — set when the host starts
      players: {},
      playersByName: {},
      hostId: null,
      gameId: null,
      startedAt: null,
    };
  }
  return rooms[roomId];
}

function makeGameId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function publicState(room) {
  return {
    settings: room.settings,
    gameId: room.gameId,
    previewNo: room.previewNo || null,
    hostId: room.hostId,
    githubEnabled: githubEnabled(),
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      seat: p.seat,
      name: p.name,
      connected: p.connected,
      turnCount: p.turns.length,
      lastTurn: p.turns[p.turns.length - 1] || null,
      teammates: p.teammates || [],
      enemies: p.enemies || [],
      place: p.place ?? null,
      teammatePlaces: p.teammatePlaces || {},
      cardsRemainingCount: (p.cardsRemaining || []).length,
    })).sort((a, b) => a.seat - b.seat),
  };
}

function assignHost(room, preferredId) {
  if (preferredId && room.players[preferredId]?.connected) {
    room.hostId = preferredId;
    return;
  }
  const next = Object.entries(room.players).find(([, p]) => p.connected);
  room.hostId = next ? next[0] : null;
}

function nextFreeSeat(room) {
  const taken = new Set(Object.values(room.players).map((p) => p.seat));
  const max = room.settings?.playerCount ?? 6;
  for (let i = 0; i < max; i++) if (!taken.has(i)) return i;
  return taken.size; // overflow observer seats
}

// Snapshot the whole room's game. status is 'complete' for a normal end.
function snapshotGame(room, status = 'complete') {
  const included = Object.values(room.players).filter((p) => p.turns.length > 0);
  // Game-level provenance stamp: true when any included player recorded at least
  // one teammate finishing place. Lets analysis find the first game this feature
  // was used in without scanning every player's map.
  const hasTeammatePlaces = included.some(
    (p) => p.teammatePlaces && Object.keys(p.teammatePlaces).length > 0
  );
  return {
    schema: SCHEMA_VERSION,
    gameId: room.gameId,
    playerCount: room.settings.playerCount,
    rankCard: room.settings.rankCard,
    date: room.startedAt.slice(0, 10), // YYYY-MM-DD, for easy grouping/filtering
    status,
    startedAt: room.startedAt,
    endedAt: new Date().toISOString(),
    hasTeammatePlaces,
    players: included
      .map((p) => ({
        seat: p.seat, name: p.name,
        teammates: p.teammates, enemies: p.enemies,
        place: p.place ?? null, // finishing position; null if not entered
        // Places this player observed for their teammates: { name: place }.
        teammatePlaces: p.teammatePlaces || {},
        cardsRemaining: p.cardsRemaining || [],
        turns: p.turns,
      }))
      .sort((a, b) => a.seat - b.seat),
  };
}

// Snapshot a SINGLE player's stream — used when a player abandons their own game
// mid-play. Shares the room's gameId so it can be tied back to the same table,
// but is a standalone record marked status 'abandoned'.
function snapshotPlayer(room, player) {
  return {
    schema: SCHEMA_VERSION,
    gameId: room.gameId,
    playerCount: room.settings.playerCount,
    rankCard: room.settings.rankCard,
    date: room.startedAt.slice(0, 10),
    status: 'abandoned',
    startedAt: room.startedAt,
    endedAt: new Date().toISOString(),
    players: [{
      seat: player.seat, name: player.name,
      teammates: player.teammates, enemies: player.enemies,
      place: null, // abandoned: player didn't finish, so no place
      teammatePlaces: player.teammatePlaces || {}, // any teammate places recorded before abandoning
      cardsRemaining: player.cardsRemaining || [], // whatever was in hand when abandoned
      turns: player.turns,
    }],
  };
}

io.on('connection', (socket) => {
  let roomId = 'main';

  socket.on('joinRoom', (id) => {
    roomId = id || 'main';
    socket.join(roomId);
    socket.emit('state', publicState(getRoom(roomId)));
  });

  socket.on('join', (name) => {
    const room = getRoom(roomId);
    const clean = String(name || '').trim().slice(0, 20) || 'Player';

    // Reconnect under the same name resumes the existing turn stream rather
    // than starting a second, empty one.
    const prior = room.playersByName[clean];
    if (prior) {
      delete room.players[prior.socketId];
      prior.socketId = socket.id;
      prior.connected = true;
      room.players[socket.id] = prior;
    } else {
      const p = {
        socketId: socket.id, seat: nextFreeSeat(room), name: clean,
        turns: [], connected: true,
        teammates: [], enemies: [], // self-reported, optional
        place: null, // finishing position, set at game end; null = unknown/abandoned
        teammatePlaces: {}, // { teammateName: place } observed by this player
        cardsRemaining: [], // cards still in hand at game end (empty if finished)
      };
      room.players[socket.id] = p;
      room.playersByName[clean] = p;
    }

    if (!room.hostId) assignHost(room, socket.id);
    io.to(roomId).emit('state', publicState(room));
  });

  socket.on('startGame', async ({ playerCount, rankCard }) => {
    const room = getRoom(roomId);
    if (socket.id !== room.hostId) return;
    const pc = playerCount === 6 ? 6 : 4;
    const rc = String(rankCard || '2');
    room.settings = { playerCount: pc, rankCard: rc };
    room.gameId = makeGameId();
    room.startedAt = new Date().toISOString();
    // Predicted number for live display only ("Four Player Game #7"). The real
    // gameNo is assigned atomically at save time and may differ if another game
    // saves in between.
    try {
      room.previewNo = await previewGameNumber(pc);
    } catch {
      room.previewNo = null;
    }
    for (const p of Object.values(room.players)) { p.turns = []; p.place = null; p.teammatePlaces = {}; p.cardsRemaining = []; }
    io.to(roomId).emit('state', publicState(room));
    io.to(roomId).emit('toast', `Game started — ${pc} players, rank card ${rc}`);
  });

  // Set this player's self-reported teammates/enemies (free-text names, optional,
  // may be empty). Stored on the player and persisted with their game record.
  socket.on('setRelations', ({ teammates, enemies }) => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p) return;
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 10);
    p.teammates = clean(teammates);
    p.enemies = clean(enemies);
    socket.emit('relationsSet', { teammates: p.teammates, enemies: p.enemies });
    io.to(roomId).emit('state', publicState(room));
  });

  // Set this player's finishing place (1..playerCount), or null to clear.
  socket.on('setPlace', ({ place }) => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p || !room.settings) return;
    const max = room.settings.playerCount;
    const n = Number(place);
    p.place = Number.isInteger(n) && n >= 1 && n <= max ? n : null;
    socket.emit('placeSet', { place: p.place });
    io.to(roomId).emit('state', publicState(room));
  });

  // Set the finishing places this player observed for their TEAMMATES — a
  // { name: place } map, so a table where not everyone has a device can still
  // capture the whole side's finishing order. Only names in this player's
  // teammates list are kept; a null/invalid place drops that entry. The teammate
  // marked place 1 is, by definition, the first one out (no separate flag).
  socket.on('setTeammatePlaces', ({ places }) => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p || !room.settings) return;
    const max = room.settings.playerCount;
    const allowed = new Set(p.teammates || []);
    const out = {};
    for (const [name, place] of Object.entries(places || {})) {
      const key = String(name || '').trim().slice(0, 20);
      const n = Number(place);
      if (allowed.has(key) && Number.isInteger(n) && n >= 1 && n <= max) {
        out[key] = n;
      }
    }
    p.teammatePlaces = out;
    socket.emit('teammatePlacesSet', { places: out });
    io.to(roomId).emit('state', publicState(room));
  });

  // Set this player's cards-remaining-at-end (an array of card codes, possibly
  // empty). Raw list only — no combo classification, since a leftover hand isn't
  // a play.
  socket.on('setCardsRemaining', ({ cards }) => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p || !room.settings) return;
    p.cardsRemaining = Array.isArray(cards) ? cards.slice(0, 54) : [];
    socket.emit('cardsRemainingSet', { count: p.cardsRemaining.length });
    io.to(roomId).emit('state', publicState(room));
  });

  // Record one action for THIS socket's player. cards=[] means a pass.
  socket.on('recordTurn', ({ action, cards }) => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p || !room.settings) return;

    const turnNo = p.turns.length + 1;
    if (action === 'pass') {
      p.turns.push({ turn: turnNo, action: 'pass' });
    } else {
      const list = Array.isArray(cards) ? cards : [];
      if (!list.length) return;
      const c = classify(list, room.settings.rankCard);
      p.turns.push({
        turn: turnNo,
        action: 'play',
        cards: list,
        combo: c.combo,
        comboRank: c.comboRank,
        usedWildcards: c.usedWildcards,
      });
    }
    // Send the full turns array so the client re-renders its log (and the undo
    // button / count) from authoritative state, not just the delta.
    socket.emit('turnRecorded', p.turns);
    io.to(roomId).emit('state', publicState(room));
  });

  socket.on('undoTurn', () => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p || !p.turns.length) return;
    p.turns.pop();
    socket.emit('turnsReplaced', p.turns);
    io.to(roomId).emit('state', publicState(room));
  });

  socket.on('endGame', async () => {
    const room = getRoom(roomId);
    if (socket.id !== room.hostId || !room.settings) return;

    const game = snapshotGame(room);
    if (!game.players.length) {
      socket.emit('toast', 'Nothing to save — no turns recorded.');
      return;
    }
    try {
      const res = await saveGame(game);
      let msg = `Saved game ${res.gameNo} — ${res.turnCount} turns`;
      if (res.github?.ok) msg += ' · pushed to GitHub';
      else if (res.github?.error) msg += ` · GitHub failed: ${res.github.error}`;
      io.to(roomId).emit('toast', msg);
    } catch (err) {
      socket.emit('toast', `Save failed: ${err.message}`);
      return;
    }

    room.settings = null;
    room.gameId = null;
    for (const p of Object.values(room.players)) { p.turns = []; p.place = null; p.teammatePlaces = {}; p.cardsRemaining = []; }
    io.to(roomId).emit('turnsReplaced', []);
    io.to(roomId).emit('state', publicState(room));
  });

  // A player abandons their own game mid-play. keep=true saves their partial
  // stream (flagged 'abandoned'); keep=false discards it. Either way the player
  // leaves the current game so the host's later save won't double-count them.
  socket.on('abandonGame', async ({ keep }) => {
    const room = getRoom(roomId);
    const p = room.players[socket.id];
    if (!p || !room.settings) return;

    if (keep && p.turns.length) {
      try {
        const res = await saveGame(snapshotPlayer(room, p));
        let msg = `Abandoned & saved ${res.gameNo} (${p.name}) — ${res.turnCount} turns`;
        if (res.github?.ok) msg += ' · pushed to GitHub';
        else if (res.github?.error) msg += ` · GitHub failed: ${res.github.error}`;
        socket.emit('toast', msg);
      } catch (err) {
        socket.emit('toast', `Save failed: ${err.message}`);
        return; // keep their turns so they can retry rather than lose data
      }
    } else {
      socket.emit('toast', keep ? 'Nothing to save — no turns recorded.' : 'Game abandoned, not saved.');
    }

    // Reset this player's stream for the current game and pull them out of it.
    p.turns = [];
    socket.emit('turnsReplaced', []);
    io.to(roomId).emit('state', publicState(room));
  });

  socket.on('resync', () => {
    const room = getRoom(roomId);
    socket.emit('state', publicState(room));
    const p = room.players[socket.id];
    if (p) socket.emit('turnsReplaced', p.turns);
  });

  socket.on('disconnect', () => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[socket.id];
    if (p) p.connected = false; // keep turns for reconnect
    if (room.hostId === socket.id) assignHost(room, null);
    io.to(roomId).emit('state', publicState(room));
  });
});

// --- Export endpoints (the escape hatch from Render's ephemeral disk) ---
app.get('/api/games', async (_req, res) => {
  res.json({ games: await listGames(), githubEnabled: githubEnabled() });
});

app.get('/api/export.json', async (_req, res) => {
  const games = await readAllGames();
  res.setHeader('Content-Disposition', 'attachment; filename="guandan-games.json"');
  res.json(games);
});

app.get('/api/export.jsonl', async (_req, res) => {
  const games = await readAllGames();
  const lines = [];
  for (const g of games) {
    for (const p of g.players) {
      for (const t of p.turns) {
        lines.push(JSON.stringify({
          gameId: g.gameId, playerCount: g.playerCount, rankCard: g.rankCard,
          seat: p.seat, name: p.name, ...t,
        }));
      }
    }
  }
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', 'attachment; filename="turns.jsonl"');
  res.send(lines.join('\n') + '\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Guandan data collector on :${PORT}`);
  // Verify GitHub access up front so a misconfigured token is obvious in the logs
  // at boot, not only when the first game fails to push.
  console.log(await verifyGithubAccess());
});
