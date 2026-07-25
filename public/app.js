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

  // Any joined player can abandon their own game while one is running.
  $('abandon-btn').classList.toggle('hidden', !(joined && settings));

  // Reflect this player's saved relations (e.g. after a reconnect). Only fill
  // when both inputs are empty, so we never overwrite what the user is typing.
  const me = state.players.find((p) => p.id === socket.id);
  if (me && !$('teammates-input').value && !$('enemies-input').value) {
    if (me.teammates?.length) $('teammates-input').value = me.teammates.join(', ');
    if (me.enemies?.length) $('enemies-input').value = me.enemies.join(', ');
  }

  // Finishing-place picker: show while a game is running, buttons 1..playerCount.
  $('place-box').classList.toggle('hidden', !(joined && settings));
  if (joined && settings) renderPlacePicker(settings.playerCount, me?.place ?? null);

  if (settings) renderDeck();
});

socket.on('turnRecorded', (turns) => {
  clearSelection();
  renderTurnLog(turns); // refresh log, count, and undo-button enabled state
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

  const decks = maxCopies();
  $('deck-hint').textContent =
    `Click to add · click again for more copies (${decks} decks, up to ×${decks}) · right-click to remove`;

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

  // Count badge — shows "×N" when a card is selected more than once (two decks in
  // the 4-player game, three in the 6-player variant; see maxCopies).
  const badge = document.createElement('span');
  badge.className = 'count-badge';
  el.appendChild(badge);
  paintCard(el, code, badge);

  // Left click adds a copy (capped at 2); right click removes one.
  el.addEventListener('click', () => addCard(code));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); removeCard(code); });
  return el;
}

// Deck count = max copies of any identical card: 4-player Guandan uses two
// decks, the 6-player variant uses three. Defaults to 2 until a game starts.
const maxCopies = () => (settings?.playerCount === 6 ? 3 : 2);
const countOf = (code) => selected.filter((c) => c === code).length;

function paintCard(el, code, badge) {
  const n = countOf(code);
  el.classList.toggle('selected', n > 0);
  badge.textContent = n > 1 ? `×${n}` : '';
  badge.classList.toggle('hidden', n === 0);
}

function repaintDeck() {
  document.querySelectorAll('.card').forEach((el) => {
    const badge = el.querySelector('.count-badge');
    if (badge) paintCard(el, el.dataset.code, badge);
  });
}

function addCard(code) {
  if (countOf(code) >= maxCopies()) return;
  selected.push(code);
  renderSelection();
  repaintDeck();
}

function removeCard(code) {
  const i = selected.lastIndexOf(code);
  if (i >= 0) selected.splice(i, 1);
  renderSelection();
  repaintDeck();
}

function clearSelection() {
  selected = [];
  renderSelection();
  repaintDeck();
}

// ---------- Selection panel ----------
function renderSelection() {
  const box = $('selected-cards');
  box.innerHTML = '';

  // Keep the "Set cards remaining (N)" button in sync with the live selection.
  const remSel = $('remaining-sel');
  if (remSel) remSel.textContent = selected.length;

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
    chip.addEventListener('click', () => removeCard(code));
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
  if (state.settings) {
    const word = state.settings.playerCount === 6 ? 'Six' : 'Four';
    // previewNo is "<variant>.<n>"; show the n as the game number. It's a live
    // prediction — the actual saved number appears in the end-of-game toast.
    const n = state.previewNo ? state.previewNo.split('.')[1] : '?';
    $('game-info').textContent =
      `${word} Player Game #${n} · rank ${labelRank(state.settings.rankCard)}`;
  } else {
    $('game-info').textContent = 'No game running';
  }
  $('end-btn').classList.toggle('hidden', !(amHost && state.settings));
}

$('end-btn').addEventListener('click', () => {
  if (confirm('End the game and save all recorded turns?')) socket.emit('endGame');
});

$('abandon-btn').addEventListener('click', () => {
  const n = Number($('turn-count').textContent) || 0;
  showAbandonModal(n);
});

$('export-btn').addEventListener('click', () => {
  window.location.href = '/api/export.jsonl';
});

// ---------- Teammates / enemies (optional, self-reported) ----------
const parseNames = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

$('relations-btn').addEventListener('click', () => {
  socket.emit('setRelations', {
    teammates: parseNames($('teammates-input').value),
    enemies: parseNames($('enemies-input').value),
  });
});

socket.on('relationsSet', ({ teammates, enemies }) => {
  $('teammates-input').value = teammates.join(', ');
  $('enemies-input').value = enemies.join(', ');
  $('relations-status').textContent = 'Saved.';
  setTimeout(() => ($('relations-status').textContent = ''), 2000);
});

// ---------- Finishing place ----------
const PLACE_LABEL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th' };

// Buttons 1..count; clicking one (or the already-selected one again) toggles it.
function renderPlacePicker(count, current) {
  const wrap = $('place-group');
  wrap.innerHTML = '';
  for (let n = 1; n <= count; n++) {
    const b = document.createElement('button');
    b.className = 'seg' + (current === n ? ' active' : '');
    b.textContent = PLACE_LABEL[n];
    b.addEventListener('click', () => {
      // Click the active one to clear it back to null (unknown/abandoned).
      socket.emit('setPlace', { place: current === n ? null : n });
    });
    wrap.appendChild(b);
  }
}

socket.on('placeSet', () => {
  // State broadcast re-renders the picker with the new active button.
});

// ---------- Cards remaining at end ----------
// Reuses the deck selection: whatever is selected becomes the leftover hand.
$('remaining-btn').addEventListener('click', () => {
  socket.emit('setCardsRemaining', { cards: [...selected] });
});

socket.on('cardsRemainingSet', ({ count }) => {
  $('remaining-status').textContent = count
    ? `Saved ${count} card${count === 1 ? '' : 's'} as your remaining hand.`
    : 'Saved — no cards remaining (finished).';
  clearSelection();
  setTimeout(() => ($('remaining-status').textContent = ''), 3000);
});

// Abandon = leave the current game early. Three outcomes: save the partial hand
// (flagged 'abandoned'), discard it, or cancel. Built as a modal because a plain
// confirm() can't offer three choices.
function showAbandonModal(turnCount) {
  const overlay = $('abandon-overlay');
  $('abandon-summary').textContent = turnCount
    ? `You've recorded ${turnCount} turn${turnCount === 1 ? '' : 's'} this game.`
    : "You haven't recorded any turns yet.";
  // No point offering "save" when there's nothing to save.
  $('abandon-save').classList.toggle('hidden', turnCount === 0);
  overlay.classList.remove('hidden');
}

function hideAbandonModal() {
  $('abandon-overlay').classList.add('hidden');
}

$('abandon-save').addEventListener('click', () => {
  socket.emit('abandonGame', { keep: true });
  hideAbandonModal();
});
$('abandon-discard').addEventListener('click', () => {
  socket.emit('abandonGame', { keep: false });
  hideAbandonModal();
});
$('abandon-cancel').addEventListener('click', hideAbandonModal);

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
