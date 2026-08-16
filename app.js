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
    historyDetailPromise: null // lazy-loaded + cached data-history-detail.json fetch
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
      horaDark: v('--hora-dark') || '#2e1a47'
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
      init(data);
    })
    .catch(function (err) {
      document.querySelector('main').innerHTML =
        '<p style="color:#f87171;padding:2rem;text-align:center;">No se pudo cargar data.json (' +
        err.message + '). ¿El archivo ya existe en el repo?</p>';
      console.error(err);
    });

  function init(data) {
    document.getElementById('updated-at').textContent = data.generatedAt
      ? 'Actualizado: ' + new Date(data.generatedAt).toLocaleString('es-MX')
      : '';

    setupTabs();
    setupEquipoControls(data);
    setupHistorialControls(data);
    renderLeaderboard();
  }

  // ---------------- Tabs ----------------
  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        // The leaderboard's very first render happens in init(), before
        // the user has clicked any tab — if "Jugadores" isn't the
        // default active tab, that render happens while it's still
        // display: none, so syncStickyOffsets_'s width measurement
        // returns 0 (see its own visibility guard) and never gets a
        // real value. Re-measuring now that this tab is actually
        // visible catches that case, and is a harmless no-op otherwise
        // (re-measuring an already-correct value doesn't change it).
        syncStickyOffsets_();
      });
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
  }
  function showTeamBalance_() {
    document.getElementById('team-message').hidden = true;
    document.getElementById('team-season-detail').hidden = true;
    document.getElementById('team-balance-wrap').hidden = false;
  }
  function showTeamMessage_(text) {
    var msg = document.getElementById('team-message');
    msg.textContent = text;
    msg.hidden = false;
    document.getElementById('team-season-detail').hidden = true;
    document.getElementById('team-balance-wrap').hidden = true;
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

    // "Balance General" still earns its own heading (nothing else on
    // the all-time view names it), but a specific season's "Temporada
    // X" heading was pure duplication of the dropdown right above it
    // (which already reads "X") — hidden rather than shown empty, so
    // it doesn't leave a stray blank heading's worth of margin.
    var eraHeading = document.getElementById('temporada-era');
    eraHeading.hidden = state.teamEra !== '__all__';
    eraHeading.textContent = 'Balance General';

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
    var ranges = {};
    STAT_KEYS.forEach(function (k) {
      var vals = rows.map(function (r) { return Number(r.standings[k]) || 0; });
      ranges[k] = { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
    });

    tbody.innerHTML = rows.map(function (r) {
      var cells = STAT_KEYS.map(function (k) {
        var v = r.standings[k];
        var color = (v === null || v === undefined) ? null : scaleColor_(v, ranges[k].min, ranges[k].max, COLORS.greyCell, COLORS.scaleBest);
        return '<td class="val-strong"' + styleAttr_(color) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td class="val-strong">' + esc(formatEraLabel_(r.era)) + '</td>' + cells + '</tr>';
    }).join('');
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
      standingsBody.innerHTML = '<tr>' + STANDINGS_KEYS.map(function (k) {
        var v = s[k];
        return '<td>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('') + '</tr>';
    } else {
      standingsBody.innerHTML = '<tr><td colspan="8" style="color:#7fa3a8;">Tabla de posiciones no disponible aún.</td></tr>';
    }

    var tbody = document.querySelector('#matches-table tbody');
    var matches = season.matches || []; // chronological order: J1 first
    if (!matches.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:#7fa3a8;">Sin partidos jugados todavía.</td></tr>';
    } else {
      // Cancha (blue) and Hora (purple) gradients — computed from this
      // season's own played matches, low value -> light end, high -> dark.
      var canchaVals = matches.map(function (m) { return Number(m.cancha); }).filter(function (v) { return !isNaN(v); });
      var canchaMin = canchaVals.length ? Math.min.apply(null, canchaVals) : 0;
      var canchaMax = canchaVals.length ? Math.max.apply(null, canchaVals) : 0;
      var horaMins = matches.map(function (m) { return parseHoraMinutes_(m.hora); }).filter(function (v) { return v !== null; });
      var horaMin = horaMins.length ? Math.min.apply(null, horaMins) : 0;
      var horaMax = horaMins.length ? Math.max.apply(null, horaMins) : 0;

      // Column order: Jornada, Resultado, GF, GC, Rival, Fecha, Hora,
      // Cancha — most important data first (visible without scrolling
      // on a phone), with Jornada staying first/sticky throughout.
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

        return '<tr><td class="jornada-cell">' + esc(m.jornada) + '</td><td class="result-chip ' + resClass + '"></td>' +
          '<td class="val-strong">' + esc(m.gf) + '</td><td class="val-strong">' + esc(m.gc) + '</td>' +
          '<td' + rivalStyle + '>' + esc(m.rival) + '</td><td>' + esc(formatFechaCorta_(m.fecha)) + '</td>' +
          '<td' + styleAttr_(horaColor) + '>' + esc(m.hora) + '</td><td' + styleAttr_(canchaColor) + '>' + esc(m.cancha) + '</td></tr>';
      }).join('');
    }
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
  function setupHistorialControls(data) {
    document.querySelectorAll('.stat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.stat-btn').forEach(function (b) { b.classList.remove('active'); });
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

  /** BALANCE — a fifth, always-simple view: every player's total across
   * all 4 real stats in one row. No "#" rank column (there's no single
   * value to rank by here) — ordered by dorsal ascending instead.
   * Respects the era dropdown like every other stat (per-era dorsal +
   * per-era values), but never the detail toggle (disabled whenever
   * BALANCE is active — see updateDetailToggleAvailability_). */
  function renderBalanceLeaderboard(data) {
    setTableHead('<tr><th>N°</th><th>Jugador</th><th>GOL</th><th>AST</th><th>PA</th><th>PI</th></tr>');

    var STATS_ORDER = ['GOL', 'AST', 'PA', 'PI'];
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
