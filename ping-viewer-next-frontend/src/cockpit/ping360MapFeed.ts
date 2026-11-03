// Feeds one Ping360's pings to Cockpit's map as a map mesh, at the vehicle's pose from Cockpit's
// data lake. The mesh is one fixed texture, MAP_STRIP_WIDTH texels by MAP_CAPACITY slots, that
// takes every range and number of samples: Cockpit makes a mesh set with other texels or capacity
// afresh, empty, so a mesh that changed with them would wipe the map. Nothing reaches Cockpit
// until a ping comes with both a known range, from its own message or the device config, and a
// valid position, so a vehicle without a fix never makes an empty mesh.

import { paletteGradient } from '@/components/widgets/colorPalettes';
import { type MapMeshPost, type MapMeshReply, MapMeshSender } from './mapMeshSender';
import {
  GRADIANS,
  MAP_CAPACITY,
  MAP_STRIP_WIDTH,
  PING360_FORWARD_GRAD,
  type Ping360RangeConfig,
  SOUND_SPEED,
  isValidPosition,
  mapPalette,
  mapPaletteFrom,
  ping360Range,
  pingQuad,
} from './ping360MapMesh';

// ATTITUDE/yaw older than this gives way to GLOBAL_POSITION_INT/hdg, ms
export const YAW_STALE_MS = 2000;
// GLOBAL_POSITION_INT/hdg when the autopilot does not know it
export const UNKNOWN_HDG = 65535;

export interface Ping360Config extends Ping360RangeConfig {
  num_steps?: number;
  start_angle?: number;
  stop_angle?: number;
}

export interface Ping360MapFeedOptions {
  slot: number;
  post?: MapMeshPost;
  now?: () => number;
  speedOfSound?: number;
  blankM?: number;
  mountOffsetGrad?: number;
  reversed?: boolean;
  // the name of the widget's colour palette
  palette?: string;
}

export const ping360MeshId = (slot: number): string => `ping-viewer-next-ping360-${slot}`;

// The map palette of the widget's colour palette `name`, or BlueSim's mapPalette() without one
export const ping360MapPalette = (name?: string): Uint8Array => {
  const gradient = paletteGradient(name);
  return gradient ? mapPaletteFrom(gradient) : mapPalette();
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, k) => value === b[k]);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositive = (value: unknown): value is number => isFiniteNumber(value) && value > 0;

const hasAngles = ({ start_angle, stop_angle }: Partial<Ping360Config>): boolean =>
  isFiniteNumber(start_angle) && isFiniteNumber(stop_angle);

// The gradians Ping360Loader adds to the raw head angle for display, from the device's scan: the
// middle of the scan, half a turn from start_angle on a full circle, goes to PING360_FORWARD_GRAD.
// 0 without both angles.
export const ping360MountOffsetGrad = (config: {
  start_angle?: number;
  stop_angle?: number;
}): number => {
  const { start_angle, stop_angle } = config;
  if (!isFiniteNumber(start_angle) || !isFiniteNumber(stop_angle)) return 0;
  const wrap = (grad: number): number => ((grad % GRADIANS) + GRADIANS) % GRADIANS;
  const isFullCircle = (stop_angle + 1) % GRADIANS === start_angle % GRADIANS;
  const centreGrad = isFullCircle
    ? (start_angle + GRADIANS / 2) % GRADIANS
    : (start_angle + wrap(stop_angle - start_angle) / 2) % GRADIANS;
  return wrap(PING360_FORWARD_GRAD - centreGrad);
};

export class Ping360MapFeed {
  slot: number;
  post: MapMeshPost | undefined;
  now: () => number;
  speedOfSound: number;
  blankM: number | undefined;
  mountOffsetGrad: number;
  reversed: boolean;
  palette: Uint8Array;
  // false pauses the feed: what is on the map stays, nothing new is written
  enabled = true;
  sender: MapMeshSender | undefined;

  private lat: number | undefined;
  private lon: number | undefined;
  private yawDeg: number | undefined;
  private yawAt = Number.NEGATIVE_INFINITY;
  private hdgDeg: number | undefined;
  private rangeM: number | undefined;
  private stepGrad = 1;

  constructor(options: Ping360MapFeedOptions) {
    this.slot = options.slot;
    this.post = options.post;
    this.now = options.now ?? (() => Date.now());
    this.speedOfSound = options.speedOfSound ?? SOUND_SPEED;
    this.blankM = options.blankM;
    this.mountOffsetGrad = options.mountOffsetGrad ?? 0;
    this.reversed = options.reversed ?? false;
    this.palette = ping360MapPalette(options.palette);
  }

  // Recolours the map with the widget's colour palette `name`: only the palette goes to Cockpit,
  // the mesh and its pings stay
  setPalette(name?: string): void {
    const palette = ping360MapPalette(name);
    if (sameBytes(palette, this.palette)) return;
    this.palette = palette;
    this.sender?.setPalette(palette);
  }

  setLatitudeE7(value: unknown): void {
    this.lat = typeof value === 'number' ? value / 1e7 : undefined;
  }

  setLongitudeE7(value: unknown): void {
    this.lon = typeof value === 'number' ? value / 1e7 : undefined;
  }

  setYawRadians(value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.yawDeg = (value * 180) / Math.PI;
    this.yawAt = this.now();
  }

  setHdgCentidegrees(value: unknown): void {
    const valid = typeof value === 'number' && Number.isFinite(value) && value !== UNKNOWN_HDG;
    this.hdgDeg = valid ? value / 100 : undefined;
  }

  // Forgets the pose, as when the vehicle it came from is no longer the one followed
  resetPose(): void {
    this.lat = undefined;
    this.lon = undefined;
    this.yawDeg = undefined;
    this.yawAt = Number.NEGATIVE_INFINITY;
    this.hdgDeg = undefined;
  }

  // Where the transducer is and which way the vehicle heads, or undefined while either is unknown
  pose(): { lat: number; lon: number; headingDeg: number } | undefined {
    if (!isValidPosition(this.lat, this.lon)) return undefined;
    const yawFresh = this.now() - this.yawAt < YAW_STALE_MS;
    const headingDeg = yawFresh ? this.yawDeg : (this.hdgDeg ?? this.yawDeg);
    if (headingDeg === undefined) return undefined;
    return { lat: this.lat as number, lon: this.lon as number, headingDeg };
  }

  handleConfig(config: Ping360Config): void {
    const range = ping360Range(config, this.speedOfSound);
    this.rangeM = isPositive(range) ? range : undefined;
    this.stepGrad = config.num_steps && config.num_steps > 0 ? config.num_steps : 1;
    if (hasAngles(config)) this.mountOffsetGrad = ping360MountOffsetGrad(config);
  }

  // One ping: the device's raw head angle in gradians, its bins, and the settings its message
  // carries. Those win over the last device config: a range or scan another client sets may never
  // reach this page as a config.
  handlePing(
    angleGrad: number,
    levels: ArrayLike<number>,
    settings: Partial<Ping360Config> = {}
  ): void {
    if (!this.enabled || !Number.isFinite(angleGrad)) return;
    const { rangeM, stepGrad } = this.geometryOf(settings);
    if (rangeM === undefined) return;
    const bins = levels?.length ?? 0;
    if (bins < 1 || bins > MAP_STRIP_WIDTH) return;
    const pose = this.pose();
    if (!pose) return;
    const sender = this.mesh();
    const quad = pingQuad(pose, angleGrad, stepGrad, rangeM, levels, {
      blankM: this.blankM,
      mountOffsetGrad: hasAngles(settings)
        ? ping360MountOffsetGrad(settings)
        : this.mountOffsetGrad,
      reversed: this.reversed,
      stripWidth: MAP_STRIP_WIDTH,
    });
    sender.writeQuad(quad.corners, quad.uv, quad.texels);
  }

  handleReply(reply: MapMeshReply): boolean {
    return this.sender?.handleReply(reply) ?? false;
  }

  // Empties the map; it fills again from the next ping
  clear(): void {
    this.sender?.clear();
  }

  // Stops sending, leaving the mesh on Cockpit's map
  dispose(): void {
    this.sender?.dispose();
    this.sender = undefined;
  }

  // The range and head step of a ping: its message's when it carries a range, num_steps too when
  // it has one, and the last device config's otherwise
  private geometryOf({ sample_period, number_of_samples, num_steps }: Partial<Ping360Config>): {
    rangeM: number | undefined;
    stepGrad: number;
  } {
    const configured = { rangeM: this.rangeM, stepGrad: this.stepGrad };
    if (!isPositive(sample_period) || !isPositive(number_of_samples)) return configured;
    const rangeM = ping360Range({ sample_period, number_of_samples }, this.speedOfSound);
    if (!isPositive(rangeM)) return configured;
    return { rangeM, stepGrad: isPositive(num_steps) ? num_steps : this.stepGrad };
  }

  // The mesh, made on the first ping there is to draw and kept for every one after it
  private mesh(): MapMeshSender {
    if (this.sender) return this.sender;
    const sender = new MapMeshSender(
      ping360MeshId(this.slot),
      `Ping360 (slot ${this.slot})`,
      MAP_CAPACITY,
      'r8',
      MAP_STRIP_WIDTH,
      1,
      this.post
    );
    sender.filter = 'linear';
    sender.opacity = 1;
    sender.palette = this.palette;
    sender.now = this.now;
    this.sender = sender;
    sender.create();
    return sender;
  }
}
