// ─── AVO Tracking Poller v5 ────────────────────────────────────────────────────
// NOVEDAD: trackea IDA y VUELTA simultáneamente por línea
// Cada línea puede tener hasta 2 buses activos al mismo tiempo

const fetch  = require('node-fetch');
const { calculateETAs } = require('./eta');

const BASE_URL = process.env.TRACKING_BASE_URL || 'https://www.virtual-office365.com/app/locrutas/v2/api/api.php';
const COMPANY  = process.env.TRACKING_COMPANY  || 'VAZQUEZOLMEDO';
const POLL_MS  = parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '5000');

// ─── Definición de líneas ──────────────────────────────────────────────────────
const LINE_DEFS = [
  { lineId:'M135',  name:'M-135 · Alhaurín de la Torre — Málaga',        color:'#00C8E8', codEnruta:4, codServRuta:200020 },
  { lineId:'M143',  name:'M-143 · Alhaurín de la Torre — Teatinos',      color:'#FFB830', codEnruta:7, codServRuta:200065 },
  { lineId:'M170',  name:'M-170 · Pinos de Alhaurín — Málaga (Express)', color:'#00E8A0', codEnruta:9, codServRuta:500586 },
  { lineId:'MUMFI', name:'MUMFI · Alhaurín de la Torre — Alquería',      color:'#A78BFA', codEnruta:8, codServRuta:500584 },
];

// ─── Estado por línea ──────────────────────────────────────────────────────────
// vehicles: { ida: vehicleObj|null, vuelta: vehicleObj|null }
const lineStates = {};
LINE_DEFS.forEach(l => {
  lineStates[l.lineId] = {
    def:      l,
    stops:    [],
    route:    [],
    services: [],
    vehicles: { ida: null, vuelta: null },  // DOS buses
    active:   { ida: null, vuelta: null },  // servicios activos
    kalman:   { ida: {}, vuelta: {} },
    history:  { ida: {}, vuelta: {} },
  };
});

const listeners = new Set();

// ─── HTTP ──────────────────────────────────────────────────────────────────────
async function apiFetch(params) {
  const qs = Object.entries({ COMPANY, USER:'', PASS:'', ...params })
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${BASE_URL}?${qs}&_=${Date.now()}`, { timeout: 8000 });
  return res.json();
}

// ─── Dirección desde DESCRIPCION ──────────────────────────────────────────────
function parseDirection(descripcion, color) {
  const d = descripcion || '';
  if (/Santa Amalia.*Málaga|Alhaurín.*Málaga|Torre.*Málaga/i.test(d))
    return { dir:'ida',    label:'→ Málaga',               short:'ida' };
  if (/Málaga.*Santa Amalia|Málaga.*Alhaurín|Málaga.*Torre/i.test(d))
    return { dir:'vuelta', label:'→ Alhaurín de la Torre', short:'vuelta' };
  const c = (color||'').toUpperCase();
  if (c === '#8A9747') return { dir:'ida',    label:'→ Málaga',               short:'ida' };
  if (c === '#2DA701') return { dir:'vuelta', label:'→ Alhaurín de la Torre', short:'vuelta' };
  return { dir:'unknown', label:'', short:'' };
}

// ─── Cargar servicios ──────────────────────────────────────────────────────────
async function loadServices(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP:'RUTAS_GET', COD_ENRUTA:st.def.codEnruta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin servicios');
    st.services = data.resultados.map(r => ({
      cod:       r.COD_SERV_REITERACION,
      codRuta:   r.COD_SERV_RUTA,
      hora:      r.HORA_SALIDA,
      desc:      r.DESCRIPCION,
      color:     r.COLOR,
      direction: parseDirection(r.DESCRIPCION, r.COLOR),
      lunes:r.LUNES, martes:r.MARTES, miercoles:r.MIERCOLES,
      jueves:r.JUEVES, viernes:r.VIERNES, sabado:r.SABADO, domingo:r.DOMINGO,
    }));
    const ida    = st.services.filter(s => s.direction.dir === 'ida').length;
    const vuelta = st.services.filter(s => s.direction.dir === 'vuelta').length;
    console.log(`[${lineId}] ✅ ${st.services.length} servicios (${ida} ida, ${vuelta} vuelta)`);
  } catch(e) {
    console.warn(`[${lineId}] ⚠️  servicios: ${e.message}`);
  }
}

// ─── Cargar paradas y recorrido ────────────────────────────────────────────────
async function loadStops(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP:'RUTA_PARADAS_GET', COD_ENRUTA:st.def.codEnruta, COD_SERV_RUTA:st.def.codServRuta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin paradas');
    st.stops = data.resultados.map(p => ({
      orden:  p.NUM_PARADA,
      nombre: p.LUGAR_PARADA.replace(/, [A-Za-záéíóúñÁÉÍÓÚÑ\s]+$/, '').trim(),
      lat:    parseFloat(p.COOR_X),
      lon:    parseFloat(p.COOR_Y),
      hora:   p.HORA_PARADA,
    }));
    console.log(`[${lineId}] ✅ ${st.stops.length} paradas`);
  } catch(e) { console.warn(`[${lineId}] ⚠️  paradas: ${e.message}`); }
}

async function loadRoute(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP:'RUTA_RECORRIDO_GET', COD_ENRUTA:st.def.codEnruta, COD_SERV_RUTA:st.def.codServRuta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin recorrido');
    st.route = data.resultados.map(p => ({ lat:parseFloat(p.LAT), lon:parseFloat(p.LONG) }));
    console.log(`[${lineId}] ✅ ${st.route.length} puntos recorrido`);
  } catch(e) {
    st.route = st.stops.map(s => ({ lat:s.lat, lon:s.lon }));
  }
}

// ─── Fetch posición de un servicio ────────────────────────────────────────────
async function fetchPosition(codEnruta, codReiteracion) {
  try {
    const data = await apiFetch({ OP:'VEHICULO_POSICION_GET', COD_ENRUTA:codEnruta, COD_SERV_REITERACION:codReiteracion });
    if (data.estado !== 'ok' || !data.resultado) return null;
    const lat = parseFloat(data.resultado.LAT);
    const lon = parseFloat(data.resultado.LON);
    if (isNaN(lat)||isNaN(lon)||lat<35||lat>39||lon<-7||lon>-3) return null;
    return { lat, lon, vehicleId:data.resultado.COD_VEHICULO, fechaHora:data.resultado.FECHA_HORA };
  } catch { return null; }
}

// ─── Descubrir servicio activo (separado por dirección) ───────────────────────
async function discoverActiveByDir(lineId, dir) {
  const st = lineStates[lineId];
  const days = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const today = days[new Date().getDay()];

  // Filtrar servicios de la dirección correcta y del día actual
  const candidates = st.services.filter(s =>
    s.direction.dir === dir && (s[today] === 1)
  );

  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i+8);
    const results = await Promise.all(
      batch.map(s => fetchPosition(st.def.codEnruta, s.cod)
        .then(pos => pos ? { ...s, pos } : null).catch(() => null))
    );
    const found = results.find(r => r !== null);
    if (found) {
      console.log(`[${lineId}/${dir}] ✅ Activo: ${found.hora} ${found.direction.label}`);
      return found;
    }
  }
  return null;
}

// ─── Kalman + velocidad ────────────────────────────────────────────────────────
function smooth(k, lat, lon) {
  if (!k.lat) { k.lat=lat; k.lon=lon; k.u=1; return {lat,lon}; }
  k.u += 0.00001;
  const g = k.u / (k.u + 0.0001);
  k.lat += g*(lat-k.lat); k.lon += g*(lon-k.lon); k.u *= (1-g);
  return { lat:k.lat, lon:k.lon };
}

function calcSpeed(h, lat, lon) {
  const prev = h.lat ? {...h} : null;
  h.lat=lat; h.lon=lon; h.ts=Date.now();
  if (!prev) return 0;
  const { haversineMeters } = require('./eta');
  const d = haversineMeters(prev.lat,prev.lon,lat,lon);
  const t = (Date.now()-prev.ts)/1000;
  return t > 0 ? Math.round((d/t)*3.6*10)/10 : 0;
}

// ─── Poll una dirección (ida o vuelta) ────────────────────────────────────────
async function pollDirection(lineId, dir) {
  const st = lineStates[lineId];

  if (!st.active[dir]) {
    st.active[dir] = await discoverActiveByDir(lineId, dir);
    if (!st.active[dir]) {
      if (st.vehicles[dir]?.isOnline !== false) {
        st.vehicles[dir] = { ...(st.vehicles[dir]||{}), lineId, dir, isOnline:false, updatedAt:new Date().toISOString() };
        notify({ type:'vehicle:offline', data:{ lineId, dir } });
      }
      return;
    }
  }

  const pos = await fetchPosition(st.def.codEnruta, st.active[dir].cod);
  if (!pos) {
    st.active[dir] = null;
    st.vehicles[dir] = { ...(st.vehicles[dir]||{}), lineId, dir, isOnline:false, updatedAt:new Date().toISOString() };
    notify({ type:'vehicle:offline', data:{ lineId, dir } });
    return;
  }

  const s   = smooth(st.kalman[dir], pos.lat, pos.lon);
  const sp  = calcSpeed(st.history[dir], s.lat, s.lon);
  const etas = st.stops.length ? calculateETAs(s.lat, s.lon, sp, st.stops, lineId+':'+dir) : [];
  const direction = st.active[dir].direction;

  st.vehicles[dir] = {
    lineId,
    dir,
    lineName:    st.def.name,
    lineColor:   st.def.color,
    lat:         s.lat,
    lon:         s.lon,
    speedKmh:    sp,
    vehicleId:   pos.vehicleId,
    service:     st.active[dir].hora,
    direction,
    fetchedAt:   pos.fechaHora,
    updatedAt:   new Date().toISOString(),
    isOnline:    true,
    etas,
  };

  // Notificar con id único por dirección
  notify({ type:'vehicle:position', data:{ ...st.vehicles[dir], lineId: lineId + (dir==='vuelta'?'_V':'') }});
  console.log(`[${lineId}/${dir}] ${s.lat.toFixed(5)},${s.lon.toFixed(5)} ${sp}km/h ${direction.label}`);
}

// ─── Poll completo de una línea (ambas direcciones) ────────────────────────────
async function pollLine(lineId) {
  await Promise.all([
    pollDirection(lineId, 'ida'),
    pollDirection(lineId, 'vuelta'),
  ]);
}

// ─── Arrancar ──────────────────────────────────────────────────────────────────
async function startPolling() {
  console.log('🚌 AVO Backend v5 — IDA + VUELTA simultáneos');
  await Promise.all(LINE_DEFS.map(async l => {
    await loadServices(l.lineId);
    await loadStops(l.lineId);
    await loadRoute(l.lineId);
  }));

  async function pollAll() {
    await Promise.all(LINE_DEFS.map(l => pollLine(l.lineId).catch(e => console.error(`[${l.lineId}]`, e.message))));
  }

  await pollAll();
  setInterval(pollAll, POLL_MS);
  setInterval(() => {
    LINE_DEFS.forEach(l => {
      lineStates[l.lineId].active = { ida:null, vuelta:null };
      loadServices(l.lineId);
    });
  }, 30*60*1000);
}

function notify(msg) {
  const json = JSON.stringify(msg);
  listeners.forEach(cb => { try{ cb(json); }catch{} });
}

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  startPolling,
  addListener:    cb => listeners.add(cb),
  removeListener: cb => listeners.delete(cb),

  // Devuelve todos los vehículos activos (ida + vuelta de cada línea)
  getVehicleState: () => {
    const result = {};
    LINE_DEFS.forEach(l => {
      const st = lineStates[l.lineId];
      // Vehicle principal (ida si existe, si no vuelta)
      const main = st.vehicles.ida || st.vehicles.vuelta;
      if (main) result[l.lineId] = main;
      // Vuelta como línea separada si ambas están activas
      if (st.vehicles.ida && st.vehicles.vuelta) {
        result[l.lineId + '_V'] = st.vehicles.vuelta;
      }
    });
    return result;
  },

  // Para el endpoint /vehicles/:lineId devolver ambos si están activos
  getVehiclesByLine: (lineId) => {
    const st = lineStates[lineId];
    if (!st) return [];
    return [st.vehicles.ida, st.vehicles.vuelta].filter(Boolean);
  },

  getLineStops:  lineId => lineStates[lineId]?.stops  || [],
  getLineRoute:  lineId => lineStates[lineId]?.route  || [],
  getLines: () => LINE_DEFS.map(l => ({
    lineId:l.lineId, name:l.name, color:l.color,
    stops:lineStates[l.lineId].stops,
    route:lineStates[l.lineId].route,
    services:lineStates[l.lineId].services,
    vehicles:lineStates[l.lineId].vehicles,
  })),
};

// ─── Dead-reckoning ────────────────────────────────────────────────────────────
function extrapolatePosition(vehicle, stops) {
  if (!vehicle?.lat || !vehicle?.lon) return vehicle;
  const lagSeconds = (Date.now() - new Date(vehicle.updatedAt).getTime()) / 1000;
  if (lagSeconds < 5 || lagSeconds > 120 || !vehicle.speedKmh || vehicle.speedKmh < 5) return vehicle;
  const distExtraM = (vehicle.speedKmh/3.6) * lagSeconds;
  const nextStop = (vehicle.etas||[]).find(e=>e.status==='next');
  if (!nextStop) return vehicle;
  const { haversineMeters } = require('./eta');
  const distToNext = haversineMeters(vehicle.lat,vehicle.lon,nextStop.lat,nextStop.lon);
  let extraLat=vehicle.lat, extraLon=vehicle.lon;
  if (distExtraM < distToNext) {
    const frac = distExtraM/distToNext;
    extraLat = vehicle.lat + frac*(nextStop.lat-vehicle.lat);
    extraLon = vehicle.lon + frac*(nextStop.lon-vehicle.lon);
  } else {
    const nn = (vehicle.etas||[]).filter(e=>e.status==='upcoming')[0];
    if (nn) {
      const seg = haversineMeters(nextStop.lat,nextStop.lon,nn.lat,nn.lon);
      const frac = Math.min(1,(distExtraM-distToNext)/seg);
      extraLat = nextStop.lat+frac*(nn.lat-nextStop.lat);
      extraLon = nextStop.lon+frac*(nn.lon-nextStop.lon);
    }
  }
  return { ...vehicle, lat:extraLat, lon:extraLon, _extrapolated:true, _lagSeconds:Math.round(lagSeconds) };
}
module.exports.extrapolatePosition = extrapolatePosition;
