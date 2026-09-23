// Смоук-тест движка на живом матче из fixtures/match.json: node test.js
const fs = require('fs');
const path = require('path');
const engine = require('./engine.js');

const file = process.argv[2] || path.join(__dirname, 'fixtures', 'match.json');
const match = JSON.parse(fs.readFileSync(file, 'utf8'));
const v = engine.analyze(match);
if (!v) {
  console.error('FAIL: analyze вернул null');
  process.exit(1);
}

const fmtP = (pl) => `${pl.nick} (hero ${pl.heroId}) | ${pl.kills}/${pl.deaths}/${pl.assists} | GPM ${pl.gpm} | участие ${Math.round(pl.participation * 100)}%`;

console.log('=== ВЕРДИКТ по матчу', match.match_id, '===');
console.log('Победитель:', v.winner, '| проигравший:', v.loser, '| длит.', engine.fmtDur(v.duration));
console.log('\nВиновник:', v.collective ? 'КОЛЛЕКТИВНАЯ ВИНА' : '');
if (!v.collective) {
  console.log(' ', fmtP(v.ruiner));
  console.log('  степень вины:', v.ruiner.ruin.score + '%');
  v.ruiner.ruin.comps.forEach((c) => console.log('   -', c.text));
}
console.log('\nMVP победителя:', fmtP(v.mvpWinner), '| скор', v.mvpWinner.mvp);
console.log('MVP проигравшего:', fmtP(v.mvpLoser), '| скор', v.mvpLoser.mvp);
if (v.fakeInnocent) console.log('Замечание победившим:', fmtP(v.fakeInnocent), v.fakeInnocent.ruin.score + '%');

console.log('\nМедали:');
for (const [slot, list] of v.medals) {
  const pl = [...v.teams.radiant.players, ...v.teams.dire.players].find((p) => p.slot === slot);
  console.log(' ', pl.nick, '→', list.map((m) => m.emoji + ' ' + m.title).join(', '));
}
console.log('\nКлючевые моменты:');
if (v.moments && v.moments.length) {
  v.moments.forEach((m) =>
    console.log(`  #${m.n} ${m.minute} мин → ${m.toward} ${Math.round(m.delta)} зол. | умерли: ` +
      (m.victims.length ? m.victims.map((x) => `${x.nick} (hero ${x.heroId}) ×${x.count}`).join(', ') : '—')));
} else {
  console.log('  не найдены');
}
console.log('Распарсен:', v.parsed, '| варды:', v.hasWardData);
console.log('\nOK');
