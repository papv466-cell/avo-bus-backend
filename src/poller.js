// ─── Tracking Poller v2 ───────────────────────────────────────────────────────
// Auto-descubre el COD_SERV_REITERACION activo
// Carga paradas y recorrido desde la API del proveedor

const fetch = require('node-fetch');
const { calculateETAs } = require('./eta');

const BASE_URL   = process.env.TRACKING_BASE_URL || 'https://www.virtual-office365.com/app/locrutas/v2/api/api.php';
const COMPANY    = process.env.TRACKING_COMPANY  || 'VAZQUEZOLMEDO';
const POLL_MS    = parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '5000');
const COD_SERV_RUTA = parseInt(process.env.COD_SERV_RUTA || '200020');
const COD_ENRUTA    = parseInt(process.env.COD_ENRUTA     || '4');
const SCAN_START    = parseInt(process.env.SCAN_START     || '540000');
const SCAN_END      = parseInt(process.env.SCAN_END       || '560000');

let currentCod   = null;
let lineStops    = [];
let lineRoute    = [];
let vehicleState = {};
const listeners  = new Set();

// ─── Cargar paradas ───────────────────────────────────────────────────────────
async function loadStops() {
  const url = `${BASE_URL}?OP=RUTA_PARADAS_GET&COMPANY=${COMPANY}&COD_ENRUTA=${COD_ENRUTA}&USER=&PASS=&COD_SERV_RUTA=${COD_SERV_RUTA}`;
  try {
    const res  = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin resultados');
    lineStops = data.resultados.map(p => ({
      orden:  p.NUM_PARADA,
      nombre: p.LUGAR_PARADA.replace(/, [A-Za-záéíóúñÁÉÍÓÚÑ\s]+$/, '').trim(),
      lat:    parseFloat(p.COOR_X),
      lon:    parseFloat(p.COOR_Y),
      hora:   p.HORA_PARADA,
    }));
    console.log(`✅ ${lineStops.length} paradas cargadas desde API`);
  } catch (e) {
    const { STOPS_M135 } = require('./stops');
    lineStops = STOPS_M135;
    console.warn('⚠️  Usando paradas hardcodeadas:', e.message);
  }
}

// ─── Cargar recorrido ─────────────────────────────────────────────────────────
async function loadRoute() {
  const url = `${BASE_URL}?OP=RUTA_RECORRIDO_GET&COMPANY=${COMPANY}&COD_ENRUTA=${COD_ENRUTA}&USER=&PASS=&COD_SERV_RUTA=${COD_SERV_RUTA}`;
  try {
    const res  = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin resultados');
    lineRoute = data.resultados.map(p => ({ lat: parseFloat(p.LAT), lon: parseFloat(p.LONG) }));
    console.log(`✅ ${lineRoute.length} puntos de recorrido cargados desde API`);
  } catch (e) {
    lineRoute = lineStops.map(s => ({ lat: s.lat, lon: s.lon }));
    console.warn('⚠️  Usando paradas como recorrido fallback:', e.message);
  }
}

// ─── Fetch posición ───────────────────────────────────────────────────────────
async function fetchPosition(cod) {
  const url = `${BASE_URL}?OP=VEHICULO_POSICION_GET&COMPANY=${COMPANY}&COD_ENRUTA=${COD_ENRUTA}&USER=&PASS=&COD_SERV_REITERACION=${cod}&_=${Date.now()}`;
  try {
    const res  = await fetch(url, { timeout: 5000 });
    const data = await res.json();
    if (data.estado !== 'ok' || !data.resultado) return null;
    const lat = parseFloat(data.resultado.LAT);
    const lon = parseFloat(data.resultado.LON);
    if (lat < 35 || lat > 38 || lon < -6 || lon > -3) return null;
    return { lat, lon, vehicleId: data.resultado.COD_VEHICULO, fechaHora: data.resultado.FECHA_HORA };
  } catch { return null; }
}

// ─── Auto-descubrir servicio activo ──────────────────────────────────────────
async function discoverActive() {
  // Primero probar el último que funcionó
  if (currentCod) {
    const pos = await fetchPosition(currentCod);
    if (pos) return currentCod;
    console.log(`[M135] ⚠️  COD ${currentCod} ya no responde, re-escaneando...`);
    currentCod = null;
  }

  console.log(`[M135] 🔍 Escaneando ${SCAN_START}-${SCAN_END}...`);
  const BLOCK = 100;
  for (let start = SCAN_START; start <= SCAN_END; start += BLOCK) {
    const batch = [];
    for (let cod = start; cod < start + BLOCK && cod <= SCAN_END; cod++) {
      batch.push(fetchPosition(cod).then(pos => pos ? cod : null).catch(() => null));
    }
    const results = await Promise.all(batch);
    const found = results.find(r => r !== null);
    if (found) {
      console.log(`[M135] ✅ Bus activo: COD_SERV_REITERACION=${found}`);
      currentCod = found;
      return found;
    }
  }
  console.log('[M135] 🔴 Ningún bus activo en el rango');
  return null;
}

// ─── Kalman + velocidad ───────────────────────────────────────────────────────
const K = {}, H = {};
function smooth(lat, lon) {
  if (!K.lat) { K.lat = lat; K.lon = lon; K.u = 1; return { lat, lon }; }
  K.u += 0.00001;
  const g = K.u / (K.u + 0.0001);
  K.lat += g * (lat - K.lat); K.lon += g * (lon - K.lon); K.u *= (1 - g);
  return { lat: K.lat, lon: K.lon };
}
function speed(lat, lon) {
  const prev = H.lat ? H : null;
  H.lat = lat; H.lon = lon; H.ts = Date.now();
  if (!prev) return 0;
  const { haversineMeters } = require('./eta');
  const d = haversineMeters(prev.lat, prev.lon, lat, lon);
  const t = (Date.now() - prev.ts) / 1000;
  return t > 0 ? Math.round((d / t) * 3.6 * 10) / 10 : 0;
}

// ─── Ciclo de polling ─────────────────────────────────────────────────────────
async function poll() {
  if (!currentCod) { await discoverActive(); }
  if (!currentCod) { markOffline(); return; }

  const pos = await fetchPosition(currentCod);
  if (!pos) { currentCod = null; markOffline(); return; }

  const s  = smooth(pos.lat, pos.lon);
  const sp = speed(s.lat, s.lon);
  const etas = calculateETAs(s.lat, s.lon, sp, lineStops);

  const state = {
    lineId: 'M135', lineName: 'M135 — Estación Autobuses ↔ Santa Amalia',
    lineColor: '#0F3460', lat: s.lat, lon: s.lon, speedKmh: sp,
    vehicleId: pos.vehicleId, fetchedAt: pos.fechaHora,
    updatedAt: new Date().toISOString(), isOnline: true, etas,
  };
  vehicleState['M135'] = state;
  notify({ type: 'vehicle:position', data: state });
  console.log(`[M135] ✅ lat=${s.lat.toFixed(5)} lon=${s.lon.toFixed(5)} ${sp}km/h`);
}

function markOffline() {
  if (vehicleState['M135']?.isOnline !== false) {
    vehicleState['M135'] = { ...(vehicleState['M135'] || {}), lineId: 'M135', isOnline: false, updatedAt: new Date().toISOString() };
    notify({ type: 'vehicle:offline', data: { lineId: 'M135' } });
    console.log('[M135] 🔴 Offline');
  }
}

function notify(msg) {
  const json = JSON.stringify(msg);
  listeners.forEach(cb => { try { cb(json); } catch {} });
}

// ─── Arrancar ─────────────────────────────────────────────────────────────────
async function startPolling() {
  console.log('🚌 Cargando paradas y recorrido desde API...');
  await loadStops();
  await loadRoute();
  console.log(`🚌 Polling cada ${POLL_MS}ms con auto-descubrimiento`);
  await poll();
  setInterval(poll, POLL_MS);
  // Re-escanear cada 15 min por si cambia el servicio
  setInterval(() => { currentCod = null; }, 15 * 60 * 1000);
}

module.exports = {
  startPolling,
  addListener:     cb => listeners.add(cb),
  removeListener:  cb => listeners.delete(cb),
  getVehicleState: () => vehicleState,
  getLineStops:    () => lineStops,
  getLineRoute:    () => lineRoute,
  getLines: () => [{ lineId: 'M135', name: 'M135 — Estación Autobuses ↔ Santa Amalia', color: '#0F3460', stops: lineStops, route: lineRoute }],
};
