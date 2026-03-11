// ─── AVO MVP Backend ──────────────────────────────────────────────────────────
// Express REST API + WebSocket para tiempo real
// Arranca con: node src/index.js

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const { startPolling, addListener, removeListener, getVehicleState, getLines, getLineStops, getLineRoute } = require('./poller');
const { STOPS_M135 } = require('./stops');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const path = require("path");
app.use(require("express").static(path.join(__dirname, "..")));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Log básico de requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /lines — Lista de líneas disponibles
app.get('/lines', (req, res) => {
  const lines = getLines().map(l => ({
    lineId: l.lineId,
    name: l.name,
    color: l.color,
    stopsCount: l.stops.length,
  }));
  res.json({ lines });
});

// GET /lines/:lineId — Detalle de una línea con paradas, recorrido y shape
app.get('/lines/:lineId', (req, res) => {
  const line = getLines().find(l => l.lineId === req.params.lineId);
  if (!line) return res.status(404).json({ error: 'Línea no encontrada' });

  const route = getLineRoute();
  const stops = getLineStops();

  // Usar recorrido real si está disponible, si no usar paradas
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

// GET /vehicles — Posiciones actuales de todos los vehículos
app.get('/vehicles', (req, res) => {
  const state = getVehicleState();
  const vehicles = Object.values(state).map(v => ({
    lineId: v.lineId,
    lineName: v.lineName,
    lineColor: v.lineColor,
    lat: v.lat,
    lon: v.lon,
    speedKmh: v.speedKmh,
    vehicleId: v.vehicleId,
    updatedAt: v.updatedAt,
    isOnline: v.isOnline,
  }));
  res.json({ vehicles });
});

// GET /vehicles/:lineId — Posición de un vehículo específico con ETAs completas
app.get('/vehicles/:lineId', (req, res) => {
  const state = getVehicleState();
  const vehicle = state[req.params.lineId];
  if (!vehicle) {
    return res.status(404).json({ error: 'Vehículo no disponible', isOnline: false });
  }
  res.json(vehicle);
});

// GET /stops/m135 — Paradas de la línea M135
app.get('/stops/m135', (req, res) => {
  res.json({ lineId: 'M135', stops: STOPS_M135 });
});

// GET /stops/:lineId/:stopIndex/eta — ETA del bus a una parada específica
app.get('/stops/:lineId/:stopIndex/eta', (req, res) => {
  const state = getVehicleState();
  const vehicle = state[req.params.lineId];
  const stopIndex = parseInt(req.params.stopIndex);

  if (!vehicle || !vehicle.isOnline) {
    return res.json({
      status: 'offline',
      message: 'Bus no disponible en tiempo real',
      etaMinutes: null,
      etaSeconds: null,
    });
  }

  const eta = vehicle.etas?.[stopIndex];
  if (!eta) return res.status(404).json({ error: 'Parada no encontrada' });

  res.json(eta);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log(`🔌 Cliente WS conectado. Total: ${wss.clients.size}`);

  // Enviar estado actual al conectarse
  const state = getVehicleState();
  ws.send(JSON.stringify({
    type: 'init',
    data: Object.values(state),
    timestamp: new Date().toISOString(),
  }));

  // Suscribir al listener del poller
  const listener = (json) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  };
  addListener(listener);

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      // El cliente puede suscribirse a una línea específica (por ahora ignoramos, mandamos todo)
      console.log('WS message from client:', parsed);
    } catch (e) { /* ignorar mensajes malformados */ }
  });

  ws.on('close', () => {
    removeListener(listener);
    console.log(`🔌 Cliente WS desconectado. Total: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    removeListener(listener);
  });
});

// ─── Ping/Pong para mantener conexiones vivas ─────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 30000);

// ─── Arrancar ─────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚌 AVO Backend MVP corriendo en http://localhost:${PORT}`);
  console.log(`📡 WebSocket en ws://localhost:${PORT}/ws`);
  console.log(`📋 Endpoints:`);
  console.log(`   GET /health`);
  console.log(`   GET /lines`);
  console.log(`   GET /lines/:lineId`);
  console.log(`   GET /vehicles`);
  console.log(`   GET /vehicles/:lineId`);
  console.log(`   GET /stops/m135`);
  console.log(`   GET /stops/:lineId/:stopIndex/eta\n`);

  startPolling();
});

module.exports = { app, server };
