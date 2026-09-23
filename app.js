/*
 * КТО ЗАРУНИЛ? — клиент: OpenDota API, рендер вердикта, график перевеса.
 */
(function () {
  'use strict';

  const API = 'https://api.opendota.com/api';
  const $ = (s) => document.querySelector(s);

  const HERO_IMG = (h) =>
    h && h.name
      ? 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/' +
        h.name.replace('npc_dota_hero_', '') + '.png'
      : '';

  const MODES = {
    1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft', 4: 'Single Draft',
    5: 'All Random', 12: 'Least Played', 18: 'Ability Draft', 20: 'All Draft',
    21: 'Solo Mid', 22: 'Ranked All Pick', 23: 'Turbo',
  };

  const LOADING_LINES = [
    'Опрашиваем свидетелей. Крипы отказываются говорить...',
    'Сверяем показания с хронологией вардов...',
    'Считаем смерти. Их много. Продолжаем считать...',
    'Проверяем алиби оффлейнера...',
    'Ищем, кто фармил, пока команда умирала...',
    'Суд удаляется на совещание...',
  ];

  const HEADLINES = {
    leaver: ['Нажал «Покинуть игру» — и на боль всей команды.', 'Катка была слита в прямом эфире, без метафор.'],
    feed: ['Кормил вражеский керри как родного.', 'Смертей больше, чем идей за весь драфт.'],
    ghost: ['В командной игре выбрал соло-квест.', 'Играл рядом с командой. Но не вместе.'],
    greedy: ['Фармил джунгли, пока команда умирала.', 'Крипы помнят его лучше, чем тиммейты.'],
    fakecarry: ['Шесть слотов урона... не, не слышал.', 'Голда была. Урона не дождались.'],
    wards: ['Карта — терра инкогнита. Спасибо, саппорт.', 'Вардинг — это миф, решил он.'],
    bench: ['Показатели такие, будто он играл за другую команду.', 'Играл так, будто ставил на врагов.'],
    default: ['Вклад в поражение: значительный и разнообразный.', 'Это была работа всей его жизни.'],
  };

  const PRAISE_HIGH = ['Тащил так, что статистика плачет.', 'На нём держалась вся катка. И не прогнулась.'];
  const PRAISE_MID = ['Держал катку на себе, сколько мог.', 'Боец. Жаль, что не всем коллективом.'];
  const PRAISE_LOW = ['Сделал, что мог. Катка решила иначе.', 'Старание зачтено. Результат — нет.'];
  const SUPPORT_PRAISE = [
    'Варды — это тоже урон. По нервам врага.',
    'Пока коры считали ластхиты, он считал руны и тайминги.',
    'Смоки есть, варды стоят, тиммейты целы. Почти.',
    'Сало, стан, спасение — всё по расписанию.',
  ];

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n || 0));

  const heroSafe = (heroes, id) => (heroes[id] || { localized_name: 'Герой #' + id }).localized_name;

  function pickQuote(pools, key, seed) {
    const arr = pools[key] || pools.default;
    let h = 0;
    const s = String(seed == null ? '' : seed);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return arr[h % arr.length];
  }

  // ---------- API ----------

  async function loadHeroes() {
    try {
      const cached = JSON.parse(localStorage.getItem('dv_heroes') || 'null');
      if (cached && Date.now() - cached.t < 7 * 864e5) return cached.m;
      const list = await fetchJSON(API + '/heroes');
      const m = {};
      for (const h of list || []) m[h.id] = h;
      localStorage.setItem('dv_heroes', JSON.stringify({ t: Date.now(), m }));
      return m;
    } catch (e) {
      return {};
    }
  }

  const matchCache = new Map();

  async function loadItems() {
    try {
      const cached = JSON.parse(localStorage.getItem('dv_items') || 'null');
      if (cached && Date.now() - cached.t < 7 * 864e5) return cached.m;
      const m = await fetchJSON(API + '/constants/item_ids');
      localStorage.setItem('dv_items', JSON.stringify({ t: Date.now(), m }));
      return m || {};
    } catch (e) {
      return {};
    }
  }

  const itemImg = (key) =>
    'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/items/' + key + '.png';

  // Кандидаты прокси: свой путь (страница открыта с локального сервера) и фиксированный порт
  // на этой же машине. https-страницы могут ходить на http://127.0.0.1 (loopback-исключение),
  // поэтому даже живой сайт на GitHub Pages пользуется локальным кэширующим сервером, если он запущен.
  const PROXY_CANDIDATES = [];
  if (/^https?:$/.test(location.protocol) && ['127.0.0.1', 'localhost'].indexOf(location.hostname) !== -1) {
    PROXY_CANDIDATES.push(location.origin + '/opendota/api');
  }
  PROXY_CANDIDATES.push('http://127.0.0.1:8765/opendota/api');
  let proxyBase = null;
  let proxyProbed = false;

  const isNetErr = (e) => !e || e.name === 'AbortError' || e instanceof TypeError;

  async function tryFetchJSON(url, timeoutMs, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function findProxy() {
    if (proxyProbed) return proxyBase;
    proxyProbed = true;
    for (const base of PROXY_CANDIDATES) {
      try {
        await tryFetchJSON(base + '/heroes', 2500);
        proxyBase = base;
        break;
      } catch (e) { /* пробуем следующий кандидат */ }
    }
    return proxyBase;
  }

  async function fetchJSON(url, timeoutMs, opts) {
    timeoutMs = timeoutMs || 20000;
    const base = await findProxy();
    if (base) {
      try {
        return await tryFetchJSON(url.replace('https://api.opendota.com/api', base), timeoutMs, opts);
      } catch (e) {
        if (!isNetErr(e)) throw e; // ошибки API (404, 429...) честно показываем
      }
    }
    try {
      return await tryFetchJSON(url, timeoutMs, opts);
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('OpenDota не ответил за ' + Math.round(timeoutMs / 1000) + ' с — попробуй ещё раз');
      }
      if (e instanceof TypeError) {
        throw new Error('Браузер не смог достучаться до OpenDota (встроенный просмотрщик или блокировщик?). Открой сайт в обычном Chrome/Edge — или запусти start.bat и обнови страницу.');
      }
      throw e;
    }
  }

  async function fetchMatch(id) {
    if (matchCache.has(id)) return matchCache.get(id);
    let match;
    try {
      match = await fetchJSON(API + '/matches/' + id);
    } catch (e) {
      if (/HTTP 404/.test(e.message)) throw new Error('Матч не найден. Проверь ID.');
      if (/HTTP 429/.test(e.message)) throw new Error('OpenDota ограничил запросы (лимит 60 в минуту). Подожди минутку и попробуй снова.');
      throw new Error('Не удалось получить матч: ' + e.message);
    }
    if (!match || !Array.isArray(match.players) || !match.players.length) {
      throw new Error('Матч не найден или данные недоступны.');
    }
    // сверхсвежие матчи OpenDota отдаёт пустыми заглушками — по ним вердикт будет мусором
    const totalKills = (match.radiant_score || 0) + (match.dire_score || 0);
    if (!match.duration || match.duration < 300 || totalKills < 5) {
      throw new Error('Матч ещё не обработан OpenDota — данных нет. Попробуй через пару минут.');
    }
    matchCache.set(id, match);
    return match;
  }

  // ---------- Статус / загрузка ----------

  let loadingTimer = null;
  function showStatus(text, cls) {
    const el = $('#status');
    el.className = 'status ' + (cls || '');
    el.textContent = text;
  }

  function startLoading() {
    let i = 0;
    showStatus('⚖️ ' + LOADING_LINES[0]);
    loadingTimer = setInterval(() => {
      i = (i + 1) % LOADING_LINES.length;
      showStatus('⚖️ ' + LOADING_LINES[i]);
    }, 1900);
    return () => clearInterval(loadingTimer);
  }

  // ---------- Основной сценарий ----------

  async function run() {
    const raw = $('#matchInput').value || '';
    const id = (raw.match(/\d{4,}/) || [])[0];
    if (!id) {
      showStatus('Это не похоже на ID матча. Нужны цифры, например 8123456789.', 'error');
      return;
    }
    const stop = startLoading();
    try {
      const [match, heroes, items] = await Promise.all([fetchMatch(id), loadHeroes(), loadItems()]);
      const verdict = DotaVerdict.analyze(match);
      if (!verdict) throw new Error('Не удалось разобрать данные матча.');
      render(match, verdict, heroes, items);
      history.replaceState(null, '', '?match=' + id);
    } catch (e) {
      showStatus(e.message || 'Что-то пошло не так. Попробуй ещё раз.', 'error');
    } finally {
      stop();
      $('#status').classList.add('hidden');
    }
  }

  async function randomPro() {
    showStatus('Тянем свежую про-катку из архива OpenDota...');
    try {
      const list = await fetchJSON(API + '/proMatches');
      const m = list[Math.floor(Math.random() * Math.min(25, list.length))];
      if (!m || !m.match_id) throw new Error('Список пуст.');
      $('#matchInput').value = m.match_id;
      run();
    } catch (e) {
      showStatus('Не удалось получить про-катки: ' + e.message, 'error');
    }
  }

  async function requestParse(matchId) {
    try {
      const j = await fetchJSON(API + '/request/' + matchId, 20000, { method: 'POST' });
      if (j && j.job) {
        showStatus('Парсинг запрошен у OpenDota. Обычно занимает 1–3 минуты — потом снова нажми «ВЫНЕСТИ ВЕРДИКТ».', 'ok');
      } else {
        showStatus('Не удалось запросить парсинг: ' + ((j && j.error) || 'нет ответа'), 'error');
      }
    } catch (e) {
      showStatus('Не удалось запросить парсинг: ' + e.message, 'error');
    }
  }

  // ---------- Рендер ----------

  function render(match, v, heroes, items) {
    const hero = (id) => heroes[id] || { localized_name: 'Герой #' + id, name: '' };
    const res = $('#result');
    res.innerHTML = [
      bannerHTML(match, v),
      '<div class="cards">' +
        guiltyHTML(match, v, hero, items) +
        mvpCard(v.mvpWinner, 'winner', v, hero, match, items) +
        mvpCard(v.mvpLoser, 'loser', v, hero, match, items) +
        (v.bestSupport ? mvpCard(v.bestSupport, 'support', v, hero, match, items) : '') +
      '</div>',
      chartHTML(match, v, heroes),
      unparsedHTML(match, v),
      '<div class="team-grid">' +
        teamTable('radiant', v, hero) +
        teamTable('dire', v, hero) +
      '</div>',
    ].join('');
    res.classList.remove('hidden');
    drawChart(match, v);
    const parseBtn = document.getElementById('parseBtn');
    if (parseBtn) parseBtn.addEventListener('click', () => requestParse(match.match_id));
    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', () => shareVerdict(match, v, heroes));
  }

  function bannerHTML(match, v) {
    const winnerName = v.winner === 'radiant' ? 'Radiant' : 'Dire';
    const mode = MODES[match.game_mode] || 'Режим ' + match.game_mode;
    const date = match.start_time ? new Date(match.start_time * 1000).toLocaleDateString('ru-RU') : '';
    return (
      '<section class="banner ' + v.winner + '">' +
      '<div class="score"><span class="r">Radiant ' + (match.radiant_score ?? v.teams.radiant.kills) + '</span>' +
      ' : <span class="d">' + (match.dire_score ?? v.teams.dire.kills) + ' Dire</span></div>' +
      '<h2>' + winnerName + ' одерживает победу' + (match.radiant_name && match.dire_name ? ' — ' + (v.winner === 'radiant' ? esc(match.radiant_name) : esc(match.dire_name)) : '') + '</h2>' +
      '<div class="meta">' + mode + ' · ' + DotaVerdict.fmtDur(v.duration) + ' · ' + date + ' · матч ' + match.match_id + '</div>' +
      '<div class="banner-actions"><button id="shareBtn" class="btn primary sm">📤 Поделиться картинкой</button></div>' +
      '</section>'
    );
  }

  // ---------- Разборы «почему» и билды ----------

  const KEY_TIMINGS = [
    'black_king_bar', 'blink', 'battlefury', 'radiance', 'manta', 'aghanims_scepter',
    'aghanims_shard', 'butterfly', 'monkey_king_bar', 'satanic', 'abyssal_blade', 'heart',
  ];

  function buildHTML(pl, items) {
    const raw = pl.raw || {};
    const slotIds = [0, 1, 2, 3, 4, 5].map((i) => raw['item_' + i]).filter((id) => id && items[id]);
    const neutralId = raw.item_neutral;
    const icons = slotIds
      .map((id) =>
        '<img class="item-icon" src="' + itemImg(items[id]) + '" title="' + esc(DotaVerdict.itemLabel(items[id])) + '" alt="">')
      .join('');
    const neutral = neutralId && items[neutralId]
      ? '<img class="item-icon neutral" src="' + itemImg(items[neutralId]) + '" title="Нейтральный: ' + esc(DotaVerdict.itemLabel(items[neutralId])) + '" alt="">'
      : '';
    const timings = [];
    if (raw.first_purchase_time) {
      for (const key of KEY_TIMINGS) {
        const t = raw.first_purchase_time[key];
        if (typeof t === 'number') timings.push({ key, t });
      }
      timings.sort((a, b) => a.t - b.t);
    }
    const timeChips = timings.slice(0, 4)
      .map((x) => '<span class="chip chip-time">' + esc(DotaVerdict.itemLabel(x.key)) + ' ' + DotaVerdict.fmtDur(x.t) + '</span>')
      .join('');
    if (!icons && !timeChips) return '';
    return (
      '<div class="build"><span class="build-label">Снаряжение</span>' +
      '<span class="build-icons">' + icons + neutral + '</span>' +
      (timeChips ? '<span class="build-times">' + timeChips + '</span>' : '') +
      '</div>'
    );
  }

  function whyGuiltyHTML(v, hero) {
    const losers = [...v.teams[v.loser].players].sort((a, b) => b.ruin.score - a.ruin.score);
    const bars = losers
      .map((p) =>
        '<div class="part-row"><span class="part-label">' + esc(hero(p.heroId).localized_name) + '</span>' +
        '<span class="part-bar ruin"><i style="width:' + p.ruin.score + '%"></i></span>' +
        '<span class="part-pts">' + p.ruin.score + '%</span></div>')
      .join('');
    const gap = losers.length > 1 ? losers[0].ruin.score - losers[1].ruin.score : 100;
    const verdict = gap < 10
      ? 'Отрыв от следующего небольшой — суд сомневался, но решение принял.'
      : 'Отрыв очевиден: это не случайный выбор.';
    return (
      '<details class="why" open><summary>Почему именно он?</summary>' + bars +
      '<p class="fineprint">Индекс вины всех игроков проигравшей команды: смерти, участие в драках, фарм без вклада, варды, бенчмарки OpenDota и выход из игры. ' + verdict + '</p></details>'
    );
  }

  function whyMvpHTML(pl, pool, hero) {
    const rows = pl.mvpParts
      .map((p) =>
        '<div class="part-row"><span class="part-label">' + p.label + '</span>' +
        '<span class="part-val">' + p.display + '</span>' +
        '<span class="part-bar"><i style="width:' + Math.round((100 * p.pts) / p.max) + '%"></i></span>' +
        '<span class="part-pts">' + p.pts + '/' + p.max + '</span></div>')
      .join('');
    const others = (pool || []).filter((q) => q !== pl).sort((a, b) => b.mvp - a.mvp);
    const runner = others[0];
    let comp = '';
    if (runner) {
      let best = null;
      for (const p of pl.mvpParts) {
        const rp = runner.mvpParts.find((q) => q.key === p.key);
        if (!rp) continue;
        const d = p.pts - rp.pts;
        if (!best || d > best.d) best = { d, p, rp };
      }
      if (best && best.d > 0) {
        comp =
          '<div class="competitor">Ближайший конкурент — <b>' + esc(hero(runner.heroId).localized_name) +
          '</b> (' + runner.mvp + '%). Решило вот что: ' + best.p.label.toLowerCase() + ' — ' +
          best.p.display + ' против ' + best.rp.display + '.</div>';
      }
    }
    return (
      '<details class="why" open><summary>Почему именно он?</summary>' + rows + comp +
      '<p class="fineprint">Урон и вышки сравниваются с нормой для роли игрока (по фарму), поэтому саппорт с малым уроном не проигрывает автоматически, а кор должен отработать свои ресурсы.</p></details>'
    );
  }

  function guiltyHTML(match, v, hero, items) {
    const rankBlock = whyGuiltyHTML(v, hero);
    if (v.collective) {
      return (
        '<article class="card guilty">' +
        '<div class="card-title">🔨 Виновник проигрыша</div>' +
        '<div class="collective-body">' +
        '<p>Алгоритм перебрал все улики — и яркого руинера не нашёл.</p>' +
        '<p class="quote">«Приговор: коллективная вина. Катку слила вся команда — дружно, организованно, без лишних.»</p>' +
        '</div>' + rankBlock + '</article>'
      );
    }
    const h = hero(v.ruiner.heroId);
    const reasons = v.ruiner.ruin.comps.slice(0, 3)
      .map((c) => '<li>' + c.text + ' <span class="share">— ' + c.share + '% вины</span></li>')
      .join('');
    const quote = pickQuote(HEADLINES, v.ruiner.ruin.comps[0] && v.ruiner.ruin.comps[0].key, match.match_id);
    let footnote = '';
    if (v.fakeInnocent) {
      const fh = hero(v.fakeInnocent.heroId);
      footnote =
        '<div class="footnote">🤡 Дисциплинарное замечание победившим: <b>' + esc(fh.localized_name) +
        '</b> (' + esc(v.fakeInnocent.nick) + ') — ' + (v.fakeInnocent.ruin.comps[0] ? v.fakeInnocent.ruin.comps[0].text : 'статистику испортил') + '.</div>';
    }
    return (
      '<article class="card guilty">' +
      '<div class="card-title">🔨 Виновник проигрыша</div>' +
      '<div class="who"><img src="' + HERO_IMG(h) + '" alt="">' +
      '<div><h3>' + esc(h.localized_name) + '</h3><span class="nick">' + esc(v.ruiner.nick) + '</span></div></div>' +
      '<div class="scorebar"><span>Степень вины</span><div class="bar"><i style="width:' + v.ruiner.ruin.score + '%"></i></div><b>' + v.ruiner.ruin.score + '%</b></div>' +
      (reasons ? '<ul class="reasons">' + reasons + '</ul>' : '') +
      '<p class="quote">«' + esc(quote) + '»</p>' +
      buildHTML(v.ruiner, items) +
      rankBlock +
      footnote +
      '</article>'
    );
  }

  function mvpCard(pl, kind, v, hero, match, items) {
    const h = hero(pl.heroId);
    const cfg =
      kind === 'winner'
        ? { cls: 'mvp-winner', title: '🏆 MVP катки' }
        : kind === 'support'
        ? { cls: 'mvp-support', title: '🧤 Лучший саппорт матча' }
        : { cls: 'mvp-loser', title: '🛡 Лучший из проигравших' };
    const pools = kind === 'support' ? SUPPORT_PRAISE : pl.mvp >= 75 ? PRAISE_HIGH : pl.mvp >= 55 ? PRAISE_MID : PRAISE_LOW;
    const quote = pickQuote({ default: pools }, 'default', match.match_id + ':' + pl.slot + ':' + kind);
    const pool =
      kind === 'support'
        ? ['radiant', 'dire'].flatMap((s) => v.teams[s].players).filter((p) => p.isSupport)
        : v.teams[pl === v.mvpWinner ? v.winner : v.loser].players;
    const chips = [
      '<span class="chip"><b>' + pl.kills + '/' + pl.deaths + '/' + pl.assists + '</b> K/D/A</span>',
      '<span class="chip"><b>' + pl.gpm + '</b> GPM</span>',
      '<span class="chip"><b>' + Math.round(pl.participation * 100) + '%</b> участие</span>',
    ];
    if (kind === 'support') {
      if (pl.wards !== null) chips.push('<span class="chip"><b>' + pl.wards + '</b> вардов</span>');
      if (pl.healing > 1000) chips.push('<span class="chip"><b>' + fmtNum(pl.healing) + '</b> лечения</span>');
    } else {
      chips.push('<span class="chip"><b>' + Math.round(pl.dmgShare * 100) + '%</b> урона команды</span>');
      if (pl.wards !== null) chips.push('<span class="chip"><b>' + pl.wards + '</b> вардов</span>');
    }
    return (
      '<article class="card ' + cfg.cls + '">' +
      '<div class="card-title">' + cfg.title + '</div>' +
      '<div class="who"><img src="' + HERO_IMG(h) + '" alt="">' +
      '<div><h3>' + esc(h.localized_name) + '</h3><span class="nick">' + esc(pl.nick) + '</span></div></div>' +
      '<div class="scorebar"><span>Вклад</span><div class="bar"><i style="width:' + pl.mvp + '%"></i></div><b>' + pl.mvp + '%</b></div>' +
      '<div class="chips">' + chips.join('') + '</div>' +
      buildHTML(pl, items) +
      '<p class="quote">«' + esc(quote) + '»</p>' +
      whyMvpHTML(pl, pool, hero) +
      '</article>'
    );
  }

  function chartHTML(match, v, heroes) {
    if (!v.parsed) return '';
    const sideName = (s) => (s === 'radiant' ? '<b class="r">Radiant</b>' : '<b class="d">Dire</b>');
    const moments = (v.moments || [])
      .map((m) => {
        const victims = m.victims.length
          ? m.victims.map((x) => esc(heroSafe(heroes, x.heroId)) + ' (' + esc(x.nick) + ', ×' + x.count + ')').join(', ')
          : 'без смертей — перевес нафармили';
        return (
          '<div class="moment"><span class="mnum ' + m.toward + '">' + m.n + '</span>' +
          '<span><b>' + m.minute + '-я минута</b>: ' + sideName(m.toward) + ' + ' + fmtNum(Math.abs(m.delta)) +
          ' золота. На волне умерли: ' + victims + '</span></div>'
        );
      })
      .join('');
    return (
      '<article class="card chart-card">' +
      '<div class="card-title">📈 Хронология катки (перевес золота Radiant)</div>' +
      '<canvas id="advChart"></canvas>' +
      (moments ? '<div class="moments">' + moments + '</div>' : '') +
      '</article>'
    );
  }

  function unparsedHTML(match, v) {
    if (v.parsed) return '';
    return (
      '<div class="notice">🕵️ Реплей ещё не распарсен: часть улик (варды, график перевеса, бенчмарки) недоступна. Вердикт вынесен по базовой статистике.' +
      '<button id="parseBtn" class="btn ghost">Запросить парсинг у OpenDota</button></div>'
    );
  }

  function teamTable(side, v, hero) {
    const t = v.teams[side];
    const won = v.winner === side;
    const rows = t.players
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((pl) => {
        const h = hero(pl.heroId);
        const medals = (v.medals.get(pl.slot) || [])
          .map((m) => '<span title="' + esc(m.title) + '">' + m.emoji + '</span>')
          .join(' ');
        let cls = '';
        if (!v.collective && v.loser === side && pl === v.ruiner) cls = ' class="hl-guilty"';
        if (pl === t.mvp) cls = ' class="hl-mvp"';
        const attrs = cls + (pl.accountId ? ' data-account="' + pl.accountId + '" title="Открыть досье игрока"' : '');
        return (
          '<tr' + attrs + '>' +
          '<td class="hero-cell"><img src="' + HERO_IMG(h) + '" alt=""><span>' + esc(h.localized_name) + '</span></td>' +
          '<td class="nick-cell"><span class="nick">' + esc(pl.nick) + '</span><span class="role">' + pl.laneRole + '</span></td>' +
          '<td><b>' + pl.kills + '</b>/' + pl.deaths + '/<b>' + pl.assists + '</b></td>' +
          '<td class="contrib-cell"><span class="contrib-bar"><i style="width:' + pl.mvp + '%"></i></span><span class="contrib-val">' + pl.mvp + '%</span></td>' +
          '<td>' + pl.gpm + '</td>' +
          '<td>' + fmtNum(pl.heroDamage) + '</td>' +
          '<td>' + fmtNum(pl.towerDamage) + '</td>' +
          '<td>' + (pl.wards === null ? '—' : pl.wards) + '</td>' +
          '<td>' + Math.round(pl.participation * 100) + '%</td>' +
          '<td class="medals-cell">' + medals + '</td>' +
          '</tr>'
        );
      })
      .join('');
    return (
      '<article class="card team ' + side + '">' +
      '<div class="card-title">' + (side === 'radiant' ? '☀️ RADIANT' : '🌑 DIRE') + (won ? ' — победа' : ' — поражение') + '</div>' +
      '<table><thead><tr><th>Герой</th><th>Игрок</th><th>K/D/A</th><th title="Вклад: участие в убийствах, доля урона, вышки, лечение, KDA и варды (для саппортов)">Вклад</th><th>GPM</th><th>Урон</th><th>Вышки</th><th>Варды</th><th>Участ.</th><th>Медали</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '</article>'
    );
  }

  // ---------- Досье игрока ----------

  const RANK_TIERS = { 1: 'Herald', 2: 'Guardian', 3: 'Crusader', 4: 'Archon', 5: 'Legend', 6: 'Ancient', 7: 'Divine', 8: 'Immortal' };

  function rankName(t) {
    if (!t) return '';
    const tier = RANK_TIERS[Math.floor(t / 10)];
    if (!tier) return '';
    return tier === 'Immortal' ? 'Immortal' : tier + ' ' + (t % 10);
  }

  function dossierQuote(accused, mvpTotal, n) {
    if (n === 0) return 'Каток не нашлось. Досье пустое — суд разводит руками.';
    if (accused === 0 && mvpTotal > 0) return 'За последние ' + n + ' каток — ни одного обвинения и ' + mvpTotal + ' наград за тащерство. Суд официально впечатлён.';
    if (accused === 0) return 'За последние ' + n + ' каток суд не нашёл, к чему придраться. Подозрительно чисто.';
    if (mvpTotal > accused) return 'Чаще тащит, чем руинит: ' + mvpTotal + ' наград против ' + accused + ' обвинений. Но суд всё помнит.';
    if (accused >= 3) return 'Руинер со стажем: ' + accused + ' из ' + n + ' каток заканчивались обвинением. Дело закрыто.';
    return accused + ' из ' + n + ' каток заканчивались обвинением. Совпадение? Суд так не думает.';
  }

  let dossierToken = 0;

  async function openDossier(accountId, heroes) {
    let box = document.getElementById('dossier');
    if (!box) {
      box = document.createElement('div');
      box.id = 'dossier';
      document.getElementById('result').appendChild(box);
    }
    const token = ++dossierToken;
    box.innerHTML =
      '<article class="card dossier"><div class="card-title">📁 Досье игрока</div>' +
      '<div class="dossier-loading">⚖️ Суд запрашивает материалы дела...</div></article>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const [profile, recent] = await Promise.all([
        fetchJSON(API + '/players/' + accountId).catch(() => null),
        fetchJSON(API + '/players/' + accountId + '/recentMatches').catch(() => null),
      ]);
      if (token !== dossierToken) return;

      const matches = (Array.isArray(recent) ? recent : []).slice(0, 10);
      const loadEl = box.querySelector('.dossier-loading');
      const rows = [];
      let wins = 0, accused = 0, mvpTotal = 0, contribSum = 0, contribN = 0;

      for (let k = 0; k < matches.length; k++) {
        if (token !== dossierToken) return;
        const rm = matches[k];
        const win = rm.player_slot < 128 ? !!rm.radiant_win : !rm.radiant_win;
        const row = { matchId: rm.match_id, heroId: rm.hero_id, win, kda: [rm.kills, rm.deaths, rm.assists], status: '', contrib: null, guilt: null };
        try {
          const m = await fetchMatch(rm.match_id);
          if (token !== dossierToken) return;
          const v = DotaVerdict.analyze(m);
          const dec = v && ['radiant', 'dire'].flatMap((s) => v.teams[s].players).find((q) => q.raw.account_id === accountId);
          if (v && dec) {
            row.contrib = dec.mvp;
            contribSum += dec.mvp;
            contribN++;
            if (!v.collective && v.ruiner.slot === dec.slot) {
              row.status = 'guilty'; row.guilt = dec.ruin.score; accused++;
            } else if (v.mvpWinner.slot === dec.slot) {
              row.status = 'mvp'; mvpTotal++;
            } else if (v.mvpLoser.slot === dec.slot) {
              row.status = 'best'; mvpTotal++;
            }
          }
        } catch (e) { /* матч недоступен — в таблице будет базовая строка */ }
        if (win) wins++;
        rows.push(row);
        if (loadEl && loadEl.isConnected) loadEl.textContent = '⚖️ Изучаю катки: ' + (k + 1) + '/' + matches.length + '...';
      }
      if (token !== dossierToken) return;

      const prof = (profile && profile.profile) || {};
      const rank = rankName(profile && profile.rank_tier);
      const mmr = profile && profile.mmr_estimate && profile.mmr_estimate.estimate ? '· ~' + profile.mmr_estimate.estimate + ' MMR' : '';
      const n = rows.length;
      const contribAvg = contribN ? Math.round(contribSum / contribN) : null;

      const statusLabels = {
        guilty: '<span class="st st-guilty">🔨 Виновник</span>',
        mvp: '<span class="st st-mvp">🏆 MVP</span>',
        best: '<span class="st st-best">🛡 Лучший из проигравших</span>',
      };

      const rowHtml = rows.map((r) => {
        const heroImg = heroes[r.heroId] ? HERO_IMG(heroes[r.heroId]) : '';
        const heroName = heroes[r.heroId] ? esc(heroes[r.heroId].localized_name) : 'Герой #' + r.heroId;
        return (
          '<tr data-goto="' + r.matchId + '">' +
          '<td class="hero-cell">' + (heroImg ? '<img src="' + heroImg + '" alt="">' : '') + '<span>' + heroName + '</span></td>' +
          '<td><span class="wl ' + (r.win ? 'w' : 'l') + '">' + (r.win ? 'Победа' : 'Поражение') + '</span></td>' +
          '<td>' + r.kda[0] + '/' + r.kda[1] + '/' + r.kda[2] + '</td>' +
          '<td class="contrib-cell">' + (r.contrib !== null
            ? '<span class="contrib-bar"><i style="width:' + r.contrib + '%"></i></span><span class="contrib-val">' + r.contrib + '%' + (r.guilt !== null ? ' · вина ' + r.guilt + '%' : '') + '</span>'
            : '<span class="contrib-val">—</span>') + '</td>' +
          '<td>' + (statusLabels[r.status] || '<span class="st">—</span>') + '</td>' +
          '</tr>'
        );
      }).join('');

      box.innerHTML =
        '<article class="card dossier">' +
        '<div class="card-title">📁 Досье игрока</div>' +
        '<div class="dossier-head">' +
        (prof.avatarfull ? '<img class="avatar" src="' + esc(prof.avatarfull) + '" alt="">' : '') +
        '<div class="dossier-id"><h3>' + esc(prof.personaname || 'Игрок ' + accountId) + '</h3>' +
        '<span class="nick">' + [rank, mmr].filter(Boolean).join(' ') + (rank || mmr ? ' · ' : '') + 'последние ' + n + ' каток</span></div>' +
        '<button class="dossier-close" title="Закрыть досье">✕</button>' +
        '</div>' +
        '<div class="chips">' +
        '<span class="chip">Винрейт <b>' + wins + '/' + n + '</b></span>' +
        '<span class="chip">Обвинений <b>' + accused + '</b></span>' +
        '<span class="chip">Наград за тащерство <b>' + mvpTotal + '</b></span>' +
        (contribAvg !== null ? '<span class="chip">Средний вклад <b>' + contribAvg + '%</b></span>' : '') +
        '</div>' +
        '<p class="quote">«' + dossierQuote(accused, mvpTotal, n) + '»</p>' +
        '<table class="dossier-table"><thead><tr><th>Герой</th><th>Итог</th><th>K/D/A</th><th>Вклад</th><th>Роль в катке</th></tr></thead>' +
        '<tbody>' + rowHtml + '</tbody></table>' +
        '</article>';

      box.querySelector('.dossier-close').addEventListener('click', () => box.remove());
      box.querySelectorAll('tr[data-goto]').forEach((tr) =>
        tr.addEventListener('click', () => {
          $('#matchInput').value = tr.dataset.goto;
          run();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        })
      );
    } catch (e) {
      if (token !== dossierToken) return;
      box.innerHTML =
        '<article class="card dossier"><div class="card-title">📁 Досье игрока</div>' +
        '<div class="dossier-loading">Не удалось собрать досье: ' + esc(e.message) + '</div></article>';
    }
  }

  // ---------- Шеринг картинкой ----------

  const LIVE_URL = 'https://leeeeeeeeeemon.github.io/dota-verdict/';

  // Steam-CDN отдаёт CORS только для dota2.com, поэтому портреты для canvas
  // грузим через wsrv.nl (добавляет Access-Control-Allow-Origin: *), с запасным плашечным фолбэком
  const shareImgUrl = (url, w) => 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=' + w + '&output=png';

  function loadImg(src) {
    return new Promise((res) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        res(val);
      };
      const timer = setTimeout(() => finish(null), 5000); // медленный/молчащий CDN не должен вешать генерацию
      img.onload = () => {
        clearTimeout(timer);
        finish(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      img.src = src;
    });
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawPortrait(ctx, img, x, y, w, h, fallbackText) {
    rr(ctx, x, y, w, h, 8);
    ctx.save();
    ctx.clip();
    if (img && img.width) {
      ctx.drawImage(img, x, y, w, h);
    } else {
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#8a93a3';
      ctx.font = '600 ' + Math.round(h * 0.38) + 'px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fallbackText, x + w / 2, y + h / 2 + 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
    rr(ctx, x, y, w, h, 8);
    ctx.strokeStyle = '#26303d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  async function generateShareImage(match, v, heroes) {
    const W = 1200, H = 630;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const F = (weight, size) => weight + ' ' + size + 'px "Segoe UI", system-ui, sans-serif';
    const heroName = (id) => (heroes[id] || {}).localized_name || 'Герой #' + id;
    const initials = (s) => s.split(/\s+/).map((x) => x[0] || '').join('').slice(0, 2).toUpperCase();

    ctx.fillStyle = '#10141a';
    ctx.fillRect(0, 0, W, H);
    let g = ctx.createRadialGradient(120, 0, 0, 120, 0, 720);
    g.addColorStop(0, 'rgba(212,165,69,.15)');
    g.addColorStop(1, 'rgba(212,165,69,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(1200, 630, 0, 1200, 630, 720);
    g.addColorStop(0, 'rgba(224,93,79,.13)');
    g.addColorStop(1, 'rgba(224,93,79,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    rr(ctx, 14, 14, W - 28, H - 28, 26);
    ctx.strokeStyle = 'rgba(212,165,69,.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#d4a545';
    ctx.font = F('700', 42);
    ctx.fillText('⚖️ КТО ЗАРУНИЛ?', 48, 84);
    const rScore = match.radiant_score != null ? match.radiant_score : v.teams.radiant.kills;
    const dScore = match.dire_score != null ? match.dire_score : v.teams.dire.kills;
    ctx.font = F('600', 28);
    const scoreParts = [['Radiant ' + rScore, '#7ec850'], [' : ', '#8a93a3'], [dScore + ' Dire', '#e05d4f']];
    let tx = W - 48 - scoreParts.reduce((a, p) => a + ctx.measureText(p[0]).width, 0);
    for (const [text, color] of scoreParts) {
      ctx.fillStyle = color;
      ctx.fillText(text, tx, 84);
      tx += ctx.measureText(text).width;
    }
    const mode = MODES[match.game_mode] || 'Режим ' + match.game_mode;
    ctx.fillStyle = '#8a93a3';
    ctx.font = F('400', 19);
    ctx.fillText(mode + ' · ' + DotaVerdict.fmtDur(v.duration) + ' · матч ' + match.match_id, 48, 118);

    const need = [v.ruiner, v.mvpWinner, v.bestSupport].filter(Boolean);
    const imgs = await Promise.all(
      need.map((pl) => {
        const h = heroes[pl.heroId];
        return h && h.name ? loadImg(shareImgUrl(HERO_IMG(h), 256)) : Promise.resolve(null);
      })
    );
    const imgOf = new Map(need.map((pl, i) => [pl, imgs[i]]));

    // левая карточка — виновник
    const lx = 48, ly = 148, lw = 610, lh = 356;
    rr(ctx, lx, ly, lw, lh, 20);
    ctx.fillStyle = 'rgba(224,93,79,.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(224,93,79,.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#e05d4f';
    ctx.font = F('700', 20);
    ctx.fillText('🔨 ВИНОВНИК ПРОИГРЫША', lx + 26, ly + 40);
    if (v.collective) {
      ctx.fillStyle = '#cfc9ba';
      ctx.font = F('600', 34);
      ctx.fillText('Коллективная вина', lx + 26, ly + 140);
      ctx.fillStyle = '#8a93a3';
      ctx.font = F('400', 20);
      ctx.fillText('Яркого руинера нет — катку слила вся команда.', lx + 26, ly + 184);
      ctx.fillText('Дружно. Организованно. Без лишних.', lx + 26, ly + 214);
    } else {
      drawPortrait(ctx, imgOf.get(v.ruiner), lx + 26, ly + 64, 128, 72, initials(heroName(v.ruiner.heroId)));
      ctx.fillStyle = '#e8e3d5';
      ctx.font = F('700', 32);
      ctx.fillText(ellipsize(ctx, heroName(v.ruiner.heroId), 300), lx + 174, ly + 102);
      ctx.fillStyle = '#8a93a3';
      ctx.font = F('400', 19);
      ctx.fillText(ellipsize(ctx, v.ruiner.nick, 300), lx + 174, ly + 128);
      const barW = lw - 52;
      rr(ctx, lx + 26, ly + 162, barW, 14, 7);
      ctx.fillStyle = '#0d1117';
      ctx.fill();
      rr(ctx, lx + 26, ly + 162, Math.max(24, (barW * v.ruiner.ruin.score) / 100), 14, 7);
      ctx.fillStyle = '#e05d4f';
      ctx.fill();
      ctx.font = F('700', 20);
      ctx.fillText('СТЕПЕНЬ ВИНЫ ' + v.ruiner.ruin.score + '%', lx + 26, ly + 206);
      ctx.font = F('400', 18);
      ctx.fillStyle = '#cfc9ba';
      v.ruiner.ruin.comps.slice(0, 3).forEach((comp, i) => {
        ctx.fillText('• ' + ellipsize(ctx, comp.text, barW - 24), lx + 26, ly + 244 + i * 32);
      });
    }

    // правые мини-карточки — MVP и лучший саппорт
    const rx = 686, rw = 466, rh = 170;
    const minis = [
      { pl: v.mvpWinner, color: '#d4a545', title: '🏆 MVP КАТКИ', bg: 'rgba(212,165,69,.07)' },
      v.bestSupport ? { pl: v.bestSupport, color: '#4fc3c9', title: '🧤 ЛУЧШИЙ САППОРТ', bg: 'rgba(79,195,201,.07)' } : null,
    ].filter(Boolean);
    minis.forEach((mcard, i) => {
      const my = ly + i * (rh + 16);
      rr(ctx, rx, my, rw, rh, 20);
      ctx.fillStyle = mcard.bg;
      ctx.fill();
      ctx.strokeStyle = mcard.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = mcard.color;
      ctx.font = F('700', 18);
      ctx.fillText(mcard.title, rx + 24, my + 36);
      drawPortrait(ctx, imgOf.get(mcard.pl), rx + 24, my + 56, 96, 54, initials(heroName(mcard.pl.heroId)));
      ctx.fillStyle = '#e8e3d5';
      ctx.font = F('700', 26);
      ctx.fillText(ellipsize(ctx, heroName(mcard.pl.heroId), 190), rx + 136, my + 86);
      ctx.fillStyle = '#8a93a3';
      ctx.font = F('400', 17);
      ctx.fillText(ellipsize(ctx, mcard.pl.nick, 190), rx + 136, my + 110);
      ctx.font = F('400', 14);
      ctx.fillText(mcard.pl.kills + '/' + mcard.pl.deaths + '/' + mcard.pl.assists + ' · ' + mcard.pl.gpm + ' GPM', rx + 136, my + 134);
      ctx.font = F('700', 40);
      ctx.textAlign = 'right';
      ctx.fillText(mcard.pl.mvp + '%', rx + rw - 24, my + 106);
      ctx.font = F('400', 15);
      ctx.fillStyle = '#8a93a3';
      ctx.fillText('вклад', rx + rw - 24, my + 130);
      ctx.textAlign = 'left';
    });

    ctx.strokeStyle = '#26303d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(48, 560);
    ctx.lineTo(1152, 560);
    ctx.stroke();
    ctx.fillStyle = '#d4a545';
    ctx.font = F('600', 20);
    ctx.fillText('leeeeeeeeeemon.github.io/dota-verdict?match=' + match.match_id, 48, 598);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8a93a3';
    ctx.font = F('400', 16);
    ctx.fillText('Вердикт вынесен алгоритмом · это шутка · данные OpenDota', 1152, 598);
    ctx.textAlign = 'left';

    return c;
  }

  async function shareVerdict(match, v, heroes) {
    const btn = document.getElementById('shareBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⚖️ Рисуем приговор...';
    }
    try {
      const canvas = await generateShareImage(match, v, heroes);
      const blob = await new Promise((res, rej) => {
        try {
          canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG не собрался'))), 'image/png');
        } catch (e) {
          rej(e);
        }
      });
      const file = new File([blob], 'verdict-' + match.match_id + '.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'КТО ЗАРУНИЛ?', text: 'Вердикт по матчу ' + match.match_id });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // пользователь закрыл шаринг — не ошибка
      showStatus('Не удалось собрать картинку: ' + e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📤 Поделиться картинкой';
      }
    }
  }

  // ---------- График перевеса ----------

  function drawChart(match, v) {
    const c = document.getElementById('advChart');
    if (!c) return;
    const adv = match.radiant_gold_adv || [];
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth || 900;
    const H = 220;
    c.width = W * dpr;
    c.height = H * dpr;
    ctx.scale(dpr, dpr);
    const pad = { l: 42, r: 12, t: 14, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const maxAbs = Math.max(2000, ...adv.map((x) => Math.abs(x)));
    const y = (val) => pad.t + ih / 2 - (val / maxAbs) * (ih / 2);
    const x = (i) => pad.l + (i / Math.max(1, adv.length - 1)) * iw;

    ctx.strokeStyle = '#2a3240';
    ctx.beginPath();
    ctx.moveTo(pad.l, y(0));
    ctx.lineTo(W - pad.r, y(0));
    ctx.stroke();

    ctx.fillStyle = '#8a93a3';
    ctx.font = '11px system-ui';
    ctx.fillText('+' + fmtNum(maxAbs), 4, pad.t + 10);
    ctx.fillText('-' + fmtNum(maxAbs), 4, H - pad.b);
    ctx.fillText('Radiant ↑', 4, y(0) - 4);

    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    adv.forEach((val, i) => ctx.lineTo(x(i), y(val)));
    ctx.lineTo(x(adv.length - 1), y(0));
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(126,200,80,.28)';
    ctx.fillRect(0, 0, W, y(0));
    ctx.fillStyle = 'rgba(224,93,79,.28)';
    ctx.fillRect(0, y(0), W, H - y(0));
    ctx.restore();

    ctx.beginPath();
    adv.forEach((val, i) => (i ? ctx.lineTo(x(i), y(val)) : ctx.moveTo(x(i), y(val))));
    ctx.strokeStyle = '#e8c56b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // ключевые моменты: пронумерованные точки в цвет команды, получившей перевес
    for (const m of v.moments || []) {
      const mx = x(m.minute);
      const my = y(adv[m.minute]);
      ctx.beginPath();
      ctx.arc(mx, my, 9, 0, Math.PI * 2);
      ctx.fillStyle = m.toward === 'radiant' ? '#7ec850' : '#e05d4f';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0f1216';
      ctx.stroke();
      ctx.fillStyle = m.toward === 'radiant' ? '#0f1a0c' : '#1a0d0b';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(m.n), mx, my + 4);
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#8a93a3';
    for (let m = 0; m < adv.length; m += 10) ctx.fillText(m, x(m) - 4, H - 6);
  }

  // ---------- Инициализация ----------

  document.addEventListener('DOMContentLoaded', () => {
    $('#goBtn').addEventListener('click', run);
    $('#randomBtn').addEventListener('click', randomPro);
    $('#matchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run();
    });
    $('#result').addEventListener('click', async (e) => {
      const tr = e.target.closest('tr[data-account]');
      if (!tr) return;
      const heroes = await loadHeroes();
      openDossier(Number(tr.dataset.account), heroes);
    });
    const fromUrl = new URLSearchParams(location.search).get('match');
    if (fromUrl && /^\d{4,}$/.test(fromUrl)) {
      $('#matchInput').value = fromUrl;
      run();
    }
  });
})();
