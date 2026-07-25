// Reclassify bridge: reads JSON on stdin, writes classifications on stdout, using
// the SAME classifier the server uses (public/guandan.js). This lets the Python
// loader re-derive combo/comboRank from raw cards without duplicating the logic —
// one source of truth. Fixes to guandan.js retroactively correct old data.
//
// Input:  {"rows": [{"cards": ["S5","H5"], "rankCard": "2"}, ...]}
// Output: {"results": [{"combo": "pair", "comboRank": 5, "usedWildcards": []}, ...]}

import { classify } from '../public/guandan.js';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const { rows } = JSON.parse(raw);
  const results = rows.map(({ cards, rankCard }) => {
    const c = classify(cards, String(rankCard));
    return { combo: c.combo, comboRank: c.comboRank, usedWildcards: c.usedWildcards };
  });
  process.stdout.write(JSON.stringify({ results }));
});
