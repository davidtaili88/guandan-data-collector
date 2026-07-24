import { fullDeck, RANKS, rankOf, suitOf, isJoker, isWildcard, classify, labelRank } from './guandan.js';

const socket = io();
const $ = (id) => document.getElementById(id);
const roomId = location.hash.slice(1) || 'main';

let myId = null;
let amHost = false;
let settings = null;          // { playerCount, rankCard } once a game is running
let selected = [];            // card codes currently selected, in click order
let pendingCount = 4;
let pendingRank = '2';
let joinedName = localStorage.getItem('gd_name_' + roomId) || null;

const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED = new Set(['H', 'D']);

// ---------- Socket wiring ----------
socket.on('connect', () => {
  myId = socket.id;
  socket.emit('joinRoom', roomId);
  if (joinedName) {
    $('name-input').value = joinedName;
    socket.emit('join', joinedName);
    socket.emit('resync');
  }
});

socket.on('state', (state) => {
  amHost = state.hostId === socket.id;
  settings = state.settings;
  renderPlayers(state.players);
  renderTopbar(state);
  renderHostSetup(state);

  const joined = state.players.some((p) => p.id === socket.id);
  if (joined && settings) $('setup-overlay').classList.add('hidden');
  else $('setup-overlay').classList.remove('hidden');

  if (settings) renderDeck();
});

socket.on('turnRecorded', () => {
  clearSelection();
});

socket.on('turnsReplaced', (turns) => {
  renderTurnLog(turns);
});

socket.on('toast', showToast);

// ---------- Setup overlay ----------
$('join-btn').addEventListener('click', () => {
  const name = $('name-input').value.trim();
  if (!name) return showToast('Enter a name first');
  joinedName = name;
  localStorage.setItem('gd_name_' + roomId, name);
  socket.emit('join', name);
});

$('player-count-group').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  pendingCount = Number(btn.dataset.count);
  [...$('player-count-group').children].forEach((b) => b.classList.toggle('active', b === btn));
});

function renderRankPicker() {
  const wrap = $('rank-card-group');
  wrap.innerHTML = '';
  for (const r of RANKS) {
    const b = document.createElement('button');
    b.className = 'rank-chip' + (r === pendingRank ? ' active' : '');
    b.textContent = labelRank(r);
    b.addEventListener('click', () => {
      pendingRank = r;
      renderRankPicker();
      $('start-btn').disabled = false;
    });
    wrap.appendChild(b);
  }
}
renderRankPicker();

$('start-btn').addEventListener('click', () => {
  socket.emit('startGame', { playerCount: pendingCount, rankCard: pendingRank });
});

function renderHostSetup(state) {
  const joined = state.players.some((p) => p.id === socket.id);
  $('host-setup').classList.toggle('hidden', !(joined && amHost && !state.settings));
  if (joined && !amHost && !state.settings) {
    $('setup-status').textContent = 'Waiting for the host to start the game…';
  } else if (!joined) {
    $('setup-status').textContent = '';
  } else {
    $('setup-status').textContent = '';
  }
  $('start-btn').disabled = false;
}

// ---------- Deck ----------
function renderDeck() {
  const deck = $('deck');
  const rankCard = settings?.rankCard;
  deck.innerHTML = '';

  $('wildcard-note').textContent = rankCard
    ? `Rank card ${labelRank(rankCard)} · H${rankCard} is the wildcard`
    : '';

  for (const suit of ['S', 'H', 'D', 'C']) {
    const row = document.createElement('div');
    row.className = 'suit-row';

    const label = document.createElement('div');
    label.className = 'suit-label' + (RED.has(suit) ? ' red' : '');
    label.textContent = SUIT_GLYPH[suit];
    row.appendChild(label);

    for (const r of RANKS) {
      row.appendChild(cardEl(suit + r, rankCard));
    }
    deck.appendChild(row);
  }

  const jokerRow = document.createElement('div');
  jokerRow.className = 'suit-row';
  const jl = document.createElement('div');
  jl.className = 'suit-label';
  jl.textContent = '★';
  jokerRow.appendChild(jl);
  jokerRow.appendChild(cardEl('BJ', rankCard));
  jokerRow.appendChild(cardEl('RJ', rankCard));
  deck.appendChild(jokerRow);
}

function cardEl(code, rankCard) {
  const el = document.createElement('button');
  const suit = suitOf(code);
  const r = rankOf(code);
  el.className = 'card';
  el.dataset.code = code;

  if (isJoker(code)) {
    el.classList.add('joker', code === 'RJ' ? 'red' : 'black');
    el.innerHTML = `<span class="card-rank">${code === 'RJ' ? 'RJ' : 'BJ'}</span><span class="card-suit">★</span>`;
  } else {
    if (RED.has(suit)) el.classList.add('red');
    el.innerHTML = `<span class="card-rank">${labelRank(r)}</span><span class="card-suit">${SUIT_GLYPH[suit]}</span>`;
  }

  if (rankCard && r === rankCard) el.classList.add('is-rank-card');
  if (rankCard && isWildcard(code, rankCard)) el.classList.add('is-wildcard');
  if (selected.includes(code)) el.classList.add('selected');

  el.addEventListener('click', () => toggleCard(code));
  return el;
}

function toggleCard(code) {
  const i = selected.indexOf(code);
  if (i >= 0) selected.splice(i, 1);
  else selected.push(code);
  renderSelection();
  // Reflect selected state on the deck without a full re-render.
  document.querySelectorAll('.card').forEach((el) => {
    el.classList.toggle('selected', selected.includes(el.dataset.code));
  });
}

function clearSelection() {
  selected = [];
  renderSelection();
  document.querySelectorAll('.card.selected').forEach((el) => el.classList.remove('selected'));
}

// ---------- Selection panel ----------
function renderSelection() {
  const box = $('selected-cards');
  box.innerHTML = '';

  if (!selected.length) {
    box.innerHTML = '<span class="muted">Click cards to add them here</span>';
    $('combo-readout').innerHTML = '';
    $('play-btn').disabled = true;
    $('clear-btn').disabled = true;
    return;
  }

  for (const code of selected) {
    const chip = document.createElement('button');
    const suit = suitOf(code);
    chip.className = 'chip' + (isJoker(code) ? (code === 'RJ' ? ' red' : '') : RED.has(suit) ? ' red' : '');
    chip.textContent = isJoker(code) ? code : labelRank(rankOf(code)) + SUIT_GLYPH[suit];
    chip.title = 'Remove';
    chip.addEventListener('click', () => toggleCard(code));
    box.appendChild(chip);
  }

  const c = classify(selected, settings.rankCard);
  const readout = $('combo-readout');
  const unknown = c.combo === 'unknown';
  readout.className = 'combo-readout ' + (unknown ? 'warn' : 'ok');
  readout.innerHTML = unknown
    ? `⚠️ ${c.label} — you can still record it, it'll be saved as <code>unknown</code>.`
    : `✓ <b>${c.label}</b>${c.usedWildcards.length ? ` · wildcard: ${c.usedWildcards.join(', ')}` : ''}`;

  $('play-btn').disabled = false;
  $('clear-btn').disabled = false;
}

$('play-btn').addEventListener('click', () => {
  if (!selected.length) return;
  socket.emit('recordTurn', { action: 'play', cards: [...selected] });
});

$('clear-btn').addEventListener('click', clearSelection);

$('pass-btn').addEventListener('click', () => {
  socket.emit('recordTurn', { action: 'pass' });
  clearSelection();
});

$('undo-btn').addEventListener('click', () => socket.emit('undoTurn'));

// ---------- Turn log ----------
function renderTurnLog(turns) {
  const log = $('turn-log');
  log.innerHTML = '';
  $('turn-count').textContent = turns.length;
  $('undo-btn').disabled = turns.length === 0;

  for (const t of turns) {
    const li = document.createElement('li');
    if (t.action === 'pass') {
      li.innerHTML = `<span class="t-num">${t.turn}</span><span class="t-pass">Pass</span>`;
    } else {
      const cards = t.cards.map((c) => {
        const s = suitOf(c);
        const red = isJoker(c) ? c === 'RJ' : RED.has(s);
        const text = isJoker(c) ? c : labelRank(rankOf(c)) + SUIT_GLYPH[s];
        return `<span class="mini${red ? ' red' : ''}">${text}</span>`;
      }).join('');
      li.innerHTML = `<span class="t-num">${t.turn}</span><span class="t-cards">${cards}</span><span class="t-combo">${t.combo}</span>`;
    }
    log.appendChild(li);
  }
  log.scrollTop = log.scrollHeight;
}

// ---------- Players / topbar ----------
function renderPlayers(players) {
  const ul = $('player-list');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="dot ${p.connected ? 'on' : 'off'}"></span>
      <span class="p-name">${escapeHtml(p.name)}${p.id === socket.id ? ' (you)' : ''}</span>
      <span class="muted">seat ${p.seat} · ${p.turnCount} turns</span>`;
    ul.appendChild(li);
  }
}

function renderTopbar(state) {
  $('game-info').textContent = state.settings
    ? `Game ${state.gameId?.slice(0, 19)} · ${state.settings.playerCount}p · rank ${labelRank(state.settings.rankCard)}`
    : 'No game running';
  $('end-btn').classList.toggle('hidden', !(amHost && state.settings));
}

$('end-btn').addEventListener('click', () => {
  if (confirm('End the game and save all recorded turns?')) socket.emit('endGame');
});

$('export-btn').addEventListener('click', () => {
  window.location.href = '/api/export.jsonl';
});

// ---------- Misc ----------
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
