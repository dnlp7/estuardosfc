(function () {
  var DATA_URL = 'data.json';
  var HISTORY_DETAIL_URL = 'data-history-detail.json';
  var STAT_TITLES = {
    BALANCE: 'BALANCE',
    GOL: 'GOLES ANOTADOS',
    AST: 'ASISTENCIAS DE GOL',
    PA: 'PARTIDOS ASISTIDOS',
    PI: 'PARTIDOS INICIADOS'
  };
  // Shared by BALANCE mode's leaderboard columns and the Perfil page's
  // career-totals row — one definition so the two never drift apart.
  var STATS_ORDER = ['GOL', 'AST', 'PA', 'PI'];

  // Position colors shared by the PI detailed view and the Equipo tab's
  // TxJ starter pills (once that lands) — matches the real season docs'
  // own convention. White text on every position except SUP, whose
  // dark background needs the dimmer #4c818e instead.
  var POSITION_COLORS_ = {
    POR: { bg: '#f87c23', text: '#ffffff' },
    DEF: { bg: '#f9c204', text: '#ffffff' },
    MED: { bg: '#60d233', text: '#ffffff' },
    DEL: { bg: '#566bf6', text: '#ffffff' },
    SUP: { bg: '#12343d', text: '#4c818e' }
  };
  var CAPTAIN_COLOR_ = { bg: '#a3cb42', text: '#000000' };

  var state = {
    data: null,
    stat: 'BALANCE',
    era: '__all__',
    teamEra: '__all__',      // Equipo tab's own season dropdown — independent of "era" above (Jugadores tab)
    search: '',
    detail: false,           // "Mostrar detalle" toggle — off by default
    historyDetailPromise: null, // lazy-loaded + cached data-history-detail.json fetch
    charts: {},               // canvas id -> live Chart.js instance, see renderChart_
    perfilNombre: null,       // whichever player's profile is currently rendered — lets the stat selector re-render without needing playerId passed back in
    perfilStat: 'BALANCE'     // Perfil page's own BALANCE/GOL/AST/PA/PI selector — independent of "stat" above (the Individuales tab's own selector)
  };

  // ---------------- Color scales ----------------
  // Endpoints live as CSS variables (style.css :root) — read once here so
  // JS and CSS never drift out of sync.
  var COLORS = readCssColors_();
  function readCssColors_() {
    var s = getComputedStyle(document.documentElement);
    function v(name) { return s.getPropertyValue(name).trim(); }
    return {
      scaleBest: v('--scale-best') || '#0b5394',
      greyCell: v('--grey-cell') || '#333333',
      accentLight: v('--accent-light') || '#18a8b6',
      canchaLight: v('--cancha-light') || '#4a86c9',
      canchaDark: v('--cancha-dark') || '#0d2b4a',
      horaLight: v('--hora-light') || '#8a63b3',
      horaDark: v('--hora-dark') || '#2e1a47',
      gcColor: v('--gc-color') || '#8f2eb3',
      // Win/draw/loss — same colors as .result-chip-g/p/e etc. (see
      // style.css), read here too since the all-time balance table's
      // PG/PE/PP/PTS column scales use these as their high-value
      // endpoint via JS, not just a static CSS class.
      good: v('--good') || '#25b659',
      draw: v('--draw') || '#979797',
      bad: v('--bad') || '#ec071e'
    };
  }

  function hexToRgb_(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(h, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  function rgbToHex_(rgb) {
    return '#' + rgb.map(function (v) {
      var n = Math.round(Math.max(0, Math.min(255, v)));
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join('');
  }
  function lerpColor_(hexA, hexB, t) {
    var a = hexToRgb_(hexA), b = hexToRgb_(hexB);
    var tt = Math.max(0, Math.min(1, t));
    return rgbToHex_([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, a[2] + (b[2] - a[2]) * tt]);
  }
  /** Interpolates a color for `value` across [min,max] -> [colorMin,colorMax].
   * A degenerate range (min === max — e.g. only one row on screen)
   * returns the midpoint color rather than arbitrarily favoring either
   * end. Returns null for a non-numeric value (caller should skip the
   * inline style entirely so the cell keeps its default background). */
  function scaleColor_(value, min, max, colorMin, colorMax) {
    var n = Number(value);
    if (isNaN(n)) return null;
    if (min === max) return lerpColor_(colorMin, colorMax, 0.5);
    return lerpColor_(colorMin, colorMax, (n - min) / (max - min));
  }
  function styleAttr_(hex) {
    return hex ? ' style="background:' + hex + '"' : '';
  }

  // ---------------- Charts (GF/GC, Equipo tab) ----------------
  // Both goals charts (all-seasons + per-season-by-jornada) go through
  // this one helper: destroys any previous Chart.js instance on that
  // canvas first (re-rendering the same canvas without doing so throws
  // — Chart.js doesn't allow two live instances on one <canvas>, and
  // this fires on every era-filter change), then creates the new one.
  // `state.charts` keys off the canvas id so the two charts' lifecycles
  // never interfere with each other.
  function renderChart_(canvasId, config) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return; // fail open — a CDN hiccup shouldn't break the rest of the tab
    if (state.charts[canvasId]) state.charts[canvasId].destroy();
    state.charts[canvasId] = new Chart(canvas.getContext('2d'), config);
  }

  // Shared look for both charts — dark tooltip/legend text/grid lines to
  // match the site's own dark theme (Chart.js defaults assume a light
  // page). GF uses COLORS.scaleBest (blue) and GC uses COLORS.gcColor
  // (purple) — the exact same two colors the Balance tables already use
  // for their own GF/GC column scales, so the chart reads as the same
  // "language" rather than introducing a new color pairing.
  function chartBaseOptions_() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#ffffff' } },
        tooltip: { titleColor: '#ffffff', bodyColor: '#ffffff', backgroundColor: '#000000' }
      },
      scales: {
        x: { ticks: { color: '#9a9a9a' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        y: { beginAtZero: true, ticks: { color: '#9a9a9a', precision: 0 }, grid: { color: 'rgba(255,255,255,0.08)' } }
      }
    };
  }

  /** Builds rank/total color-lookup closures for one rendered table's
   * worth of rows — rank 1 (best) -> scale-best, worst rank -> grey;
   * highest total (best) -> scale-best, lowest total -> grey. Recomputed
   * per render since the visible rows (and their min/max) change with
   * search/era filters. */
  function rankTotalStyles_(rows) {
    var ranks = rows.filter(function (r) { return r.rank !== undefined && r.rank !== null; })
      .map(function (r) { return r.rank; });
    var totals = rows.map(function (r) { return Number(r.total) || 0; });
    var maxRank = ranks.length ? Math.max.apply(null, ranks) : 1;
    var minTotal = totals.length ? Math.min.apply(null, totals) : 0;
    var maxTotal = totals.length ? Math.max.apply(null, totals) : 0;
    return {
      rankColor: function (rank) {
        if (rank === undefined || rank === null) return null;
        return scaleColor_(rank, 1, maxRank, COLORS.scaleBest, COLORS.greyCell);
      },
      totalColor: function (total) {
        return scaleColor_(total, minTotal, maxTotal, COLORS.greyCell, COLORS.scaleBest);
      }
    };
  }

  /** Matchday/era grid-value color — grey fixed at 0 (and at "no data
   * recorded"), light accent at the highest value present anywhere in
   * the currently rendered grid. */
  function gridValueColor_(value, maxValue) {
    if (value === null || value === undefined || value === '') return null;
    return scaleColor_(value, 0, maxValue, COLORS.greyCell, COLORS.accentLight);
  }

  /** Per-match detail cell style — stat-specific, not just a generic
   * numeric gradient:
   *   - PA: presence/absence only (an "x" mark, not a magnitude) — a
   *     fixed light-accent background + white text rather than a scale.
   *   - PI: position text (POR/DEF/MED/DEL/SUP) — fixed color per
   *     position (POSITION_COLORS_), matching the real season docs.
   *   - everything else (GOL/AST): the usual numeric grid gradient.
   * Returns { bg, text } (text may be null, meaning "leave default") or
   * null for a blank cell. */
  function matchCellStyle_(stat, value, maxValue) {
    if (value === null || value === undefined || value === '') return null;
    if (stat === 'PA') return { bg: COLORS.accentLight, text: '#ffffff' };
    if (stat === 'PI') return POSITION_COLORS_[String(value).trim().toUpperCase()] || null;
    var bg = gridValueColor_(value, maxValue);
    return bg ? { bg: bg, text: null } : null;
  }
  function matchCellStyleAttr_(style) {
    if (!style) return '';
    return ' style="background:' + style.bg + (style.text ? ';color:' + style.text : '') + '"';
  }

  /** Looks up one player's Jugadores entry (activo + dorsalByEra) by
   * Nombre — the shared identity lookup lives once in data.json
   * ("jugadores") and is reused for every player table, regardless of
   * which JSON file supplied that table's actual rows (main data.json
   * or the lazily-fetched data-history-detail.json). Returns null if
   * the player isn't listed (fail open — caller treats that as active,
   * no era-specific dorsal). */
  function jugadorInfo_(nombre) {
    var jugadores = state.data && state.data.jugadores;
    return (jugadores && jugadores[nombre]) || null;
  }

  /** Dorsal/name cell background — main-color for a current roster
   * player, dark grey for a former one, per Jugadores' Activo flag.
   * Fails open to "active" (main color) when the player isn't listed. */
  function activoBackground_(nombre) {
    var info = jugadorInfo_(nombre);
    var activo = info ? info.activo : true;
    return ' style="background:' + (activo ? 'var(--main)' : 'var(--grey-header)') + '"';
  }
  var INACTIVE_BG_ = ' style="background:var(--grey-header)"';

  /** The dorsal a player actually wore in `era` (Jugadores.dorsalByEra),
   * falling back to their canonical/current dorsal if that era isn't
   * listed for them — used only where a table shows one specific
   * season at a time (simple mode with an era selected), since that's
   * the one view where "which dorsal" is unambiguous. */
  function dorsalForEra_(p, era) {
    var info = jugadorInfo_(p.nombre);
    if (info && info.dorsalByEra && info.dorsalByEra[era] !== undefined) return info.dorsalByEra[era];
    return p.dorsal;
  }

  /** Display-only era abbreviation: "2019/20" -> "19/20", "2017/18" ->
   * "17/18" — strips the century off a two-year "NNNN/NN" era label.
   * Single-year eras ("2020", "2024") are left unchanged; so is
   * "__all__" and anything else that doesn't match the pattern. Never
   * used on the underlying era VALUE (dropdown option value, byEra/
   * dorsalByEra lookup key, historyData.equipo key, etc.) — only on
   * text actually rendered to the page — since every lookup elsewhere
   * still keys off the full era string from data.json. */
  function formatEraLabel_(era) {
    return /^\d{4}\/\d{2}$/.test(String(era)) ? String(era).slice(2) : era;
  }

  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      state.data = data;
      hideLoadingOverlay_();
      init(data);
    })
    .catch(function (err) {
      hideLoadingOverlay_();
      document.querySelector('main').innerHTML =
        '<p style="color:#f87171;padding:2rem;text-align:center;">No se pudo cargar data.json (' +
        err.message + '). ¿El archivo ya existe en el repo?</p>';
      console.error(err);
    });

  // display:none rather than a fade — the overlay is position:fixed and
  // covers the full viewport, so leaving it merely invisible would still
  // block every click on the real page underneath it.
  function hideLoadingOverlay_() {
    var overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function init(data) {
    document.getElementById('updated-at').textContent = data.generatedAt
      ? 'Actualizado: ' + new Date(data.generatedAt).toLocaleString('es-MX')
      : '';

    setupSections();
    // Inicio is the site's default landing view — set here (not just in
    // index.html's static markup) so it's driven by the same single
    // function every other section switch uses, rather than two places
    // that could drift apart. setupPerfil() below can still override
    // this to Perfil if the page was opened on a #jugador/<id> deep link
    // — that's the one case where landing on Inicio would be wrong.
    activateSection_('inicio');
    setupInicio_();
    renderUltimoPartido_();
    renderProximoPartido_();
    setupTabs();
    setupHistoria_();
    setupEquipoControls(data);
    setupHistorialControls(data);
    renderLeaderboard();
    renderPlantel();
    renderRecordsLeaders_();
    setupPerfil();
  }

  // ---------------- Historia ----------------
  // Escudos/Jerseys are a fixed, hand-maintained list — not something
  // that changes often enough (or lives in the historical Sheet at all)
  // to warrant a data.json pipeline like every other section on the
  // site. Chronological order is just array order, oldest first, per
  // Daniel's own list.
  // Years only (months dropped per Daniel — the full "JUL 2010 - MAY
  // 2017" title was wrapping to two lines on the ~160px card width).
  var ESCUDOS_ = [
    { file: 'escudo-2010.png', title: '2010 - 2017' },
    { file: 'escudo-2017.png', title: '2017 - 2022' },
    { file: 'escudo-2022.png', title: '2022 - 2024' },
    { file: 'escudo-2024.png', title: '2024 - 2026' },
    { file: 'escudo-2026.png', title: '2026 -' }
  ];
  var JERSEYS_ = [
    { tipo: 'Jugador', file: 'jersey-2010.png', title: '2010 - 2011', subtitle: 'Anka' },
    { tipo: 'Jugador', file: 'jersey-2011.png', title: '2011 - 2015', subtitle: 'Atletica' },
    { tipo: 'Jugador', file: 'jersey-2015.png', title: '2015 - 2018', subtitle: 'Undo Skin' },
    { tipo: 'Jugador', file: 'jersey-2018.png', title: '2018 - 2019', subtitle: 'Running 4U' },
    { tipo: 'Jugador', file: 'jersey-2019.png', title: '2019 - 2022', subtitle: 'Running 4U' },
    { tipo: 'Jugador', file: 'jersey-2022.png', title: '2022 - 2024', subtitle: 'Running 4U' },
    { tipo: 'Jugador', file: 'jersey-2024.png', title: '2024 - 2026', subtitle: 'Running 4U' },
    { tipo: 'Jugador', file: 'jersey-2026.png', title: '2026 -', subtitle: 'Running 4U' },
    { tipo: 'Portero', file: 'jerseyp-2010.png', title: '2010 - 2011', subtitle: 'Anka' },
    { tipo: 'Portero', file: 'jerseyp-2018.png', title: '2018 - 2019', subtitle: 'Running 4U' },
    { tipo: 'Portero', file: 'jerseyp-2019.png', title: '2019 - 2022', subtitle: 'Running 4U' },
    { tipo: 'Portero', file: 'jerseyp-2022.png', title: '2022 - 2024', subtitle: 'Running 4U' },
    { tipo: 'Portero', file: 'jerseyp-2024.png', title: '2024 - 2026', subtitle: 'Running 4U' },
    { tipo: 'Portero', file: 'jerseyp-2026.png', title: '2026 -', subtitle: 'Running 4U' }
  ];
  var historiaJerseyTipo_ = 'Jugador'; // Jugador open by default

  function historiaCardHtml_(imgPath, title, subtitle) {
    return '<div class="historia-card"><img src="' + imgPath + '" alt="' + esc(title) + '" loading="lazy">' +
      '<div class="historia-card-title">' + esc(title) + '</div>' +
      (subtitle ? '<div class="historia-card-subtitle">' + esc(subtitle) + '</div>' : '') +
      '</div>';
  }

  function renderEscudos_() {
    var grid = document.getElementById('escudos-grid');
    if (!grid) return;
    grid.innerHTML = ESCUDOS_.map(function (e) {
      return historiaCardHtml_('images/escudos/' + e.file, e.title, null);
    }).join('');
  }

  function renderJerseys_() {
    var grid = document.getElementById('jerseys-grid');
    if (!grid) return;
    grid.innerHTML = JERSEYS_.filter(function (j) { return j.tipo === historiaJerseyTipo_; })
      .map(function (j) { return historiaCardHtml_('images/jerseys/' + j.file, j.title, j.subtitle); })
      .join('');
  }

  /** Jugador/Portero switch — same look-and-wiring pattern as the
   * Estadísticas stat-type buttons (.stat-btn / .stat-selector), just a
   * two-way toggle instead of five stats. */
  function setupJerseysTipoSelector_() {
    var wrap = document.getElementById('jerseys-tipo-selector');
    if (!wrap) return;
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.stat-btn');
      if (!btn) return;
      wrap.querySelectorAll('.stat-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      historiaJerseyTipo_ = btn.dataset.tipo;
      renderJerseys_();
    });
  }

  /** Historia — unlike Estadísticas' Equipo/Jugadores sub-tabs, all four
   * sections (¿Quiénes somos? / Línea de Tiempo / Escudos / Jerseys)
   * render at once as plain titled blocks (see .historia-block in
   * style.css) rather than switching between them — Daniel wants the
   * whole page scannable on load. The only real toggle left is Jerseys'
   * own Jugador/Portero selector. */
  function setupHistoria_() {
    renderEscudos_();
    renderJerseys_();
    setupJerseysTipoSelector_();
  }

  // ---------------- Inicio (home page) ----------------
  // Reachable two ways: the home icon in the main nav (a regular
  // .main-tab-btn, wired up by setupSections() like Plantel/Estadísticas/
  // Historia) and the crest in the header. Both just call
  // activateSection_('inicio') — kept as two separate entry points since
  // Daniel wanted the header crest to remain a home shortcut too.
  function setupInicio_() {
    var badge = document.getElementById('site-badge-btn');
    if (badge) {
      badge.addEventListener('click', function () {
        location.hash = 'inicio';
        activateSection_('inicio');
      });
    }
  }

  /** Finds a per-match detail column's index by its JORNADA CODE (the
   * leading token of the column header — "J20 RFU" -> "J20") within one
   * stat's detail block (data.detail.<STAT>). Used to join
   * currentSeason.matches/proximo (keyed by RES's own jornada value)
   * against data.detail's per-match GOL/AST/PI columns (keyed by
   * header text) — the two are written together by the same "Cargar
   * partido" action, so they always describe the same matches in the
   * same order, but this joins by CONTENT (the jornada code) rather
   * than assuming array position, since that's a weaker, riskier
   * coupling. Returns -1 if the stat has no detail block, or the
   * jornada genuinely isn't in it — callers treat that as "no detail
   * available for this stat/match" rather than an error. */
  function detailColumnIndex_(statBlock, jornada) {
    if (!statBlock || !statBlock.columns || !jornada) return -1;
    for (var i = 0; i < statBlock.columns.length; i++) {
      var partido = String(statBlock.columns[i].partido || '');
      if (partido.split(' ')[0] === jornada) return i;
    }
    return -1;
  }

  /** Every player with a POSITIVE byMatch value at `idx` — GOL/AST
   * scorers/assisters for one match. [Default]/[Autogoles] utility
   * rows ARE included (real goals credited to the team, per the
   * project's own GOL convention) — their bracketed name is shown with
   * the brackets stripped for a cleaner match-summary read. Carries
   * `dorsal` straight off the same detail row (already in the JSON) so
   * callers can sort without a second lookup. */
  function detailScorersAt_(statBlock, idx) {
    if (!statBlock || idx < 0) return [];
    return statBlock.players
      .map(function (p) { return { nombre: String(p.nombre || '').replace(/^\[|\]$/g, ''), dorsal: p.dorsal, valor: p.byMatch[idx] }; })
      .filter(function (p) { return Number(p.valor) > 0; });
  }

  /** Every player with ANY non-blank byMatch value at `idx` — used for
   * PI's lineup (position text, not a magnitude, so this checks
   * presence rather than a positive number). Carries `dorsal` for the
   * same reason as detailScorersAt_. */
  function detailPresentAt_(statBlock, idx) {
    if (!statBlock || idx < 0) return [];
    return statBlock.players
      .map(function (p) { return { nombre: p.nombre, dorsal: p.dorsal, valor: p.byMatch[idx] }; })
      .filter(function (p) { return p.valor !== null && p.valor !== undefined && p.valor !== ''; });
  }

  /** Numeric sort key for a dorsal value — non-numeric/blank dorsals
   * (utility rows like [Default]/[Autogoles], which have none) sort
   * last rather than breaking a numeric comparison. */
  function dorsalSortKey_(dorsal) {
    var n = Number(dorsal);
    return isNaN(n) ? Infinity : n;
  }

  /** [Autogoles] displays as "[Autogol]" (Daniel's own convention,
   * singular, brackets kept) in the Goles list — everything else (a
   * real player, or "Default") is shown exactly as detailScorersAt_
   * already stripped it. */
  function displayNombreGol_(nombre) {
    return nombre === 'Autogoles' ? '[Autogol]' : nombre;
  }

  /** Goles/Asistencias as ONE comma-separated line — "Paco (3), Daniel,
   * Abraham" — sorted by count descending, dorsal ascending within a
   * tie. A count of 1 is shown bare (no "(1)"). Autogoles ("[Autogol]")
   * always sorts last regardless of its count — it's not really "a
   * player's" goal, so it doesn't compete for the top of the list the
   * way a real scorer's count does. */
  function listaConConteo_(items) {
    var sorted = items.slice().sort(function (a, b) {
      var aAuto = a.nombre === 'Autogoles', bAuto = b.nombre === 'Autogoles';
      if (aAuto !== bAuto) return aAuto ? 1 : -1;
      if (Number(b.valor) !== Number(a.valor)) return Number(b.valor) - Number(a.valor);
      return dorsalSortKey_(a.dorsal) - dorsalSortKey_(b.dorsal);
    });
    return sorted.map(function (p) {
      var nombre = displayNombreGol_(p.nombre);
      return Number(p.valor) > 1 ? nombre + ' (' + p.valor + ')' : nombre;
    }).join(', ');
  }

  /** Season code ("ATS2", "SOL18", ...) for one era — data.seasons is
   * the same {era, torneo} list the historical doc's row 2 uses (see
   * dashboard_export.gs). Used in the meta row alongside the jornada
   * code, matching Daniel's own social-graphic convention ("ATS2 /
   * J20") — the raw jornada code is kept as-is rather than expanded to
   * "JORNADA 20", since not every code cleanly expands that way (JP,
   * CF, SF, 3R, ...). */
  function torneoForEra_(era) {
    var season = (state.data.seasons || []).filter(function (s) { return s.era === era; })[0];
    return season ? season.torneo : '';
  }

  // Small outline icons (trophy/calendar/clock/pin) for the meta row —
  // inline SVG rather than image assets, so no new upload is needed and
  // they inherit color via CSS (currentColor) same as any text.
  var ICON_TROFEO_ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 5H4a3 3 0 0 0 3 5M17 5h3a3 3 0 0 1-3 5"/></svg>';
  var ICON_CALENDARIO_ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  var ICON_RELOJ_ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
  var ICON_PIN_ = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>';

  function partidoMetaItemHtml_(icon, label) {
    return '<span class="partido-meta-item">' + icon + esc(label) + '</span>';
  }

  /** The icon+label row under a partido-card's title — torneo/jornada,
   * fecha, hora, cancha — mirroring the Estuardos social-graphic
   * convention (trophy/calendar/clock/pin) instead of the site's usual
   * plain "·"-separated meta line. Any piece that's blank/unavailable
   * is just omitted, not shown empty. */
  function partidoMetaHtml_(era, jornada, fecha, hora, cancha) {
    var torneo = torneoForEra_(era);
    var items = [];
    if (torneo || jornada) items.push(partidoMetaItemHtml_(ICON_TROFEO_, (torneo ? torneo + ' / ' : '') + jornada));
    if (fecha) items.push(partidoMetaItemHtml_(ICON_CALENDARIO_, formatFechaCorta_(fecha)));
    if (hora) items.push(partidoMetaItemHtml_(ICON_RELOJ_, hora));
    if (cancha) items.push(partidoMetaItemHtml_(ICON_PIN_, 'Cancha ' + cancha));
    return '<div class="partido-meta-row">' + items.join('') + '</div>';
  }

  /** Color-coded position pill (POR/DEF/MED/DEL/SUP) — reuses the exact
   * same POSITION_COLORS_ map the PI detailed leaderboard view already
   * uses, instead of introducing a second color scheme for the same
   * five position codes. */
  function posicionPillHtml_(pos) {
    var c = POSITION_COLORS_[pos];
    var style = c ? ' style="background:' + c.bg + ';color:' + c.text + '"' : '';
    return '<span class="jugador-card-pos"' + style + '>' + esc(pos) + '</span>';
  }

  /** One player card inside a Titulares/Suplentes/Asistentes grid —
   * photo (images/perfiles, looked up by playerId via the shared
   * jugadorInfo_ helper, same identity lookup every other player table
   * on the site uses) + dorsal-prefixed name ("7 Daniel", lineup cards
   * only — the Goles/Asistencias text lists never get a dorsal prefix)
   * + an optional color-coded position pill (omitted entirely — no
   * empty pill — for Asistentes, the default-win case where there are
   * no starting positions to show at all). A player with no Jugadores
   * entry falls back to a plain text placeholder tile instead of a
   * broken image — same fallback philosophy as renderPerfil's own
   * badge icons. */
  function jugadorCardHtml_(nombre, dorsal, posicion) {
    var info = jugadorInfo_(nombre);
    var visual = info && info.playerId
      ? '<img src="images/perfiles/' + esc(info.playerId) + '.jpg" alt="' + esc(nombre) + '" loading="lazy">'
      : '<div class="jugador-card-placeholder">' + esc(nombre) + '</div>';
    var etiqueta = (dorsal !== undefined && dorsal !== null && dorsal !== '') ? dorsal + ' ' + nombre : nombre;
    return '<div class="jugador-card">' + visual +
      '<div class="jugador-card-nombre">' + esc(etiqueta) + '</div>' +
      (posicion ? posicionPillHtml_(posicion) : '') +
      '</div>';
  }

  /** One Titulares/Suplentes/Asistentes card grid (with its own "h4"
   * heading) — omitted entirely (returns '') if there's nothing to
   * show, rather than a heading over an empty grid (same convention as
   * plantelSectionHtml_/renderPerfil's badge section). `items` is
   * [{nombre, dorsal, posicion}, ...] — posicion may be null/omitted
   * (Asistentes). */
  function partidoJugadoresGridHtml_(titulo, items) {
    if (!items.length) return '';
    return '<h4>' + esc(titulo) + '</h4><div class="partido-jugadores-grid">' +
      items.map(function (i) { return jugadorCardHtml_(i.nombre, i.dorsal, i.posicion); }).join('') +
      '</div>';
  }

  /** The two full-width team "bands" (score + name) that make up
   * Último Partido's scoreboard — same visual idea as the Estuardos
   * social graphics' alternating color blocks. Estuardos' own band
   * always uses the team's own brand color (var(--main)) — NOT a
   * win/draw/loss result color; the score number itself already makes
   * the outcome obvious, per Daniel's own call. The rival's band uses
   * their real kit colors (rivalBg/rivalText, read straight off RES's
   * Rival cell — same convention as the Results table), falling back
   * to the plain grey card background if that rival hasn't been
   * colored yet. Score sits to the LEFT of the name in both bands
   * (grouped close together, not spread to opposite edges), per
   * Daniel's own layout call. */
  function partidoMarcadorHtml_(m) {
    var rivalStyle = m.rivalBg ? ' style="background:' + esc(m.rivalBg) + ';color:' + esc(m.rivalText || '#ffffff') + '"' : '';
    return '<div class="partido-marcador">' +
      '<div class="partido-banda partido-banda-local">' +
        '<span class="partido-banda-score">' + esc(m.gf) + '</span><span class="partido-banda-nombre">Estuardos FC</span>' +
      '</div>' +
      '<div class="partido-banda"' + rivalStyle + '>' +
        '<span class="partido-banda-score">' + esc(m.gc) + '</span><span class="partido-banda-nombre">' + esc(m.rival) + '</span>' +
      '</div>' +
    '</div>';
  }

  /** Último Partido — the last (chronologically) match in
   * currentSeason.matches, which is now guaranteed PLAYED-only (see
   * readMatchLog_'s GF-based split, dashboard_export.gs) — no separate
   * "is this really played" check needed here. Individual stats are
   * pulled from data.detail via detailColumnIndex_'s jornada join; any
   * stat that doesn't resolve (e.g. AST detail missing) is just
   * silently omitted from the card rather than blocking the rest of
   * it. Below the scoreboard, the card splits into two halves — left
   * the lineup (Titulares sorted by position then dorsal, Suplentes by
   * dorsal), right the scoring info (Goles/Asistencias as plain
   * comma-separated text lists) — per Daniel's own layout call.
   *
   * Default-win handling: a match with genuinely no PI data at all
   * (zero titulares AND zero suplentes — "There won't be any starting
   * positions", per Daniel) is a win-by-default/walkover, not a real
   * played match. In that case the left column becomes "Asistentes"
   * (every player logged in PA for this match, dorsal ascending, no
   * position pill — there isn't one) instead of Titulares/Suplentes,
   * and Goles shows the fixed text "[Triunfo por default]" instead of
   * the usual scorer breakdown (a walkover's GF isn't really "someone's
   * goals"). Asistencias is untouched either way — it's simply empty
   * (and omitted) for a walkover, same as any match with no assists. */
  function renderUltimoPartido_() {
    var data = state.data;
    var card = document.getElementById('ultimo-partido-card');
    if (!card || !data || !data.currentSeason) return;

    var matches = data.currentSeason.matches || [];
    if (!matches.length) {
      card.innerHTML = '<h3 class="partido-titulo">Último Partido</h3><p class="placeholder-text">Aún no se ha jugado ningún partido esta temporada.</p>';
      return;
    }
    var m = matches[matches.length - 1];
    var detail = data.detail || {};

    var goleadores = detailScorersAt_(detail.GOL, detailColumnIndex_(detail.GOL, m.jornada));
    var asistencias = detailScorersAt_(detail.AST, detailColumnIndex_(detail.AST, m.jornada));
    var presentesPI = detailPresentAt_(detail.PI, detailColumnIndex_(detail.PI, m.jornada));

    var titulares = presentesPI.filter(function (p) {
      return POSICION_ORDER_.indexOf(String(p.valor).trim().toUpperCase()) !== -1;
    }).sort(function (a, b) {
      var pa = POSICION_ORDER_.indexOf(String(a.valor).trim().toUpperCase());
      var pb = POSICION_ORDER_.indexOf(String(b.valor).trim().toUpperCase());
      if (pa !== pb) return pa - pb;
      return dorsalSortKey_(a.dorsal) - dorsalSortKey_(b.dorsal);
    });
    var suplentes = presentesPI.filter(function (p) {
      return String(p.valor).trim().toUpperCase() === 'SUP';
    }).sort(function (a, b) { return dorsalSortKey_(a.dorsal) - dorsalSortKey_(b.dorsal); });

    var victoriaPorDefault = !titulares.length && !suplentes.length;

    var colIzquierdaHtml;
    if (victoriaPorDefault) {
      var asistentes = detailPresentAt_(detail.PA, detailColumnIndex_(detail.PA, m.jornada))
        .sort(function (a, b) { return dorsalSortKey_(a.dorsal) - dorsalSortKey_(b.dorsal); });
      colIzquierdaHtml = partidoJugadoresGridHtml_('Asistentes', asistentes.map(function (p) { return { nombre: p.nombre, dorsal: p.dorsal, posicion: null }; }));
    } else {
      colIzquierdaHtml =
        partidoJugadoresGridHtml_('Titulares', titulares.map(function (p) { return { nombre: p.nombre, dorsal: p.dorsal, posicion: String(p.valor).trim().toUpperCase() }; })) +
        partidoJugadoresGridHtml_('Suplentes', suplentes.map(function (p) { return { nombre: p.nombre, dorsal: p.dorsal, posicion: 'SUP' }; }));
    }

    var golesTexto = victoriaPorDefault ? '[Triunfo por default]' : listaConConteo_(goleadores);
    var golesHtml = (victoriaPorDefault || goleadores.length)
      ? '<h4>Goles</h4><p class="partido-lista">' + esc(golesTexto) + '</p>' : '';
    var asistHtml = asistencias.length
      ? '<h4>Asistencias</h4><p class="partido-lista">' + esc(listaConConteo_(asistencias)) + '</p>' : '';

    var html = '<h3 class="partido-titulo">Último Partido</h3>' +
      partidoMetaHtml_(data.currentSeason.era, m.jornada, m.fecha, m.hora, m.cancha) +
      partidoMarcadorHtml_(m) +
      '<div class="partido-columnas">' +
        '<div class="partido-col">' + colIzquierdaHtml + '</div>' +
        '<div class="partido-col">' + golesHtml + asistHtml + '</div>' +
      '</div>' +
      '<a href="#estadisticas" class="partido-ver-todos" id="ultimo-partido-ver-todos">Ver todos los resultados →</a>';
    card.innerHTML = html;

    // A real <a href="#estadisticas"> — works with no JS at all (lands
    // on the right top-level section via routeFromHash_) and is
    // keyboard/middle-click friendly. The click handler layers the
    // extra state routeFromHash_ doesn't know about on top: which
    // Estadísticas sub-tab (Equipo) and which season (this card's own
    // era) to land on — same "drive it directly, hash is for deep-
    // link/refresh" pattern used by the Plantel cards and main nav.
    var verTodosLink = document.getElementById('ultimo-partido-ver-todos');
    if (verTodosLink) {
      verTodosLink.addEventListener('click', function (e) {
        e.preventDefault();
        var era = data.currentSeason.era;
        var select = document.getElementById('team-era-filter');
        if (select) select.value = era;
        state.teamEra = era;
        renderEquipo();
        activateEstadisticasTab_('temporada');
        location.hash = 'estadisticas';
        activateSection_('estadisticas');
      });
    }
  }

  /** Próximo Partido — reads straight off data.currentSeason.proximo
   * (dashboard_export.gs's readMatchLog_: the first RES row with a real
   * Fecha but still-blank GF). null is the normal, expected state until
   * Daniel starts pre-filling a scheduled match ahead of time — shows a
   * placeholder, not an error. No score/individual stats here (the
   * match hasn't happened yet), so this gets the plain centered
   * "ESTUARDOS FC / VS / RIVAL" treatment instead of Último's colored
   * scoreboard bands. */
  function renderProximoPartido_() {
    var data = state.data;
    var card = document.getElementById('proximo-partido-card');
    if (!card || !data || !data.currentSeason) return;

    var p = data.currentSeason.proximo;
    if (!p) {
      card.innerHTML = '<h3 class="partido-titulo">Próximo Partido</h3><p class="placeholder-text">Aún no hay información sobre el próximo partido.</p>';
      return;
    }
    var rivalStyle = p.rivalBg ? ' style="background:' + esc(p.rivalBg) + ';color:' + esc(p.rivalText || '#ffffff') + '"' : '';
    card.innerHTML = '<h3 class="partido-titulo">Próximo Partido</h3>' +
      partidoMetaHtml_(data.currentSeason.era, p.jornada, p.fecha, p.hora, p.cancha) +
      '<div class="partido-vs">' +
        '<span class="partido-vs-equipo">Estuardos FC</span>' +
        '<span class="partido-vs-sep">vs</span>' +
        '<span class="partido-vs-equipo partido-vs-rival"' + rivalStyle + '>' + esc(p.rival || '?') + '</span>' +
      '</div>';
  }

  // ---------------- Plantel ----------------
  // Section order + labels for grouping the roster by main position
  // (Datos tab's "Posicion" column) — same POR/DEF/MED/DEL codes as the
  // PI stat, not a new vocabulary. A player with no Posicion entered
  // yet (or a value that doesn't match one of these four) falls into a
  // trailing "Otros" section instead of silently vanishing from Plantel.
  var POSICION_ORDER_ = ['POR', 'DEF', 'MED', 'DEL'];
  var POSICION_LABELS_ = { POR: 'Porteros', DEF: 'Defensas', MED: 'Medios', DEL: 'Delanteros' };

  /** Current roster, grouped into position sections, each sorted by
   * dorsal ascending within itself. Same "Activo" flag (Jugadores tab)
   * that already drives active/inactive coloring everywhere else, so no
   * separate roster list to maintain. Each player's CURRENT dorsal
   * comes from dorsalByEra[currentEra], not the BALANCE table's all-time
   * "dorsal" field (which can be stale/blank for eras that predate a
   * player, or simply wrong for someone whose number changed) —
   * currentEra is the same value data.json's season/era controls
   * already use. */
  function renderPlantel() {
    var data = state.data;
    var grid = document.getElementById('plantel-grid');
    if (!data || !grid) return;
    var jugadores = data.jugadores || {};
    var datos = data.datos || {};
    var currentEra = data.currentEra;
    var roster = Object.keys(jugadores).map(function (nombre) {
      var info = jugadores[nombre];
      var dorsal = info.dorsalByEra && info.dorsalByEra[currentEra];
      var posicion = (datos[nombre] && datos[nombre].posicion) || '';
      return { nombre: nombre, playerId: info.playerId, activo: info.activo, dorsal: dorsal, posicion: posicion };
    }).filter(function (p) {
      return p.activo && p.dorsal !== undefined && p.dorsal !== null && p.dorsal !== '';
    });

    var groups = {};
    POSICION_ORDER_.forEach(function (pos) { groups[pos] = []; });
    var otros = [];
    roster.forEach(function (p) {
      (groups[p.posicion] || otros).push(p);
    });

    var html = POSICION_ORDER_.map(function (pos) {
      return plantelSectionHtml_(POSICION_LABELS_[pos], groups[pos]);
    }).join('');
    if (otros.length) html += plantelSectionHtml_('Otros', otros);

    grid.innerHTML = html;
  }

  /** One position section: heading + its own 4-per-row card grid.
   * Returns '' for an empty group so, e.g., a squad with no Porteros
   * entered yet doesn't leave a heading floating over nothing. */
  function plantelSectionHtml_(titulo, players) {
    if (!players.length) return '';
    var cards = players.slice().sort(function (a, b) {
      return (Number(a.dorsal) || 0) - (Number(b.dorsal) || 0);
    }).map(function (p) {
      var img = 'images/plantel/' + p.playerId + '.jpg';
      // A real <button>, not a clickable <div> — free keyboard focus/
      // activation (Tab + Enter/Space) and correct screen-reader role,
      // rather than needing a hand-rolled tabindex + keydown handler.
      return '<button type="button" class="plantel-card" data-player-id="' + esc(p.playerId) + '" aria-label="Ver perfil de ' + esc(p.nombre) + '">' +
        '<img src="' + img + '" alt="" loading="lazy"></button>';
    }).join('');
    return '<section class="plantel-section"><h3>' + esc(titulo) + '</h3>' +
      '<div class="plantel-cards-grid">' + cards + '</div></section>';
  }

  // ---------------- Sections (Estadísticas / Plantel / Perfil) ----------------
  // Top-level nav, one level above the Equipo/Jugadores sub-tabs. The
  // sub-tab buttons also carry the shared ".tab-btn" pill styling, so
  // this scopes its own button/click handling to ".main-tab-btn" only —
  // sharing ".tab-btn" for CSS but never for the two nav levels' click
  // wiring, which stay fully independent of each other.
  //
  // "perfil" (a player profile page) is a section-panel too, but has no
  // matching .main-tab-btn — it's only ever reached via a Plantel card
  // or a shared #jugador/<id> link, never the nav bar. Routing it
  // through this same activateSection_ still works correctly: the "no
  // button has data-section === 'perfil'" case just means every nav
  // button ends up inactive, which is exactly the right look for a page
  // that isn't one of the nav's own destinations. ("inicio" used to be
  // in the same boat, reachable only via the header crest — it now also
  // has a real nav button, the home icon, so it no longer falls into
  // this case.)
  // <title> per section — was stuck on "Estuardos FC — Estadísticas"
  // everywhere. "perfil" is deliberately NOT listed here: renderPerfil
  // always runs immediately before activateSection_('perfil') (both the
  // Plantel-card click handler and routeFromHash_ call it in that
  // order), setting the real "Estuardos FC — <Nombre>" title itself —
  // giving 'perfil' a generic entry here would just clobber that right
  // after it's set.
  var SECTION_TITLES_ = {
    inicio: 'Estuardos FC',
    estadisticas: 'Estuardos FC — Estadísticas',
    plantel: 'Estuardos FC — Plantel',
    historia: 'Estuardos FC — Historia'
  };

  function activateSection_(name) {
    // Every call here is a real "go to this section" action (nav click,
    // Plantel card -> Perfil, Volver, a #jugador/<id> deep link) — a
    // single-page app never gets the free scroll-to-top a real page
    // navigation would. Without this, clicking a card near the bottom
    // of a scrolled Plantel page (e.g. Delanteros) opened that player's
    // profile already scrolled halfway down, since the browser just
    // keeps whatever scroll position it already had.
    window.scrollTo(0, 0);
    document.querySelectorAll('.main-tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.section === name);
    });
    document.querySelectorAll('.section-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'section-' + name);
    });
    if (SECTION_TITLES_[name]) document.title = SECTION_TITLES_[name];
    var isEstadisticas = name === 'estadisticas';
    // The Equipo/Jugadores sub-nav only makes sense inside Estadísticas.
    document.getElementById('estadisticas-subnav').hidden = !isEstadisticas;
    // Same "wide" resync reasoning as setupTabs() below — leaving
    // Estadísticas while Jugadores' detail view is on must not keep
    // <main> stretched on Plantel/Perfil (or vice versa, coming back).
    var historialActive = document.querySelector('#estadisticas-subnav .tab-btn[data-tab="historial"]').classList.contains('active');
    document.querySelector('main').classList.toggle('wide', isEstadisticas && historialActive && state.detail);
    if (isEstadisticas) syncStickyOffsets_();
  }

  function setupSections() {
    document.querySelectorAll('.main-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // Same instant-render + shareable-hash pattern as the Plantel
        // cards below: set the hash so every main section has its own
        // dedicated, shareable/deep-linkable URL (#inicio, #estadisticas,
        // #plantel, #historia), but still call activateSection_ directly
        // rather than waiting for the resulting hashchange event, so the
        // click feels instant. This also naturally overwrites/clears any
        // stale #jugador/<id> hash left over from a profile page.
        location.hash = btn.dataset.section;
        activateSection_(btn.dataset.section);
      });
    });
  }

  // ---------------- Perfil (player profile page) ----------------
  var MESES_ = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  // "Octubre 2" — month name capitalized, no year (see buildDatosJson_'s
  // own comment on why the sheet's placeholder year never reaches here).
  function formatCumpleanos_(c) {
    var mes = MESES_[c.mes - 1];
    return mes.charAt(0).toUpperCase() + mes.slice(1) + ' ' + c.dia;
  }

  /** Click delegation on the grid (not a listener per card) — survives
   * renderPlantel() re-rendering the grid's innerHTML, and only needs
   * wiring up once. Sets a shareable #jugador/<id> hash AND renders
   * immediately, rather than waiting for the resulting hashchange event
   * — instant on click, with the hash update mainly there for deep
   * links / refresh, not as the trigger. */
  function setupPerfil() {
    setupPerfilStatSelector_();
    var grid = document.getElementById('plantel-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var card = e.target.closest('.plantel-card');
        if (!card || !card.dataset.playerId) return;
        location.hash = 'jugador/' + encodeURIComponent(card.dataset.playerId);
        renderPerfil(card.dataset.playerId);
        activateSection_('perfil');
      });
    }
    var volver = document.getElementById('perfil-volver');
    if (volver) {
      volver.addEventListener('click', function () {
        location.hash = 'plantel';
        activateSection_('plantel');
      });
    }
    window.addEventListener('hashchange', routeFromHash_);
    if (location.hash) routeFromHash_();
  }

  // Every main section has its own dedicated hash now, same idea as
  // #jugador/<id> — mirrors the .main-tab-btn data-section values 1:1,
  // so any of these is a shareable/deep-linkable URL straight to that
  // page (#inicio, #estadisticas, #plantel, #historia).
  var SECTION_HASHES_ = ['inicio', 'estadisticas', 'plantel', 'historia'];

  /** Two hash shapes matter: #jugador/<playerId> (profile) and a bare
   * section name (#inicio/#estadisticas/#plantel/#historia). Matching
   * either renders + shows the right page — used both on initial load
   * (deep links) and on hashchange (back/forward, or the redundant fire
   * after a nav click already set the hash directly, see setupSections).
   * Any OTHER hash value (including empty, e.g. the back button leaving
   * a profile) only matters if the profile is what's currently on
   * screen; if some other section is already showing, there's nothing
   * to do here — the nav-button and "Volver" handlers already handle
   * their own section switch directly rather than depending on this
   * firing. */
  function routeFromHash_() {
    var m = /^#jugador\/(.+)$/.exec(location.hash);
    if (m) {
      renderPerfil(decodeURIComponent(m[1]));
      activateSection_('perfil');
      return;
    }
    var name = location.hash.replace(/^#/, '');
    if (SECTION_HASHES_.indexOf(name) !== -1) {
      activateSection_(name);
    } else if (document.getElementById('section-perfil').classList.contains('active')) {
      activateSection_('plantel');
    }
  }

  /** Looks a player up by playerId (data.jugadores is keyed by Nombre,
   * not playerId — a short scan over ~36 players is cheap enough that a
   * reverse index isn't worth maintaining) and fills in every part of
   * the profile: photo, name, current dorsal, birthday, debut, badges
   * (Logros), and all-time GOL/AST/PA/PI totals (read straight off the
   * same data.stats.<STAT>.players[].total every leaderboard already
   * uses — a player's career total IS their all-time total, no separate
   * aggregation needed). */
  function renderPerfil(playerId) {
    var data = state.data;
    if (!data) return;
    var jugadores = data.jugadores || {};
    var nombre = null;
    Object.keys(jugadores).some(function (n) {
      if (jugadores[n].playerId === playerId) { nombre = n; return true; }
      return false;
    });
    if (!nombre) return;

    var info = jugadores[nombre];
    var datos = (data.datos && data.datos[nombre]) || {};
    var badges = (data.logros && data.logros[nombre]) || [];
    var dorsal = info.dorsalByEra && info.dorsalByEra[data.currentEra];

    // images/perfiles — a separate, plain-headshot photo set from
    // Plantel's (images/plantel), which has dorsal/name baked into the
    // graphic itself. These don't, so the page renders that text itself.
    document.title = 'Estuardos FC — ' + nombre;
    document.getElementById('perfil-foto').src = 'images/perfiles/' + playerId + '.jpg';
    document.getElementById('perfil-foto').alt = nombre;
    document.getElementById('perfil-dorsal').textContent =
      (dorsal !== undefined && dorsal !== null && dorsal !== '') ? dorsal : '';
    document.getElementById('perfil-nombre').textContent = nombre;
    document.getElementById('perfil-nombre-completo').textContent = datos.nombreCompleto || '';
    // Label text ("Debut", "Cumpleaños") lives in the HTML itself — only
    // the value span is touched here — and the whole row hides if that
    // piece of data hasn't been entered yet, rather than showing a bare
    // label with nothing after it.
    document.getElementById('perfil-debut-row').hidden = !datos.debut;
    document.getElementById('perfil-debut').textContent = datos.debut || '';
    document.getElementById('perfil-cumple-row').hidden = !datos.cumpleanos;
    document.getElementById('perfil-cumple').textContent = datos.cumpleanos ? formatCumpleanos_(datos.cumpleanos) : '';

    // Social links — one icon per site, shown only when that player has
    // a real handle entered in Datos (see socialHandle_ in
    // dashboard_export.gs); no account, no icon. Same icon assets and
    // URL domains as the footer's own team-account links.
    var socialLinks = [];
    if (datos.instagram) socialLinks.push({ href: 'https://www.instagram.com/' + encodeURIComponent(datos.instagram), icon: 'instagram.png', label: 'Instagram' });
    if (datos.twitter) socialLinks.push({ href: 'https://x.com/' + encodeURIComponent(datos.twitter), icon: 'twitter.png', label: 'Twitter' });
    document.getElementById('perfil-social').innerHTML = socialLinks.map(function (s) {
      return '<a href="' + esc(s.href) + '" target="_blank" rel="noopener noreferrer"><img src="images/social/' + s.icon + '" alt="' + esc(s.label) + '"></a>';
    }).join('');

    // Nivel ascending, then Temporada ascending — Daniel's own Logros
    // column (e.g. every Nivel-1 "Miembro Fundador" before any Nivel-2
    // "Campeón Recopa", oldest season first within the same Nivel). A
    // badge with no Nivel entered yet (null) sorts to the very end
    // rather than being guessed into a position.
    var badgesSorted = badges.slice().sort(function (a, b) {
      var na = (a.nivel === null || a.nivel === undefined) ? Infinity : a.nivel;
      var nb = (b.nivel === null || b.nivel === undefined) ? Infinity : b.nivel;
      if (na !== nb) return na - nb;
      return String(a.temporada || '').localeCompare(String(b.temporada || ''));
    });

    var insigniasWrap = document.getElementById('perfil-insignias');
    if (!badgesSorted.length) {
      insigniasWrap.innerHTML = '<p class="detail-message">Sin insignias todavía.</p>';
    } else {
      insigniasWrap.innerHTML = badgesSorted.map(function (b) {
        var icon = b.imagen
          ? '<img src="images/insignias/' + esc(b.imagen) + '" alt="' + esc(b.insignia) + '" loading="lazy">'
          : '<div class="insignia-placeholder">' + esc(b.insignia) + '</div>';
        return '<div class="insignia-card">' + icon +
          '<div class="insignia-label">' + esc(b.insignia) + '</div>' +
          '<div class="insignia-temporada">' + esc(b.temporada) + '</div></div>';
      }).join('');
    }

    // Every fresh profile load resets back to BALANCE — switching
    // players while a GOL chart is showing would otherwise carry that
    // selection over to someone whose GOL history looks completely
    // different, with no visual cue anything changed underneath them.
    state.perfilNombre = nombre;
    state.perfilStat = 'BALANCE';
    resetPerfilStatSelector_();
    renderPerfilStatsView_(nombre);
  }

  /** BALANCE shows the existing table; GOL_AST and PA_PI each show a
   * two-line chart of that pair instead (goals+assists, attendance+
   * starts — related numbers worth comparing side by side) — same
   * selector look, same .stat-btn markup as the Estadísticas >
   * Individuales tab, just scoped to its own #perfil-stat-selector (see
   * setupPerfilStatSelector_). */
  function renderPerfilStatsView_(nombre) {
    var isBalance = state.perfilStat === 'BALANCE';
    document.getElementById('perfil-stats-wrap').hidden = !isBalance;
    document.getElementById('perfil-stat-chart-wrap').hidden = true; // renderPerfilStatChart_ un-hides it if there's data to show
    document.getElementById('perfil-stat-message').hidden = true;
    if (isBalance) {
      renderPerfilStatsTable_(nombre);
    } else {
      // "GOL_AST" / "PA_PI" -> ['GOL','AST'] / ['PA','PI'] — the two
      // pairs are shown together (one line each) since they're related
      // numbers a player/coach would naturally want to compare, rather
      // than as four separate single-line tabs.
      renderPerfilStatChart_(nombre, state.perfilStat.split('_'));
    }
  }

  function setupPerfilStatSelector_() {
    var wrap = document.getElementById('perfil-stat-selector');
    if (!wrap) return;
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.stat-btn');
      if (!btn) return;
      wrap.querySelectorAll('.stat-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.perfilStat = btn.dataset.stat;
      if (state.perfilNombre) renderPerfilStatsView_(state.perfilNombre);
    });
  }

  function resetPerfilStatSelector_() {
    var wrap = document.getElementById('perfil-stat-selector');
    if (!wrap) return;
    wrap.querySelectorAll('.stat-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.stat === 'BALANCE');
    });
  }

  /** Career stats table — same visual language as the BALANCE tab (one
   * blue scale per stat column, grey-to-scale-best) but rows are this
   * ONE player's seasons instead of the roster's players, plus a TOTAL
   * row at the bottom with no scale (same convention as the all-time
   * team balance table). Row order follows data.seasons (oldest first,
   * the site-wide convention), filtered down to only the eras this
   * player actually has a record in — same "blank means not rostered
   * that era" rule used everywhere else, not the union of every era
   * that exists. */
  function renderPerfilStatsTable_(nombre) {
    var data = state.data;
    var byEra = {};
    STATS_ORDER.forEach(function (stat) {
      var block = data.stats && data.stats[stat];
      var row = block && block.players.filter(function (p) { return p.nombre === nombre; })[0];
      if (!row || !row.byEra) return;
      Object.keys(row.byEra).forEach(function (era) {
        if (row.byEra[era] === null || row.byEra[era] === undefined) return;
        if (!byEra[era]) byEra[era] = {};
        byEra[era][stat] = row.byEra[era];
      });
    });

    // Reverse chronological — most recent season first, same convention
    // as the all-seasons team stats table (#team-balance-table).
    var eras = (data.seasons || []).map(function (s) { return s.era; }).filter(function (era) { return byEra[era]; }).reverse();
    var tbody = document.querySelector('#perfil-stats-table tbody');
    if (!eras.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#7fa3a8;">Sin datos.</td></tr>';
      return;
    }

    var ranges = {};
    STATS_ORDER.forEach(function (stat) {
      var vals = eras.map(function (era) { return Number(byEra[era][stat]) || 0; });
      ranges[stat] = { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
    });

    var rowsHtml = eras.map(function (era) {
      var cells = STATS_ORDER.map(function (stat) {
        var v = byEra[era][stat];
        var color = (v === null || v === undefined) ? null : scaleColor_(v, ranges[stat].min, ranges[stat].max, COLORS.greyCell, COLORS.scaleBest);
        return '<td class="val-strong"' + styleAttr_(color) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td class="val-strong">' + esc(formatEraLabel_(era)) + '</td>' + cells + '</tr>';
    }).join('');

    var totalCells = STATS_ORDER.map(function (stat) {
      var block = data.stats && data.stats[stat];
      var row = block && block.players.filter(function (p) { return p.nombre === nombre; })[0];
      var total = row ? row.total : null;
      return '<td class="val-strong">' + (total === null || total === undefined ? '' : esc(total)) + '</td>';
    }).join('');

    tbody.innerHTML = rowsHtml + '<tr class="total-row"><td class="val-strong">TOTAL</td>' + totalCells + '</tr>';
  }

  // Same blue/purple pairing GF/GC already use everywhere else on the
  // site — first stat in the pair gets blue, second gets purple, so the
  // "two related lines together" visual language stays consistent site-
  // wide rather than inventing a new color pairing just for this chart.
  var PERFIL_CHART_COLORS_ = [COLORS.scaleBest, COLORS.gcColor];

  /** Line chart of this player's own value across seasons, one line per
   * stat in `stats` (1 or 2 codes, e.g. ['GOL','AST']) — chronological
   * oldest -> newest (data.seasons' own order, NOT reversed like the
   * table above, since a trend line reads left-to-right). The x-axis is
   * the UNION of eras either stat has real data for, so e.g. GOL's full
   * history still shows even though AST only starts at 2022/23 — a stat
   * with no value for a given era is plotted as null (a real gap in
   * that line, not a false 0), same "blank means not rostered that era"
   * rule as the table. A pair with NO data at all for either stat gets
   * a message instead of an empty chart, same pattern as the Equipo
   * tab's season-goals chart. */
  function renderPerfilStatChart_(nombre, stats) {
    var data = state.data;
    var byEraPerStat = stats.map(function (stat) {
      var block = data.stats && data.stats[stat];
      var row = block && block.players.filter(function (p) { return p.nombre === nombre; })[0];
      return (row && row.byEra) || {};
    });

    var eras = (data.seasons || []).map(function (s) { return s.era; })
      .filter(function (era) {
        return byEraPerStat.some(function (byEra) { return byEra[era] !== null && byEra[era] !== undefined; });
      });

    if (!eras.length) {
      var msg = document.getElementById('perfil-stat-message');
      msg.textContent = 'Sin datos de ' + stats.join('/') + ' para este jugador.';
      msg.hidden = false;
      return;
    }

    document.getElementById('perfil-stat-chart-wrap').hidden = false;
    renderChart_('perfil-stat-chart', {
      type: 'line',
      data: {
        labels: eras.map(function (era) { return formatEraLabel_(era); }),
        datasets: stats.map(function (stat, i) {
          var byEra = byEraPerStat[i];
          var color = PERFIL_CHART_COLORS_[i] || COLORS.scaleBest;
          return {
            label: stat,
            data: eras.map(function (era) { return byEra[era] === null || byEra[era] === undefined ? null : Number(byEra[era]) || 0; }),
            borderColor: color,
            backgroundColor: color,
            tension: 0.2
          };
        })
      },
      options: chartBaseOptions_()
    });
  }

  // ---------------- Tabs ----------------
  /** Switches the Estadísticas sub-nav to `tab` ('temporada'/'historial'/
   * 'records') — pulled out of setupTabs()'s click handler so anything
   * else that needs to land on a specific sub-tab programmatically (see
   * the Inicio card's "Ver todos los resultados" link) can call this
   * directly instead of having to simulate a click on the right button. */
  function activateEstadisticasTab_(tab) {
    document.querySelectorAll('#estadisticas-subnav .tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
    document.getElementById('tab-' + tab).classList.add('active');
    // The "wide" layout (setWideLayout, called from renderLeaderboard)
    // lives on <main> — shared by both tab panels, since a panel can
    // never render wider than its own parent — rather than scoped to
    // #tab-historial specifically. It's only ever meant for the
    // Jugadores detail view, so switching tabs must explicitly
    // resync it: otherwise leaving "Mostrar detalle" enabled on
    // Jugadores keeps <main> stretched to 1400px even after
    // switching to Equipo, stretching its tables/gaps too. Same
    // boolean renderLeaderboard() itself uses for setWideLayout.
    document.querySelector('main').classList.toggle('wide', tab === 'historial' && state.detail);
    // The leaderboard's very first render happens in init(), before
    // the user has clicked any tab — if "Jugadores" isn't the
    // default active tab, that render happens while it's still
    // display: none, so syncStickyOffsets_'s width measurement
    // returns 0 (see its own visibility guard) and never gets a
    // real value. Re-measuring now that this tab is actually
    // visible catches that case, and is a harmless no-op otherwise
    // (re-measuring an already-correct value doesn't change it).
    syncStickyOffsets_();

    // Récords' two highlight cards need the full historical detail
    // (data-history-detail.json) — lazily fetched (and cached) the
    // same way as the Equipo tab's all-time balance / Individuales'
    // "Mostrar detalle" older-era view. Líderes Históricos above it
    // doesn't need this fetch at all (already rendered once at
    // init(), see renderRecordsLeaders_) so it shows instantly even
    // while this one's still loading.
    if (tab === 'records') renderRecordsHighlights_();
  }

  function setupTabs() {
    document.querySelectorAll('#estadisticas-subnav .tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { activateEstadisticasTab_(btn.dataset.tab); });
    });
  }

  // ---------------- Equipo ----------------
  function setupEquipoControls(data) {
    document.getElementById('team-era-filter').addEventListener('change', function (e) {
      state.teamEra = e.target.value;
      renderEquipo();
    });
    populateTeamEraFilter(data);
    renderEquipo();
  }

  /** Season dropdown source: PA's own era list. PA/PI both only cover
   * the 14 real season docs (never the 3 legacy-only eras, which have
   * no RES tab at all to build a season summary from) — GOL's list is
   * NOT used here since it also includes those 3 legacy eras. */
  function populateTeamEraFilter(data) {
    var select = document.getElementById('team-era-filter');
    var eras = (data.stats.PA ? data.stats.PA.eras : []).slice().reverse();
    select.innerHTML = '<option value="__all__">Todas las temporadas</option>' +
      eras.map(function (era) { return '<option value="' + esc(era) + '">' + esc(formatEraLabel_(era)) + '</option>'; }).join('');
    select.value = '__all__'; // default: all-time balance, not the current season
    state.teamEra = select.value;
  }

  function showTeamSeasonDetail_() {
    document.getElementById('team-message').hidden = true;
    document.getElementById('team-season-detail').hidden = false;
    document.getElementById('team-balance-wrap').hidden = true;
    document.getElementById('team-goals-title').hidden = true;
    document.getElementById('team-goals-chart-wrap').hidden = true;
  }
  function showTeamBalance_() {
    document.getElementById('team-message').hidden = true;
    document.getElementById('team-season-detail').hidden = true;
    document.getElementById('team-balance-wrap').hidden = false;
    document.getElementById('team-goals-title').hidden = false;
    document.getElementById('team-goals-chart-wrap').hidden = false;
  }
  function showTeamMessage_(text) {
    var msg = document.getElementById('team-message');
    msg.textContent = text;
    msg.hidden = false;
    document.getElementById('team-season-detail').hidden = true;
    document.getElementById('team-balance-wrap').hidden = true;
    document.getElementById('team-goals-title').hidden = true;
    document.getElementById('team-goals-chart-wrap').hidden = true;
  }

  /** Main Equipo dispatcher — "Todas" shows the all-time balance table
   * (one row per season); a specific season shows that season's
   * standings + results, sourced from data.json directly if it's the
   * current era, or lazily fetched (and cached) from
   * data-history-detail.json's "equipo" section otherwise — same
   * lazy-fetch pattern as the player Historial tab's older-era detail. */
  function renderEquipo() {
    var data = state.data;
    if (!data) return;

    if (state.teamEra === '__all__') {
      renderTeamBalanceTable_(data);
      return;
    }

    if (data.currentSeason && state.teamEra === data.currentSeason.era) {
      showTeamSeasonDetail_();
      renderTemporadaSeason_(data.currentSeason);
      return;
    }

    showTeamMessage_('Cargando temporada...');
    var requestedEra = state.teamEra;
    fetchHistoryDetail()
      .then(function (historyData) {
        if (state.teamEra !== requestedEra) return; // stale — a newer request already handled it
        var season = historyData && historyData.equipo && historyData.equipo[requestedEra];
        if (!season) {
          showTeamMessage_('Detalle no disponible para esta temporada.');
          return;
        }
        showTeamSeasonDetail_();
        renderTemporadaSeason_({ era: requestedEra, matches: season.matches, standings: season.standings });
      })
      .catch(function (err) {
        if (state.teamEra !== requestedEra) return;
        showTeamMessage_('No se pudo cargar el detalle histórico.');
        console.error(err);
      });
  }

  /** All-time balance — one row per season (newest first), one column
   * per standings value, each with its own blue scale (same convention
   * as the player BALANCE tab). The current season's standings come
   * straight from data.json; the other 13 need the same lazily-fetched
   * data-history-detail.json as everything else historical — but this
   * is the DEFAULT Equipo view, so that fetch effectively happens as
   * soon as the tab is first shown, not on some deferred user action. */
  function renderTeamBalanceTable_(data) {
    var eras = (data.stats.PA ? data.stats.PA.eras : []).slice().reverse();
    showTeamMessage_('Cargando balance histórico...');

    fetchHistoryDetail()
      .then(function (historyData) {
        if (state.teamEra !== '__all__') return;
        renderTeamBalanceRows_(buildTeamBalanceRows_(data, eras, historyData));
      })
      .catch(function (err) {
        if (state.teamEra !== '__all__') return;
        // Degrade gracefully — the current season's own standings are
        // already in hand even if the historical file fails to load.
        var rows = buildTeamBalanceRows_(data, eras, null);
        if (rows.length) { renderTeamBalanceRows_(rows); return; }
        showTeamMessage_('No se pudo cargar el balance histórico.');
        console.error(err);
      });
  }

  function buildTeamBalanceRows_(data, eras, historyData) {
    return eras.map(function (era) {
      var standings = (data.currentSeason && era === data.currentSeason.era)
        ? data.currentSeason.standings
        : (historyData && historyData.equipo && historyData.equipo[era] && historyData.equipo[era].standings);
      return { era: era, standings: standings };
    }).filter(function (r) { return r.standings; });
  }

  function renderTeamBalanceRows_(rows) {
    showTeamBalance_();
    var tbody = document.querySelector('#team-balance-table tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="color:#7fa3a8;">Sin datos.</td></tr>';
      return;
    }

    var STAT_KEYS = ['pj', 'pg', 'pe', 'pp', 'gf', 'gc', 'dif', 'pts'];
    // Per-column scale endpoints — not the uniform grey -> blue gradient
    // every other table on the site uses. PJ has no entry (no scale at
    // all, just a plain count). DIF's low end is GC's own high color
    // (purple) rather than the usual grey, since it's framed as "as bad
    // as the worst GC" to "as good as the best GF" instead of a plain
    // low/high spread.
    var SCALE_ENDPOINTS = {
      pg: { low: COLORS.greyCell, high: COLORS.good },
      pe: { low: COLORS.greyCell, high: COLORS.draw },
      pp: { low: COLORS.greyCell, high: COLORS.bad },
      gf: { low: COLORS.greyCell, high: COLORS.scaleBest },
      gc: { low: COLORS.greyCell, high: COLORS.gcColor },
      dif: { low: COLORS.gcColor, high: COLORS.scaleBest },
      pts: { low: COLORS.greyCell, high: COLORS.good }
    };

    var ranges = {};
    STAT_KEYS.forEach(function (k) {
      if (!SCALE_ENDPOINTS[k]) return; // pj — no scale, nothing to range
      var vals = rows.map(function (r) { return Number(r.standings[k]) || 0; });
      ranges[k] = { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
    });

    tbody.innerHTML = rows.map(function (r) {
      var cells = STAT_KEYS.map(function (k) {
        var v = r.standings[k];
        var endpoints = SCALE_ENDPOINTS[k];
        var color = (v === null || v === undefined || !endpoints) ? null : scaleColor_(v, ranges[k].min, ranges[k].max, endpoints.low, endpoints.high);
        return '<td class="val-strong"' + styleAttr_(color) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td class="val-strong">' + esc(formatEraLabel_(r.era)) + '</td>' + cells + '</tr>';
    }).join('');

    // TOTAL row — plain sums across every season shown, no color scale
    // (matches PJ's own always-plain treatment above).
    var totalCells = STAT_KEYS.map(function (k) {
      var total = rows.reduce(function (sum, r) { return sum + (Number(r.standings[k]) || 0); }, 0);
      return '<td class="val-strong">' + esc(total) + '</td>';
    }).join('');
    tbody.innerHTML += '<tr class="total-row"><td class="val-strong">TOTAL</td>' + totalCells + '</tr>';

    renderTeamGoalsChart_(rows);
  }

  /** GF/GC per season — a line chart, same visual language as the
   * per-season by-jornada chart below. `rows` arrives newest-first (same
   * order as the table above); reversed here so the chart reads
   * oldest -> newest, left to right, like any normal timeline. */
  function renderTeamGoalsChart_(rows) {
    var chronological = rows.slice().reverse();
    var options = chartBaseOptions_();
    renderChart_('team-goals-chart', {
      type: 'line',
      data: {
        labels: chronological.map(function (r) { return formatEraLabel_(r.era); }),
        datasets: [
          { label: 'GF', data: chronological.map(function (r) { return Number(r.standings.gf) || 0; }), borderColor: COLORS.scaleBest, backgroundColor: COLORS.scaleBest, tension: 0.2 },
          { label: 'GC', data: chronological.map(function (r) { return Number(r.standings.gc) || 0; }), borderColor: COLORS.gcColor, backgroundColor: COLORS.gcColor, tension: 0.2 }
        ]
      },
      options: options
    });
  }

  /** Renders one season's standings + results — used for both the
   * current season (data straight from data.json) and any older season
   * (lazily fetched from data-history-detail.json's "equipo" section). */
  function renderTemporadaSeason_(season) {
    if (!season) return;

    // Single-row PJ/PG/PE/PP/GF/GC/DIF/PTS table — same column order as
    // #standings-table's header in index.html and the all-time
    // #team-balance-table (minus its leading Temporada column, implicit
    // here from the season dropdown/heading instead).
    var standingsBody = document.querySelector('#standings-table tbody');
    if (season.standings) {
      var s = season.standings;
      var STANDINGS_KEYS = ['pj', 'pg', 'pe', 'pp', 'gf', 'gc', 'dif', 'pts'];
      // Single-row table, so there's no set of other rows to scale
      // against — each column instead scales against its own natural
      // ceiling: PG/PE/PP can't exceed PJ (matches played), PTS can't
      // exceed PJ*3 (a win every match). GF/GC aren't scaled at all,
      // just always shown in their "high" color — DIF is the one that
      // scales, from GC*-1 (worst possible) to GF (best possible).
      var pj = Number(s.pj) || 0;
      var gf = Number(s.gf) || 0;
      var gc = Number(s.gc) || 0;
      var STANDINGS_COLOR = {
        pg: function (v) { return scaleColor_(v, 0, pj, COLORS.greyCell, COLORS.good); },
        pe: function (v) { return scaleColor_(v, 0, pj, COLORS.greyCell, COLORS.draw); },
        pp: function (v) { return scaleColor_(v, 0, pj, COLORS.greyCell, COLORS.bad); },
        gf: function () { return COLORS.scaleBest; },
        gc: function () { return COLORS.gcColor; },
        dif: function (v) { return scaleColor_(v, -gc, gf, COLORS.gcColor, COLORS.scaleBest); },
        pts: function (v) { return scaleColor_(v, 0, pj * 3, COLORS.greyCell, COLORS.good); }
      };
      standingsBody.innerHTML = '<tr>' + STANDINGS_KEYS.map(function (k) {
        var v = s[k];
        var color = (v === null || v === undefined || !STANDINGS_COLOR[k]) ? null : STANDINGS_COLOR[k](v);
        return '<td' + styleAttr_(color) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('') + '</tr>';
    } else {
      standingsBody.innerHTML = '<tr><td colspan="8" style="color:#7fa3a8;">Tabla de posiciones no disponible aún.</td></tr>';
    }

    var tbody = document.querySelector('#matches-table tbody');
    var matches = season.matches || []; // chronological order: J1 first
    if (!matches.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:#7fa3a8;">Sin partidos jugados todavía.</td></tr>';
    } else {
      // Cancha (blue) and Hora (purple) gradients — computed from this
      // season's own played matches, low value -> light end, high -> dark.
      var canchaVals = matches.map(function (m) { return Number(m.cancha); }).filter(function (v) { return !isNaN(v); });
      var canchaMin = canchaVals.length ? Math.min.apply(null, canchaVals) : 0;
      var canchaMax = canchaVals.length ? Math.max.apply(null, canchaVals) : 0;
      var horaMins = matches.map(function (m) { return parseHoraMinutes_(m.hora); }).filter(function (v) { return v !== null; });
      var horaMin = horaMins.length ? Math.min.apply(null, horaMins) : 0;
      var horaMax = horaMins.length ? Math.max.apply(null, horaMins) : 0;

      // Column order: Jornada, Resultado, Marc. (GF-GC merged into one
      // "3 - 2" cell), Rival, Fecha, Hora, Cancha — most important data
      // first (visible without scrolling on a phone), with Jornada
      // staying first/sticky throughout.
      tbody.innerHTML = matches.map(function (m) {
        var resClass = m.resultado === 'g' ? 'result-chip-g' : m.resultado === 'p' ? 'result-chip-p' : m.resultado === 'e' ? 'result-chip-e' : '';
        var canchaNum = Number(m.cancha);
        var canchaColor = isNaN(canchaNum) ? null : scaleColor_(canchaNum, canchaMin, canchaMax, COLORS.canchaLight, COLORS.canchaDark);
        var horaVal = parseHoraMinutes_(m.hora);
        var horaColor = horaVal === null ? null : scaleColor_(horaVal, horaMin, horaMax, COLORS.horaLight, COLORS.horaDark);
        // Rival kit colors come straight from RES's own Rival cell
        // formatting (bg/font color) in the season doc — no separate
        // Rivales tab. A rival cell with no color set gets no inline
        // style (default cell).
        var rivalStyle = m.rivalBg ? ' style="background:' + esc(m.rivalBg) + ';color:' + esc(m.rivalText || '#ffffff') + '"' : '';
        var marcador = esc(m.gf) + ' - ' + esc(m.gc);

        return '<tr><td class="jornada-cell">' + esc(m.jornada) + '</td><td class="result-chip ' + resClass + '"></td>' +
          '<td class="val-strong">' + marcador + '</td>' +
          '<td' + rivalStyle + '>' + esc(m.rival) + '</td><td>' + esc(formatFechaCorta_(m.fecha)) + '</td>' +
          '<td' + styleAttr_(horaColor) + '>' + esc(m.hora) + '</td><td' + styleAttr_(canchaColor) + '>' + esc(m.cancha) + '</td></tr>';
      }).join('');
    }

    renderSeasonGoalsChart_(matches);
  }

  /** GF/GC per jornada, one season — a line chart (unlike the all-seasons
   * bar chart above), since jornadas within a single season DO form a
   * real continuous trend. `matches` already arrives chronological
   * (J1 first, see readMatchLog_ in dashboard_export.gs), so no
   * reordering needed here. An empty season (no matches played yet)
   * still renders — an empty chart, same "nothing to show yet" look as
   * the empty-state row already in the Resultados table above it. */
  function renderSeasonGoalsChart_(matches) {
    // No matches played yet this season — the Resultados table above
    // already shows its own "Sin partidos jugados todavía" row; an
    // empty chart underneath it would just be dead space, so hide the
    // whole chart (title included) instead of rendering one.
    document.getElementById('season-goals-title').hidden = !matches.length;
    document.getElementById('season-goals-chart-wrap').hidden = !matches.length;
    if (!matches.length) return;

    var options = chartBaseOptions_();
    renderChart_('season-goals-chart', {
      type: 'line',
      data: {
        labels: matches.map(function (m) { return m.jornada; }),
        datasets: [
          { label: 'GF', data: matches.map(function (m) { return Number(m.gf) || 0; }), borderColor: COLORS.scaleBest, backgroundColor: COLORS.scaleBest, tension: 0.2 },
          { label: 'GC', data: matches.map(function (m) { return Number(m.gc) || 0; }), borderColor: COLORS.gcColor, backgroundColor: COLORS.gcColor, tension: 0.2 }
        ]
      },
      options: options
    });
  }

  /** Parses a Hora display value ("10:30") into minutes-since-midnight
   * for the Results table's purple gradient. Returns null (no color)
   * for anything that doesn't match the expected "H:MM" shape. */
  function parseHoraMinutes_(hora) {
    var m = String(hora || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  var MESES_ES_ = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  /** Reformats data.json's ISO "yyyy-MM-dd" Fecha into the shorter
   * "DD/Mmm/YY" the Results table shows (e.g. "2026-07-04" -> "04/Jul/26"),
   * so the column doesn't need to be as wide. Falls back to the raw
   * value unchanged if it isn't in the expected shape. */
  function formatFechaCorta_(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    var mes = MESES_ES_[Number(m[2]) - 1];
    if (!mes) return iso;
    return m[3] + '/' + mes + '/' + m[1].slice(2);
  }

  // ---------------- Historial (leaderboards) ----------------
  // Scoped to #stat-selector specifically (not a bare global ".stat-btn"
  // query) — that class is shared with two OTHER, unrelated selectors
  // (Historia's Jerseys Jugador/Portero toggle, and Perfil's own stat
  // selector below), which would otherwise also get wired to this exact
  // handler and have their clicks silently corrupt state.stat/#stat-title
  // for a page/section they don't even belong to.
  function setupHistorialControls(data) {
    document.querySelectorAll('#stat-selector .stat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('#stat-selector .stat-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.stat = btn.dataset.stat;
        document.getElementById('stat-title').textContent = STAT_TITLES[state.stat] || state.stat;
        updateDetailToggleAvailability_();
        populateEraFilter(data);
        renderLeaderboard();
      });
    });

    document.getElementById('player-search').addEventListener('input', function (e) {
      state.search = e.target.value.trim().toLowerCase();
      renderLeaderboard();
    });

    document.getElementById('era-filter').addEventListener('change', function (e) {
      state.era = e.target.value;
      renderLeaderboard();
    });

    document.getElementById('detail-toggle').addEventListener('change', function (e) {
      state.detail = e.target.checked;
      renderLeaderboard();
    });

    document.getElementById('stat-title').textContent = STAT_TITLES[state.stat] || state.stat;
    updateDetailToggleAvailability_();
    populateEraFilter(data);
  }

  /** BALANCE has no meaningful "detailed" view (it's already a 4-column
   * summary) — the checkbox is disabled and forced off while BALANCE is
   * the active stat, and re-enabled when switching to any real stat. */
  function updateDetailToggleAvailability_() {
    var checkbox = document.getElementById('detail-toggle');
    var isBalance = state.stat === 'BALANCE';
    checkbox.disabled = isBalance;
    if (isBalance && state.detail) {
      state.detail = false;
      checkbox.checked = false;
    }
  }

  function populateEraFilter(data) {
    var select = document.getElementById('era-filter');
    // BALANCE has no stat block of its own — GOL's era list is the most
    // complete (it's the only stat with data back through the 3 legacy
    // eras), so it doubles as BALANCE's era dropdown too.
    var statBlock = data.stats[state.stat] || data.stats.GOL;
    // eras arrives oldest-first (matches the historical doc's own column
    // order); the dropdown shows most-recent-first, "Todas" pinned on top.
    var eras = (statBlock ? statBlock.eras : []).slice().reverse();
    var current = select.value || '__all__';
    select.innerHTML = '<option value="__all__">Todas las temporadas</option>' +
      eras.map(function (era) { return '<option value="' + esc(era) + '">' + esc(formatEraLabel_(era)) + '</option>'; }).join('');
    select.value = eras.indexOf(current) >= 0 ? current : '__all__';
    state.era = select.value;
  }

  function matchesSearch_(nombre) {
    if (!state.search) return true;
    return String(nombre).toLowerCase().indexOf(state.search) >= 0;
  }

  /** Assigns "competition" rank (ties share a rank; the rank after a
   * tie skips ahead by the tie's size — 1,2,2,4) to every item in
   * `rows`, which must already be sorted by value descending. Mutates
   * each row with a `.rank` property. Always called on the FULL,
   * unfiltered row set — the search box only hides rows afterward, it
   * never renumbers what's left. */
  function assignRanks_(rows, valueFn) {
    var prevVal = null, prevRank = 0;
    rows.forEach(function (row, i) {
      var v = Number(valueFn(row)) || 0;
      if (prevVal === null || v !== prevVal) {
        row.rank = i + 1;
        prevRank = row.rank;
        prevVal = v;
      } else {
        row.rank = prevRank;
      }
    });
  }

  function rankPillHtml(rank) {
    return String(rank);
  }

  function setTableHead(html) { document.querySelector('#leaderboard-table thead').innerHTML = html; }
  function setTableBody(html) {
    document.querySelector('#leaderboard-table tbody').innerHTML = html;
    syncStickyOffsets_();
  }

  /** The frozen leading columns' "left" offsets (--sticky-left-2/-3,
   * read by style.css) are measured from the ACTUAL rendered width of
   * the header row's cells, not assumed from a CSS width declaration.
   * These tables use table-layout: auto (so the Jugador name column
   * can stay content-flexible instead of a fixed width), and auto
   * layout only ever treats a cell's declared "width" as a hint, not a
   * guarantee — the real rendered width of the rank/dorsal columns can
   * differ slightly by device/font. A hardcoded rem-based offset left
   * a visible gap between dorsal and Jugador on one phone despite
   * looking correct on desktop; measuring what actually rendered is
   * correct everywhere, not just wherever it was last tuned. Called
   * after every table body render (from setTableBody, above), so it's
   * always in sync with whatever just got drawn — including the
   * BALANCE-mode column shift (rank column absent, so column 1 is
   * dorsal instead of rank; the formula is identical either way, it's
   * just "the width of whatever column 1 actually is").
   *
   * GUARDED against measuring while hidden: the table's very first
   * render happens in init(), before the user has clicked any tab —
   * if the Jugadores tab isn't the default active one, that render
   * happens while #leaderboard-table sits inside a display: none
   * panel, and getBoundingClientRect() on anything inside a hidden
   * subtree always returns 0. Writing that 0 as a real offset made the
   * Jugador column stick at the same left: 0 as the dorsal column,
   * completely covering it — worse than the gap this was meant to
   * fix. table.offsetParent is null whenever an ancestor is
   * display: none, so this bails out and leaves the CSS's rem
   * fallback in place instead; setupTabs()'s click handler re-calls
   * this once the tab is actually visible, so a real measurement
   * always follows shortly after. */
  function syncStickyOffsets_() {
    var table = document.getElementById('leaderboard-table');
    if (!table || !table.offsetParent) return;
    var headRow = table.querySelector('thead tr');
    if (!headRow || headRow.children.length < 2) return;
    var width1 = headRow.children[0].getBoundingClientRect().width;
    if (!width1) return;
    table.style.setProperty('--sticky-left-2', width1 + 'px');
    if (!table.classList.contains('balance-mode') && headRow.children.length >= 3) {
      var width2 = headRow.children[1].getBoundingClientRect().width;
      table.style.setProperty('--sticky-left-3', (width1 + width2) + 'px');
    }
  }
  // Same underlying reason as the tab-switch re-sync above: a rendered
  // width can go stale any time the viewport reflows the table without
  // re-rendering it — e.g. rotating a phone, or resizing a desktop
  // window — so re-measure on resize too. Cheap (a couple of
  // getBoundingClientRect reads) and a safe no-op while the leaderboard
  // tab is hidden, per this function's own visibility guard.
  window.addEventListener('resize', function () { syncStickyOffsets_(); });

  function setWideLayout(wide) {
    document.getElementById('leaderboard-wrap').classList.toggle('compact', !wide);
    document.querySelector('main').classList.toggle('wide', wide);
  }

  function showLeaderboardTable() {
    document.getElementById('detail-message').hidden = true;
    document.getElementById('leaderboard-wrap').hidden = false;
  }

  function showDetailMessage(text) {
    var msg = document.getElementById('detail-message');
    msg.textContent = text;
    msg.hidden = false;
    document.getElementById('leaderboard-wrap').hidden = true;
  }

  /** Main dispatcher — picks one of three render modes based on the
   * "Mostrar detalle" toggle and which era is selected:
   *   - toggle off              -> simple TOT/single-era table (unchanged)
   *   - toggle on, "Todas"      -> one column per era (already in data.json)
   *   - toggle on, current era  -> per-match columns (already in data.json's "detail")
   *   - toggle on, older era    -> per-match columns, lazy-fetched from
   *                                data-history-detail.json (cached after first load)
   */
  function renderLeaderboard() {
    var data = state.data;
    if (!data) return;

    document.getElementById('leaderboard-table').classList.toggle('balance-mode', state.stat === 'BALANCE');

    if (state.stat === 'BALANCE') {
      showLeaderboardTable();
      setWideLayout(false);
      renderBalanceLeaderboard(data);
      return;
    }

    var statBlock = data.stats[state.stat];

    if (!statBlock || !statBlock.players.length) {
      showLeaderboardTable();
      setWideLayout(false);
      setTableHead('<tr><th>#</th><th>N°</th><th>Jugador</th><th>TOT</th></tr>');
      setTableBody('<tr><td colspan="100" style="color:#7fa3a8;">Sin datos.</td></tr>');
      return;
    }

    if (!state.detail) {
      showLeaderboardTable();
      setWideLayout(false);
      renderSimpleLeaderboard(statBlock);
      return;
    }

    setWideLayout(true);

    if (state.era === '__all__') {
      showLeaderboardTable();
      renderEraWideLeaderboard(statBlock);
      return;
    }

    if (data.detail && state.era === data.detail.era && data.detail[state.stat]) {
      showLeaderboardTable();
      renderMatchDetailLeaderboard(data.detail[state.stat]);
      return;
    }

    // Older season — lazy fetch data-history-detail.json (once, cached).
    showDetailMessage('Cargando detalle...');
    var requestedEra = state.era, requestedStat = state.stat;
    fetchHistoryDetail()
      .then(function (historyData) {
        // If the user changed era/stat/toggle while this was in flight,
        // a fresh renderLeaderboard() already handled it — don't stomp it.
        if (!state.detail || state.era !== requestedEra || state.stat !== requestedStat) return;
        var eraData = historyData && historyData.eras && historyData.eras[requestedEra];
        var statDetail = eraData ? eraData[requestedStat] : undefined;
        if (!statDetail || !statDetail.columns || !statDetail.columns.length) {
          showDetailMessage('Detalle no disponible para esta temporada.');
          return;
        }
        showLeaderboardTable();
        renderMatchDetailLeaderboard(statDetail);
      })
      .catch(function (err) {
        if (!state.detail || state.era !== requestedEra || state.stat !== requestedStat) return;
        showDetailMessage('No se pudo cargar el detalle histórico.');
        console.error(err);
      });
  }

  function fetchHistoryDetail() {
    if (!state.historyDetailPromise) {
      state.historyDetailPromise = fetch(HISTORY_DETAIL_URL).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    return state.historyDetailPromise;
  }

  // ---------------- Récords ----------------

  /** Líderes Históricos — top 5 per stat, all-time. No fetch needed:
   * data.stats[stat].players already arrives sorted by all-time total
   * (dorsal-ascending tiebreak) straight from the Apps Script export
   * (writeStatTab_ physically re-sorts the historical doc's own tabs on
   * every write) — this just takes the first 5 rows as-is. Dorsal isn't
   * shown here (Daniel: unnecessary, can even be misleading — a
   * player's dorsal has changed across eras, so printing whichever one
   * happens to be "current" next to an ALL-TIME total reads oddly). */
  function renderRecordsLeaders_() {
    var data = state.data;
    var wrap = document.getElementById('records-leaders');
    if (!data || !wrap) return;
    wrap.innerHTML = STATS_ORDER.map(function (stat) {
      var block = data.stats && data.stats[stat];
      var top = block ? block.players.slice(0, 5) : [];
      var rowsHtml = top.length
        ? top.map(function (p, i) {
            return '<div class="record-leader-row"><span class="record-leader-rank">' + (i + 1) + '</span>' +
              '<span class="record-leader-nombre">' + esc(p.nombre) + '</span>' +
              '<span class="record-leader-total">' + esc(p.total) + '</span></div>';
          }).join('')
        : '<p class="detail-message">Sin datos.</p>';
      return '<div class="record-leader-col"><h4>' + esc(STAT_TITLES[stat] || stat) + '</h4>' + rowsHtml + '</div>';
    }).join('');
  }

  /** Every era's own match log (RES), keyed by era — current season's
   * straight from data.json, every older era's from the lazily-fetched
   * historyData.equipo (no entry at all for the 3 legacy-only eras,
   * which never had a season doc / RES tab to begin with). Shared by
   * every match-level record below (team goals, both streaks) and the
   * Equipo tab's own all-time balance table. */
  function allEraMatches_(historyData) {
    var data = state.data;
    var byEra = {};
    (data.seasons || []).forEach(function (s) {
      var era = s.era;
      if (data.currentSeason && era === data.currentSeason.era) {
        byEra[era] = data.currentSeason.matches || [];
      } else {
        var e = historyData && historyData.equipo && historyData.equipo[era];
        byEra[era] = (e && e.matches) || [];
      }
    });
    return byEra;
  }

  /** Every era's own per-match detail block for one stat (columns +
   * per-player byMatch) — GOL or AST, keyed by era. Current season's
   * from data.detail[stat], every older era's from the lazily-fetched
   * historyData.eras[era][stat] (GOL only for the 3 legacy-only eras —
   * AST simply has no entry there, same as everywhere else in this
   * project AST predates 2022/23). */
  function allEraStatDetail_(historyData, stat) {
    var data = state.data;
    var byEra = {};
    (data.seasons || []).forEach(function (s) {
      var era = s.era;
      if (data.currentSeason && era === data.currentSeason.era && data.detail && data.detail[stat]) {
        byEra[era] = data.detail[stat];
        return;
      }
      var e = historyData && historyData.eras && historyData.eras[era] && historyData.eras[era][stat];
      if (e) byEra[era] = e;
    });
    return byEra;
  }

  /** Highest single-match value for one player stat (GOL or AST) across
   * every era, every real player ([Default]/[Autogoles] utility rows
   * excluded — a team-credit goal isn't a player's own record). Every
   * tie at the max gets its own entry. Match context (rival/fecha) comes
   * from a jornada-prefix join against that era's own RES matches
   * (allEraMatches_, same join convention detailColumnIndex_ already
   * uses elsewhere) — falls back to the raw "J1 MAP"-style column text
   * when there's no matches list to join against at all (GOL's 3
   * legacy-only eras, which have match detail but never had a RES tab). */
  function mostStatInMatchRecord_(historyData, stat) {
    var detailByEra = allEraStatDetail_(historyData, stat);
    var matchesByEra = allEraMatches_(historyData);
    var best = []; // [{nombre, era, valor, columnIdx}]
    var max = 0;

    Object.keys(detailByEra).forEach(function (era) {
      var block = detailByEra[era];
      if (!block || !block.columns || !block.players) return;
      block.players.forEach(function (p) {
        if (p.isUtility) return;
        (p.byMatch || []).forEach(function (v, idx) {
          var n = Number(v);
          if (!n || isNaN(n)) return;
          if (n > max) { max = n; best = []; }
          if (n === max) best.push({ nombre: p.nombre, era: era, valor: n, columnIdx: idx });
        });
      });
    });

    return {
      max: max,
      entries: best.map(function (b) {
        var column = detailByEra[b.era].columns[b.columnIdx];
        var jornada = String(column.partido || '').split(' ')[0];
        var matches = matchesByEra[b.era] || [];
        var match = matches.filter(function (m) { return m.jornada === jornada; })[0];
        var label = match ? ('vs ' + match.rival + ' — ' + formatFechaCorta_(match.fecha)) : column.partido;
        return { nombre: b.nombre, era: b.era, valor: b.valor, matchLabel: label };
      })
    };
  }

  /** Highest SEASON total for one player stat (GOL or AST) — this one
   * needs no historical-detail fetch at all, data.stats[stat].players[]
   * .byEra already holds every era's totals straight from the main
   * data.json. Computed alongside the fetch-dependent records anyway
   * (see renderRecordsHighlights_) purely so the whole Récords section
   * pops in together instead of some cards appearing before others. */
  function mostStatInSeasonRecord_(stat) {
    var data = state.data;
    var block = data.stats && data.stats[stat];
    var best = []; // [{nombre, era, valor}]
    var max = 0;
    if (block) {
      block.players.forEach(function (p) {
        Object.keys(p.byEra || {}).forEach(function (era) {
          var n = Number(p.byEra[era]);
          if (!n || isNaN(n)) return;
          if (n > max) { max = n; best = []; }
          if (n === max) best.push({ nombre: p.nombre, era: era, valor: n });
        });
      });
    }
    return { max: max, entries: best.map(function (b) { return { nombre: b.nombre, era: b.era }; }) };
  }

  /** Highest single-match team GF across every era — same join as
   * mostStatInMatchRecord_ but reading straight off each match's own gf
   * field (allEraMatches_), no per-player detail involved. */
  function mostTeamGoalsInMatchRecord_(historyData) {
    var matchesByEra = allEraMatches_(historyData);
    var best = []; // [{era, match}]
    var max = 0;
    Object.keys(matchesByEra).forEach(function (era) {
      matchesByEra[era].forEach(function (m) {
        var n = Number(m.gf);
        if (!n || isNaN(n)) return;
        if (n > max) { max = n; best = []; }
        if (n === max) best.push({ era: era, match: m });
      });
    });
    return {
      max: max,
      entries: best.map(function (b) {
        return { era: b.era, matchLabel: 'vs ' + b.match.rival + ' — ' + formatFechaCorta_(b.match.fecha) };
      })
    };
  }

  /** Highest SEASON team GF total — reuses buildTeamBalanceRows_ (the
   * exact same all-time-balance computation the Equipo tab's own "Todas
   * las temporadas" table already does), rather than re-deriving
   * standings a second way. */
  function mostTeamGoalsInSeasonRecord_(historyData) {
    var data = state.data;
    var eras = (data.stats.PA ? data.stats.PA.eras : []).slice().reverse();
    var rows = buildTeamBalanceRows_(data, eras, historyData);
    var best = []; // [era, ...]
    var max = 0;
    rows.forEach(function (r) {
      var n = Number(r.standings.gf);
      if (!n || isNaN(n)) return;
      if (n > max) { max = n; best = []; }
      if (n === max) best.push(r.era);
    });
    return { max: max, entries: best.map(function (era) { return { era: era }; }) };
  }

  /** Longest run of consecutive matches satisfying `matchOk` (a function
   * of the resultado letter) across the FULL chronological match history
   * — every era in data.seasons order, each era's own matches already
   * jornada-ordered (the 3 legacy-only eras contribute nothing,
   * allEraMatches_ never has a real entry for them). Every streak tied
   * at the max length gets its own entry, not just the first/most recent
   * one found. Shared by the win-streak and unbeaten-streak records
   * below — rival names deliberately left out of the range label
   * (Daniel: showing just the two EDGE matches' rivals doesn't convey
   * anything about the whole streak and just clutters the read), so it's
   * only ever era + jornada. */
  function longestStreakRecord_(historyData, matchOk) {
    var data = state.data;
    var matchesByEra = allEraMatches_(historyData);
    var all = [];
    (data.seasons || []).forEach(function (s) {
      (matchesByEra[s.era] || []).forEach(function (m) { all.push({ era: s.era, match: m }); });
    });

    var streaks = [];
    var current = null;
    all.forEach(function (entry) {
      if (matchOk(entry.match.resultado)) {
        if (!current) current = { length: 0, start: entry };
        current.length++;
        current.end = entry;
      } else if (current) {
        streaks.push(current);
        current = null;
      }
    });
    if (current) streaks.push(current);

    var max = streaks.reduce(function (m, s) { return Math.max(m, s.length); }, 0);
    var top = streaks.filter(function (s) { return s.length === max; });

    return {
      max: max,
      entries: top.map(function (s) {
        var startLabel = formatEraLabel_(s.start.era) + ' · ' + s.start.match.jornada;
        var endLabel = formatEraLabel_(s.end.era) + ' · ' + s.end.match.jornada;
        return { length: s.length, rangeLabel: s.start === s.end ? startLabel : (startLabel + ' → ' + endLabel) };
      })
    };
  }

  function longestWinStreakRecord_(historyData) {
    return longestStreakRecord_(historyData, function (r) { return r === 'g'; });
  }
  function longestUnbeatenStreakRecord_(historyData) {
    return longestStreakRecord_(historyData, function (r) { return r !== 'p'; });
  }

  /** All 8 highlight cards — the team/season records and both streaks
   * need the full historical detail (data-history-detail.json), lazily
   * fetched (and cached) the same way the Equipo tab's all-time balance
   * / Individuales' older-era detail view already do; the two season-
   * total player records don't strictly need it (see
   * mostStatInSeasonRecord_) but are computed here too anyway so the
   * whole section renders together rather than in two visible waves.
   * Líderes Históricos above all this doesn't depend on any of it (see
   * renderRecordsLeaders_, called once at init()), so it's already on
   * screen while this is still loading. */
  function renderRecordsHighlights_() {
    var msg = document.getElementById('records-message');
    var grid = document.getElementById('records-highlights');
    if (!msg || !grid) return;
    msg.textContent = 'Cargando récords...';
    msg.hidden = false;
    grid.hidden = true;

    fetchHistoryDetail()
      .then(function (historyData) {
        renderRecordCard_('record-goles-partido', mostStatInMatchRecord_(historyData, 'GOL'), function (e) {
          return esc(e.nombre) + '<span class="record-highlight-meta">' + esc(formatEraLabel_(e.era)) + ' — ' + esc(e.matchLabel) + '</span>';
        });
        renderRecordCard_('record-goles-temporada', mostStatInSeasonRecord_('GOL'), function (e) {
          return esc(e.nombre) + '<span class="record-highlight-meta">' + esc(formatEraLabel_(e.era)) + '</span>';
        });
        renderRecordCard_('record-asistencias-partido', mostStatInMatchRecord_(historyData, 'AST'), function (e) {
          return esc(e.nombre) + '<span class="record-highlight-meta">' + esc(formatEraLabel_(e.era)) + ' — ' + esc(e.matchLabel) + '</span>';
        });
        renderRecordCard_('record-asistencias-temporada', mostStatInSeasonRecord_('AST'), function (e) {
          return esc(e.nombre) + '<span class="record-highlight-meta">' + esc(formatEraLabel_(e.era)) + '</span>';
        });
        renderRecordCard_('record-goles-partido-equipo', mostTeamGoalsInMatchRecord_(historyData), function (e) {
          return esc(formatEraLabel_(e.era)) + ' — ' + esc(e.matchLabel);
        });
        renderRecordCard_('record-goles-temporada-equipo', mostTeamGoalsInSeasonRecord_(historyData), function (e) {
          return esc(formatEraLabel_(e.era));
        });
        renderRecordCard_('record-racha', longestWinStreakRecord_(historyData), function (e) { return esc(e.rangeLabel); });
        renderRecordCard_('record-invicto', longestUnbeatenStreakRecord_(historyData), function (e) { return esc(e.rangeLabel); });

        msg.hidden = true;
        grid.hidden = false;
      })
      .catch(function (err) {
        msg.textContent = 'No se pudo cargar el detalle histórico.';
        console.error(err);
      });
  }

  /** Shared renderer for one record card's content: the big headline
   * number, then one .record-highlight-entry per tied record-holder (via
   * `entryHtml`) — no separate "goles en un partido"-style label under
   * the number, since the card's own <h5> title already says exactly
   * that (Daniel: redundant). */
  function renderRecordCard_(elId, record, entryHtml) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = record.max
      ? '<div class="record-highlight-value">' + esc(record.max) + '</div>' +
        record.entries.map(function (e) { return '<div class="record-highlight-entry">' + entryHtml(e) + '</div>'; }).join('')
      : '<p class="detail-message">Sin datos.</p>';
  }

  /** BALANCE — a fifth, always-simple view: every player's total across
   * all 4 real stats in one row. No "#" rank column (there's no single
   * value to rank by here) — ordered by dorsal ascending instead.
   * Respects the era dropdown like every other stat (per-era dorsal +
   * per-era values), but never the detail toggle (disabled whenever
   * BALANCE is active — see updateDetailToggleAvailability_). */
  function renderBalanceLeaderboard(data) {
    setTableHead('<tr><th>N°</th><th>Jugador</th><th>GOL</th><th>AST</th><th>PA</th><th>PI</th></tr>');

    // Union of every player appearing in ANY of the 4 stat blocks — GOL
    // alone isn't guaranteed exhaustive (e.g. a player who only ever
    // appears in PA/PI edge cases), so this doesn't assume one master list.
    var byName = {};
    STATS_ORDER.forEach(function (stat) {
      var block = data.stats[stat];
      if (!block) return;
      block.players.forEach(function (p) {
        if (!byName[p.nombre]) byName[p.nombre] = { nombre: p.nombre, dorsal: p.dorsal, values: {} };
        var entry = byName[p.nombre];
        entry.values[stat] = state.era === '__all__' ? p.total : (p.byEra ? p.byEra[state.era] : undefined);
        if (!entry.dorsal) entry.dorsal = p.dorsal;
      });
    });

    var allRows = Object.keys(byName).map(function (nombre) { return byName[nombre]; });
    // Dorsal ascending — non-numeric/missing dorsals sort after every
    // real number, alphabetically among themselves.
    allRows.sort(function (a, b) {
      var da = Number(a.dorsal), db = Number(b.dorsal);
      var aValid = !isNaN(da) && a.dorsal !== '', bValid = !isNaN(db) && b.dorsal !== '';
      if (aValid && bValid) return da - db;
      if (aValid) return -1;
      if (bValid) return 1;
      return String(a.nombre).localeCompare(String(b.nombre));
    });

    var rows = allRows.filter(function (r) {
      if (!matchesSearch_(r.nombre)) return false;
      // "Todas" -> anyone who ever has a real all-time record (as with
      // every other stat table). A specific season -> only players with
      // a defined value in at least one of the 4 stats that era, same
      // "byEra[era] !== undefined" participation test the single-stat
      // views already use — otherwise every player who's ever existed
      // shows up in every season's table, blank cells and all.
      if (state.era === '__all__') return true;
      return STATS_ORDER.some(function (stat) { return r.values[stat] !== undefined && r.values[stat] !== null; });
    });
    if (!rows.length) {
      setTableBody('<tr><td colspan="6" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    // Each stat column gets its own blue scale (grey at that column's
    // lowest visible value, scale-best at its highest) — independent
    // per column, same convention as the TOT column everywhere else.
    var columnRanges = {};
    STATS_ORDER.forEach(function (stat) {
      var vals = rows.map(function (r) { return Number(r.values[stat]) || 0; });
      columnRanges[stat] = { min: vals.length ? Math.min.apply(null, vals) : 0, max: vals.length ? Math.max.apply(null, vals) : 0 };
    });

    setTableBody(rows.map(function (r) {
      var dorsal = state.era === '__all__' ? r.dorsal : dorsalForEra_(r, state.era);
      var idBg = activoBackground_(r.nombre);
      var statCells = STATS_ORDER.map(function (stat) {
        var v = r.values[stat];
        var range = columnRanges[stat];
        var color = (v === null || v === undefined) ? null : scaleColor_(v, range.min, range.max, COLORS.greyCell, COLORS.scaleBest);
        return '<td class="val-strong"' + styleAttr_(color) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td' + idBg + '>' + esc(dorsal) + '</td><td' + idBg + '>' + esc(r.nombre) + '</td>' + statCells + '</tr>';
    }).join(''));
  }

  /** Simple mode (toggle off) — TOT, or one specific era's total. */
  function renderSimpleLeaderboard(statBlock) {
    var valueHeader = state.era === '__all__' ? 'TOT' : formatEraLabel_(state.era);
    setTableHead('<tr><th>#</th><th>N°</th><th>Jugador</th><th>' + esc(valueHeader) + '</th></tr>');

    var allRows;
    if (state.era === '__all__') {
      allRows = statBlock.players.map(function (p) { return { p: p, val: p.total }; });
    } else {
      allRows = statBlock.players
        .filter(function (p) { return p.byEra && p.byEra[state.era] !== undefined; })
        .map(function (p) { return { p: p, val: p.byEra[state.era] }; });
      allRows.sort(function (a, b) {
        var diff = (Number(b.val) || 0) - (Number(a.val) || 0);
        if (diff !== 0) return diff;
        return (Number(a.p.dorsal) || 0) - (Number(b.p.dorsal) || 0);
      });
    }
    // Rank on the full list first, then filter — ties share a rank and
    // the search box never renumbers what's left visible.
    assignRanks_(allRows, function (r) { return r.val; });
    var rows = allRows.filter(function (r) { return matchesSearch_(r.p.nombre); });

    if (!rows.length) {
      setTableBody('<tr><td colspan="4" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    var scales = rankTotalStyles_(rows.map(function (r) { return { rank: r.rank, total: r.val }; }));

    setTableBody(rows.map(function (r) {
      // One specific season selected -> the dorsal that player actually
      // wore THAT season (Jugadores.dorsalByEra), not their current one.
      var dorsal = state.era === '__all__' ? r.p.dorsal : dorsalForEra_(r.p, state.era);
      var idBg = activoBackground_(r.p.nombre);
      return '<tr><td class="rank-cell"' + styleAttr_(scales.rankColor(r.rank)) + '>' + rankPillHtml(r.rank) +
        '</td><td' + idBg + '>' + esc(dorsal) + '</td><td' + idBg + '>' + esc(r.p.nombre) + '</td><td class="val-strong"' +
        styleAttr_(scales.totalColor(r.val)) + '>' + esc(r.val) + '</td></tr>';
    }).join(''));
  }

  /** Detailed mode, "Todas las temporadas" — one column per era, same
   * totals already in data.json (stats[stat].players[].byEra), no
   * extra fetch needed. Player order is already the source doc's own
   * sorted (total desc, dorsal-tiebreak) physical row order. */
  function renderEraWideLeaderboard(statBlock) {
    var eras = statBlock.eras; // oldest-first, matches the historical doc's own layout — real keys, never abbreviated
    var headCells = ['#', 'N°', 'Jugador', 'TOT'].concat(eras.map(formatEraLabel_));
    setTableHead('<tr>' + headCells.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>');

    // statBlock.players is already sorted total desc, dorsal-tiebreak —
    // rank the full list before the search box filters it down.
    var allRows = statBlock.players.map(function (p) { return { p: p }; });
    assignRanks_(allRows, function (r) { return r.p.total; });
    var rows = allRows.filter(function (r) { return matchesSearch_(r.p.nombre); });
    if (!rows.length) {
      setTableBody('<tr><td colspan="100" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    var scales = rankTotalStyles_(rows.map(function (r) { return { rank: r.rank, total: r.p.total }; }));

    var maxEraVal = 0;
    rows.forEach(function (r) {
      eras.forEach(function (era) {
        var v = r.p.byEra && r.p.byEra[era];
        if (v !== undefined && Number(v) > maxEraVal) maxEraVal = Number(v);
      });
    });

    setTableBody(rows.map(function (r) {
      var p = r.p;
      var idBg = activoBackground_(p.nombre);
      var eraCells = eras.map(function (era) {
        var v = p.byEra && p.byEra[era];
        var color = v === undefined ? null : gridValueColor_(v, maxEraVal);
        return '<td' + styleAttr_(color) + '>' + (v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td class="rank-cell"' + styleAttr_(scales.rankColor(r.rank)) + '>' + rankPillHtml(r.rank) +
        '</td><td' + idBg + '>' + esc(p.dorsal) + '</td><td' + idBg + '>' + esc(p.nombre) + '</td><td class="val-strong"' +
        styleAttr_(scales.totalColor(p.total)) + '>' + esc(p.total) + '</td>' + eraCells + '</tr>';
    }).join(''));
  }

  /** Detailed mode, one specific era — per-match columns (either from
   * data.json's "detail" for the current season, or a lazily-fetched
   * data-history-detail.json entry for an older one). Includes a
   * result-colored bar row under the match headers, and
   * [Default]/[Autogoles] utility rows (GOL only) styled distinctly
   * and left out of the rank count. */
  function renderMatchDetailLeaderboard(detail) {
    var columns = detail.columns || [];
    var fixedHeadHtml = ['#', 'N°', 'Jugador', 'TOT'].map(function (h) { return '<th>' + esc(h) + '</th>'; });
    var matchHeadHtml = columns.map(function (c) { return '<th>' + jornadaHeaderHtml(c.partido) + '</th>'; });
    var barCellsHtml = ['<td class="result-bar"></td>', '<td class="result-bar"></td>', '<td class="result-bar"></td>', '<td class="result-bar"></td>'].concat(
      columns.map(function (c) {
        var cls = c.resultado === 'g' ? 'result-bar-g' : c.resultado === 'p' ? 'result-bar-p' : c.resultado === 'e' ? 'result-bar-e' : '';
        return '<td class="result-bar' + (cls ? ' ' + cls : '') + '"></td>';
      })
    );
    setTableHead(
      '<tr>' + fixedHeadHtml.concat(matchHeadHtml).join('') + '</tr>' +
      '<tr>' + barCellsHtml.join('') + '</tr>'
    );

    // Rank on the FULL player list (ties share a rank, utility rows are
    // excluded from ranking entirely) before the search box filters it.
    var allRows = (detail.players || []).map(function (p) { return { p: p, rank: null }; });
    assignRanks_(
      allRows.filter(function (r) { return !r.p.isUtility; }),
      function (r) { return r.p.total; }
    );
    var rankedPlayers = allRows.filter(function (r) { return matchesSearch_(r.p.nombre); });
    if (!rankedPlayers.length) {
      setTableBody('<tr><td colspan="100" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    var scales = rankTotalStyles_(
      rankedPlayers.filter(function (r) { return r.rank !== null; })
        .map(function (r) { return { rank: r.rank, total: r.p.total }; })
    );

    var maxMatchVal = 0;
    rankedPlayers.forEach(function (r) {
      (r.p.byMatch || []).forEach(function (v) {
        if (v !== null && v !== undefined && Number(v) > maxMatchVal) maxMatchVal = Number(v);
      });
    });

    setTableBody(rankedPlayers.map(function (r) {
      var p = r.p;
      var rankCell = r.rank ? rankPillHtml(r.rank) : '';
      var rankStyle = r.rank ? styleAttr_(scales.rankColor(r.rank)) : '';
      var totalStyle = p.isUtility ? '' : styleAttr_(scales.totalColor(p.total));
      // [Default]/[Autogoles] aren't real players (no Jugadores entry to
      // fail open to "active" from) — treat them as inactive-colored.
      var idBg = p.isUtility ? INACTIVE_BG_ : activoBackground_(p.nombre);
      var matchCells = (p.byMatch || []).map(function (v) {
        var cellStyle = matchCellStyle_(state.stat, v, maxMatchVal);
        return '<td' + matchCellStyleAttr_(cellStyle) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr' + (p.isUtility ? ' class="utility-row"' : '') + '><td class="rank-cell"' + rankStyle + '>' + rankCell +
        '</td><td' + idBg + '>' + esc(p.dorsal) + '</td><td' + idBg + '>' + esc(p.nombre) + '</td><td class="val-strong"' + totalStyle + '>' +
        esc(p.total) + '</td>' + matchCells + '</tr>';
    }).join(''));
  }

  /** Splits a match header like "J1 RFU" into two lines (jornada code /
   * rival abbreviation) so the column doesn't have to be wide enough
   * for both on one line — the single biggest driver of how wide a
   * detailed table ends up. */
  function jornadaHeaderHtml(partido) {
    var parts = String(partido || '').trim().split(/\s+/);
    if (parts.length < 2) return esc(partido);
    return esc(parts[0]) + '<br>' + esc(parts.slice(1).join(' '));
  }

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
