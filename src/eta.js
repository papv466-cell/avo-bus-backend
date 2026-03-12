// ─── eta.js — Cálculo de ETAs v2 ─────────────────────────────────────────────
// Corrige el bug de velocidad: usaba MIN_SPEED=5km/h cuando GPS daba 0,
// haciendo que paradas a 2km se mostraran como 30 minutos en vez de 3.

const EARTH_RADIUS_M = 6371000;

// Velocidades: bus urbano/interurbano en Málaga
const DEFAULT_SPEED_KMH = 40;  // velocidad media real M135 (antes era 30)
const MIN_SPEED_KMH     = 25;  // mínimo cuando bus está "en movimiento" (antes 5 — BUG)
const MAX_SPEED_KMH     = 90;
const DWELL_TIME_PER_STOP_S = 20; // segundos de parada en cada stop

// Historial de velocidades para suavizar (por lineId)
const speedHistory = {};

/**
 * Registra una velocidad medida y devuelve la media de los últimos 60s
 * Evita que una lectura de 0 km/h (semáforo) tire los ETAs a infinito
 */
function smoothSpeed(lineId, rawSpeedKmh) {
  if (!speedHistory[lineId]) speedHistory[lineId] = [];
  const now = Date.now();

  // Añadir lectura solo si es positiva (descartamos 0 por GPS sin movimiento)
  if (rawSpeedKmh > 0) {
    speedHistory[lineId].push({ v: rawSpeedKmh, ts: now });
  }

  // Mantener solo lecturas de los últimos 90 segundos
  speedHistory[lineId] = speedHistory[lineId].filter(x => now - x.ts < 90000);

  if (speedHistory[lineId].length === 0) return DEFAULT_SPEED_KMH;

  // Media ponderada: más peso a las lecturas recientes
  let weightSum = 0, valueSum = 0;
  speedHistory[lineId].forEach((x, i) => {
    const w = i + 1; // peso creciente
    weightSum += w;
    valueSum  += w * x.v;
  });

  const avg = valueSum / weightSum;
  return Math.max(MIN_SPEED_KMH, Math.min(MAX_SPEED_KMH, avg));
}

/**
 * Distancia en metros entre dos coordenadas (Haversine)
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Encuentra la parada más cercana al bus.
 * Devuelve el índice de la PRÓXIMA parada (la que el bus aún no ha pasado).
 *
 * Mejora sobre v1: tiene en cuenta la dirección del bus comprobando
 * si la parada más cercana está "por delante" usando la segunda más cercana.
 */
function findNextStopIndex(busLat, busLon, stops) {
  if (!stops.length) return 0;

  // Calcular distancia a todas las paradas
  const dists = stops.map((s, i) => ({
    i,
    d: haversineMeters(busLat, busLon, s.lat, s.lon),
  }));

  // Ordenar por distancia
  dists.sort((a, b) => a.d - b.d);
  const closest = dists[0];

  // Si el bus está muy cerca de una parada (< 150m), esa es la "próxima"
  // o la siguiente si ya prácticamente la está pasando (< 50m)
  if (closest.d < 50 && closest.i < stops.length - 1) {
    return closest.i + 1; // ya la pasó, la siguiente es la próxima
  }
  if (closest.d < 150) {
    return closest.i; // está llegando a esta parada
  }

  // Si está más lejos, intentar determinar si ya pasó la parada más cercana
  // comparando con la anterior y siguiente
  const ci = closest.i;
  if (ci > 0) {
    const dPrev = haversineMeters(busLat, busLon, stops[ci-1].lat, stops[ci-1].lon);
    const dNext = ci < stops.length - 1
      ? haversineMeters(busLat, busLon, stops[ci+1].lat, stops[ci+1].lon)
      : Infinity;

    // Si la anterior está más lejos que la siguiente, el bus va hacia la parada ci
    // Si la siguiente está más lejos, el bus está entre ci-1 y ci
    if (dNext < dPrev) {
      // Bus entre ci y ci+1 — la próxima es ci+1
      return ci + 1 < stops.length ? ci + 1 : ci;
    }
  }

  return ci;
}

/**
 * Distancia acumulada del bus hasta la parada targetIdx
 * siguiendo el orden de paradas (no línea recta)
 */
function distanceAlongRoute(busLat, busLon, stops, nextIdx, targetIdx) {
  if (targetIdx < nextIdx) return null; // ya pasada

  // Distancia del bus a la primera parada pendiente
  let total = haversineMeters(busLat, busLon, stops[nextIdx].lat, stops[nextIdx].lon);

  // Suma de segmentos entre paradas
  for (let i = nextIdx; i < targetIdx; i++) {
    total += haversineMeters(stops[i].lat, stops[i].lon, stops[i+1].lat, stops[i+1].lon);
  }

  return total;
}

/**
 * Calcula ETAs para todas las paradas desde la posición actual del bus.
 *
 * @param {number} busLat
 * @param {number} busLon
 * @param {number} rawSpeedKmh  — velocidad GPS cruda (puede ser 0)
 * @param {Array}  stops        — array de { lat, lon, nombre, orden }
 * @param {string} lineId       — para suavizado de velocidad
 * @returns Array de { stopIndex, stopNombre, etaSeconds, etaMinutes, distanceM, status }
 */
function calculateETAs(busLat, busLon, rawSpeedKmh, stops, lineId = 'default') {
  // Velocidad suavizada con historial — elimina el bug de MIN=5km/h
  const speedKmh = smoothSpeed(lineId, rawSpeedKmh);
  const speedMs  = speedKmh / 3.6;

  const nextIdx = findNextStopIndex(busLat, busLon, stops);

  return stops.map((stop, i) => {
    if (i < nextIdx) {
      return {
        stopIndex:  i,
        stopOrden:  stop.orden,
        stopNombre: stop.nombre,
        lat: stop.lat,
        lon: stop.lon,
        etaSeconds: null,
        etaMinutes: null,
        distanceM:  null,
        status: 'passed',
      };
    }

    const distM = distanceAlongRoute(busLat, busLon, stops, nextIdx, i);
    if (distM === null) {
      return { stopIndex:i, stopOrden:stop.orden, stopNombre:stop.nombre,
               lat:stop.lat, lon:stop.lon, etaSeconds:null, etaMinutes:null,
               distanceM:null, status:'passed' };
    }

    const stopsInBetween  = i - nextIdx;
    const travelSeconds   = distM / speedMs;
    const dwellSeconds    = stopsInBetween * DWELL_TIME_PER_STOP_S;
    const totalSeconds    = Math.round(travelSeconds + dwellSeconds);
    const etaMinutes      = Math.max(0, Math.round(totalSeconds / 60));

    return {
      stopIndex:  i,
      stopOrden:  stop.orden,
      stopNombre: stop.nombre,
      lat:  stop.lat,
      lon:  stop.lon,
      etaSeconds: totalSeconds,
      etaMinutes,
      distanceM:  Math.round(distM),
      status: i === nextIdx ? 'next' : 'upcoming',
    };
  });
}

module.exports = { calculateETAs, haversineMeters, findNextStopIndex, smoothSpeed };
