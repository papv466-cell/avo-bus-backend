// ─── AVO Bus Backend — index.js v2 ────────────────────────────────────────────
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const {
  startPolling, addListener, removeListener,
  getVehicleState, getLineStops, getLineRoute,
  getLines, extrapolatePosition,
} = require('./poller');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(cors());
app.use(express.json());

// ── Historial de puntualidad en memoria ───────────────────────────────────────
const punctLog = {};
function recordArrival(lid, stopName, etaMin) {
  if (!punctLog[lid]) punctLog[lid] = {};
  if (!punctLog[lid][stopName]) punctLog[lid][stopName] = [];
  punctLog[lid][stopName].push({ ts: Date.now(), etaMin, dow: new Date().getDay() });
  if (punctLog[lid][stopName].length > 100) punctLog[lid][stopName] = punctLog[lid][stopName].slice(-100);
}
function getPunctStats(lid, stopName) {
  const log = punctLog[lid]?.[stopName];
  if (!log || log.length < 3) return null;
  const avg = log.reduce((s,r) => s + r.etaMin, 0) / log.length;
  return { avg: Math.round(avg*10)/10, min: Math.min(...log.map(r=>r.etaMin)), max: Math.max(...log.map(r=>r.etaMin)), samples: log.length };
}

// ── Detección de dirección ─────────────────────────────────────────────────────
const prevPos = {};
function detectDirection(lid, lat, lon) {
  const prev = prevPos[lid];
  prevPos[lid] = { lat, lon };
  if (!prev) return null;
  const dLon = lon - prev.lon, dLat = lat - prev.lat;
  if (Math.sqrt(dLat*dLat+dLon*dLon) < 0.0002) return null;
  return {
    heading: Math.round(Math.atan2(dLon,dLat)*180/Math.PI),
    towardsMalaga: dLon > 0,
    label: dLon > 0 ? 'ida → Málaga' : 'vuelta → Alhaurín de la Torre',
  };
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
  const coords = (route.length > 0 ? route : stops);
  res.json({ lineId:line.lineId, name:line.name, color:line.color, stops, route,
    shape:{ type:'Feature', geometry:{ type:'LineString', coordinates:coords.map(p=>[p.lon,p.lat]) },
      properties:{ lineId:line.lineId, name:line.name, color:line.color } } });
});

app.get('/vehicles', (req,res) => {
  const vs = Object.values(getVehicleState()).map(v=>({
    lineId:v.lineId, lineName:v.lineName, lineColor:v.lineColor,
    lat:v.lat, lon:v.lon, speedKmh:v.speedKmh, vehicleId:v.vehicleId,
    updatedAt:v.updatedAt, isOnline:v.isOnline,
  }));
  res.json({ vehicles: vs });
});

app.get('/vehicles/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const vehicle = getVehicleState()[lid];
  if (!vehicle) return res.status(404).json({ error:'Vehículo no disponible', isOnline:false });
  const extrapolated = typeof extrapolatePosition==='function'
    ? extrapolatePosition(vehicle, getLineStops(lid)) : vehicle;
  const direction = vehicle.lat && vehicle.lon ? detectDirection(lid, vehicle.lat, vehicle.lon) : null;
  // Registrar llegadas próximas para historial
  if (extrapolated.etas) {
    extrapolated.etas.forEach(eta => {
      if (eta.status==='next' && eta.etaMinutes!=null && eta.etaMinutes<=2)
        recordArrival(lid, eta.stopNombre, eta.etaMinutes);
    });
  }
  res.json({ ...extrapolated, direction });
});

app.get('/stops/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const stops = getLineStops(lid);
  if (!stops.length) return res.status(404).json({ error:'Línea no encontrada' });
  res.json({ lineId:lid, stops });
});

// NUEVO: historial de puntualidad por línea
app.get('/punctuality/:lineId', (req,res) => {
  const lid = req.params.lineId.toUpperCase();
  const data = punctLog[lid];
  if (!data) return res.json({ lineId:lid, stops:[], totalRecords:0 });
  const stops = Object.entries(data)
    .map(([stopName, records]) => ({ stopName, stats:getPunctStats(lid,stopName), recent:records.slice(-5) }))
    .filter(s => s.stats !== null);
  res.json({ lineId:lid, stops, totalRecords:Object.values(data).flat().length });
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const cb = msg => { if (ws.readyState===WebSocket.OPEN) ws.send(msg); };
  addListener(cb);
  Object.values(getVehicleState()).forEach(v => {
    if (v.isOnline) ws.send(JSON.stringify({ type:'vehicle:position', data:v }));
  });
  ws.on('close', () => removeListener(cb));
  ws.on('error', () => removeListener(cb));
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚌 AVO Backend v2 — puerto ${PORT}`);
  startPolling();
});
