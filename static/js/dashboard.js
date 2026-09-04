/**
 * LORE Dashboard — dashboard.js v4.0
 *
 * RESTRICCION: Solo lectura. Usa onSnapshot para escuchar
 * telemetria_resultados en Firestore. Sin datos simulados.
 * Ningun metodo escribe, actualiza ni borra datos en Firestore.
 *
 * Coleccion leida: telemetria_resultados
 * Documento ID   : {codigo_sala}_{alumno_id}  (ej. CKKAF_Alan)
 * Campos usados  : alumno_id, codigo_sala, estado_final,
 *                  historial_aciertos[], historial_errores[], total_intentos
 *
 * Metricas:
 *   - Precision  = Σaciertos / Σ(aciertos+errores) × 100  (preguntas variables)
 *   - Prom.Intent= Σtotal_intentos / n_alumnos
 */

'use strict';

// ════════════════════════════════════════════════════════
// 1. Chart.js Defaults institucionales
// ════════════════════════════════════════════════════════
Chart.defaults.font.family  = "'Inter', 'Segoe UI', system-ui, sans-serif";
Chart.defaults.font.size    = 12;
Chart.defaults.color        = '#64748B';
Chart.defaults.borderColor  = '#E2E8F0';

Object.assign(Chart.defaults.plugins.tooltip, {
  backgroundColor : '#0F172A',
  titleColor      : '#F8FAFC',
  bodyColor       : '#CBD5E1',
  borderColor     : '#1E293B',
  borderWidth     : 1,
  padding         : 10,
  cornerRadius    : 4,
  displayColors   : false,
});

// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// 2. Estado de aplicacion (solo lectura)
// ════════════════════════════════════════════════════════
let chartAciertos     = null;
let chartErrores      = null;
let allDocs           = [];    // cache de documentos Firestore (telemetría)
let roomsMap          = new Map(); // cache de salas activas { codigo => data }
let currentRoomFilter = 'ALL'; // filtro de sala seleccionado ('ALL' o código específico ej. 'CKKAF')
let unsubTelemetria   = null;  // función de cancelación onSnapshot
let unsubSalas        = null;  // función de cancelación de salas
let toastTimer        = null;

// ════════════════════════════════════════════════════════
// 3. Utilidades
// ════════════════════════════════════════════════════════

/** Cuenta frecuencias de un array de strings. Retorna Map<string,number> */
function calcFrequencies(arr) {
  const freq = new Map();
  arr.forEach(w => {
    const k = String(w).trim();
    if (k) freq.set(k, (freq.get(k) || 0) + 1);
  });
  return freq;
}

/** Ordena Map por valor desc y retorna los primeros N como [{label,count}] */
function topN(freqMap, n = 5) {
  return [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

/** Actualiza un elemento del DOM si existe */
function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** Ajusta la barra de progreso CSS --w */
function setBarWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.setProperty('--w', `${Math.min(100, Math.max(0, pct))}%`);
}

/** Extrae y convierte el número de intentos de un documento de forma segura */
function parseIntentos(doc) {
  const val = doc.total_intentos ?? doc.intentos ?? doc.total_disparos ?? doc.disparos;
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string') {
    const p = parseInt(val, 10);
    if (!isNaN(p)) return p;
  }
  const ac = Array.isArray(doc.historial_aciertos) ? doc.historial_aciertos.length : 0;
  const er = Array.isArray(doc.historial_errores)  ? doc.historial_errores.length  : 0;
  return ac + er;
}

/** Formatea una fecha a hora local HH:MM:SS */
function fmtTime(date) {
  return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ════════════════════════════════════════════════════════
// 4. Toast
// ════════════════════════════════════════════════════════
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = msg;
  el.className   = 'toast show';
  el.style.background = type === 'err' ? '#991B1B' : '#0F172A';
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ════════════════════════════════════════════════════════
// 5. Estado de conexion
// ════════════════════════════════════════════════════════
function setConnectionStatus(state) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot || !label) return;
  dot.className = 'conn-dot';
  switch (state) {
    case 'live': dot.classList.add('live'); label.textContent = 'En vivo (Firestore)'; break;
    case 'err':  dot.classList.add('err');  label.textContent = 'Sin conexión';        break;
    default:                                label.textContent = 'Conectando…';
  }
}

// ════════════════════════════════════════════════════════
// 6. Inicializar Chart.js — Barras
// ════════════════════════════════════════════════════════

/** Azules institucionales: del mas oscuro al mas claro */
const AZULES = ['#002B5B','#0041A0','#1A5DAB','#4A80C4','#8AAFC9'];

/** Grises-rojizos para errores */
const ERRORES_COLORS = ['#7F1D1D','#B91C1C','#DC2626','#94A3B8','#CBD5E1'];

function initChartAciertos() {
  const ctx = document.getElementById('chartAciertos');
  if (!ctx) return;
  chartAciertos = new Chart(ctx, {
    type: 'bar',
    data: {
      labels  : [],
      datasets: [{
        label           : 'Frecuencia',
        data            : [],
        backgroundColor : AZULES,
        borderRadius    : 4,
        borderSkipped   : false,
        maxBarThickness : 52,
      }],
    },
    options: barOptions('Frecuencia de aciertos'),
  });
}

function initChartErrores() {
  const ctx = document.getElementById('chartErrores');
  if (!ctx) return;
  chartErrores = new Chart(ctx, {
    type: 'bar',
    data: {
      labels  : [],
      datasets: [{
        label           : 'Frecuencia',
        data            : [],
        backgroundColor : ERRORES_COLORS,
        borderRadius    : 4,
        borderSkipped   : false,
        maxBarThickness : 52,
      }],
    },
    options: barOptions('Frecuencia de errores'),
  });
}

function barOptions(label) {
  return {
    responsive          : true,
    maintainAspectRatio : false,
    scales: {
      x: {
        grid  : { display: false },
        border: { display: false },
        ticks : { font: { size: 11 }, color: '#94A3B8', maxRotation: 30 },
      },
      y: {
        beginAtZero : true,
        grid        : { color: '#F1F5F9' },
        border      : { display: false },
        ticks: {
          font         : { size: 12 },
          color        : '#94A3B8',
          precision    : 0,
          maxTicksLimit: 6,
        },
      },
    },
    plugins: {
      legend : { display: false },
      tooltip: {
        callbacks: {
          label: (c) => ` ${c.raw} ocurrencia${c.raw !== 1 ? 's' : ''}`,
        },
      },
    },
    animation: { duration: 650, easing: 'easeOutQuart' },
  };
}

// ════════════════════════════════════════════════════════
// 7. Gestión del Filtro por Código de Sala
// ════════════════════════════════════════════════════════

function applyRoomFilter(newCode = null) {
  const input = document.getElementById('room-input');

  if (newCode !== null) {
    currentRoomFilter = String(newCode).trim().toUpperCase();
  } else if (input && input.value.trim()) {
    currentRoomFilter = input.value.trim().toUpperCase();
  } else {
    currentRoomFilter = '';
  }

  if (input && newCode !== null) {
    input.value = currentRoomFilter;
  }

  // Actualizar metadatos de sala en los badges superiores
  updateRoomMetaBadge(currentRoomFilter);

  // Filtrar documentos de telemetría
  const filteredDocs = (!currentRoomFilter || currentRoomFilter === 'ALL')
    ? allDocs
    : allDocs.filter(d => String(d.codigo_sala || '').toUpperCase() === currentRoomFilter);

  updateDashboard(filteredDocs);
}

function updateRoomMetaBadge(code) {
  const materiaEl = document.getElementById('room-meta-materia');
  const temaEl    = document.getElementById('room-meta-tema');
  if (!materiaEl || !temaEl) return;

  if (!code || code === 'ALL') {
    materiaEl.style.display = 'none';
    temaEl.style.display    = 'none';
    return;
  }

  const roomInfo = roomsMap.get(code) || roomsMap.get(code.toLowerCase());
  if (roomInfo && (roomInfo.materia || roomInfo.tema)) {
    materiaEl.style.display = 'inline-block';
    temaEl.style.display    = 'inline-block';
    materiaEl.textContent = `Materia: ${roomInfo.materia || '—'}`;
    temaEl.textContent    = `Tema: ${roomInfo.tema || '—'}`;
  } else {
    // Si no tiene materia/tema registrados en salas-activas, ocultar badges limpios
    materiaEl.style.display = 'none';
    temaEl.style.display    = 'none';
  }
}

// ════════════════════════════════════════════════════════
// 8. Actualizar UI completo a partir de los documentos
// ════════════════════════════════════════════════════════
function updateDashboard(docs) {
  const total = docs.length;

  // ── KPI 1: Alumnos Evaluados ──
  setEl('val-alumnos', total.toLocaleString('es-MX'));

  // ── KPI 2: Tasa de victorias ──
  const victorias = docs.filter(d => String(d.estado_final).toLowerCase() === 'victoria').length;
  const pctVic    = total > 0 ? Math.round((victorias / total) * 100) : 0;
  setEl('val-victorias', `${pctVic}%`);
  setBarWidth('fill-victorias', pctVic);
  const trackVic = document.getElementById('fill-victorias')?.closest('[role=progressbar]');
  if (trackVic) trackVic.setAttribute('aria-valuenow', pctVic);

  // ── KPI 3: Precision Global ──
  // Σaciertos / Σ(aciertos+errores) × 100
  let totalAciertos = 0, totalPreguntas = 0;
  docs.forEach(d => {
    const ac = Array.isArray(d.historial_aciertos) ? d.historial_aciertos.length : 0;
    const er = Array.isArray(d.historial_errores)  ? d.historial_errores.length  : 0;
    totalAciertos  += ac;
    totalPreguntas += (ac + er);
  });
  const pctPrec = totalPreguntas > 0 ? Math.round((totalAciertos / totalPreguntas) * 100) : 0;
  setEl('val-precision', `${pctPrec}%`);
  setBarWidth('fill-precision', pctPrec);
  const trackPr = document.getElementById('fill-precision')?.closest('[role=progressbar]');
  if (trackPr) trackPr.setAttribute('aria-valuenow', pctPrec);

  // ── KPI 4: Promedio de Intentos ──
  let totalIntentos = 0;
  docs.forEach(d => {
    totalIntentos += parseIntentos(d);
  });
  const promedioIntentos = total > 0 ? (totalIntentos / total).toFixed(1) : '—';
  setEl('val-intentos', promedioIntentos);

  // ── Charts: consolidar historial global ──
  const allAciertosArr = docs.flatMap(d => Array.isArray(d.historial_aciertos) ? d.historial_aciertos : []);
  const allErroresArr  = docs.flatMap(d => Array.isArray(d.historial_errores)  ? d.historial_errores  : []);

  const top5Aciertos = topN(calcFrequencies(allAciertosArr), 5);
  const top5Errores  = topN(calcFrequencies(allErroresArr),  5);

  if (chartAciertos) {
    chartAciertos.data.labels                    = top5Aciertos.map(i => i.label);
    chartAciertos.data.datasets[0].data          = top5Aciertos.map(i => i.count);
    chartAciertos.data.datasets[0].backgroundColor = AZULES.slice(0, top5Aciertos.length);
    chartAciertos.update();
  }
  if (chartErrores) {
    chartErrores.data.labels                    = top5Errores.map(i => i.label);
    chartErrores.data.datasets[0].data          = top5Errores.map(i => i.count);
    chartErrores.data.datasets[0].backgroundColor = ERRORES_COLORS.slice(0, top5Errores.length);
    chartErrores.update();
  }

  // ── Tabla de resultados ──
  renderTable(docs);

  // ── Distribucion victoria / derrota ──
  const derrotas   = total - victorias;
  const pctDerrota = total > 0 ? Math.round((derrotas / total) * 100) : 0;
  setBarWidth('dist-victoria', pctVic);
  setBarWidth('dist-derrota',  pctDerrota);
  setEl('dist-pct-victoria', `${pctVic}%`);
  setEl('dist-pct-derrota',  `${pctDerrota}%`);

  // ── Alerta pedagogica ──
  updateAlertAndRecs(top5Errores, pctPrec);

  // ── Timestamp ──
  setEl('ts-text', `Actualizado: ${fmtTime(new Date())}`);
}

// ════════════════════════════════════════════════════════
// 9. Tabla de resultados
// ════════════════════════════════════════════════════════
function renderTable(docs) {
  const tbody   = document.getElementById('tbody-students');
  const counter = document.getElementById('student-count');
  if (!tbody) return;

  // Filtrar por busqueda activa: nombre del alumno O codigo de sala
  const q = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const filtered = q
    ? docs.filter(d =>
        String(d.alumno_id   || '').toLowerCase().includes(q) ||
        String(d.codigo_sala || '').toLowerCase().includes(q)
      )
    : docs;

  if (counter) counter.textContent = filtered.length;

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="td-empty" aria-live="polite">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${q ? 'No se encontraron resultados con ese criterio.' : 'Sin resultados para la sala seleccionada.'}</span>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((d, i) => buildRow(d, i)).join('');
}

function buildRow(doc, idx) {
  const alumnoId   = doc.alumno_id   || '—';
  const codigoSala = doc.codigo_sala || '—';
  const estado     = String(doc.estado_final || '—').toLowerCase();
  const aciertos   = Array.isArray(doc.historial_aciertos) ? doc.historial_aciertos.length : 0;
  const errores    = Array.isArray(doc.historial_errores)  ? doc.historial_errores.length  : 0;
  const intentos   = parseIntentos(doc);
  const preguntas  = aciertos + errores;
  const precision  = preguntas > 0 ? Math.round((aciertos / preguntas) * 100) : 0;

  const pillClass = estado === 'victoria' ? 'pill-victoria' : 'pill-derrota';
  const pillLabel = estado.charAt(0).toUpperCase() + estado.slice(1);

  const fillClass = precision >= 70 ? 'high' : precision < 40 ? 'low' : '';
  const initials  = alumnoId.slice(0, 2).toUpperCase();

  return `
    <tr style="animation-delay:${idx * 30}ms">
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="
            width:28px;height:28px;border-radius:50%;
            background:var(--navy-pale);color:var(--navy);
            font-size:.65rem;font-weight:700;
            display:flex;align-items:center;justify-content:center;
            flex-shrink:0;
          " aria-hidden="true">${initials}</div>
          <span style="font-weight:500;color:var(--text-dark)">${alumnoId}</span>
        </div>
      </td>
      <td class="tc">
        <span class="sala-badge">${codigoSala}</span>
      </td>
      <td class="tc">
        <span class="status-pill ${pillClass}" aria-label="Estado: ${pillLabel}">${pillLabel}</span>
      </td>
      <td class="tc" aria-label="${aciertos} aciertos">
        <strong style="color:var(--green)">${aciertos}</strong>
      </td>
      <td class="tc" aria-label="${errores} errores">
        <strong style="color:var(--red)">${errores}</strong>
      </td>
      <td class="tc">${intentos}</td>
      <td class="tc">
        <div class="efect-bar-wrap">
          <div class="efect-mini">
            <div class="efect-fill ${fillClass}" style="width:${precision}%"></div>
          </div>
          <span style="font-weight:600;font-size:.8rem">${precision}%</span>
        </div>
      </td>
    </tr>`;
}

// ════════════════════════════════════════════════════════
// 10. Alerta pedagogica y recomendaciones
// ════════════════════════════════════════════════════════
function updateAlertAndRecs(top5Errores, pctPrec) {
  const alertText = document.getElementById('alert-text');
  if (alertText) {
    if (top5Errores.length) {
      const topConcept = top5Errores[0].label;
      alertText.textContent =
        `Se sugiere repasar "${topConcept}" ` +
        `(${top5Errores[0].count} ocurrencia${top5Errores[0].count !== 1 ? 's' : ''} en historial_errores grupal).`;
    } else {
      alertText.textContent = 'No se han registrado errores aún.';
    }
  }

  const recList = document.getElementById('rec-list');
  if (recList) {
    if (!top5Errores.length) {
      recList.innerHTML = '<li class="rec-item rec-item--loading"><span>Sin errores registrados.</span></li>';
    } else {
      const items = top5Errores.slice(0, 3).map((item, i) => {
        const mark = i === 0 ? '⚠' : '→';
        const cls  = i === 0 ? 'rec-item--warn' : '';
        return `
          <li class="rec-item ${cls}">
            <div class="rec-item-mark">${mark}</div>
            <div class="rec-item-text">
              <strong>${item.label}</strong>
              <p>${item.count} estudiante${item.count !== 1 ? 's' : ''} presentaron dificultad en este concepto.</p>
            </div>
          </li>`;
      });
      if (pctPrec < 50) {
        items.push(`
          <li class="rec-item">
            <div class="rec-item-mark">⚠</div>
            <div class="rec-item-text">
              <strong>Precisión Grupal Baja (${pctPrec}%)</strong>
              <p>Se recomienda revisar la estrategia didáctica y reforzar los conceptos base.</p>
            </div>
          </li>`);
      } else if (pctPrec >= 80) {
        items.push(`
          <li class="rec-item">
            <div class="rec-item-mark">✓</div>
            <div class="rec-item-text">
              <strong>Precisión Satisfactoria (${pctPrec}%)</strong>
              <p>El grupo muestra buen dominio general. Comunicar el logro al grupo.</p>
            </div>
          </li>`);
      }
      recList.innerHTML = items.join('');
    }
  }
}

// ════════════════════════════════════════════════════════
// 11. Exportar CSV (lectura de allDocs filtrados)
// ════════════════════════════════════════════════════════
function exportCSV() {
  const docsToExport = currentRoomFilter === 'ALL'
    ? allDocs
    : allDocs.filter(d => String(d.codigo_sala || '').toUpperCase() === currentRoomFilter);

  if (!docsToExport.length) { toast('No hay datos para exportar.', 'err'); return; }
  const header = ['alumno_id', 'codigo_sala', 'estado_final', 'aciertos', 'errores', 'total_intentos', 'precision_%'];
  const rows = docsToExport.map(d => {
    const ac   = Array.isArray(d.historial_aciertos) ? d.historial_aciertos.length : 0;
    const er   = Array.isArray(d.historial_errores)  ? d.historial_errores.length  : 0;
    const int  = parseIntentos(d);
    const prec = (ac + er) > 0 ? Math.round((ac / (ac + er)) * 100) : 0;
    return [d.alumno_id || '', d.codigo_sala || '', d.estado_final || '', ac, er, int, prec];
  });
  const csv  = [header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const fileName = currentRoomFilter === 'ALL' ? 'lore_telemetria_global.csv' : `lore_telemetria_${currentRoomFilter}.csv`;
  const a    = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Exportación lista: ${fileName}`);
}

// ════════════════════════════════════════════════════════
// 12. Busqueda y Eventos de Sala
// ════════════════════════════════════════════════════════
function setupRoomEvents() {
  const input  = document.getElementById('room-input');
  const btn    = document.getElementById('btn-apply-room');

  if (btn) {
    btn.addEventListener('click', () => {
      if (input) {
        applyRoomFilter(input.value.trim());
      }
    });
  }

  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyRoomFilter(input.value.trim());
      }
    });
    input.addEventListener('input', () => {
      applyRoomFilter(input.value.trim());
    });
  }
}

function setupSearch() {
  const inp = document.getElementById('search-input');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const filteredDocs = (!currentRoomFilter || currentRoomFilter === 'ALL')
      ? allDocs
      : allDocs.filter(d => String(d.codigo_sala || '').toUpperCase() === currentRoomFilter);
    renderTable(filteredDocs);
  });
}

// ════════════════════════════════════════════════════════
// 13. Estado de error — sin conexion a Firebase
// ════════════════════════════════════════════════════════
function showFirebaseError() {
  setConnectionStatus('err');
  const tbody = document.getElementById('tbody-students');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="td-empty" aria-live="polite">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>No se pudo conectar con Firestore.<br>Verifica la configuración en firebase-config.js.</span>
        </td>
      </tr>`;
  }
  ['val-alumnos', 'val-victorias', 'val-precision', 'val-intentos'].forEach(id => setEl(id, '—'));
  toast('Sin conexión a Firestore. Verifica firebase-config.js.', 'err');
}

// ════════════════════════════════════════════════════════
// 14. Suscripcion en tiempo real a salas_activas / salas-activas
// ════════════════════════════════════════════════════════
function subscribeToSalas() {
  if (!window.firebaseReady || !window.db) return;

  const colRef = window.db.collection('salas-activas');

  unsubSalas = colRef.onSnapshot(
    (snapshot) => {
      roomsMap.clear();
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data && doc.id) {
          roomsMap.set(doc.id.toUpperCase(), data);
          if (data.codigo) roomsMap.set(data.codigo.toUpperCase(), data);
        }
      });
      updateRoomMetaBadge(currentRoomFilter);
    },
    (err) => {
      window.db.collection('salas_activas').onSnapshot(snap => {
        roomsMap.clear();
        snap.docs.forEach(doc => {
          const data = doc.data();
          if (data && doc.id) {
            roomsMap.set(doc.id.toUpperCase(), data);
            if (data.codigo) roomsMap.set(data.codigo.toUpperCase(), data);
          }
        });
        updateRoomMetaBadge(currentRoomFilter);
      });
    }
  );
}

// ════════════════════════════════════════════════════════
// 15. Suscripcion en tiempo real a telemetria_resultados
// ════════════════════════════════════════════════════════
function subscribeToTelemetria() {
  if (!window.firebaseReady || !window.db) {
    console.warn('[LORE] Firebase no está disponible. Verifica firebase-config.js.');
    showFirebaseError();
    return;
  }

  const colRef = window.db.collection('telemetria_resultados');

  unsubTelemetria = colRef.onSnapshot(
    (snapshot) => {
      const validDocs = snapshot.docs
        .map(doc => ({ _id: doc.id, ...doc.data() }))
        .filter(d => d && (Boolean(d.alumno_id) || Boolean(d.codigo_sala)));

      if (validDocs.length === 0) {
        console.log('[LORE] telemetria_resultados sin datos aún.');
        allDocs = [];
        applyRoomFilter(currentRoomFilter);
        setConnectionStatus('live');
        return;
      }

      allDocs = validDocs;
      applyRoomFilter(currentRoomFilter);
      setConnectionStatus('live');
    },
    (err) => {
      console.error('[LORE] Error al leer Firestore:', err);
      showFirebaseError();
    }
  );
}

// ════════════════════════════════════════════════════════
// 16. Bootstrap
// ════════════════════════════════════════════════════════
window.addEventListener('beforeunload', () => {
  if (typeof unsubTelemetria === 'function') unsubTelemetria();
  if (typeof unsubSalas === 'function') unsubSalas();
});

document.addEventListener('DOMContentLoaded', () => {
  // Inicializar gráficas vacías
  initChartAciertos();
  initChartErrores();

  // Leer parámetro URL ?sala= o ?codigo= (ej. /dashboard?sala=CKKAF)
  const urlParams = new URLSearchParams(window.location.search);
  const initialRoom = urlParams.get('sala') || urlParams.get('code') || urlParams.get('codigo');
  if (initialRoom) {
    const roomInput = document.getElementById('room-input');
    const cleanCode = initialRoom.trim().toUpperCase();
    if (roomInput) roomInput.value = cleanCode;
    currentRoomFilter = cleanCode;
  }

  // Estado inicial de conexión
  setConnectionStatus('wait');

  // Configurar eventos del filtro de sala
  setupRoomEvents();

  // Conectar a Firestore en tiempo real
  subscribeToSalas();
  subscribeToTelemetria();

  // Búsqueda por alumno o código de sala
  setupSearch();

  // Exportar CSV
  document.getElementById('btn-export')?.addEventListener('click', exportCSV);
});
