// ─── AVO Bus Backend — index.js v3 (IDA + VUELTA) ────────────────────────────
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const {
  startPolling, addListener, removeListener,
  getVehicleState, getVehiclesByLine, getLineStops, getLineRoute,
  getLines, extrapolatePosition,
} = require('./poller');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(cors());
app.use(express.json());

// ── Historial de puntualidad ───────────────────────────────────────────────────
const punctLog = {};
function recordArrival(lid, stopName, etaMin) {
  if (!punctLog[lid]) punctLog[lid] = {};
  if (!punctLog[lid][stopName]) punctLog[lid][stopName] = [];
  punctLog[lid][stopName].push({ ts:Date.now(), etaMin, dow:new Date().getDay() });
  if (punctLog[lid][stopName].length > 100) punctLog[lid][stopName] = punctLog[lid][stopName].slice(-100);
}
function getPunctStats(lid, stopName) {
  const log = punctLog[lid]?.[stopName];
  if (!log || log.length < 3) return null;
  const avg = log.reduce((s,r)=>s+r.etaMin,0)/log.length;
  return { avg:Math.round(avg*10)/10, min:Math.min(...log.map(r=>r.etaMin)), max:Math.max(...log.map(r=>r.etaMin)), samples:log.length };
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get('/health', (req,res) => res.json({ status:'ok', ts:new Date().toISOString() }));

app.get('/lines', (req,res) => {
  res.json({ lines: getLines().map(l=>({ lineId:l.lineId, name:l.name, color:l.color, stopsCount:l.stops.length })) });
});

app.get('/lines/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const line = getLines().find(l=>l.lineId===lid);
  if (!line) return res.status(404).json({ error:'Línea no encontrada' });
  const route = getLineRoute(lid), stops = getLineStops(lid);
  const coords = route.length>0 ? route : stops;
  res.json({ lineId:line.lineId, name:line.name, color:line.color, stops, route,
    shape:{ type:'Feature', geometry:{ type:'LineString', coordinates:coords.map(p=>[p.lon,p.lat]) },
      properties:{ lineId:line.lineId, name:line.name, color:line.color } } });
});

app.get('/vehicles', (req,res) => {
  const vs = Object.values(getVehicleState()).map(v=>({
    lineId:v.lineId, dir:v.dir, lineName:v.lineName, lineColor:v.lineColor,
    lat:v.lat, lon:v.lon, speedKmh:v.speedKmh, vehicleId:v.vehicleId,
    direction:v.direction, updatedAt:v.updatedAt, isOnline:v.isOnline,
  }));
  res.json({ vehicles:vs });
});

// Devuelve TODOS los buses de una línea (ida + vuelta si ambos activos)
app.get('/vehicles/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase().replace('_V','');
  const isVuelta = req.params.lineId.toUpperCase().includes('_V');
  
  // Try to get from dual-vehicle system
  const allVehicles = typeof getVehiclesByLine === 'function' ? getVehiclesByLine(lid) : [];
  
  if (allVehicles.length > 0) {
    // Return specific direction or primary
    const target = isVuelta
      ? allVehicles.find(v=>v.dir==='vuelta')
      : allVehicles.find(v=>v.dir==='ida') || allVehicles[0];
    
    if (!target) return res.status(404).json({ error:'Vehículo no disponible', isOnline:false });
    const extrapolated = typeof extrapolatePosition==='function'
      ? extrapolatePosition(target, getLineStops(lid)) : target;
    if (extrapolated.etas) {
      extrapolated.etas.forEach(eta => {
        if (eta.status==='next' && eta.etaMinutes!=null && eta.etaMinutes<=2)
          recordArrival(lid, eta.stopNombre, eta.etaMinutes);
      });
    }
    return res.json(extrapolated);
  }

  // Fallback: legacy single vehicle
  const vehicle = getVehicleState()[lid];
  if (!vehicle) return res.status(404).json({ error:'Vehículo no disponible', isOnline:false });
  const extrapolated = typeof extrapolatePosition==='function'
    ? extrapolatePosition(vehicle, getLineStops(lid)) : vehicle;
  return res.json(extrapolated);
});

// Nuevo: devuelve ambos buses de una línea (ida + vuelta)
app.get('/vehicles/:lineId/all', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const all = typeof getVehiclesByLine==='function' ? getVehiclesByLine(lid) : [];
  if (!all.length) return res.json({ lineId:lid, vehicles:[], count:0 });
  const result = all.map(v => {
    const ext = typeof extrapolatePosition==='function' ? extrapolatePosition(v, getLineStops(lid)) : v;
    return ext;
  });
  res.json({ lineId:lid, vehicles:result, count:result.length });
});

app.get('/stops/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const stops = getLineStops(lid);
  if (!stops.length) return res.status(404).json({ error:'Línea no encontrada' });
  res.json({ lineId:lid, stops });
});

app.get('/punctuality/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const data = punctLog[lid];
  if (!data) return res.json({ lineId:lid, stops:[], totalRecords:0 });
  const stops = Object.entries(data)
    .map(([stopName,records]) => ({ stopName, stats:getPunctStats(lid,stopName), recent:records.slice(-5) }))
    .filter(s=>s.stats!==null);
  res.json({ lineId:lid, stops, totalRecords:Object.values(data).flat().length });
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const cb = msg => { if(ws.readyState===WebSocket.OPEN) ws.send(msg); };
  addListener(cb);
  // Enviar estado inicial (todos los vehículos activos)
  Object.values(getVehicleState()).forEach(v => {
    if(v.isOnline) ws.send(JSON.stringify({ type:'vehicle:position', data:v }));
  });
  ws.on('close', ()=>removeListener(cb));
  ws.on('error', ()=>removeListener(cb));
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚌 AVO Backend v3 — IDA+VUELTA — puerto ${PORT}`);
  startPolling();
});
