// ─── AVO Bus Backend — index.js ───────────────────────────────────────────────
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const {
  startPolling,
  addListener,
  removeListener,
  getVehicleState,
  getLineStops,
  getLineRoute,
  getLines,
  getLine,
  extrapolatePosition,
} = require('./poller');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ── GET /health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── GET /lines ─────────────────────────────────────────────────────────────────
app.get('/lines', (req, res) => {
  const lines = getLines().map(l => ({
    lineId:     l.lineId,
    name:       l.name,
    color:      l.color,
    stopsCount: l.stops.length,
  }));
  res.json({ lines });
});

// ── GET /lines/:lineId — Detalle con paradas + recorrido real (shape) ──────────
app.get('/lines/:lineId', (req, res) => {
  const lid  = req.params.lineId.toUpperCase();
  const line = getLines().find(l => l.lineId === lid);
  if (!line) return res.status(404).json({ error: 'Línea no encontrada' });

  const route = getLineRoute(lid);
  const stops = getLineStops(lid);
  const routeCoords = route.length > 0 ? route : stops;

  res.json({
    lineId: line.lineId,
    name:   line.name,
    color:  line.color,
    stops,
    route,
    shape: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: routeCoords.map(p => [p.lon, p.lat]),
      },
      properties: { lineId: line.lineId, name: line.name, color: line.color },
    },
  });
});

// ── GET /vehicles — Posiciones de todos los vehículos ─────────────────────────
app.get('/vehicles', (req, res) => {
  const state = getVehicleState();
  const vehicles = Object.values(state).map(v => ({
    lineId:    v.lineId,
    lineName:  v.lineName,
    lineColor: v.lineColor,
    lat:       v.lat,
    lon:       v.lon,
    speedKmh:  v.speedKmh,
    vehicleId: v.vehicleId,
    updatedAt: v.updatedAt,
    isOnline:  v.isOnline,
  }));
  res.json({ vehicles });
});

// ── GET /vehicles/:lineId — Vehículo con ETAs y dead-reckoning ────────────────
// Dead-reckoning: si el GPS del bus lleva N segundos sin actualizar,
// extrapolamos la posición usando velocidad + dirección hacia siguiente parada.
// Esto elimina el lag visual en el mapa (icono 3 min por detrás del bus real).
app.get('/vehicles/:lineId', (req, res) => {
  const lid     = req.params.lineId.toUpperCase();
  const state   = getVehicleState();
  const vehicle = state[lid];
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehículo no disponible', isOnline: false });
  }

  // Aplicar dead-reckoning si el GPS está desactualizado
  const extrapolated = typeof extrapolatePosition === 'function'
    ? extrapolatePosition(vehicle, getLineStops(lid))
    : vehicle;

  res.json(extrapolated);
});

// ── GET /stops/:lineId — Paradas de una línea ─────────────────────────────────
app.get('/stops/:lineId', (req, res) => {
  const lid   = req.params.lineId.toUpperCase();
  const stops = getLineStops(lid);
  if (!stops.length) return res.status(404).json({ error: 'Línea no encontrada' });
  res.json({ lineId: lid, stops });
});

// ── WebSocket — push en tiempo real ───────────────────────────────────────────
wss.on('connection', (ws) => {
  const cb = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); };
  addListener(cb);

  // Enviar estado actual de todos los vehículos al conectar
  const state = getVehicleState();
  Object.values(state).forEach(v => {
    if (v.isOnline) ws.send(JSON.stringify({ type: 'vehicle:position', data: v }));
  });

  ws.on('close', () => removeListener(cb));
  ws.on('error', () => removeListener(cb));
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚌 AVO Backend escuchando en puerto ${PORT}`);
  startPolling();
});
