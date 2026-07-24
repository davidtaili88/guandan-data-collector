// Guandan card model + combo classification.
//
// Card codes are 2 chars: suit letter + rank letter.
//   suits: S(pades) H(earts) D(iamonds) C(lubs)
//   ranks: 2 3 4 5 6 7 8 9 T J Q K A
//   jokers: BJ (black/small) RJ (red/big)
// e.g. "S5", "HT", "DA", "RJ"

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const JOKERS = ['BJ', 'RJ'];

// Base ordering used for straights/plates/tubes, where A can be low (A2345) or
// high (TJQKA). The rank card does NOT affect these — it only affects the value
// of a single/pair/triple/bomb comparison, which we store as comboRank.
const STRAIGHT_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export function fullDeck() {
  const cards = [];
  for (const s of SUITS) for (const r of RANKS) cards.push(s + r);
  cards.push('BJ', 'RJ');
  return cards;
}

export function rankOf(card) {
  if (card === 'BJ' || card === 'RJ') return card;
  return card.slice(1);
}

export function suitOf(card) {
  if (card === 'BJ' || card === 'RJ') return null;
  return card[0];
}

export function isJoker(card) {
  return card === 'BJ' || card === 'RJ';
}

// Numeric value for comparing plays of the same combo type. The rank card jumps
// above A (but below jokers), which is the core Guandan rule.
export function cardValue(card, rankCard) {
  if (card === 'RJ') return 17;
  if (card === 'BJ') return 16;
  const r = rankOf(card);
  if (r === rankCard) return 15;
  const idx = RANKS.indexOf(r);
  return idx + 2; // '2' -> 2 ... 'A' -> 14
}

// The rank card in Hearts is the wildcard (逢人配) and can stand in for any
// non-joker card. There are two of them in a full two-deck Guandan game; this
// collector uses one deck, so at most one.
export function isWildcard(card, rankCard) {
  return suitOf(card) === 'H' && rankOf(card) === rankCard;
}

function counts(ranks) {
  const m = new Map();
  for (const r of ranks) m.set(r, (m.get(r) || 0) + 1);
  return m;
}

// Try to place `wildCount` wildcards to complete a run of `len` consecutive
// ranks, each needing `per` copies (per=1 straight, 2 tube, 3 plate).
// Returns the top rank of the best (highest) completion, or null.
function fitRun(fixedRanks, wildCount, len, per) {
  const need = counts(fixedRanks);
  let best = null;

  for (let start = 0; start + len <= STRAIGHT_ORDER.length; start++) {
    const window = STRAIGHT_ORDER.slice(start, start + len);
    if (new Set(window).size !== len) continue; // skip A-wrapping duplicates

    const pool = new Map(need);
    let wildsLeft = wildCount;
    let ok = true;

    for (const r of window) {
      const have = pool.get(r) || 0;
      const used = Math.min(have, per);
      pool.set(r, have - used);
      const short = per - used;
      if (short > wildsLeft) { ok = false; break; }
      wildsLeft -= short;
    }
    // Every card must be consumed — leftovers mean it isn't this combo.
    if (!ok) continue;
    let leftover = wildsLeft;
    for (const v of pool.values()) leftover += v;
    if (leftover !== 0) continue;

    // Rank by the window's END position, not indexOf(top) — indexOf would map a
    // high ace back to the low ace at index 0, making TJQKA rank below A2345.
    const topVal = start + len;
    if (best === null || topVal > best) best = topVal;
  }
  return best;
}

// Human-readable top card for a run ranked by fitRun's end position.
function runTopRank(topVal) {
  return STRAIGHT_ORDER[topVal - 1];
}

/**
 * Classify a selection of cards.
 * Returns { combo, comboRank, usedWildcards, label } — combo is 'unknown' when
 * the selection doesn't match a legal shape. We never reject: unknown is saved
 * as-is so data entry is never blocked.
 */
export function classify(cards, rankCard) {
  const n = cards.length;
  if (n === 0) return { combo: 'none', comboRank: null, usedWildcards: [], label: 'Nothing selected' };

  const wilds = cards.filter((c) => isWildcard(c, rankCard));
  const fixed = cards.filter((c) => !isWildcard(c, rankCard));
  const w = wilds.length;
  const fixedRanks = fixed.map(rankOf);
  const jokers = fixed.filter(isJoker);
  const nonJokerFixed = fixed.filter((c) => !isJoker(c));

  const result = (combo, comboRank, label) => ({ combo, comboRank, usedWildcards: wilds, label });
  const valOf = (r) => {
    if (r === 'RJ') return 17;
    if (r === 'BJ') return 16;
    if (r === rankCard) return 15;
    return RANKS.indexOf(r) + 2;
  };

  // --- Four jokers: the highest bomb in the game ---
  if (n === 4 && jokers.length === 4) return result('jokerBomb', 100, 'Joker bomb 王炸');

  // Jokers other than in a joker bomb can't participate in shaped combos.
  const jokerFree = jokers.length === 0;

  // --- Single ---
  if (n === 1) {
    const r = rankOf(cards[0]);
    return result('single', valOf(r), `Single ${labelRank(r)}`);
  }

  const uniq = new Set(fixedRanks);

  // --- Same-rank groups: pair / triple / bomb(4+) ---
  if (jokerFree && (uniq.size === 1 || fixed.length === 0)) {
    const r = fixed.length ? fixedRanks[0] : rankCard;
    const v = valOf(r);
    if (n === 2) return result('pair', v, `Pair of ${labelRank(r)}`);
    if (n === 3) return result('triple', v, `Triple ${labelRank(r)}`);
    if (n >= 4) return result(`bomb${n}`, v, `${n}-card bomb of ${labelRank(r)}`);
  }

  // --- Straight flush 同花顺 (5 cards, one suit, consecutive) ---
  if (jokerFree && n === 5) {
    const suits = new Set(nonJokerFixed.map(suitOf));
    if (suits.size === 1) {
      const top = fitRun(fixedRanks, w, 5, 1);
      if (top !== null) return result('straightFlush', top, `Straight flush to ${labelRank(runTopRank(top))}`);
    }
  }

  // --- Straight 顺子 (5 consecutive singles) ---
  if (jokerFree && n === 5) {
    const top = fitRun(fixedRanks, w, 5, 1);
    if (top !== null) return result('straight', top, `Straight to ${labelRank(runTopRank(top))}`);
  }

  // --- Tube 木板 (3 consecutive pairs, 6 cards) ---
  if (jokerFree && n === 6) {
    const top = fitRun(fixedRanks, w, 3, 2);
    if (top !== null) return result('tube', top, `Tube to ${labelRank(runTopRank(top))}`);
  }

  // --- Plate 钢板 (2 consecutive triples, 6 cards) ---
  if (jokerFree && n === 6) {
    const top = fitRun(fixedRanks, w, 2, 3);
    if (top !== null) return result('plate', top, `Plate to ${labelRank(runTopRank(top))}`);
  }

  // --- Full house 三带二 (triple + pair) ---
  if (jokerFree && n === 5) {
    const c = counts(fixedRanks);
    const entries = [...c.entries()].sort((a, b) => b[1] - a[1]);
    if (w === 0 && entries.length === 2 && entries[0][1] === 3 && entries[1][1] === 2) {
      return result('fullHouse', valOf(entries[0][0]), `Full house, ${labelRank(entries[0][0])} over ${labelRank(entries[1][0])}`);
    }
    if (w === 1 && entries.length === 2) {
      // Wildcard fills either the triple or the pair.
      const [a, b] = entries;
      if ((a[1] === 3 && b[1] === 1) || (a[1] === 2 && b[1] === 2)) {
        const tripleRank = a[1] === 3 ? a[0] : a[0];
        return result('fullHouse', valOf(tripleRank), `Full house, ${labelRank(tripleRank)} over ${labelRank(b[0])}`);
      }
    }
  }

  return result('unknown', null, `Unrecognised (${n} cards)`);
}

export function labelRank(r) {
  if (r === 'BJ') return 'Black Joker';
  if (r === 'RJ') return 'Red Joker';
  if (r === 'T') return '10';
  return r;
}

export const COMBO_LABELS = {
  single: 'Single',
  pair: 'Pair',
  triple: 'Triple',
  fullHouse: 'Full house',
  straight: 'Straight',
  straightFlush: 'Straight flush',
  tube: 'Tube (3 pairs)',
  plate: 'Plate (2 triples)',
  bomb4: '4-bomb',
  bomb5: '5-bomb',
  bomb6: '6-bomb',
  bomb7: '7-bomb',
  bomb8: '8-bomb',
  jokerBomb: 'Joker bomb',
  unknown: 'Unknown',
};
