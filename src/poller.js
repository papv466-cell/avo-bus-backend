// ─── Tracking Poller v3 — Multi-línea ────────────────────────────────────────
const fetch = require('node-fetch');
const { calculateETAs } = require('./eta');

const BASE_URL = process.env.TRACKING_BASE_URL || 'https://www.virtual-office365.com/app/locrutas/v2/api/api.php';
const COMPANY  = process.env.TRACKING_COMPANY  || 'VAZQUEZOLMEDO';
const POLL_MS  = parseInt(process.env.TRACKING_POLL_INTERVAL_MS || '5000');

const LINE_DEFS = [
  { lineId:'M135', name:'M-135 · Alhaurín de la Torre — Málaga', shortName:'M135', color:'#00C8E8', codEnruta:4, codServRuta:200020 },
  { lineId:'M143', name:'M-143 · Alhaurín de la Torre — Teatinos', shortName:'M143', color:'#FFB830', codEnruta:7, codServRuta:200065 },
  { lineId:'M170', name:'M-170 · Pinos de Alhaurín — Málaga Express', shortName:'M170', color:'#00E8A0', codEnruta:9, codServRuta:500586 },
  { lineId:'MUMFI', name:'MUMFI · Alhaurín de la Torre — Alquería', shortName:'MUMFI', color:'#A78BFA', codEnruta:8, codServRuta:500584 },
];

const lineStates = {};
LINE_DEFS.forEach(l => {
  lineStates[l.lineId] = { def:l, stops:[], route:[], services:[], activeService:null, vehicle:null, kalman:{}, history:{} };
});

const listeners = new Set();

async function apiFetch(params) {
  const qs = Object.entries({ COMPANY, USER:'', PASS:'', ...params }).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${BASE_URL}?${qs}&_=${Date.now()}`, { timeout:8000 });
  return res.json();
}

async function loadServices(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP:'RUTAS_GET', COD_ENRUTA:st.def.codEnruta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin servicios');
    st.services = data.resultados.map(r => ({
      cod:r.COD_SERV_REITERACION, codRuta:r.COD_SERV_RUTA, hora:r.HORA_SALIDA,
      descripcion:r.DESCRIPCION, lunes:r.LUNES, martes:r.MARTES, miercoles:r.MIERCOLES,
      jueves:r.JUEVES, viernes:r.VIERNES, sabado:r.SABADO, domingo:r.DOMINGO,
    }));
    console.log(`[${lineId}] ✅ ${st.services.length} servicios`);
  } catch(e) { console.warn(`[${lineId}] ⚠️ Servicios: ${e.message}`); }
}

async function loadStops(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP:'RUTA_PARADAS_GET', COD_ENRUTA:st.def.codEnruta, COD_SERV_RUTA:st.def.codServRuta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin paradas');
    st.stops = data.resultados.map(p => ({
      orden:p.NUM_PARADA, nombre:p.LUGAR_PARADA.replace(/, [A-Za-záéíóúñÁÉÍÓÚÑ\s]+$/, '').trim(),
      lat:parseFloat(p.COOR_X), lon:parseFloat(p.COOR_Y), hora:p.HORA_PARADA,
    }));
    console.log(`[${lineId}] ✅ ${st.stops.length} paradas`);
  } catch(e) { console.warn(`[${lineId}] ⚠️ Paradas: ${e.message}`); }
}

async function loadRoute(lineId) {
  const st = lineStates[lineId];
  try {
    const data = await apiFetch({ OP:'RUTA_RECORRIDO_GET', COD_ENRUTA:st.def.codEnruta, COD_SERV_RUTA:st.def.codServRuta });
    if (data.estado !== 'ok' || !data.resultados?.length) throw new Error('Sin recorrido');
    st.route = data.resultados.map(p => ({ lat:parseFloat(p.LAT), lon:parseFloat(p.LONG) }));
    console.log(`[${lineId}] ✅ ${st.route.length} puntos ruta`);
  } catch(e) {
    st.route = st.stops.map(s => ({ lat:s.lat, lon:s.lon }));
    console.warn(`[${lineId}] ⚠️ Ruta fallback`);
  }
}

async function fetchPosition(codEnruta, cod) {
  try {
    const data = await apiFetch({ OP:'VEHICULO_POSICION_GET', COD_ENRUTA:codEnruta, COD_SERV_REITERACION:cod });
    if (data.estado !== 'ok' || !data.resultado) return null;
    const lat = parseFloat(data.resultado.LAT), lon = parseFloat(data.resultado.LON);
    if (isNaN(lat)||isNaN(lon)||lat<35||lat>39||lon<-7||lon>-3) return null;
    return { lat, lon, vehicleId:data.resultado.COD_VEHICULO, fechaHora:data.resultado.FECHA_HORA };
  } catch { return null; }
}

async function discoverActive(lineId) {
  const st = lineStates[lineId];
  if (!st.services.length) return null;
  const days = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const today = days[new Date().getDay()];
  const toCheck = st.services.filter(s => s[today]===1).length ? st.services.filter(s => s[today]===1) : st.services;
  for (let i=0; i<toCheck.length; i+=10) {
    const batch = toCheck.slice(i,i+10);
    const results = await Promise.all(batch.map(s => fetchPosition(st.def.codEnruta,s.cod).then(pos=>pos?s:null).catch(()=>null)));
    const found = results.find(r=>r!==null);
    if (found) { console.log(`[${lineId}] ✅ Activo: ${found.cod} ${found.hora}`); return found; }
  }
  return null;
}

function smooth(k,lat,lon) {
  if (!k.lat) { k.lat=lat; k.lon=lon; k.u=1; return {lat,lon}; }
  k.u+=0.00001; const g=k.u/(k.u+0.0001);
  k.lat+=g*(lat-k.lat); k.lon+=g*(lon-k.lon); k.u*=(1-g);
  return {lat:k.lat,lon:k.lon};
}
function calcSpeed(h,lat,lon) {
  const prev=h.lat?{...h}:null; h.lat=lat; h.lon=lon; h.ts=Date.now();
  if (!prev) return 0;
  const {haversineMeters}=require('./eta');
  const d=haversineMeters(prev.lat,prev.lon,lat,lon), t=(Date.now()-prev.ts)/1000;
  return t>0?Math.round((d/t)*3.6*10)/10:0;
}

async function pollLine(lineId) {
  const st = lineStates[lineId];
  if (!st.activeService) { st.activeService = await discoverActive(lineId); if (!st.activeService) { markOffline(lineId); return; } }
  const pos = await fetchPosition(st.def.codEnruta, st.activeService.cod);
  if (!pos) { st.activeService=null; markOffline(lineId); return; }
  const s=smooth(st.kalman,pos.lat,pos.lon), sp=calcSpeed(st.history,s.lat,s.lon);
  const etas=st.stops.length?calculateETAs(s.lat,s.lon,sp,st.stops):[];
  st.vehicle = { lineId, lineName:st.def.name, lineColor:st.def.color, lat:s.lat, lon:s.lon, speedKmh:sp,
    vehicleId:pos.vehicleId, service:st.activeService.hora, direction:st.activeService.descripcion,
    fetchedAt:pos.fechaHora, updatedAt:new Date().toISOString(), isOnline:true, etas };
  notify({ type:'vehicle:position', data:st.vehicle });
  console.log(`[${lineId}] ✅ lat=${s.lat.toFixed(5)} lon=${s.lon.toFixed(5)} ${sp}km/h`);
}

function markOffline(lineId) {
  const st=lineStates[lineId];
  if (st.vehicle?.isOnline!==false) {
    st.vehicle={...(st.vehicle||{}),lineId,isOnline:false,updatedAt:new Date().toISOString()};
    notify({type:'vehicle:offline',data:{lineId}});
    console.log(`[${lineId}] 🔴 Sin servicio`);
  }
}
function notify(msg) { const j=JSON.stringify(msg); listeners.forEach(cb=>{try{cb(j)}catch{}}); }

async function startPolling() {
  console.log('🚌 AVO Backend v3 — Multi-línea (M135, M143, M170, MUMFI)');
  await Promise.all(LINE_DEFS.map(async l => {
    await loadServices(l.lineId);
    await loadStops(l.lineId);
    await loadRoute(l.lineId);
  }));
  console.log('\n🚌 Polling iniciado...');
  async function pollAll() {
    await Promise.all(LINE_DEFS.map(l => pollLine(l.lineId).catch(e => console.error(`[${l.lineId}]`,e.message))));
  }
  await pollAll();
  setInterval(pollAll, POLL_MS);
  setInterval(() => { LINE_DEFS.forEach(l => { lineStates[l.lineId].activeService=null; loadServices(l.lineId); }); }, 30*60*1000);
}

module.exports = {
  startPolling,
  addListener:    cb=>listeners.add(cb),
  removeListener: cb=>listeners.delete(cb),
  getVehicleState: () => { const r={}; LINE_DEFS.forEach(l=>{if(lineStates[l.lineId].vehicle)r[l.lineId]=lineStates[l.lineId].vehicle;}); return r; },
  getLineStops:  lineId => lineStates[lineId]?.stops||[],
  getLineRoute:  lineId => lineStates[lineId]?.route||[],
  getLines: () => LINE_DEFS.map(l => ({ ...l, stops:lineStates[l.lineId].stops, route:lineStates[l.lineId].route, services:lineStates[l.lineId].services, vehicle:lineStates[l.lineId].vehicle })),
  getLine:  lineId => { const l=LINE_DEFS.find(x=>x.lineId===lineId); if(!l)return null; const st=lineStates[lineId]; return {...l,stops:st.stops,route:st.route,services:st.services,vehicle:st.vehicle}; },
};
