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
      // Column order: Jornada, Cancha, Fecha, Hora, Resultado, GF, GC, Rival
      tbody.innerHTML = matches.map(function (m) {
        var resClass = m.resultado === 'g' ? 'res-g' : m.resultado === 'p' ? 'res-p' : m.resultado === 'e' ? 'res-e' : '';
        return '<tr><td>' + esc(m.jornada) + '</td><td>' + esc(m.cancha) + '</td><td>' + esc(m.fecha) +
          '</td><td>' + esc(m.hora) + '</td><td class="' + resClass + '">' + esc((m.resultado || '').toUpperCase()) +
          '</td><td class="val-strong">' + esc(m.gf) + '</td><td class="val-strong">' + esc(m.gc) +
          '</td><td class="val-strong">' + esc(m.rival) + '</td></tr>';
      }).join('');
    }
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
    var pillClass = rank === 1 ? ' rank-gold' : rank === 2 ? ' rank-silver' : rank === 3 ? ' rank-bronze' : '';
    return pillClass ? '<span class="rank-pill' + pillClass + '">' + rank + '</span>' : String(rank);
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

    setTableBody(rows.map(function (r, i) {
      return '<tr><td class="rank-cell">' + rankPillHtml(i + 1) + '</td><td>' + esc(r.p.dorsal) + '</td><td>' +
        esc(r.p.nombre) + '</td><td class="val-strong">' + esc(r.val) + '</td></tr>';
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

    setTableBody(players.map(function (p, i) {
      var eraCells = eras.map(function (era) {
        var v = p.byEra && p.byEra[era];
        return '<td>' + (v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr><td class="rank-cell">' + rankPillHtml(i + 1) + '</td><td>' + esc(p.dorsal) + '</td><td>' +
        esc(p.nombre) + '</td><td class="val-strong">' + esc(p.total) + '</td>' + eraCells + '</tr>';
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
    setTableBody(players.map(function (p) {
      var rankCell = p.isUtility ? '' : rankPillHtml(++rankIdx);
      var matchCells = (p.byMatch || []).map(function (v) {
        return '<td>' + (v === null || v === undefined ? '' : esc(v)) + '</td>';
      }).join('');
      return '<tr' + (p.isUtility ? ' class="utility-row"' : '') + '><td class="rank-cell">' + rankCell +
        '</td><td>' + esc(p.dorsal) + '</td><td>' + esc(p.nombre) + '</td><td class="val-strong">' +
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
