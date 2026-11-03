import { colorPalettes, paletteGradient } from '@/components/widgets/colorPalettes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapMeshMessage } from './mapMeshSender';
import {
  type Ping360Config,
  Ping360MapFeed,
  UNKNOWN_HDG,
  YAW_STALE_MS,
  ping360MapPalette,
  ping360MountOffsetGrad,
} from './ping360MapFeed';
import {
  MAP_CAPACITY,
  MAP_STRIP_WIDTH,
  METRES_PER_DEGREE,
  mapCapacity,
  mapPalette,
  mapPaletteFrom,
  ping360Range,
  pingQuad,
} from './ping360MapMesh';

// 1200 samples of 1000 ticks: 22.5 m at 1500 m/s
const CONFIG = { sample_period: 1000, number_of_samples: 1200, num_steps: 2 };
const LAT = 33.810313;
const LON = -118.393867;
const levels = (width: number): number[] => Array.from({ length: width }, (_, b) => b % 256);

const feed = (posted: MapMeshMessage[]): Ping360MapFeed =>
  new Ping360MapFeed({ slot: 2, post: (message) => posted.push(message) });

const place = (target: Ping360MapFeed, lat: number, lon: number): void => {
  target.setLatitudeE7(lat * 1e7);
  target.setLongitudeE7(lon * 1e7);
};

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

const lastQuadBearing = (posted: MapMeshMessage[]): number => {
  const quads = posted.filter((message) => message.type === 'cockpit:setMapMeshQuads');
  return farEdgeBearing(quads.at(-1)?.corners as Float64Array);
};

beforeEach(() => {
  vi.useFakeTimers();
});

describe('ping360MountOffsetGrad', () => {
  it.each([
    ['a full circle from 0', { start_angle: 0, stop_angle: 399 }, 0],
    ['a full circle from 300, centred on 100', { start_angle: 300, stop_angle: 299 }, 100],
    ['a sector centred on 200', { start_angle: 150, stop_angle: 250 }, 0],
    ['a sector centred on 100', { start_angle: 50, stop_angle: 150 }, 100],
    ['a sector across 0, centred on it', { start_angle: 350, stop_angle: 50 }, 200],
    ['no angles', {}, 0],
    ['only a start angle', { start_angle: 300 }, 0],
    ['angles that are not finite', { start_angle: Number.NaN, stop_angle: 299 }, 0],
  ])('is what Ping360Loader adds for %s', (_, config, expected) => {
    expect(ping360MountOffsetGrad(config)).toBe(expected);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Ping360MapFeed', () => {
  it.each([
    ['no position', undefined, undefined],
    ['0, 0', 0, 0],
    ['a latitude beyond 90', 91, LON],
    ['a longitude beyond 180', LAT, 181],
    ['a position that is not a number', Number.NaN, LON],
  ])('sends Cockpit nothing with %s', (_, lat, lon) => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    target.setLatitudeE7(lat === undefined ? undefined : lat * 1e7);
    target.setLongitudeE7(lon === undefined ? undefined : lon * 1e7);
    target.setYawRadians(0.5);
    target.setHdgCentidegrees(3000);
    target.handleConfig(CONFIG);
    for (let angle = 0; angle < 10; angle++) target.handlePing(angle, levels(1200));
    vi.advanceTimersByTime(1000);
    expect(posted).toEqual([]);
    expect(target.sender).toBeUndefined();
  });

  it('sends nothing before the device config, nor without a heading', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(0);
    target.handlePing(0, levels(1200));
    const headless = feed(posted);
    place(headless, LAT, LON);
    headless.setHdgCentidegrees(UNKNOWN_HDG);
    headless.handleConfig(CONFIG);
    headless.handlePing(0, levels(1200));
    vi.advanceTimersByTime(1000);
    expect(posted).toEqual([]);
  });

  it('makes the mesh on the first ping with a pose, then writes each ping', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(Math.PI / 2);
    target.handleConfig(CONFIG);
    target.handlePing(100, levels(1200));
    vi.advanceTimersByTime(20);
    expect(posted.map((message) => message.type)).toEqual([
      'cockpit:getMapCapabilities',
      'cockpit:setMapMesh',
      'cockpit:clearMapMesh',
      'cockpit:setMapMeshQuads',
    ]);
    const mesh = posted[1].mesh as Record<string, unknown>;
    const range = ping360Range(CONFIG);
    expect(mesh).toMatchObject({
      id: 'ping-viewer-next-ping360-2',
      name: 'Ping360 (slot 2)',
      capacity: MAP_CAPACITY,
      texels: { format: 'r8', width: MAP_STRIP_WIDTH, height: 1 },
      filter: 'linear',
      opacity: 1,
    });
    expect(Array.from(mesh.palette as Uint8Array)).toEqual(Array.from(mapPalette()));
    const quad = pingQuad({ lat: LAT, lon: LON, headingDeg: 90 }, 100, 2, range, levels(1200));
    expect(posted[3].first).toBe(0);
    expect(Array.from(posted[3].corners as Float64Array)).toEqual(Array.from(quad.corners));
    expect(Array.from(posted[3].texels as Uint8Array)).toEqual(Array.from(quad.texels));
  });

  it('keeps its one mesh, and the pings on it, whatever the range and number of samples', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(0);
    const pings: [Partial<Ping360Config>, number][] = [
      [{ sample_period: 889, number_of_samples: 1200 }, 20],
      [{ sample_period: 444, number_of_samples: 1200 }, 10],
      [{ sample_period: 2664, number_of_samples: 200 }, 10],
    ];
    pings.forEach(([settings, rangeM], angle) => {
      expect(ping360Range(settings as Ping360Config)).toBeCloseTo(rangeM, 1);
      target.handlePing(angle, levels(settings.number_of_samples as number), settings);
      vi.advanceTimersByTime(20);
    });
    const sets = posted.filter((message) => message.type === 'cockpit:setMapMesh');
    expect(sets).toHaveLength(1);
    expect(sets[0].mesh).toMatchObject({ capacity: 11264, texels: { width: 1200 } });
    expect(posted.filter((message) => message.type === 'cockpit:clearMapMesh')).toHaveLength(1);
    const quads = posted.filter((message) => message.type === 'cockpit:setMapMeshQuads');
    expect(quads.map((message) => message.first)).toEqual([0, 1, 2]);
    const narrow = quads[2];
    expect(Array.from(narrow.uv as Float32Array)).toEqual([0, 0.5, 0, 0.5, 200, 0.5, 200, 0.5]);
    const texels = narrow.texels as Uint8Array;
    expect(texels).toHaveLength(1200);
    expect(texels[199]).toBeGreaterThan(0);
    expect(texels[200]).toBe(texels[199]);
    expect(texels.subarray(201).every((texel) => texel === 0)).toBe(true);
    const range = ping360Range(pings[2][0] as Ping360Config);
    const quad = pingQuad({ lat: LAT, lon: LON, headingDeg: 0 }, 2, 1, range, levels(200), {
      stripWidth: MAP_STRIP_WIDTH,
    });
    expect(Array.from(texels)).toEqual(Array.from(quad.texels));
  });

  it('skips pings with no bins or more than a strip takes', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(0);
    target.handleConfig(CONFIG);
    target.handlePing(0, levels(MAP_STRIP_WIDTH + 1));
    target.handlePing(1, []);
    vi.advanceTimersByTime(20);
    expect(posted).toEqual([]);
    target.handlePing(2, levels(1200));
    target.handlePing(3, levels(1201));
    vi.advanceTimersByTime(20);
    const quads = posted.filter((message) => message.type === 'cockpit:setMapMeshQuads');
    expect(quads.map((message) => (message.corners as Float64Array).length)).toEqual([8]);
  });

  it('takes the range from the ping message without any device config', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(Math.PI / 2);
    target.handlePing(100, levels(1200), {});
    target.handlePing(100, levels(1200), { sample_period: 0, number_of_samples: 1200 });
    target.handlePing(100, levels(1200), { sample_period: Number.NaN, number_of_samples: 1200 });
    target.handlePing(100, levels(1200), { sample_period: 1000, number_of_samples: -1 });
    vi.advanceTimersByTime(20);
    expect(posted).toEqual([]);
    target.handlePing(100, levels(1200), CONFIG);
    vi.advanceTimersByTime(20);
    const sets = posted.filter((message) => message.type === 'cockpit:setMapMesh');
    expect(sets.map((message) => (message.mesh as { capacity: number }).capacity)).toEqual([
      MAP_CAPACITY,
    ]);
    const quad = pingQuad({ lat: LAT, lon: LON, headingDeg: 90 }, 100, 2, 22.5, levels(1200));
    const quads = posted.filter((message) => message.type === 'cockpit:setMapMeshQuads');
    expect(quads.map((message) => Array.from(message.corners as Float64Array))).toEqual([
      Array.from(quad.corners),
    ]);
  });

  it('takes the range and head step of the ping message over the device config', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(0);
    target.handleConfig({ ...CONFIG, num_steps: 1 });
    const pings: [Partial<Ping360Config>, number, number][] = [
      // AutoDeviceData
      [{ sample_period: 80, number_of_samples: 1200, num_steps: 4 }, 1.8, 4],
      // DeviceData, without num_steps
      [{ sample_period: 80, number_of_samples: 1200 }, 1.8, 1],
      [{ sample_period: 0, number_of_samples: 1200, num_steps: 4 }, 22.5, 1],
      [{}, 22.5, 1],
    ];
    pings.forEach(([settings], angle) => {
      target.handlePing(angle, levels(1200), settings);
      vi.advanceTimersByTime(20);
    });
    const sets = posted.filter((message) => message.type === 'cockpit:setMapMesh');
    expect(sets).toHaveLength(1);
    const quads = posted.filter((message) => message.type === 'cockpit:setMapMeshQuads');
    expect(quads.map((message) => Array.from(message.corners as Float64Array))).toEqual(
      pings.map(([, rangeM, stepGrad], angle) =>
        Array.from(
          pingQuad({ lat: LAT, lon: LON, headingDeg: 0 }, angle, stepGrad, rangeM, levels(1200))
            .corners
        )
      )
    );
  });

  it('keeps filling the ring when the range of the ping messages changes', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(0);
    target.handleConfig(CONFIG);
    const short = { ...CONFIG, sample_period: 80 };
    expect(mapCapacity(ping360Range(short))).not.toBe(mapCapacity(22.5));
    for (const [angle, settings] of [CONFIG, short, short, CONFIG].entries()) {
      target.handlePing(angle, levels(1200), settings);
      vi.advanceTimersByTime(20);
    }
    const sets = posted.filter((message) => message.type === 'cockpit:setMapMesh');
    expect(sets).toHaveLength(1);
    const quads = posted.filter((message) => message.type === 'cockpit:setMapMeshQuads');
    expect(quads.map((message) => message.first)).toEqual([0, 1, 2, 3]);
  });

  it('turns the wedge by the mount offset of the device config', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians((30 * Math.PI) / 180);
    target.handleConfig({ ...CONFIG, start_angle: 300, stop_angle: 299 });
    expect(target.mountOffsetGrad).toBe(100);
    target.handlePing(100, levels(1200));
    vi.advanceTimersByTime(20);
    expect(angleDiff(lastQuadBearing(posted), 30)).toBeLessThan(1e-6);
    target.handleConfig(CONFIG);
    expect(target.mountOffsetGrad).toBe(100);
  });

  it('takes the mount offset of the ping message over the device config', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians((30 * Math.PI) / 180);
    target.handleConfig({ ...CONFIG, start_angle: 0, stop_angle: 399 });
    target.handlePing(100, levels(1200), { start_angle: 300, stop_angle: 299 });
    vi.advanceTimersByTime(20);
    expect(angleDiff(lastQuadBearing(posted), 30)).toBeLessThan(1e-6);
    target.handlePing(200, levels(1200));
    vi.advanceTimersByTime(20);
    expect(angleDiff(lastQuadBearing(posted), 30)).toBeLessThan(1e-6);
  });

  it('mirrors the wedge head-down', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians((30 * Math.PI) / 180);
    target.handleConfig({ ...CONFIG, start_angle: 0, stop_angle: 399 });
    target.reversed = true;
    target.handlePing(250, levels(1200));
    vi.advanceTimersByTime(20);
    expect(angleDiff(lastQuadBearing(posted), 30 - 45)).toBeLessThan(1e-6);
  });

  it('heads by ATTITUDE yaw while it is fresh, by GLOBAL_POSITION_INT hdg otherwise', () => {
    const target = feed([]);
    place(target, LAT, LON);
    target.setHdgCentidegrees(4500);
    expect(target.pose()?.headingDeg).toBe(45);
    target.setYawRadians(Math.PI);
    expect(target.pose()?.headingDeg).toBe(180);
    vi.advanceTimersByTime(YAW_STALE_MS);
    expect(target.pose()?.headingDeg).toBe(45);
    target.setHdgCentidegrees(UNKNOWN_HDG);
    expect(target.pose()?.headingDeg).toBe(180);
    target.resetPose();
    expect(target.pose()).toBeUndefined();
  });

  it('writes nothing while paused, and clears the map', () => {
    const posted: MapMeshMessage[] = [];
    const target = feed(posted);
    place(target, LAT, LON);
    target.setYawRadians(0);
    target.handleConfig(CONFIG);
    target.enabled = false;
    target.handlePing(0, levels(1200));
    expect(posted).toEqual([]);
    target.enabled = true;
    target.handlePing(0, levels(1200));
    vi.advanceTimersByTime(20);
    target.clear();
    expect(posted.at(-1)?.type).toBe('cockpit:clearMapMesh');
    target.dispose();
    target.clear();
    expect(posted.at(-1)?.type).toBe('cockpit:clearMapMesh');
  });
});

describe('Ping360MapFeed palette', () => {
  const CUSTOM = [
    { pos: 0, color: [10, 20, 30, 255] },
    { pos: 1, color: [250, 240, 230, 255] },
  ];

  const storage = (saved: Record<string, string>) => ({
    getItem: (key: string) => saved[key] ?? null,
  });

  const scanning = (posted: MapMeshMessage[], palette?: string): Ping360MapFeed => {
    const target = new Ping360MapFeed({
      slot: 2,
      post: (message) => posted.push(message),
      palette,
    });
    place(target, LAT, LON);
    target.setYawRadians(0);
    target.handleConfig(CONFIG);
    return target;
  };

  const meshPalette = (posted: MapMeshMessage[]): number[] => {
    const set = posted.find((message) => message.type === 'cockpit:setMapMesh');
    return Array.from((set?.mesh as Record<string, unknown>).palette as Uint8Array);
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is BlueSim palette without a palette name', () => {
    expect(Array.from(ping360MapPalette())).toEqual(Array.from(mapPalette()));
    expect(Array.from(ping360MapPalette(''))).toEqual(Array.from(mapPalette()));
  });

  it('is the widget palette of a name, an unknown one Thermal Blue as in the widget', () => {
    const ocean = Array.from(mapPaletteFrom(colorPalettes.Ocean));
    expect(Array.from(ping360MapPalette('Ocean'))).toEqual(ocean);
    const thermalBlue = Array.from(mapPaletteFrom(colorPalettes['Thermal Blue']));
    expect(Array.from(ping360MapPalette('Nonexistent'))).toEqual(thermalBlue);
  });

  it('takes Custom from what SonarColorOptions saved, BlueSim palette without it', () => {
    expect(
      paletteGradient('Custom', storage({ customColorPalette: JSON.stringify(CUSTOM) }))
    ).toEqual(CUSTOM);
    expect(paletteGradient('Custom', storage({}))).toBeUndefined();
    expect(paletteGradient('Custom', storage({ customColorPalette: 'not json' }))).toBeUndefined();
    expect(paletteGradient('Custom', storage({ customColorPalette: '[]' }))).toBeUndefined();
    const outOfRange = [{ pos: 0, color: [300, 0, 0, 255] }];
    expect(
      paletteGradient('Custom', storage({ customColorPalette: JSON.stringify(outOfRange) }))
    ).toBeUndefined();

    vi.stubGlobal('localStorage', storage({ customColorPalette: JSON.stringify(CUSTOM) }));
    expect(Array.from(ping360MapPalette('Custom'))).toEqual(Array.from(mapPaletteFrom(CUSTOM)));
    vi.stubGlobal('localStorage', storage({}));
    expect(Array.from(ping360MapPalette('Custom'))).toEqual(Array.from(mapPalette()));
  });

  it('makes the mesh in the palette of the name it was given', () => {
    const posted: MapMeshMessage[] = [];
    scanning(posted, 'Ocean').handlePing(0, levels(1200));
    vi.advanceTimersByTime(20);
    expect(meshPalette(posted)).toEqual(Array.from(mapPaletteFrom(colorPalettes.Ocean)));
  });

  it('makes the mesh in a palette set before the first ping, sending nothing before it', () => {
    const posted: MapMeshMessage[] = [];
    const target = scanning(posted);
    target.setPalette('Heatmap');
    expect(posted).toEqual([]);
    target.handlePing(0, levels(1200));
    vi.advanceTimersByTime(20);
    expect(meshPalette(posted)).toEqual(Array.from(mapPaletteFrom(colorPalettes.Heatmap)));
  });

  it('re-sends only the palette when it changes, the mesh and its pings kept', () => {
    vi.stubGlobal('localStorage', storage({ customColorPalette: JSON.stringify(CUSTOM) }));
    const posted: MapMeshMessage[] = [];
    const target = scanning(posted, 'Thermal Blue');
    for (let angle = 0; angle < 3; angle++) target.handlePing(angle, levels(1200));
    vi.advanceTimersByTime(20);
    const before = posted.length;
    const seq = target.sender?.seq;

    target.setPalette('Thermal Blue');
    expect(posted).toHaveLength(before);

    target.setPalette('Ocean');
    target.setPalette('Custom');
    vi.advanceTimersByTime(1000);
    const after = posted.slice(before);
    expect(after.map((message) => message.type)).toEqual([
      'cockpit:setMapMeshPalette',
      'cockpit:setMapMeshPalette',
    ]);
    expect(after[0].id).toBe('ping-viewer-next-ping360-2');
    expect(Array.from(after[0].palette as Uint8Array)).toEqual(
      Array.from(mapPaletteFrom(colorPalettes.Ocean))
    );
    expect(Array.from(after[1].palette as Uint8Array)).toEqual(Array.from(mapPaletteFrom(CUSTOM)));
    expect(target.sender?.seq).toBe(seq);

    target.handlePing(3, levels(1200));
    vi.advanceTimersByTime(20);
    expect(posted.at(-1)).toMatchObject({ type: 'cockpit:setMapMeshQuads', first: 3 });
    target.sender?.replay();
    expect(meshPalette(posted.slice(before))).toEqual(Array.from(mapPaletteFrom(CUSTOM)));
  });
});
