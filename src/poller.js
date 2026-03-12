// ─── Tracking Poller v3 — Multi-línea ────────────────────────────────────────
// Usa RUTAS_GET para obtener todos los servicios de cada línea
// No necesita escaneo de rangos — los COD_SERV_REITERACION son fijos

const fetch = require('node-fetch');
const { calculateETAs } = require('./eta');

const BASE_URL = process.env.TRACKING_BASE_URL || 'https://www.virtual-office365.com/app/locrutas/v2/api/api.php';
const COMPANY  = process.env.TRACKING_COMPANY  || 'VAZQUEZOLMEDO';
const POLL_MS  = parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '5000');

// ─── Definición de líneas públicas ────────────────────────────────────────────
const LINE_DEFS = [
  {
    lineId:     'M135',
    name:       'M-135 · Alhaurín de la Torre — Málaga',
    shortName:  'M135',
    color:      '#00C8E8',
    codEnruta:  4,
    // Usamos el primer COD_SERV_RUTA de dirección Málaga como referencia para paradas/recorrido
    codServRuta: 200020,
  },
  {
    lineId:     'M143',
    name:       'M-143 · Alhaurín de la Torre — Teatinos',
    shortName:  'M143',
    color:      '#FFB830',
    codEnruta:  7,
    codServRuta: 200065,
  },
  {
    lineId:     'M170',
    name:       'M-170 · Pinos de Alhaurín — Málaga (Express)',
    shortName:  'M170',
    color:      '#00E8A0',
    codEnruta:  9,
    codServRuta: 500586,
  },
  {
    lineId:     'MUMFI',
    name:       'MUMFI · Alhaurín de la Torre — Alquería',
    shortName:  'MUMFI',
    color:      '#A78BFA',
    codEnruta:  8,
    codServRuta: 500584,
  },
];

// ─── Estado global ────────────────────────────────────────────────────────────
// Por línea: { stops, route, services, activeService, vehicleState, kalman, history }
const lineStates = {};
LINE_DEFS.forEach(l => {
  lineStates[l.lineId] = {
    def:           l,
    stops:         [],
    route:         [],
    services:      [],   // array de { COD_SERV_REITERACION, HORA_SALIDA, DESCRIPCION, ... }
    activeService: null, // el que tiene bus activo ahora
    vehicle:       null, // posición actual
    kalman:        {},
    history:       {},
  };
});

const listeners = new Set();

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────
async function apiFetch(params) {
  const qs = Object.entries({ COMPANY, USER: '', PASS: '', ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${BASE_URL}?${qs}&_=${Date.now()}`;
  const res = await fetch(url, { timeout: 8000 });
  return res.json();
}

// ─── Cargar servicios de una línea (RUTAS_GET) ────────────────────────────────
async function loadServices(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP: 'RUTAS_GET', COD_ENRUTA: st.def.codEnruta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin servicios');
    st.services = data.resultados.map(r => ({
      cod:         r.COD_SERV_REITERACION,
      codRuta:     r.COD_SERV_RUTA,
      hora:        r.HORA_SALIDA,
      descripcion: r.DESCRIPCION,
      lunes:       r.LUNES, martes: r.MARTES, miercoles: r.MIERCOLES,
      jueves:      r.JUEVES, viernes: r.VIERNES, sabado: r.SABADO, domingo: r.DOMINGO,
    }));
    console.log(`[${lineId}] ✅ ${st.services.length} servicios cargados`);
  } catch (e) {
    console.warn(`[${lineId}] ⚠️  Error cargando servicios: ${e.message}`);
  }
}

// ─── Cargar paradas ───────────────────────────────────────────────────────────
async function loadStops(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP: 'RUTA_PARADAS_GET', COD_ENRUTA: st.def.codEnruta, COD_SERV_RUTA: st.def.codServRuta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin paradas');
    st.stops = data.resultados.map(p => ({
      orden:  p.NUM_PARADA,
      nombre: p.LUGAR_PARADA.replace(/, [A-Za-záéíóúñÁÉÍÓÚÑ\s]+$/, '').trim(),
      lat:    parseFloat(p.COOR_X),
      lon:    parseFloat(p.COOR_Y),
      hora:   p.HORA_PARADA,
    }));
    console.log(`[${lineId}] ✅ ${st.stops.length} paradas cargadas`);
  } catch (e) {
    console.warn(`[${lineId}] ⚠️  Sin paradas: ${e.message}`);
  }
}

// ─── Cargar recorrido ─────────────────────────────────────────────────────────
async function loadRoute(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP: 'RUTA_RECORRIDO_GET', COD_ENRUTA: st.def.codEnruta, COD_SERV_RUTA: st.def.codServRuta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin recorrido');
    st.route = data.resultados.map(p => ({ lat: parseFloat(p.LAT), lon: parseFloat(p.LONG) }));
    console.log(`[${lineId}] ✅ ${st.route.length} puntos de recorrido`);
  } catch (e) {
    st.route = st.stops.map(s => ({ lat: s.lat, lon: s.lon }));
    console.warn(`[${lineId}] ⚠️  Recorrido fallback a paradas`);
  }
}

// ─── Fetch posición de un servicio concreto ────────────────────────────────────
async function fetchPosition(codEnruta, codReiteracion) {
  try {
    const data = await apiFetch({ OP: 'VEHICULO_POSICION_GET', COD_ENRUTA: codEnruta, COD_SERV_REITERACION: codReiteracion });
    if (data.estado !== 'ok' || !data.resultado) return null;
    const lat = parseFloat(data.resultado.LAT);
    const lon = parseFloat(data.resultado.LON);
    if (isNaN(lat) || isNaN(lon)) return null;
    if (lat < 35 || lat > 39 || lon < -7 || lon > -3) return null;
    return { lat, lon, vehicleId: data.resultado.COD_VEHICULO, fechaHora: data.resultado.FECHA_HORA };
  } catch { return null; }
}

// ─── Descubrir servicio activo para una línea ─────────────────────────────────
// Prueba todos los servicios de hoy en paralelo (batches de 10)
async function discoverActive(lineId) {
  const st = lineStates[lineId];
  if (!st.services.length) return null;

  // Filtrar servicios del día actual
  const days = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const today = days[new Date().getDay()];
  const todayServices = st.services.filter(s => s[today] === 1);
  const toCheck = todayServices.length ? todayServices : st.services;

  // Probar en batches de 10
  for (let i = 0; i < toCheck.length; i += 10) {
    const batch = toCheck.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(s => fetchPosition(st.def.codEnruta, s.cod).then(pos => pos ? s : null).catch(() => null))
    );
    const found = results.find(r => r !== null);
    if (found) {
      console.log(`[${lineId}] ✅ Servicio activo: ${found.cod} (${found.hora} ${found.descripcion.split('(')[0].trim()})`);
      return found;
    }
  }
  return null;
}

// ─── Kalman filter ────────────────────────────────────────────────────────────
function smooth(k, lat, lon) {
  if (!k.lat) { k.lat = lat; k.lon = lon; k.u = 1; return { lat, lon }; }
  k.u += 0.00001;
  const g = k.u / (k.u + 0.0001);
  k.lat += g * (lat - k.lat); k.lon += g * (lon - k.lon); k.u *= (1 - g);
  return { lat: k.lat, lon: k.lon };
}

function calcSpeed(h, lat, lon) {
  const prev = h.lat ? { ...h } : null;
  h.lat = lat; h.lon = lon; h.ts = Date.now();
  if (!prev) return 0;
  const { haversineMeters } = require('./eta');
  const d = haversineMeters(prev.lat, prev.lon, lat, lon);
  const t = (Date.now() - prev.ts) / 1000;
  return t > 0 ? Math.round((d / t) * 3.6 * 10) / 10 : 0;
}

// ─── Poll una línea ───────────────────────────────────────────────────────────
async function pollLine(lineId) {
  const st = lineStates[lineId];

  // Si no hay servicio activo, intentar descubrir
  if (!st.activeService) {
    st.activeService = await discoverActive(lineId);
    if (!st.activeService) {
      markOffline(lineId);
      return;
    }
  }

  // Fetch posición
  const pos = await fetchPosition(st.def.codEnruta, st.activeService.cod);
  if (!pos) {
    console.log(`[${lineId}] ⚠️  Servicio ${st.activeService.cod} sin respuesta, re-descubriendo...`);
    st.activeService = null;
    markOffline(lineId);
    return;
  }

  const s  = smooth(st.kalman, pos.lat, pos.lon);
  const sp = calcSpeed(st.history, s.lat, s.lon);
  const etas = st.stops.length ? calculateETAs(s.lat, s.lon, sp, st.stops, lineId) : [];

  st.vehicle = {
    lineId,
    lineName:    st.def.name,
    lineColor:   st.def.color,
    lat:         s.lat,
    lon:         s.lon,
    speedKmh:    sp,
    vehicleId:   pos.vehicleId,
    service:     st.activeService.hora,
    direction:   st.activeService.descripcion,
    fetchedAt:   pos.fechaHora,
    updatedAt:   new Date().toISOString(),
    isOnline:    true,
    etas,
  };

  notify({ type: 'vehicle:position', data: st.vehicle });
  console.log(`[${lineId}] ✅ lat=${s.lat.toFixed(5)} lon=${s.lon.toFixed(5)} ${sp}km/h`);
}

function markOffline(lineId) {
  const st = lineStates[lineId];
  if (st.vehicle?.isOnline !== false) {
    st.vehicle = { ...(st.vehicle || {}), lineId, isOnline: false, updatedAt: new Date().toISOString() };
    notify({ type: 'vehicle:offline', data: { lineId } });
    console.log(`[${lineId}] 🔴 Sin servicio activo`);
  }
}

function notify(msg) {
  const json = JSON.stringify(msg);
  listeners.forEach(cb => { try { cb(json); } catch {} });
}

// ─── Arrancar ─────────────────────────────────────────────────────────────────
async function startPolling() {
  console.log('🚌 Iniciando AVO Backend v3 — Multi-línea');

  // Cargar datos de todas las líneas en paralelo
  await Promise.all(LINE_DEFS.map(async l => {
    console.log(`\n📋 Cargando ${l.lineId}...`);
    await loadServices(l.lineId);
    await loadStops(l.lineId);
    await loadRoute(l.lineId);
  }));

  console.log('\n🚌 Iniciando polling de todas las líneas...');

  // Poll todas las líneas
  async function pollAll() {
    await Promise.all(LINE_DEFS.map(l => pollLine(l.lineId).catch(e => console.error(`[${l.lineId}] Error:`, e.message))));
  }

  await pollAll();
  setInterval(pollAll, POLL_MS);

  // Recargar servicios cada 30 min (por si cambian)
  setInterval(() => {
    LINE_DEFS.forEach(l => {
      lineStates[l.lineId].activeService = null;
      loadServices(l.lineId);
    });
  }, 30 * 60 * 1000);
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  startPolling,
  addListener:    cb => listeners.add(cb),
  removeListener: cb => listeners.delete(cb),

  getVehicleState: () => {
    const result = {};
    LINE_DEFS.forEach(l => { if (lineStates[l.lineId].vehicle) result[l.lineId] = lineStates[l.lineId].vehicle; });
    return result;
  },

  getLineStops: (lineId) => lineStates[lineId]?.stops || [],

  getLineRoute: (lineId) => lineStates[lineId]?.route || [],

  getLines: () => LINE_DEFS.map(l => ({
    lineId:    l.lineId,
    name:      l.name,
    shortName: l.shortName,
    color:     l.color,
    stops:     lineStates[l.lineId].stops,
    route:     lineStates[l.lineId].route,
    services:  lineStates[l.lineId].services,
    vehicle:   lineStates[l.lineId].vehicle,
  })),

  getLine: (lineId) => {
    const l = LINE_DEFS.find(x => x.lineId === lineId);
    if (!l) return null;
    const st = lineStates[lineId];
    return { ...l, stops: st.stops, route: st.route, services: st.services, vehicle: st.vehicle };
  },
};

// ─── Dead-reckoning: extrapola la posición del bus cuando el GPS no actualiza ──
// Si el GPS del bus no ha enviado posición en los últimos N segundos,
// proyectamos dónde debería estar ahora mismo usando velocidad + rumbo.
// Esto elimina el "lag" visual en el mapa.

function extrapolatePosition(vehicle, stops) {
  if (!vehicle || !vehicle.lat || !vehicle.lon) return vehicle;

  const now        = Date.now();
  const updatedMs  = new Date(vehicle.updatedAt).getTime();
  const lagSeconds = (now - updatedMs) / 1000;

  // Solo extrapolar si el lag es entre 5 y 120 segundos
  // (menos: no merece la pena; más: GPS puede estar offline)
  if (lagSeconds < 5 || lagSeconds > 120 || !vehicle.speedKmh || vehicle.speedKmh < 5) {
    return vehicle;
  }

  // Cuántos metros debería haber avanzado el bus
  const distExtraM = (vehicle.speedKmh / 3.6) * lagSeconds;

  // Encontrar la parada "next" y la siguiente para interpolar a lo largo de la ruta
  const etas      = vehicle.etas || [];
  const nextStop  = etas.find(e => e.status === 'next');
  const upcoming  = etas.filter(e => e.status === 'upcoming');

  if (!nextStop) return vehicle;

  const { haversineMeters } = require('./eta');
  const distToNext = haversineMeters(vehicle.lat, vehicle.lon, nextStop.lat, nextStop.lon);

  let extraLat = vehicle.lat;
  let extraLon = vehicle.lon;

  if (distExtraM < distToNext) {
    // El bus sigue entre su posición GPS y la próxima parada
    const frac = distExtraM / distToNext;
    extraLat = vehicle.lat + frac * (nextStop.lat - vehicle.lat);
    extraLon = vehicle.lon + frac * (nextStop.lon - vehicle.lon);
  } else {
    // El bus ha superado la próxima parada — usar la siguiente como destino
    const nextNext = upcoming[0];
    if (nextNext) {
      const distRemaining = distExtraM - distToNext;
      const seg = haversineMeters(nextStop.lat, nextStop.lon, nextNext.lat, nextNext.lon);
      const frac = Math.min(1, distRemaining / seg);
      extraLat = nextStop.lat + frac * (nextNext.lat - nextStop.lat);
      extraLon = nextStop.lon + frac * (nextNext.lon - nextStop.lon);
    } else {
      extraLat = nextStop.lat;
      extraLon = nextStop.lon;
    }
  }

  return { ...vehicle, lat: extraLat, lon: extraLon, _extrapolated: true, _lagSeconds: Math.round(lagSeconds) };
}

module.exports.extrapolatePosition = extrapolatePosition;
