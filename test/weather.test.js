import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.MONGO_URI ??= 'mongodb://localhost:27017/';

const { skyFor, currentWeather } = await import('../src/services/weather.js');

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

  it('never calls out from the tests', async () => {
    assert.deepEqual(await currentWeather(), { available: false });
  });
});
