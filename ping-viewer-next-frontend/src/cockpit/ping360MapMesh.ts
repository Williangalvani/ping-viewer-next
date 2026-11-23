// What a Ping360 ping looks like on Cockpit's map: a wedge from the transducer out to the range,
// its bins as indices into a sonar palette.

import { MAX_NUMBER_OF_POINTS } from '@/ping-device/utils/constants';

// ArduPilot's LATLON_TO_M
export const METERS_PER_DEGREE = 111318.84502145034;
export const GRADIANS = 400;
export const DEGREES_PER_GRADIAN = 360 / GRADIANS;
// The head angle facing the vehicle's forward: the arrow on the Ping360's housing, mounted per the
// BlueROV2 guide, with 0 at the cable penetrator, aft, and angles growing clockwise seen from above
export const PING360_FORWARD_GRAD = 200;
// Slots of the map: 210 s of pings at the Ping360's fastest, 50 a second, rounded up to 1024s, so
// every range keeps at least 210 s of scan
export const MAP_CAPACITY = 11264;
// how wide each ping's wedge is on the map, in head steps: wider than a step, so a vehicle turning
// with the head leaves no gaps between them, and still inside the beam
export const WEDGE_STEPS = 1.5;
// left out of the map nearest the transducer, m, where the Ping360 still rings from its ping
export const MAP_BLANK_M = 0.5;
// texels in each strip of the map: every ping's bins fit, whatever its number of samples
export const MAP_STRIP_WIDTH = MAX_NUMBER_OF_POINTS;
// the farthest from the equator Cockpit's map takes a corner, degrees
export const MAX_MAP_LATITUDE = 85.05;

export interface MapPose {
  lat: number;
  lon: number;
  // degrees clockwise from north
  headingDeg: number;
}

export interface PingQuadOptions {
  // gradians the widget adds to the raw head angle for display, so PING360_FORWARD_GRAD of the
  // sum faces the vehicle's forward
  mountOffsetGrad?: number;
  // head-down: the display mirrored left-right, an upside-down head turning the other way
  reversed?: boolean;
  // texels in the strip, at least the number of bins
  stripWidth?: number;
}

export interface PingQuad {
  corners: Float64Array;
  uv: Float32Array;
  texels: Uint8Array;
}

const SONAR_STOPS = [
  [0.0, 0.01, 0.05],
  [0.05, 0.15, 0.6],
  [0.8, 0.42, 0.15],
  [1, 0.85, 0.1],
  [1, 1, 1],
];

// Near black for silence, through deep blue, copper and yellow, to white for the strongest echoes,
// like SonarView, so the scan stands out against bright satellite imagery: RGB 0..1
export const sonarColor = (intensity: number): number[] => {
  const x = Math.min(Math.max(intensity, 0), 1) * (SONAR_STOPS.length - 1);
  const k = Math.min(Math.trunc(x), SONAR_STOPS.length - 2);
  const from = SONAR_STOPS[k];
  const to = SONAR_STOPS[k + 1];
  return from.map((c, i) => c + (x - k) * (to[i] - c));
};

// A color channel 0..1 as a byte
const byte = (c: number): number => Math.min(Math.max(Math.round(c * 255), 0), 255);

// The map texel of a byte of echo strength, 0..255 onto 1..255: 0 is left for no data
export const mapIndex = (level: number): number => 1 + Math.round((level * 254) / 255);

// The map's palette, 256 RGBA entries, straight alpha: 0 transparent, where there is no data, and
// 1..255 black for silence and then sonarColor() for the echo strength mapIndex() gave them. Their
// alpha is their index, so Cockpit's mesh opacity hides silence completely at 0 and shows it solid
// black at 1, and fades the weak echoes with it, while strong returns stay solid.
export const mapPalette = (): Uint8Array => {
  const palette = new Uint8Array(256 * 4);
  for (let index = 1; index < 256; index++) {
    const color = index === 1 ? [0, 0, 0] : sonarColor((index - 1) / 254);
    palette.set([byte(color[0]), byte(color[1]), byte(color[2]), index], index * 4);
  }
  return palette;
};

// Whether a position is one to draw at: a vehicle without a fix reports 0, 0
export const isValidPosition = (lat: unknown, lon: unknown): boolean =>
  typeof lat === 'number' &&
  typeof lon === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= MAX_MAP_LATITUDE &&
  Math.abs(lon) <= 180 &&
  !(lat === 0 && lon === 0);

// Whether Cockpit's map takes every corner of a quad. The wedge starts at the vehicle, inside
// ±180, so a corner past ±180 means it crosses the antimeridian: wrapping that corner would make a
// quad spanning the globe, which Cockpit refuses, so such a quad is left out instead.
export const fitsMap = (corners: ArrayLike<number>): boolean => {
  for (let k = 0; k < corners.length; k += 2) {
    if (Math.abs(corners[k]) > 180 || Math.abs(corners[k + 1]) > MAX_MAP_LATITUDE) return false;
  }
  return true;
};

// [lon, lat] `rangeM` from `pose` at `bearingDeg` clockwise from north, on a flat earth around it
const offset = (pose: MapPose, bearingDeg: number, rangeM: number): number[] => {
  const bearing = (bearingDeg * Math.PI) / 180;
  const north = rangeM * Math.cos(bearing);
  const east = rangeM * Math.sin(bearing);
  return [
    pose.lon + east / (METERS_PER_DEGREE * Math.cos((pose.lat * Math.PI) / 180)),
    pose.lat + north / METERS_PER_DEGREE,
  ];
};

// The map quad of one ping, its bins `levels` at raw head `angleGrad`: a wedge WEDGE_STEPS head
// steps wide from the transducer at `pose`, centered where the widget's display draws that angle
// once `mountOffsetGrad` is added and the display mirrored when `reversed`, PING360_FORWARD_GRAD
// on the vehicle's heading, out to `rangeM`, as corners [O, O, A, B] in lon, lat, uv along
// the strip from 0 at the transducer to the number of bins at the range, so each bin lies over its
// own stretch of range, and the bins as mapIndex() texels, the first MAP_BLANK_M left out as 0. A
// strip `stripWidth` texels wide, as many as the bins unless given, has the bins first and the
// wedge reaches no further; one copy of the last bin follows them, so Cockpit's linear filtering
// blends the wedge's outer edge with that bin rather than with no data, which would darken its
// outer half bin, and 0 the rest.
export const pingQuad = (
  pose: MapPose,
  angleGrad: number,
  angleStepGrad: number,
  rangeM: number,
  levels: ArrayLike<number>,
  { mountOffsetGrad = 0, reversed = false, stripWidth = levels.length }: PingQuadOptions = {}
): PingQuad => {
  const bins = levels.length;
  if (stripWidth < bins) throw new RangeError(`${bins} bins do not fit ${stripWidth} texels`);
  const half = (WEDGE_STEPS * angleStepGrad) / 2;
  const angle = (reversed ? -1 : 1) * (angleGrad + mountOffsetGrad - PING360_FORWARD_GRAD);
  const corners = new Float64Array(8);
  corners.set([pose.lon, pose.lat, pose.lon, pose.lat]);
  corners.set(offset(pose, pose.headingDeg + (angle - half) * DEGREES_PER_GRADIAN, rangeM), 4);
  corners.set(offset(pose, pose.headingDeg + (angle + half) * DEGREES_PER_GRADIAN, rangeM), 6);
  const uv = Float32Array.of(0, 0.5, 0, 0.5, bins, 0.5, bins, 0.5);
  const texels = new Uint8Array(stripWidth);
  const blanked = Math.min(Math.ceil((MAP_BLANK_M / rangeM) * bins), bins);
  for (let b = blanked; b < bins; b++) texels[b] = mapIndex(levels[b]);
  if (stripWidth > bins && bins > 0) texels[bins] = texels[bins - 1];
  return { corners, uv, texels };
};
