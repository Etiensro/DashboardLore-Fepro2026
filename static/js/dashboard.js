/**
 * LORE Dashboard — dashboard.js v3.0
 *
 * RESTRICCION: Solo lectura. Usa onSnapshot para escuchar
 * telemetria_resultados. Ningun metodo escribe, actualiza
 * ni borra datos en Firestore.
 *
 * Coleccion leida: telemetria_resultados
 * Campos: alumno_id, estado_final, historial_aciertos[],
 *         historial_errores[], total_disparos
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
// 2. Estado de aplicacion (solo lectura)
// ════════════════════════════════════════════════════════
let chartAciertos  = null;
let chartErrores   = null;
let allDocs        = [];          // cache de documentos Firestore
let unsubTelemetria = null;       // funcion de cancelacion onSnapshot
let toastTimer     = null;

// ════════════════════════════════════════════════════════
// Datos simulados de respaldo (Probabilidad y Estadística)
// ════════════════════════════════════════════════════════
const MOCK_TELEMETRIA = [
  {
    alumno_id: "ALUMNO_101",
    estado_final: "victoria",
    historial_aciertos: ["PROMEDIO", "MEDIANA", "MODA", "CUALITATIVO", "MUESTRA"],
    historial_errores: ["RANGO"],
    total_disparos: 6
  },
  {
    alumno_id: "ALUMNO_102",
    estado_final: "victoria",
    historial_aciertos: ["PROMEDIO", "CUALITATIVO", "POBLACIÓN", "MUESTRA", "PROBABILIDAD"],
    historial_errores: ["MEDIANA"],
    total_disparos: 7
  },
  {
    alumno_id: "ALUMNO_103",
    estado_final: "derrota",
    historial_aciertos: ["MUESTRA", "FRECUENCIA"],
    historial_errores: ["PROMEDIO", "MEDIANA", "RANGO"],
    total_disparos: 6
  },
  {
    alumno_id: "ALUMNO_104",
    estado_final: "victoria",
    historial_aciertos: ["PROMEDIO", "MEDIANA", "MODA", "CUANTITATIVO", "FRECUENCIA"],
    historial_errores: [],
    total_disparos: 5
  },
  {
    alumno_id: "ALUMNO_105",
    estado_final: "derrota",
    historial_aciertos: ["CUALITATIVO"],
    historial_errores: ["PROMEDIO", "RANGO", "MEDIANA", "POBLACIÓN"],
    total_disparos: 5
  },
  {
    alumno_id: "ALUMNO_106",
    estado_final: "victoria",
    historial_aciertos: ["PROMEDIO", "MODA", "POBLACIÓN", "MUESTRA", "EVENTO"],
    historial_errores: ["ESPACIO MUESTRAL"],
    total_disparos: 6
  },
  {
    alumno_id: "ALUMNO_107",
    estado_final: "victoria",
    historial_aciertos: ["MEDIA", "MEDIANA", "MODA", "PROBABILIDAD", "FRECUENCIA"],
    historial_errores: ["RANGO"],
    total_disparos: 6
  },
  {
    alumno_id: "ALUMNO_108",
    estado_final: "derrota",
    historial_aciertos: ["EVENTO", "MUESTRA"],
    historial_errores: ["RANGO", "PROMEDIO", "MEDIANA"],
    total_disparos: 5
  }
];


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
    case 'demo': dot.classList.add('live'); label.textContent = 'Datos Simulados'; break;
    case 'err':  dot.classList.add('err');  label.textContent = 'Sin conexión'; break;
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
// 7. Actualizar UI completo a partir de los documentos
// ════════════════════════════════════════════════════════
function updateDashboard(docs) {
  const total = docs.length;

  // ── KPI 1: Alumnos Evaluados ──
  setEl('val-alumnos', total.toLocaleString('es-MX'));

  // ── KPI 2: Tasa de victorias ──
  const victorias  = docs.filter(d => d.estado_final === 'victoria').length;
  const pctVic     = total > 0 ? Math.round((victorias / total) * 100) : 0;
  setEl('val-victorias', `${pctVic}%`);
  setBarWidth('fill-victorias', pctVic);
  setEl('note-victorias', `${victorias} de ${total} alumnos con estado_final = "victoria"`);
  const trackVic = document.getElementById('fill-victorias')?.closest('[role=progressbar]');
  if (trackVic) trackVic.setAttribute('aria-valuenow', pctVic);

  // ── KPI 3: Efectividad global ──
  let totalAciertos = 0, totalDisparos = 0;
  docs.forEach(d => {
    const ac = Array.isArray(d.historial_aciertos) ? d.historial_aciertos.length : 0;
    totalAciertos += ac;
    totalDisparos += (typeof d.total_disparos === 'number') ? d.total_disparos : 0;
  });
  const pctEfec = totalDisparos > 0 ? Math.round((totalAciertos / totalDisparos) * 100) : 0;
  setEl('val-efectividad', `${pctEfec}%`);
  setBarWidth('fill-efectividad', pctEfec);
  const trackEf = document.getElementById('fill-efectividad')?.closest('[role=progressbar]');
  if (trackEf) trackEf.setAttribute('aria-valuenow', pctEfec);

  // ── Charts: consolidar historial global ──
  const allAciertos = docs.flatMap(d => Array.isArray(d.historial_aciertos) ? d.historial_aciertos : []);
  const allErrores  = docs.flatMap(d => Array.isArray(d.historial_errores)  ? d.historial_errores  : []);

  const top5Aciertos = topN(calcFrequencies(allAciertos), 5);
  const top5Errores  = topN(calcFrequencies(allErrores),  5);

  if (chartAciertos) {
    chartAciertos.data.labels                = top5Aciertos.map(i => i.label);
    chartAciertos.data.datasets[0].data      = top5Aciertos.map(i => i.count);
    chartAciertos.data.datasets[0].backgroundColor = AZULES.slice(0, top5Aciertos.length);
    chartAciertos.update();
  }
  if (chartErrores) {
    chartErrores.data.labels                = top5Errores.map(i => i.label);
    chartErrores.data.datasets[0].data      = top5Errores.map(i => i.count);
    chartErrores.data.datasets[0].backgroundColor = ERRORES_COLORS.slice(0, top5Errores.length);
    chartErrores.update();
  }

  // ── Tabla de resultados ──
  renderTable(docs);

  // ── Distribucion victoria / derrota ──
  const derrotas  = total - victorias;
  const pctDerrota = total > 0 ? Math.round((derrotas  / total) * 100) : 0;
  setBarWidth('dist-victoria', pctVic);
  setBarWidth('dist-derrota',  pctDerrota);
  setEl('dist-pct-victoria', `${pctVic}%`);
  setEl('dist-pct-derrota',  `${pctDerrota}%`);

  // ── Alerta pedagogica ──
  updateAlertAndRecs(top5Errores, pctEfec);

  // ── Timestamp ──
  setEl('ts-text', `Actualizado: ${fmtTime(new Date())}`);
  const recTime = document.getElementById('rec-time');
  if (recTime) {
    const now = new Date();
    recTime.setAttribute('datetime', now.toISOString());
    recTime.textContent = fmtTime(now);
  }
}

// ════════════════════════════════════════════════════════
// 8. Tabla de resultados
// ════════════════════════════════════════════════════════
function renderTable(docs) {
  const tbody   = document.getElementById('tbody-students');
  const counter = document.getElementById('student-count');
  if (!tbody) return;

  // Filtra por busqueda activa
  const q = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const filtered = q
    ? docs.filter(d => String(d.alumno_id || '').toLowerCase().includes(q))
    : docs;

  if (counter) counter.textContent = filtered.length;

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="td-empty" aria-live="polite">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${q ? 'No se encontraron alumnos con ese criterio.' : 'Sin datos en la coleccion.'}</span>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((d, i) => buildRow(d, i)).join('');
}

function buildRow(doc, idx) {
  const alumnoId  = doc.alumno_id || `—`;
  const estado    = doc.estado_final || '—';
  const aciertos  = Array.isArray(doc.historial_aciertos) ? doc.historial_aciertos.length : 0;
  const errores   = Array.isArray(doc.historial_errores)  ? doc.historial_errores.length  : 0;
  const disparos  = typeof doc.total_disparos === 'number' ? doc.total_disparos : 0;
  const efect     = disparos > 0 ? Math.round((aciertos / disparos) * 100) : 0;

  const pillClass = estado === 'victoria' ? 'pill-victoria' : 'pill-derrota';
  const pillLabel = estado.charAt(0).toUpperCase() + estado.slice(1);

  const fillClass = efect >= 70 ? 'high' : efect < 40 ? 'low' : '';
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
        <span class="status-pill ${pillClass}" aria-label="Estado: ${pillLabel}">${pillLabel}</span>
      </td>
      <td class="tc" aria-label="${aciertos} aciertos">
        <strong style="color:var(--green)">${aciertos}</strong>
      </td>
      <td class="tc" aria-label="${errores} errores">
        <strong style="color:var(--red)">${errores}</strong>
      </td>
      <td class="tc">${disparos}</td>
      <td class="tc">
        <div class="efect-bar-wrap">
          <div class="efect-mini">
            <div class="efect-fill ${fillClass}" style="width:${efect}%"></div>
          </div>
          <span style="font-weight:600;font-size:.8rem">${efect}%</span>
        </div>
      </td>
    </tr>`;
}

// ════════════════════════════════════════════════════════
// 9. Alerta pedagogica y recomendaciones
// ════════════════════════════════════════════════════════
function updateAlertAndRecs(top5Errores, pctEfec) {
  // Alerta: concepto mas frecuente en errores
  const alertText = document.getElementById('alert-text');
  if (alertText) {
    if (top5Errores.length) {
      const topConcept = top5Errores[0].label;
      alertText.textContent =
        `Se sugiere repasar el concepto de "${topConcept}" ` +
        `(aparece ${top5Errores[0].count} veces en historial_errores grupal).`;
    } else {
      alertText.textContent = 'No se han registrado errores aun.';
    }
  }

  // Lista de recomendaciones (top 3 de errores)
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
      // Agrega recomendacion de efectividad si es baja
      if (pctEfec < 50) {
        items.push(`
          <li class="rec-item">
            <div class="rec-item-mark">⚠</div>
            <div class="rec-item-text">
              <strong>Efectividad Grupal Baja (${pctEfec}%)</strong>
              <p>Se recomienda revisar la estrategia didactica y reforzar conceptos base.</p>
            </div>
          </li>`);
      } else if (pctEfec >= 80) {
        items.push(`
          <li class="rec-item">
            <div class="rec-item-mark">✓</div>
            <div class="rec-item-text">
              <strong>Efectividad Satisfactoria (${pctEfec}%)</strong>
              <p>El grupo muestra buen dominio general. Comunicar el logro al grupo.</p>
            </div>
          </li>`);
      }
      recList.innerHTML = items.join('');
    }
  }
}

// ════════════════════════════════════════════════════════
// 10. Exportar CSV (solo lectura de allDocs en memoria)
// ════════════════════════════════════════════════════════
function exportCSV() {
  if (!allDocs.length) { toast('No hay datos para exportar.', 'err'); return; }
  const header = ['alumno_id', 'estado_final', 'aciertos', 'errores', 'total_disparos', 'efectividad_%'];
  const rows = allDocs.map(d => {
    const ac  = Array.isArray(d.historial_aciertos) ? d.historial_aciertos.length : 0;
    const er  = Array.isArray(d.historial_errores)  ? d.historial_errores.length  : 0;
    const dis = typeof d.total_disparos === 'number' ? d.total_disparos : 0;
    const ef  = dis > 0 ? Math.round((ac / dis) * 100) : 0;
    return [d.alumno_id || '', d.estado_final || '', ac, er, dis, ef];
  });
  const csv  = [header, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'lore_telemetria.csv' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Exportacion lista: lore_telemetria.csv');
}

// ════════════════════════════════════════════════════════
// 11. Busqueda
// ════════════════════════════════════════════════════════
function setupSearch() {
  const inp = document.getElementById('search-input');
  if (!inp) return;
  inp.addEventListener('input', () => renderTable(allDocs));
}

function loadMockTelemetria() {
  console.log('[LORE] Cargar datos simulados de telemetría en el Dashboard.');
  if (Array.isArray(window.SERVER_DEMO_DATA) && window.SERVER_DEMO_DATA.length > 0) {
    allDocs = window.SERVER_DEMO_DATA;
    toast('Dashboard cargado con conceptos clave de tu PDF', 'ok');
  } else {
    allDocs = MOCK_TELEMETRIA;
    toast('Mostrando datos simulados de demostración', 'ok');
  }
  updateDashboard(allDocs);
  setConnectionStatus('demo');
}


function subscribeToTelemetria() {
  // Si se ha subido un PDF en esta sesión, priorizar sus conceptos generados
  if (Array.isArray(window.SERVER_DEMO_DATA) && window.SERVER_DEMO_DATA.length > 0) {
    console.log('[LORE] Mostrando telemetría simulada del PDF activo en sesión.');
    loadMockTelemetria();
    return;
  }

  if (!window.firebaseReady || !window.db) {
    console.warn('[LORE] Firebase no está disponible. Usando datos simulados de respaldo.');
    loadMockTelemetria();
    return;
  }

  const colRef = window.db.collection('telemetria_resultados');

  unsubTelemetria = colRef.onSnapshot(
    (snapshot) => {
      if (snapshot.empty) {
        console.log('[LORE] Colección telemetria_resultados vacía. Cargando datos simulados.');
        loadMockTelemetria();
      } else {
        allDocs = snapshot.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
        updateDashboard(allDocs);
        setConnectionStatus('live');
      }
    },
    (err) => {
      console.error('[LORE] Error al leer Firestore:', err);
      loadMockTelemetria();
    }
  );
}



// ════════════════════════════════════════════════════════
// 13. Bootstrap
// ════════════════════════════════════════════════════════
window.addEventListener('beforeunload', () => {
  if (typeof unsubTelemetria === 'function') unsubTelemetria();
});

document.addEventListener('DOMContentLoaded', () => {
  // Inicializar graficas vacias
  initChartAciertos();
  initChartErrores();

  // Estado inicial de conexion
  setConnectionStatus('wait');

  // Conectar a Firestore
  subscribeToTelemetria();

  // Busqueda
  setupSearch();

  // Exportar CSV
  document.getElementById('btn-export')?.addEventListener('click', exportCSV);
});
