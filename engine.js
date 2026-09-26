/*
 * КТО ЗАРУНИЛ? — движок вердиктов.
 * Чистые функции без DOM: на вход объект матча OpenDota, на выход — структура для рендера.
 * Работает и для распарсенных матчей (варды, бенчмарки), и для «сырых» (только базовая статистика).
 */
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sum = (arr, f) => arr.reduce((acc, x) => acc + (f(x) || 0), 0);
  const pct = (x) => Math.round(x * 100) + '%';

  // Позиции для подписи в таблице: мид определяется лайном, керри — лучший фарм среди не-мидов,
  // саппорты — нижние две позиции по GPM. lane_role у OpenDota — это ЛАЙН (1 изи, 2 мид, 3 хард),
  // поэтому «оба саппорта на изи-лейне» нельзя подписывать по лайну как «Керри».
  const POS_LABELS = { 4: 'Саппорт (4)', 5: 'Фулл-саппорт (5)' };

  // Предметы, по которым смотрим тайминги (и которые поздно покупать после 30-й минуты)
  const LATE_ITEMS = [
    'black_king_bar', 'blink', 'battlefury', 'radiance', 'manta', 'aghanims_scepter',
    'butterfly', 'monkey_king_bar', 'satanic', 'abyssal_blade', 'heart', 'assault',
  ];

  const ITEM_ALIASES = {
    black_king_bar: 'BKB', blink: 'Blink Dagger', battlefury: 'Battle Fury', radiance: 'Radiance',
    manta: 'Manta Style', aghanims_scepter: 'Aghanim', aghanims_shard: 'Shard',
    butterfly: 'Butterfly', monkey_king_bar: 'MKB', satanic: 'Satanic', abyssal_blade: 'Abyssal Blade',
    heart: 'Heart', assault: 'Assault Cuirass', greater_crit: 'Daedalus', skadi: 'Eye of Skadi',
    silver_edge: 'Silver Edge', invis_sword: 'Shadow Blade', travel_boots: 'Travels',
    force_staff: 'Force Staff', guardian_greaves: 'Greaves', pipe: 'Pipe', aegis: 'Aegis',
  };

  // Ролевые ожидания: типичная доля урона/вышек по рангу фарма (1 = самый фарм).
  // MVP-скор сравнивает игрока с нормой ЕГО роли, а не с абсолютной шкалой кора.
  const EXPECT_DMG = [0.30, 0.27, 0.22, 0.13, 0.08];
  const EXPECT_TOWER = [0.32, 0.26, 0.24, 0.10, 0.08];

  function itemLabel(key) {
    if (ITEM_ALIASES[key]) return ITEM_ALIASES[key];
    return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function fmtDur(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function isRadiant(p) { return p.player_slot < 128; }

  // ---------- Главная точка входа ----------

  function analyze(match) {
    const duration = match.duration || 0;
    const all = match.players || [];
    if (!all.length) return null;

    const hasWardData = all.some((p) => ((p.obs_placed || 0) + (p.sen_placed || 0)) > 0);
    const hasStackData = all.some((p) => (p.camps_stacked || 0) > 0);

    const teams = {};
    for (const side of ['radiant', 'dire']) {
      teams[side] = buildTeam(all.filter((p) => isRadiant(p) === (side === 'radiant')), duration, hasWardData, hasStackData);
    }

    const winner = match.radiant_win ? 'radiant' : 'dire';
    const loser = match.radiant_win ? 'dire' : 'radiant';

    const losers = teams[loser].players;
    const ruiner = losers.reduce((a, b) => (b.ruin.score > a.ruin.score ? b : a), losers[0]);
    const collective = ruiner.ruin.score < 35; // яркого руинера нет — виновата вся команда

    const winners = teams[winner].players;
    let fakeInnocent = winners.reduce((a, b) => (b.ruin.score > a.ruin.score ? b : a), winners[0]);
    if (fakeInnocent.ruin.score < 40) fakeInnocent = null; // «дисциплинарное замечание» победившим

    const supports = ['radiant', 'dire'].flatMap((s) => teams[s].players).filter((p) => p.isSupport);
    const bestSupport = supports.length ? supports.reduce((a, b) => (b.mvp > a.mvp ? b : a), supports[0]) : null;

    const medals = assignMedals(teams, hasWardData, hasStackData, winner, loser);
    if (!collective) addMedal(medals, ruiner, '🔨', 'Виновник проигрыша');
    if (bestSupport) addMedal(medals, bestSupport, '🧤', 'Лучший саппорт матча');

    return {
      duration,
      winner,
      loser,
      teams,
      ruiner,
      collective,
      mvpWinner: teams[winner].mvp,
      mvpLoser: teams[loser].mvp,
      bestSupport,
      fakeInnocent,
      medals,
      moments: keyMoments(match),
      hasWardData,
      parsed: Array.isArray(match.radiant_gold_adv) && match.radiant_gold_adv.length > 5,
    };
  }

  // ---------- Команда ----------

  function buildTeam(rawPlayers, duration, hasWardData, hasStackData) {
    const n = rawPlayers.length || 1;
    const t = {
      kills: sum(rawPlayers, (p) => p.kills),
      deaths: sum(rawPlayers, (p) => p.deaths),
      hero_damage: sum(rawPlayers, (p) => p.hero_damage),
      tower_damage: sum(rawPlayers, (p) => p.tower_damage),
      hero_healing: sum(rawPlayers, (p) => p.hero_healing),
      gpm: sum(rawPlayers, (p) => p.gold_per_min) / n,
      xpm: sum(rawPlayers, (p) => p.xp_per_min) / n,
      players: [],
    };
    t.wards = hasWardData ? sum(rawPlayers, (p) => (p.obs_placed || 0) + (p.sen_placed || 0)) : null;

    // Саппорты = нижняя половина команды по GPM, но мид (lane_role 2) саппортом не бывает —
    // иначе подпись «Мид» конфликтует с подсчётом его как саппорта в скоринге
    const byGpm = [...rawPlayers].sort((a, b) => (a.gold_per_min || 0) - (b.gold_per_min || 0));
    const wanted = Math.max(1, Math.floor(n / 2));
    const supportSlots = new Set();
    for (const p of byGpm) {
      if (supportSlots.size >= wanted) break;
      if (p.lane_role === 2) continue;
      supportSlots.add(p.player_slot);
    }
    // ранг фарма: 1 = самый богатый по GPM
    const rankBySlot = new Map(byGpm.map((p, i) => [p.player_slot, n - i]));

    t.players = rawPlayers.map((p) => decorate(p, t, duration, hasWardData, hasStackData, supportSlots.has(p.player_slot), rankBySlot.get(p.player_slot) || 3));

    // Позиционные подписи: мид — по лайну, керри — лучший фарм среди не-мидов,
    // саппорты — нижние две позиции по GPM
    const mids = t.players.filter((p) => p.raw.lane_role === 2);
    const rest = t.players.filter((p) => p.raw.lane_role !== 2).sort((a, b) => b.gpm - a.gpm);
    mids.forEach((p) => { p.laneRole = 'Мид (2)'; });
    if (rest[0]) rest[0].laneRole = 'Керри (1)';
    rest.slice(1).forEach((p) => {
      p.laneRole = p.farmRank >= 4
        ? POS_LABELS[p.farmRank]
        : p.farmRank === 3 || p.raw.lane_role === 3 ? 'Оффлейн (3)'
        : p.farmRank === 2 ? 'Мид (2)' // без данных о лайнах вторая позиция по фарму — почти всегда мид
        : 'Кор';
    });

    for (const pl of t.players) {
      pl.ruin = ruinOf(pl, t, duration, hasWardData);
      const m = mvpParts(pl, t, hasWardData);
      pl.mvp = m.score;
      pl.mvpParts = m.parts;
    }
    t.mvp = t.players.reduce((a, b) => (b.mvp > a.mvp ? b : a), t.players[0]);
    return t;
  }

  function decorate(p, t, duration, hasWardData, hasStackData, isSupport, farmRank) {
    const wards = hasWardData ? (p.obs_placed || 0) + (p.sen_placed || 0) : null;
    const rank = Math.min(Math.max(farmRank || 3, 1), 5);
    return {
      raw: p,
      slot: p.player_slot,
      heroId: p.hero_id,
      accountId: p.account_id || null,
      nick: p.name || p.personaname || (p.account_id ? 'Игрок ' + p.account_id : 'Аноним'),
      isSupport,
      farmRank: rank,
      expectedDmg: EXPECT_DMG[rank - 1],
      expectedTower: EXPECT_TOWER[rank - 1],
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      assists: p.assists || 0,
      gpm: p.gold_per_min || 0,
      xpm: p.xp_per_min || 0,
      level: p.level || 0,
      lastHits: p.last_hits || 0,
      heroDamage: p.hero_damage || 0,
      towerDamage: p.tower_damage || 0,
      healing: p.hero_healing || 0,
      wards,
      stacks: hasStackData ? p.camps_stacked || 0 : null,
      leaver: (p.leaver_status || 0) >= 2,
      laneRole: 'Кор',
      teamKills: t.kills,
      kda: p.deaths ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists),
      participation: t.kills > 0 ? (p.kills + p.assists) / t.kills : 0,
      deathsShare: t.deaths > 0 ? (p.deaths || 0) / t.deaths : 0,
      dmgShare: t.hero_damage > 0 ? (p.hero_damage || 0) / t.hero_damage : 0,
      towerShare: t.tower_damage > 0 ? (p.tower_damage || 0) / t.tower_damage : 0,
      healShare: t.hero_healing > 0 ? (p.hero_healing || 0) / t.hero_healing : 0,
      wardShare: t.wards > 0 ? wards / t.wards : 0,
      gpmRatio: t.gpm > 0 ? (p.gold_per_min || 0) / t.gpm : 1,
      xpmRatio: t.xpm > 0 ? (p.xp_per_min || 0) / t.xpm : 1,
      benchmarks: p.benchmarks || null,
    };
  }

  // ---------- Индекс руинера ----------
  // Каждый фактор — вклад 0..1 с весом; сумма делится на 4.2 (калибровка: закоренелый руинер ~100%).

  function ruinOf(pl, t, duration, hasWardData) {
    const comps = [];

    if (pl.leaver) {
      comps.push({ key: 'leaver', v: 1, w: 3, text: 'вышел из игры или стоял АФК — катка слита в прямом смысле' });
    }

    const feed = clamp((pl.deathsShare - 0.22) / 0.26, 0, 1);
    if (feed > 0.15) {
      comps.push({
        key: 'feed', v: feed, w: 1.6,
        text: `умер ${pl.deaths} ${plural(pl.deaths, 'раз', 'раза', 'раз')} — это ${pct(pl.deathsShare)} всех смертей команды`,
      });
    }

    if (t.kills > 0) {
      const ghost = clamp((0.38 - pl.participation) / 0.33, 0, 1);
      if (ghost > 0.15) {
        comps.push({
          key: 'ghost', v: ghost, w: 1.3,
          text: `участие в убийствах: ${pct(pl.participation)} — играл в собственный соло-квест`,
        });
      }
    }

    let greedy = 0;
    if (pl.gpmRatio > 1.12 && pl.participation < 0.45) {
      greedy = clamp((pl.gpmRatio - 1.12) / 0.5, 0, 1) * clamp((0.45 - pl.participation) / 0.3, 0, 1);
    }
    if (greedy > 0.15) {
      comps.push({
        key: 'greedy', v: greedy, w: 1.0,
        text: `${pl.gpm} GPM — выше среднего по команде, но в драках его не встречали`,
      });
    }

    let fakeCarry = 0;
    if (!pl.isSupport && pl.gpmRatio > 0.95 && pl.dmgShare < 0.55 * pl.expectedDmg) {
      fakeCarry = clamp((0.55 * pl.expectedDmg - pl.dmgShare) / (0.4 * pl.expectedDmg), 0, 1);
    }
    if (fakeCarry > 0.2) {
      comps.push({
        key: 'fakecarry', v: fakeCarry, w: 1.0,
        text: `забрал долю ресурсов кора, а урона дал ${pct(pl.dmgShare)} при норме ${pct(pl.expectedDmg)} для его роли`,
      });
    }

    if (pl.isSupport && hasWardData && pl.wards <= 2) {
      comps.push({
        key: 'wards', v: pl.wards === 0 ? 1 : 0.6, w: 0.9,
        text: `поставил ${pl.wards === 0 ? 'ноль' : pl.wards} ${plural(pl.wards, 'вард', 'варда', 'вардов')} за ${fmtDur(duration)} — команда играла вслепую`,
      });
    }

    const dmgPct = pl.benchmarks && pl.benchmarks.hero_damage_per_min && pl.benchmarks.hero_damage_per_min.pct;
    if (typeof dmgPct === 'number' && dmgPct < 0.08) {
      comps.push({
        key: 'bench', v: 1, w: 1.2,
        text: `по урону в минуту хуже ${Math.round((1 - dmgPct) * 100)}% игроков его уровня на этом герое`,
      });
    }

    // Поздние ключевые предметы:_core собрал BKB/Radiance, когда катка уже решилась
    if (!pl.isSupport && pl.raw && pl.raw.first_purchase_time && duration > 2100) {
      let worst = null;
      for (const key of LATE_ITEMS) {
        const t = pl.raw.first_purchase_time[key];
        if (typeof t === 'number' && t > 1800 && (!worst || t > worst.t)) worst = { key, t };
      }
      if (worst) {
        comps.push({
          key: 'lateitem', v: clamp((worst.t - 1800) / 900, 0, 1), w: 0.7,
          text: `ключевой предмет (${itemLabel(worst.key)}) появился только на ${fmtDur(worst.t)} — поздновато`,
        });
      }
    }

    const total = comps.reduce((a, c) => a + c.v * c.w, 0);
    const score = Math.min(100, Math.round((100 * total) / 4.2));
    comps.forEach((c) => { c.share = total > 0 ? Math.round((100 * c.v * c.w) / total) : 0; });
    comps.sort((a, b) => b.v * b.w - a.v * a.w);
    return { score, comps };
  }

  // ---------- MVP-скор ----------
  // Ролево-нейтральный: и кору, и саппорту можно набрать максимум на своём профиле.
  // Возвращаем и полную разбивку по факторам — «почему именно он», а не только итог.

  function mvpParts(pl, t, hasWardData) {
    let vision;
    if (pl.isSupport && hasWardData) {
      vision = { key: 'wards', label: 'Доля вардов команды', val: pl.wardShare, target: 0.35, max: 10, disp: pct(pl.wardShare) };
    } else if (pl.isSupport) {
      // без парса реплея вардов нет — не наказываем саппорта слепо, даём нейтральные 5/10
      vision = { key: 'wards_na', label: 'Варды (нет данных)', val: 0.5, target: 1, max: 10, disp: 'нейтрально' };
    } else {
      const delta = Math.round((pl.xpmRatio - 1) * 100);
      vision = { key: 'xpm', label: 'Опыт против среднего команды', val: pl.xpmRatio, target: 1.2, max: 10, disp: (delta >= 0 ? '+' : '') + delta + '% к среднему' };
    }
    const defs = [
      { key: 'part', label: 'Участие в убийствах', val: pl.participation, target: 0.65, max: 34, disp: pct(pl.participation) },
      { key: 'dmg', label: 'Урон относительно роли', val: pl.dmgShare / pl.expectedDmg, target: 1, max: 22, disp: pct(pl.dmgShare) + ' при норме ' + pct(pl.expectedDmg) },
      { key: 'tower', label: 'Вышки относительно роли', val: pl.towerShare / pl.expectedTower, target: 1, max: 12, disp: pct(pl.towerShare) + ' при норме ' + pct(pl.expectedTower) },
      { key: 'heal', label: 'Доля лечения', val: pl.healShare, target: 0.40, max: 10, disp: pct(pl.healShare) },
      { key: 'kda', label: 'KDA', val: pl.kda, target: 5, max: 12, disp: String(Math.round(pl.kda * 10) / 10) },
      vision,
    ];
    const parts = defs.map((d) => ({
      key: d.key,
      label: d.label,
      display: d.disp,
      pts: Math.round(d.max * clamp(d.val / d.target, 0, 1)),
      max: d.max,
    }));
    return { score: parts.reduce((a, p) => a + p.pts, 0), parts };
  }

  // ---------- Медали ----------

  function addMedal(medals, pl, emoji, title) {
    const arr = medals.get(pl.slot) || [];
    arr.push({ emoji, title });
    medals.set(pl.slot, arr);
  }

  function assignMedals(teams, hasWardData, hasStackData, winner, loser) {
    const all = ['radiant', 'dire'].flatMap((s) => teams[s].players);
    const medals = new Map();
    const bestBy = (fn) => [...all].sort((a, b) => fn(b) - fn(a))[0];

    const deathsMax = bestBy((p) => p.deaths);
    if (deathsMax.deaths >= 8) addMedal(medals, deathsMax, '🍖', 'Корм матча');

    const partMin = [...all].filter((p) => p.teamKills > 3).sort((a, b) => a.participation - b.participation)[0];
    if (partMin && partMin.participation < 0.3) addMedal(medals, partMin, '👻', 'Призрак');

    for (const s of ['radiant', 'dire']) {
      const t = teams[s];
      if (t.kills < 3) continue;
      const topFarm = [...t.players].sort((a, b) => b.gpm - a.gpm)[0];
      if (topFarm && topFarm.participation < 0.4 && topFarm.gpm > 0) addMedal(medals, topFarm, '🌿', 'Фермер-отшельник');
    }

    const towerMax = bestBy((p) => p.towerShare);
    if (towerMax.towerShare >= 0.4 && towerMax.towerDamage > 1000) addMedal(medals, towerMax, '🏰', 'Разрушитель');

    const healMax = bestBy((p) => p.healing);
    if (healMax.healing > 2000) addMedal(medals, healMax, '💉', 'Главврач');

    if (hasWardData) {
      const wardMax = bestBy((p) => p.wards || 0);
      if (wardMax.wards >= 10) addMedal(medals, wardMax, '👁', 'Вард-мастер');
    }
    if (hasStackData) {
      const stackMax = bestBy((p) => p.stacks || 0);
      if (stackMax.stacks >= 12) addMedal(medals, stackMax, '🌳', 'Лесник (стакал всем campы)');
    }

    const dmgMax = bestBy((p) => p.dmgShare);
    if (dmgMax.dmgShare >= 0.3) addMedal(medals, dmgMax, '⚔️', 'Мясник');

    all.filter((p) => p.leaver).forEach((p) => addMedal(medals, p, '🚪', 'Дезертир'));

    addMedal(medals, teams[winner].mvp, '🏆', 'MVP катки');

    const sortedLosers = [...teams[loser].players].sort((a, b) => b.mvp - a.mvp);
    if (sortedLosers[0].mvp - ((sortedLosers[1] && sortedLosers[1].mvp) || 0) >= 12) {
      addMedal(medals, sortedLosers[0], '🎯', '1-в-9');
    }
    return medals;
  }

  // ---------- Ключевые моменты ----------
  // Ищем резкие скачки перевеса золота (>=1600 за минуту) и выясняем,
  // кто умер на этой волне и «подарил» золото команде-сопернику.

  function buildDeaths(match) {
    const out = [];
    (match.players || []).forEach((p, i) => {
      if (Array.isArray(p.deaths_log)) {
        for (const d of p.deaths_log) out.push({ time: d.time, victimIdx: i });
      }
    });
    return out.sort((a, b) => a.time - b.time);
  }

  function keyMoments(match) {
    const adv = match.radiant_gold_adv;
    if (!Array.isArray(adv) || adv.length < 3) return [];
    const deaths = buildDeaths(match);

    const cands = [];
    for (let i = 1; i < adv.length; i++) {
      const delta = adv[i] - adv[i - 1];
      if (Math.abs(delta) >= 1600) cands.push({ minute: i, delta });
    }
    cands.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const picked = [];
    for (const c of cands) {
      if (picked.length >= 4) break;
      if (picked.some((p) => Math.abs(p.minute - c.minute) < 2)) continue; // не дублируем соседние минуты
      picked.push(c);
    }

    return picked.sort((a, b) => a.minute - b.minute).map((c, idx) => {
      const toward = c.delta > 0 ? 'radiant' : 'dire';
      const lo = (c.minute - 1) * 60, hi = (c.minute + 1) * 60;
      const counts = new Map();
      for (const d of deaths) {
        if (d.time < lo || d.time >= hi) continue;
        const victim = match.players[d.victimIdx];
        if (!victim || (victim.player_slot < 128) === (toward === 'radiant')) continue; // кормит та команда, что теряет золото
        const e = counts.get(d.victimIdx) || {
          heroId: victim.hero_id,
          nick: victim.name || victim.personaname || 'Аноним',
          count: 0,
        };
        e.count++;
        counts.set(d.victimIdx, e);
      }
      return {
        n: idx + 1,
        minute: c.minute,
        delta: c.delta,
        toward,
        victims: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 2),
      };
    });
  }

  // ---------- Разбор игрока: статистика последних каток + советы ----------
  // На вход: { recent: последние матчи OpenDota, heroes: агрегат по героям, heroesMap: id → герой }

  function analyzePlayer(input) {
    const recent = (input.recent || []).filter((m) => m && m.duration > 900).slice(0, 20);
    if (!recent.length) return null;
    const heroName = (id) =>
      (input.heroesMap && input.heroesMap[id] && input.heroesMap[id].localized_name) || 'герой #' + id;
    const isWin = (m) => (m.player_slot < 128) === !!m.radiant_win;
    const games = recent.length;
    const wins = recent.filter(isWin).length;
    const avg = (f) => recent.reduce((a, m) => a + (f(m) || 0), 0) / games;
    const round1 = (x) => Math.round(x * 10) / 10;

    const kills = avg((m) => m.kills);
    const deaths = avg((m) => m.deaths);
    const assists = avg((m) => m.assists);
    const gpm = avg((m) => m.gold_per_min);
    const lh10 = avg((m) => ((m.last_hits || 0) * 600) / m.duration);
    const avgDur = avg((m) => m.duration);

    const solo = recent.filter((m) => m.party_size === 1);
    const party = recent.filter((m) => (m.party_size || 1) > 1);
    const wr = (arr) => (arr.length >= 3 ? arr.filter(isWin).length / arr.length : null);
    const soloWr = wr(solo);
    const partyWr = wr(party);

    let streak = 0; // текущая серия поражений (свежие матчи в начале)
    for (const m of recent) {
      if (!isWin(m)) streak++;
      else break;
    }

    const pool = (input.heroes || []).filter((h) => h.games >= 5).sort((a, b) => b.games - a.games).slice(0, 15);
    let bestHero = null;
    for (const h of pool) {
      if (!bestHero || h.win / h.games > bestHero.win / bestHero.games) bestHero = h;
    }

    const advice = [];
    if (streak >= 3) {
      advice.push({ icon: '🧊', title: 'Сделай паузу', text: 'Последние ' + streak + ' каток — поражения. Тильт — не миф: после серии лоссов винрейт падает у всех. Выйди из очереди, попей воды, вернись завтра.' });
    }
    if (deaths >= 8) {
      advice.push({ icon: '💀', title: 'Меньше умирать', text: 'В среднем ' + round1(deaths) + ' смертей за катку. Каждая смерть — золото и опыт врагу. Перед тем как заходить на героя, посмотри на миникарту: телепорт врага там уже нарисован.' });
    } else if (deaths >= 6.5) {
      advice.push({ icon: '💀', title: 'Держи смерти ниже шести', text: round1(deaths) + ' смертей в среднем — на грани. Хороший ориентир для любого ранга: не больше 6 за катку.' });
    }
    if (lh10 < 38 && gpm < 500) {
      advice.push({ icon: '🌾', title: 'Прокачай фарм', text: '~' + Math.round(lh10) + ' ластхитов к 10-й минуте и ' + Math.round(gpm) + ' GPM. Десять минут фарма в демо-режиме перед сессией дают больше, чем три катки на автомате.' });
    }
    if (bestHero && bestHero.win / bestHero.games >= 0.55) {
      advice.push({ icon: '🎯', title: 'Играй на своём', text: heroName(bestHero.hero_id) + ': ' + Math.round((100 * bestHero.win) / bestHero.games) + '% побед за ' + bestHero.games + ' игр — твой лучший герой. Пикай его чаще, модные мета-спеки подождут.' });
    }
    if (soloWr !== null && partyWr !== null && Math.abs(soloWr - partyWr) >= 0.15) {
      advice.push(soloWr > partyWr
        ? { icon: '🧍', title: 'Соло — твой формат', text: 'В одиночку ' + pct(soloWr) + ' побед, со стаком ' + pct(partyWr) + '. Парадокс, но статистика именно такая.' }
        : { icon: '🤝', title: 'Найди стак', text: 'Со стаком ' + pct(partyWr) + ' побед, в соло ' + pct(soloWr) + '. Разница в ' + Math.round(Math.abs(soloWr - partyWr) * 100) + ' п.п. — это не случайность.' });
    }
    if (avgDur > 45 * 60 && wins / games < 0.45) {
      advice.push({ icon: '⏱', title: 'Заканчивай раньше', text: 'Катки длятся в среднем ' + Math.round(avgDur / 60) + ' минут, а побед меньше половины. Поздняя игра — лотерея: решай, пока преимущество ещё на твоей стороне.' });
    }
    if (!advice.length) {
      advice.push({ icon: '📈', title: 'Держи курс', text: 'Явных провалов в статистике нет — побеждать мешают мелочи. Посмотри реплеи своих смертей без обзора: обычно эти проценты винрейта и лежат там.' });
    }

    const winrate = wins / games;
    const verdict = winrate >= 0.55
      ? 'Форма отменная. Суд фиксирует: можно смело поднимать MMR.'
      : winrate >= 0.45
      ? 'Стабильный середняк. Решают мелочи — они перечислены ниже.'
      : winrate >= 0.35
      ? 'Винрейт ниже воды. Начни с одного пункта из списка — не со всех сразу.'
      : 'Комиссия рекомендует: тренировочный режим, вода, сон. И один пункт из списка.';

    return {
      games, wins, losses: games - wins, winrate,
      kills: round1(kills), deaths: round1(deaths), assists: round1(assists),
      kda: round1(deaths ? (kills + assists) / deaths : kills + assists),
      gpm: Math.round(gpm), lh10: Math.round(lh10),
      avgDur: Math.round(avgDur / 60),
      soloWr, partyWr, streak, bestHero, advice, verdict,
    };
  }

  const api = { analyze, fmtDur, plural, pct, itemLabel, analyzePlayer };
  root.DotaVerdict = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
