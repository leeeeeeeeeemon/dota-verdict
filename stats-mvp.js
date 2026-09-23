// Измерение баланса MVP-скора: как часто саппорт становится MVP команды-победителя.
// node stats-mvp.js [кол-во матчей]
const engine = require('./engine.js');

const PROXY = 'http://127.0.0.1:8765/opendota/api';

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

(async () => {
  const limit = Number(process.argv[2]) || 25;
  const pubs = await j(PROXY + '/publicMatches');
  const ids = pubs.slice(0, limit * 2).map((m) => m.match_id);

  let n = 0, parsedN = 0, supMvp = 0, dmgLeaderNotMvp = 0;
  let parsedSupMvp = 0, parsedDmgLeaderNotMvp = 0;
  const supScores = [], coreScores = [];
  const supMvpMatches = [];

  for (const id of ids) {
    if (n >= limit) break;
    let m;
    try {
      m = await j(PROXY + '/matches/' + id);
    } catch (e) {
      continue;
    }
    // пропускаем пустые заглушки: сверхсвежие матчи без данных, короткие/ботовые катки
    const kills = (m.radiant_score || 0) + (m.dire_score || 0);
    if (!m.duration || m.duration < 900 || kills < 15 || !m.players || m.players.length < 10) continue;
    const v = engine.analyze(m);
    if (!v) continue;
    n++;
    const wt = v.teams[v.winner];
    const mvp = wt.mvp;
    const dmgLeader = [...wt.players].sort((a, b) => b.heroDamage - a.heroDamage)[0];

    wt.players.forEach((p) => (p.isSupport ? supScores : coreScores).push(p.mvp));
    if (mvp.isSupport) { supMvp++; supMvpMatches.push(id); }
    if (dmgLeader !== mvp) dmgLeaderNotMvp++;
    if (v.parsed && v.hasWardData) {
      parsedN++;
      if (mvp.isSupport) parsedSupMvp++;
      if (dmgLeader !== mvp) parsedDmgLeaderNotMvp++;
    }
  }

  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  console.log(JSON.stringify({
    matches: n,
    mvpSupportShare: Math.round((100 * supMvp) / n) + '% (' + supMvp + ')',
    dmgLeaderIsNotMvpShare: Math.round((100 * dmgLeaderNotMvp) / n) + '%',
    parsedOnly: {
      matches: parsedN,
      mvpSupportShare: parsedN ? Math.round((100 * parsedSupMvp) / parsedN) + '%' : '-',
      dmgLeaderIsNotMvpShare: parsedN ? Math.round((100 * parsedDmgLeaderNotMvp) / parsedN) + '%' : '-',
    },
    avgScore_support: avg(supScores),
    avgScore_core: avg(coreScores),
    supportMvpMatches: supMvpMatches,
  }, null, 2));
})();
