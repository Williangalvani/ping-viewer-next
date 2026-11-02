import { describe, expect, it } from 'vitest';
// BlueSim's own values, from its ping360.gd and cockpit_map_mesh.gd (make_fixtures.gd)
import fixture from './__fixtures__/bluesim.json';
import {
  MAP_CAPACITY,
  MAP_STRIP_WIDTH,
  METRES_PER_DEGREE,
  type PingQuadOptions,
  mapCapacity,
  mapIndex,
  mapPalette,
  ping360Range,
  pingPeriod,
  pingQuad,
} from './ping360MapMesh';

// Degrees clockwise from north, 0..360, from the transducer to the midpoint of the wedge's far
// edge, on a flat earth
const farEdgeBearing = (corners: ArrayLike<number>): number => {
  const [lon, lat] = [corners[0], corners[1]];
  const east =
    ((corners[4] + corners[6]) / 2 - lon) * METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const north = ((corners[5] + corners[7]) / 2 - lat) * METRES_PER_DEGREE;
  return ((((Math.atan2(east, north) * 180) / Math.PI) % 360) + 360) % 360;
};

const angleDiff = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('Ping360 map palette', () => {
  it('maps levels like BlueSim', () => {
    expect(Array.from({ length: 256 }, (_, level) => mapIndex(level))).toEqual(fixture.map_index);
  });

  it('is byte for byte BlueSim palette', () => {
    expect(Array.from(mapPalette())).toEqual(fixture.palette);
  });
});

describe('Ping360 map quads', () => {
  it.each(fixture.quads)(
    'heading $heading_deg, angle $angle_grad, step $angle_step, $range_m m, $samples bins',
    (ping) => {
      const quad = pingQuad(
        { lat: ping.lat, lon: ping.lon, headingDeg: ping.heading_deg },
        ping.angle_grad,
        ping.angle_step,
        ping.range_m,
        ping.levels
      );
      expect(quad.corners).toHaveLength(8);
      for (let k = 0; k < 8; k++) {
        expect(Math.abs(quad.corners[k] - ping.quad.corners[k])).toBeLessThan(1e-9);
      }
      expect(Array.from(quad.uv)).toEqual(ping.quad.uv);
      expect(Array.from(quad.texels)).toEqual(ping.quad.texels);
    }
  );

  describe('points the wedge where the widget draws the head angle', () => {
    const pose = { lat: 33.8, lon: -118.4, headingDeg: 30 };
    const bearing = (angleGrad: number, options?: PingQuadOptions): number =>
      farEdgeBearing(pingQuad(pose, angleGrad, 1, 10, [0, 0, 0], options).corners);

    it.each([
      [200, 30],
      [300, 120],
      [0, 210],
      [100, 300],
    ])('raw %d at bearing %d, the arrow forward', (angleGrad, expected) => {
      expect(angleDiff(bearing(angleGrad), expected)).toBeLessThan(1e-6);
    });

    it.each([
      [300, 300],
      [100, 120],
    ])('head-down: raw %d at bearing %d', (angleGrad, expected) => {
      expect(angleDiff(bearing(angleGrad, { reversed: true }), expected)).toBeLessThan(1e-6);
    });

    it('turns with the mount offset the widget adds for display', () => {
      expect(angleDiff(bearing(100, { mountOffsetGrad: 100 }), 30)).toBeLessThan(1e-6);
    });

    it('mirrors head-down after the mount offset', () => {
      const options = { mountOffsetGrad: 100, reversed: true };
      expect(angleDiff(bearing(100, options), 30)).toBeLessThan(1e-6);
      expect(angleDiff(bearing(150, options), 345)).toBeLessThan(1e-6);
    });
  });

  it('puts the bins first in a wider strip, then one copy of the last bin, then no data', () => {
    const ping = fixture.quads[0];
    const pose = { lat: ping.lat, lon: ping.lon, headingDeg: ping.heading_deg };
    const bins = ping.levels.length;
    const quad = pingQuad(pose, ping.angle_grad, ping.angle_step, ping.range_m, ping.levels, {
      stripWidth: MAP_STRIP_WIDTH,
    });
    expect(bins).toBeLessThan(MAP_STRIP_WIDTH);
    expect(Array.from(quad.corners)).toEqual(
      Array.from(
        pingQuad(pose, ping.angle_grad, ping.angle_step, ping.range_m, ping.levels).corners
      )
    );
    expect(Array.from(quad.uv)).toEqual(ping.quad.uv);
    expect(quad.texels).toHaveLength(MAP_STRIP_WIDTH);
    expect(Array.from(quad.texels.subarray(0, bins))).toEqual(ping.quad.texels);
    expect(quad.texels[bins]).toBe(ping.quad.texels[bins - 1]);
    expect(quad.texels[bins]).toBeGreaterThan(0);
    expect(quad.texels.subarray(bins + 1).every((texel) => texel === 0)).toBe(true);
  });

  it('leaves a strip as wide as the bins as it is, and refuses a narrower one', () => {
    const pose = { lat: 33.8, lon: -118.4, headingDeg: 30 };
    const levels = [10, 20, 30, 40];
    const exact = pingQuad(pose, 0, 1, 10, levels, { stripWidth: 4 });
    expect(Array.from(exact.texels)).toEqual(Array.from(pingQuad(pose, 0, 1, 10, levels).texels));
    expect(() => pingQuad(pose, 0, 1, 10, levels, { stripWidth: 3 })).toThrow(RangeError);
  });
});

describe('Ping360 map capacity', () => {
  it.each(fixture.capacities)('at $range_m m', ({ range_m, ping_period, capacity }) => {
    expect(pingPeriod(range_m)).toBeCloseTo(ping_period, 12);
    expect(mapCapacity(range_m)).toBe(capacity);
  });

  it('matches BlueSim for the quads too', () => {
    for (const ping of fixture.quads) expect(mapCapacity(ping.range_m)).toBe(ping.capacity);
  });

  it('keeps MAP_HISTORY_S of pings at every range in MAP_CAPACITY slots', () => {
    // 210 s at 50 Hz, rounded up to a whole 1024
    expect(MAP_CAPACITY).toBe(11264);
    for (let rangeM = 0.5; rangeM <= 100; rangeM += 0.5) {
      expect(MAP_CAPACITY).toBeGreaterThanOrEqual(mapCapacity(rangeM));
    }
  });
});

describe('Ping360 range', () => {
  it('is the round trip of sample_period * number_of_samples', () => {
    // 1200 samples of 80 ticks at 1500 m/s: 1200 * 2 us * 1500 / 2
    expect(ping360Range({ sample_period: 80, number_of_samples: 1200 })).toBeCloseTo(1.8, 12);
    expect(ping360Range({ sample_period: 1000, number_of_samples: 1200 }, 1480)).toBeCloseTo(
      22.2,
      12
    );
  });
});
