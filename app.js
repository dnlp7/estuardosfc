(function () {
  var DATA_URL = 'data.json';
  var HISTORY_DETAIL_URL = 'data-history-detail.json';
  var STAT_TITLES = {
    GOL: 'GOLES ANOTADOS',
    AST: 'ASISTENCIAS DE GOL',
    PA: 'PARTIDOS ASISTIDOS',
    PI: 'PARTIDOS INICIADOS'
  };

  var state = {
    data: null,
    stat: 'GOL',
    era: '__all__',
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
    renderTemporada(data.currentSeason);
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
      });
    });
  }

  // ---------------- Temporada Actual ----------------
  function renderTemporada(season) {
    if (!season) return;
    document.getElementById('temporada-era').textContent = 'Temporada ' + (season.era || '');

    var card = document.getElementById('standings-card');
    if (season.standings) {
      var s = season.standings;
      // Grouped to mirror the real RES tab's "Torneo de Liga" box: a
      // PJ/PG/PE/PP cluster, a GF/GC/DIF cluster, and PTS on its own.
      var groups = [
        [['PJ', s.pj], ['PG', s.pg], ['PE', s.pe], ['PP', s.pp]],
        [['GF', s.gf], ['GC', s.gc], ['DIF', s.dif]],
        [['PTS', s.pts]]
      ];
      card.innerHTML = groups.map(function (group) {
        return '<div class="standings-group">' + group.map(renderStatBox).join('') + '</div>';
      }).join('');
    } else {
      card.innerHTML = '<p style="color:#7fa3a8;margin:0;">Tabla de posiciones no disponible aún.</p>';
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

      // Column order: Jornada, Cancha, Fecha, Hora, Resultado, GF, GC, Rival
      tbody.innerHTML = matches.map(function (m) {
        var resClass = m.resultado === 'g' ? 'result-chip-g' : m.resultado === 'p' ? 'result-chip-p' : m.resultado === 'e' ? 'result-chip-e' : '';
        var canchaNum = Number(m.cancha);
        var canchaColor = isNaN(canchaNum) ? null : scaleColor_(canchaNum, canchaMin, canchaMax, COLORS.canchaLight, COLORS.canchaDark);
        var horaVal = parseHoraMinutes_(m.hora);
        var horaColor = horaVal === null ? null : scaleColor_(horaVal, horaMin, horaMax, COLORS.horaLight, COLORS.horaDark);
        // Rival kit colors come from each season doc's Rivales tab; a
        // rival not listed there yet gets no inline style (default cell).
        var rivalStyle = m.rivalBg ? ' style="background:' + esc(m.rivalBg) + ';color:' + esc(m.rivalText || '#ffffff') + '"' : '';

        return '<tr><td class="jornada-cell">' + esc(m.jornada) + '</td><td' + styleAttr_(canchaColor) + '>' +
          esc(m.cancha) + '</td><td>' + esc(m.fecha) + '</td><td' + styleAttr_(horaColor) + '>' + esc(m.hora) +
          '</td><td class="result-chip ' + resClass + '"></td><td class="val-strong">' + esc(m.gf) +
          '</td><td class="val-strong">' + esc(m.gc) + '</td><td' + rivalStyle + '>' + esc(m.rival) + '</td></tr>';
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

  function renderStatBox(b) {
    return '<div class="stat-box"><span class="label">' + b[0] + '</span><span class="value">' +
      (b[1] === null || b[1] === undefined || b[1] === '' ? '—' : b[1]) + '</span></div>';
  }

  // ---------------- Historial (leaderboards) ----------------
  function setupHistorialControls(data) {
    document.querySelectorAll('.stat-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.stat-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.stat = btn.dataset.stat;
        document.getElementById('stat-title').textContent = STAT_TITLES[state.stat] || state.stat;
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

    populateEraFilter(data);
  }

  function populateEraFilter(data) {
    var select = document.getElementById('era-filter');
    var statBlock = data.stats[state.stat];
    // eras arrives oldest-first (matches the historical doc's own column
    // order); the dropdown shows most-recent-first, "Todas" pinned on top.
    var eras = (statBlock ? statBlock.eras : []).slice().reverse();
    var current = select.value || '__all__';
    select.innerHTML = '<option value="__all__">Todas las temporadas</option>' +
      eras.map(function (era) { return '<option value="' + esc(era) + '">' + esc(era) + '</option>'; }).join('');
    select.value = eras.indexOf(current) >= 0 ? current : '__all__';
    state.era = select.value;
  }

  function filteredPlayers(players) {
    return (players || []).filter(function (p) {
      if (!state.search) return true;
      return String(p.nombre).toLowerCase().indexOf(state.search) >= 0;
    });
  }

  function rankPillHtml(rank) {
    return String(rank);
  }

  function setTableHead(html) { document.querySelector('#leaderboard-table thead').innerHTML = html; }
  function setTableBody(html) { document.querySelector('#leaderboard-table tbody').innerHTML = html; }

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

  /** Simple mode (toggle off) — TOT, or one specific era's total. */
  function renderSimpleLeaderboard(statBlock) {
    var valueHeader = state.era === '__all__' ? 'TOT' : state.era;
    setTableHead('<tr><th>#</th><th>N°</th><th>Jugador</th><th>' + esc(valueHeader) + '</th></tr>');

    var players = filteredPlayers(statBlock.players);
    var rows;
    if (state.era === '__all__') {
      rows = players.map(function (p) { return { p: p, val: p.total }; });
    } else {
      rows = players
        .filter(function (p) { return p.byEra && p.byEra[state.era] !== undefined; })
        .map(function (p) { return { p: p, val: p.byEra[state.era] }; });
      rows.sort(function (a, b) {
        var diff = (Number(b.val) || 0) - (Number(a.val) || 0);
        if (diff !== 0) return diff;
        return (Number(a.p.dorsal) || 0) - (Number(b.p.dorsal) || 0);
      });
    }

    if (!rows.length) {
      setTableBody('<tr><td colspan="4" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    var scales = rankTotalStyles_(rows.map(function (r, i) { return { rank: i + 1, total: r.val }; }));

    setTableBody(rows.map(function (r, i) {
      var rank = i + 1;
      return '<tr><td class="rank-cell"' + styleAttr_(scales.rankColor(rank)) + '>' + rankPillHtml(rank) +
        '</td><td>' + esc(r.p.dorsal) + '</td><td>' + esc(r.p.nombre) + '</td><td class="val-strong"' +
        styleAttr_(scales.totalColor(r.val)) + '>' + esc(r.val) + '</td></tr>';
    }).join(''));
  }

  /** Detailed mode, "Todas las temporadas" — one column per era, same
   * totals already in data.json (stats[stat].players[].byEra), no
   * extra fetch needed. Player order is already the source doc's own
   * sorted (total desc, dorsal-tiebreak) physical row order. */
  function renderEraWideLeaderboard(statBlock) {
    var eras = statBlock.eras; // oldest-first, matches the historical doc's own layout
    var headCells = ['#', 'N°', 'Jugador', 'TOT'].concat(eras);
    setTableHead('<tr>' + headCells.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>');

    var players = filteredPlayers(statBlock.players);
    if (!players.length) {
      setTableBody('<tr><td colspan="100" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    var scales = rankTotalStyles_(players.map(function (p, i) { return { rank: i + 1, total: p.total }; }));

    var maxEraVal = 0;
    players.forEach(function (p) {
      eras.forEach(function (era) {
        var v = p.byEra && p.byEra[era];
        if (v !== undefined && Number(v) > maxEraVal) maxEraVal = Number(v);
      });
    });

    setTableBody(players.map(function (p, i) {
      var rank = i + 1;
      var eraCells = eras.map(function (era) {
        var v = p.byEra && p.byEra[era];
        var color = v === undefined ? null : gridValueColor_(v, maxEraVal);
        return '<td' + styleAttr_(color) + '>' + (v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td class="rank-cell"' + styleAttr_(scales.rankColor(rank)) + '>' + rankPillHtml(rank) +
        '</td><td>' + esc(p.dorsal) + '</td><td>' + esc(p.nombre) + '</td><td class="val-strong"' +
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

    var players = filteredPlayers(detail.players);
    if (!players.length) {
      setTableBody('<tr><td colspan="100" style="color:#7fa3a8;">Sin resultados.</td></tr>');
      return;
    }

    var rankIdx = 0;
    var rankedPlayers = players.map(function (p) {
      return { p: p, rank: p.isUtility ? null : ++rankIdx };
    });
    var scales = rankTotalStyles_(
      rankedPlayers.filter(function (r) { return r.rank !== null; })
        .map(function (r) { return { rank: r.rank, total: r.p.total }; })
    );

    var maxMatchVal = 0;
    players.forEach(function (p) {
      (p.byMatch || []).forEach(function (v) {
        if (v !== null && v !== undefined && Number(v) > maxMatchVal) maxMatchVal = Number(v);
      });
    });

    setTableBody(rankedPlayers.map(function (r) {
      var p = r.p;
      var rankCell = r.rank ? rankPillHtml(r.rank) : '';
      var rankStyle = r.rank ? styleAttr_(scales.rankColor(r.rank)) : '';
      var totalStyle = p.isUtility ? '' : styleAttr_(scales.totalColor(p.total));
      var matchCells = (p.byMatch || []).map(function (v) {
        var color = gridValueColor_(v, maxMatchVal);
        return '<td' + styleAttr_(color) + '>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr' + (p.isUtility ? ' class="utility-row"' : '') + '><td class="rank-cell"' + rankStyle + '>' + rankCell +
        '</td><td>' + esc(p.dorsal) + '</td><td>' + esc(p.nombre) + '</td><td class="val-strong"' + totalStyle + '>' +
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
