// ─── ETA Calculator ───────────────────────────────────────────────────────────
// Calcula distancia y ETA del bus a cada parada
// Versión MVP: distancia geométrica + velocidad actual + dwell time por parada

const EARTH_RADIUS_M = 6371000;
const DWELL_TIME_PER_STOP_S = 15; // segundos de parada en cada stop
const MIN_SPEED_KMH = 5;
const MAX_SPEED_KMH = 90;
const DEFAULT_SPEED_KMH = 30; // si velocidad GPS es 0 o no disponible

/**
 * Distancia en metros entre dos coordenadas (Haversine)
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Encuentra el índice de la parada más cercana al bus (parada actual o última pasada)
 * Devuelve el índice de la parada más próxima por delante del bus
 */
function findNextStopIndex(busLat, busLon, stops) {
  let minDist = Infinity;
  let closestIdx = 0;

  stops.forEach((stop, i) => {
    const dist = haversineMeters(busLat, busLon, stop.lat, stop.lon);
    if (dist < minDist) {
      minDist = dist;
      closestIdx = i;
    }
  });

  // Si el bus está muy cerca de la parada más cercana (< 100m), la siguiente es la próxima
  if (minDist < 100 && closestIdx < stops.length - 1) {
    return closestIdx + 1;
  }

  return closestIdx;
}

/**
 * Calcula la distancia total en metros del bus a una parada destino
 * siguiendo el orden del recorrido (no en línea recta entre bus y parada)
 */
function distanceAlongRoute(busLat, busLon, stops, targetStopIndex) {
  const nextIdx = findNextStopIndex(busLat, busLon, stops);

  // Si el bus ya pasó la parada destino, no aplica
  if (nextIdx > targetStopIndex) return null;

  // Distancia del bus a la próxima parada
  let totalDist = haversineMeters(busLat, busLon, stops[nextIdx].lat, stops[nextIdx].lon);

  // Suma de distancias entre paradas intermedias
  for (let i = nextIdx; i < targetStopIndex; i++) {
    totalDist += haversineMeters(
      stops[i].lat, stops[i].lon,
      stops[i + 1].lat, stops[i + 1].lon
    );
  }

  return totalDist;
}

/**
 * Calcula ETAs para todas las paradas desde la posición actual del bus
 * @returns Array de { stopIndex, stopNombre, etaSeconds, etaMinutes, distanceM, status }
 */
function calculateETAs(busLat, busLon, speedKmh, stops) {
  // Normalizar velocidad
  let speed = speedKmh;
  if (!speed || speed <= 0) speed = DEFAULT_SPEED_KMH;
  speed = Math.max(MIN_SPEED_KMH, Math.min(MAX_SPEED_KMH, speed));

  const speedMs = speed / 3.6; // km/h → m/s
  const nextIdx = findNextStopIndex(busLat, busLon, stops);

  return stops.map((stop, i) => {
    if (i < nextIdx) {
      // Parada ya pasada
      return {
        stopIndex: i,
        stopOrden: stop.orden,
        stopNombre: stop.nombre,
        lat: stop.lat,
        lon: stop.lon,
        etaSeconds: null,
        etaMinutes: null,
        distanceM: null,
        status: 'passed',
      };
    }

    const distM = distanceAlongRoute(busLat, busLon, stops, i);
    const stopsInBetween = i - nextIdx; // paradas intermedias donde hay dwell
    const travelSeconds = distM / speedMs;
    const dwellSeconds = stopsInBetween * DWELL_TIME_PER_STOP_S;
    const totalSeconds = Math.round(travelSeconds + dwellSeconds);
    const etaMinutes = Math.max(0, Math.round(totalSeconds / 60));

    return {
      stopIndex: i,
      stopOrden: stop.orden,
      stopNombre: stop.nombre,
      lat: stop.lat,
      lon: stop.lon,
      etaSeconds: totalSeconds,
      etaMinutes,
      distanceM: Math.round(distM),
      status: i === nextIdx ? 'next' : 'upcoming',
    };
  });
}

module.exports = { calculateETAs, haversineMeters, findNextStopIndex };
