import env from '../config/env.js';

// The weather right now, for the sky on the dashboard: at the office
// (Bhubaneswar, Odisha) by default, or where the person is if they let the
// browser share their location. It comes from Open-Meteo (free, no key) and
// each place is kept for ten minutes, so the server asks rarely however many
// people are signed in, and nobody's browser talks to an outside service.
//
// A shared location is rounded to one decimal place (about 10 km) before it
// is used or cached: enough for the weather, not enough to find anyone.

const FRESH_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_PLACES = 500;
const cache = new Map();
const pending = new Map();

// World Meteorological Organization weather codes, as Open-Meteo sends them,
// grouped into the skies the dashboard can draw.
export function skyFor(code) {
  if (code === 0 || code === 1) return { sky: 'clear', label: code === 0 ? 'Clear sky' : 'Mainly clear' };
  if (code === 2) return { sky: 'partly', label: 'Partly cloudy' };
  if (code === 3) return { sky: 'cloudy', label: 'Overcast' };
  if (code === 45 || code === 48) return { sky: 'fog', label: 'Fog' };
  if (code >= 51 && code <= 57) return { sky: 'drizzle', label: 'Drizzle' };
  if ([61, 80].includes(code)) return { sky: 'rain', label: 'Light rain' };
  if ([63, 66, 81].includes(code)) return { sky: 'rain', label: 'Rain' };
  if ([65, 67, 82].includes(code)) return { sky: 'rain', label: 'Heavy rain' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { sky: 'snow', label: 'Snow' };
  if (code === 95) return { sky: 'thunder', label: 'Thunderstorm' };
  if (code === 96 || code === 99) return { sky: 'thunder', label: 'Thunderstorm with hail' };
  return { sky: 'partly', label: 'Cloudy' };
}

const round = (value) => Math.round(value * 10) / 10;

// The place to read: the person's rounded location, or the office.
export function placeFor(latitude, longitude) {
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { latitude: round(latitude), longitude: round(longitude), name: 'Your location', own: true };
  }
  return { latitude: env.OFFICE_LATITUDE, longitude: env.OFFICE_LONGITUDE, name: env.OFFICE_PLACE, own: false };
}

async function fetchWeather(place) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,weather_code,is_day,precipitation',
    timezone: 'auto',
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'leave-tracker' } });
  if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
  const { current } = await response.json();
  if (!current || typeof current.weather_code !== 'number') throw new Error('Open-Meteo sent no current weather');
  return {
    available: true,
    location: place.name,
    ownLocation: place.own,
    ...skyFor(current.weather_code),
    code: current.weather_code,
    isDay: current.is_day === 1,
    temperature: Math.round(current.temperature_2m),
    precipitation: current.precipitation ?? 0,
    observedAt: current.time,
  };
}

// The current weather for a place, from the cache when it is fresh. If
// Open-Meteo cannot be reached, the last answer stays in use; with none, the
// sky follows the clock.
export async function currentWeather({ latitude, longitude } = {}) {
  if (env.isTest) return { available: false };
  const place = placeFor(latitude, longitude);
  const key = `${place.latitude},${place.longitude}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.value;
  if (!pending.has(key)) {
    pending.set(
      key,
      fetchWeather(place)
        .then((value) => {
          cache.delete(key);
          cache.set(key, { at: Date.now(), value });
          // Forget the oldest places once there are many.
          while (cache.size > MAX_PLACES) cache.delete(cache.keys().next().value);
          return value;
        })
        .catch(() => hit?.value ?? { available: false })
        .finally(() => pending.delete(key)),
    );
  }
  return pending.get(key);
}
