(function () {
  var DATA_URL = 'data.json';
  var STAT_TITLES = {
    GOL: 'GOLES ANOTADOS',
    AST: 'ASISTENCIAS DE GOL',
    PA: 'PARTIDOS ASISTIDOS',
    PI: 'PARTIDOS INICIADOS'
  };

  var state = { data: null, stat: 'GOL', era: '__all__', search: '' };

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

  function renderLeaderboard() {
    var data = state.data;
    if (!data) return;
    var statBlock = data.stats[state.stat];
    var tbody = document.querySelector('#leaderboard-table tbody');
    var header = document.getElementById('leaderboard-value-header');

    if (!statBlock || !statBlock.players.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#7fa3a8;">Sin datos.</td></tr>';
      return;
    }

    header.textContent = state.era === '__all__' ? 'TOT' : state.era;

    var players = statBlock.players.filter(function (p) {
      if (!state.search) return true;
      return String(p.nombre).toLowerCase().indexOf(state.search) >= 0;
    });

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
      tbody.innerHTML = '<tr><td colspan="4" style="color:#7fa3a8;">Sin resultados.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (r, i) {
      var rank = i + 1;
      var pillClass = rank === 1 ? ' rank-gold' : rank === 2 ? ' rank-silver' : rank === 3 ? ' rank-bronze' : '';
      var rankCell = pillClass
        ? '<span class="rank-pill' + pillClass + '">' + rank + '</span>'
        : rank;
      return '<tr><td class="rank-cell">' + rankCell + '</td><td>' + esc(r.p.dorsal) + '</td><td>' +
        esc(r.p.nombre) + '</td><td>' + esc(r.val) + '</td></tr>';
    }).join('');
  }

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
