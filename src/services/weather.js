import env from '../config/env.js';

// The weather at the office right now, for the sky on the dashboard. It comes
// from Open-Meteo (free, no key) and is kept for ten minutes, so however many
// people are signed in the server asks about six times an hour, and nobody's
// browser talks to an outside service.

const FRESH_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
let cached = null;
let pending = null;

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

async function fetchWeather() {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(env.OFFICE_LATITUDE),
    longitude: String(env.OFFICE_LONGITUDE),
    current: 'temperature_2m,weather_code,is_day,precipitation',
    timezone: env.TIMEZONE,
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'leave-tracker' } });
  if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
  const { current } = await response.json();
  if (!current || typeof current.weather_code !== 'number') throw new Error('Open-Meteo sent no current weather');
  return {
    available: true,
    location: env.COMPANY_LOCATION,
    ...skyFor(current.weather_code),
    code: current.weather_code,
    isDay: current.is_day === 1,
    temperature: Math.round(current.temperature_2m),
    precipitation: current.precipitation ?? 0,
    observedAt: current.time,
  };
}

// The current weather, from the cache when it is fresh. If Open-Meteo cannot
// be reached, the last answer stays in use; with none, the sky follows the
// clock as before.
export async function currentWeather() {
  if (env.isTest) return { available: false };
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.value;
  pending ??= fetchWeather()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch(() => cached?.value ?? { available: false })
    .finally(() => {
      pending = null;
    });
  return pending;
}
