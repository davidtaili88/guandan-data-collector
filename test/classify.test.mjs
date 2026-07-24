import { classify } from '../public/guandan.js';

// [cards, rankCard, expectedCombo, expectedRank|null (null = don't check), note]
const cases = [
  [['S5'], '2', 'single', 5, 'plain single'],
  [['S2'], '2', 'single', 15, 'rank card single outranks A'],
  [['SA'], '2', 'single', 14, 'ace single'],
  [['RJ'], '2', 'single', 17, 'red joker'],
  [['BJ'], '2', 'single', 16, 'black joker'],
  [['S5', 'H5'], '2', 'pair', 5, 'pair'],
  [['S5', 'H5', 'D5'], '2', 'triple', 5, 'triple'],
  [['S5', 'H5', 'D5', 'C5'], '2', 'bomb4', 5, '4 bomb'],
  [['BJ', 'RJ', 'BJ', 'RJ'], '2', 'jokerBomb', 100, 'joker bomb'],
  [['S6','H6','D6','C6','S6'], '2', 'bomb5', 6, '5-bomb'],
  [['S6','H6','D6','C6','S6','H6'], '2', 'bomb6', 6, '6-bomb'],
  [Array(12).fill('S8'), '2', 'bomb12', 8, '12-bomb extends to 12'],
  [['S3', 'H4', 'D5', 'C6', 'S7'], '2', 'straight', null, 'plain straight'],
  [['S3', 'S4', 'S5', 'S6', 'S7'], '2', 'tongHuaShun', null, 'straight flush'],
  [['S5','H5','S6','H6','S7','H7'], '2', 'tractor', null, 'tractor'],
  [['S5','H5','D5','S6','H6','D6'], '2', 'steelBoard', null, 'steelBoard'],
  [['S5','H5','D5','S6','H6'], '2', 'hung', 5, 'full house'],
  [['H7', 'S5', 'D5'], '7', 'triple', 5, 'wildcard completes triple'],
  [['H7', 'S3', 'D4', 'C5', 'S6'], '7', 'straight', null, 'wildcard completes straight'],
  [['S5', 'H9'], '2', 'unknown', null, 'garbage two cards'],
  [['S5', 'H9', 'DK'], '2', 'unknown', null, 'garbage three cards'],
];

let pass = 0, fail = 0;
for (const [cards, rc, expCombo, expRank, note] of cases) {
  const got = classify(cards, rc);
  const comboOk = got.combo === expCombo;
  const rankOk = expRank === null || got.comboRank === expRank;
  const ok = comboOk && rankOk;
  ok ? pass++ : fail++;
  let why = '';
  if (!comboOk) why += ` EXPECTED combo=${expCombo}`;
  if (!rankOk) why += ` EXPECTED rank=${expRank}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${note.padEnd(30)} ${got.combo.padEnd(14)} rank=${String(got.comboRank).padEnd(4)}${why}`);
}

// --- Straight ordering must be monotonic: higher straight => higher rank ---
console.log('\n-- straight ordering --');
const straights = [
  [['SA','H2','D3','C4','S5'], 'A2345'],
  [['S2','H3','D4','C5','S6'], '23456'],
  [['S5','H6','D7','C8','S9'], '56789'],
  [['S9','HT','DJ','CQ','SK'], '9TJQK'],
  [['ST','HJ','DQ','CK','SA'], 'TJQKA'],
];
let prev = -Infinity, monoOk = true;
for (const [cards, name] of straights) {
  const r = classify(cards, '2').comboRank;
  const ok = r > prev;
  if (!ok) monoOk = false;
  console.log(`  ${name.padEnd(8)} rank=${String(r).padEnd(4)} ${ok ? '' : '<-- NOT INCREASING'}`);
  prev = r;
}
monoOk ? pass++ : fail++;
console.log(`  ${monoOk ? 'PASS' : 'FAIL'} straights strictly increasing`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
