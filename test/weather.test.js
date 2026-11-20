import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';

const { skyFor, currentWeather, placeFor } = await import('../src/services/weather.js');

describe('office weather', () => {
  it('turns weather codes into the skies the dashboard draws', () => {
    assert.equal(skyFor(0).sky, 'clear');
    assert.equal(skyFor(2).sky, 'partly');
    assert.equal(skyFor(3).sky, 'cloudy');
    assert.equal(skyFor(45).sky, 'fog');
    assert.equal(skyFor(53).sky, 'drizzle');
    assert.deepEqual(skyFor(65), { sky: 'rain', label: 'Heavy rain' });
    assert.equal(skyFor(81).sky, 'rain');
    assert.equal(skyFor(95).sky, 'thunder');
    assert.equal(skyFor(99).label, 'Thunderstorm with hail');
    assert.equal(skyFor(1234).sky, 'partly', 'an unknown code still draws a sky');
  });

  it('uses the office unless a location is shared, and rounds a shared one', () => {
    assert.deepEqual(placeFor(), { latitude: 20.2961, longitude: 85.8245, name: 'Bhubaneswar, Odisha', own: false });
    assert.deepEqual(placeFor(28.61394, 77.20902), { latitude: 28.6, longitude: 77.2, name: 'Your location', own: true });
  });

  it('never calls out from the tests', async () => {
    assert.deepEqual(await currentWeather(), { available: false });
  });
});
