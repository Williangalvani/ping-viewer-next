// Feeds one Ping360's pings to Cockpit's map as a map mesh, at the vehicle's pose from Cockpit's
// data lake. The mesh is one fixed texture, MAP_STRIP_WIDTH texels by MAP_CAPACITY slots, that
// takes every range and number of samples: Cockpit empties a mesh set with other texels or
// capacity, so a mesh that changed with them would wipe the map. Pings are dropped until Cockpit
// has taken the mesh, and while the range or a valid position is unknown.
// Known limits: the transducer is drawn at the autopilot's position, with no lever arm, and at the
// pose of when the ping reached this page.

import { calculateRange } from '@/ping-device/utils/ping360-utils';
import {
  type MapMeshPost,
  type MapMeshReply,
  MapMeshSender,
  type MapMeshStatus,
} from './mapMeshSender';
import {
  GRADIANS,
  MAP_CAPACITY,
  MAP_STRIP_WIDTH,
  fitsMap,
  isValidPosition,
  mapPalette,
  pingQuad,
} from './ping360MapMesh';

// ATTITUDE/yaw older than this gives way to GLOBAL_POSITION_INT/hdg, ms
export const YAW_STALE_MS = 2000;
// GLOBAL_POSITION_INT/hdg when the autopilot does not know it
export const UNKNOWN_HDG = 65535;
// longest server part of a mesh id, well inside Cockpit's 256 characters
const MAX_SERVER_ID = 200;

export interface Ping360Config {
  sample_period?: number;
  number_of_samples?: number;
  // m/s
  speed_of_sound?: number;
  num_steps?: number;
  mount_offset?: number;
  head_down?: boolean;
}

// The mesh of the Ping360 in `slot` of the ping-viewer-next at `serverUrl`, so two servers embedded
// in one Cockpit do not share one, in the lowercase letters, digits and dashes Cockpit takes
export const ping360MeshId = (serverUrl: string, slot: number): string => {
  const { hostname, port, protocol } = new URL(serverUrl);
  const server = `${hostname}-${port || (protocol === 'https:' ? 443 : 80)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SERVER_ID)
    .replace(/^-+|-+$/g, '');
  return `ping-viewer-next-${server}-ping360-${slot}`;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositive = (value: unknown): value is number => isFiniteNumber(value) && value > 0;

// The gradians the widget adds to the raw head angle for display: Ping360Loader turns the plot by
// mount_offset - 180 degrees, 0 at the default mount offset of 180, the head's arrow forward.
export const ping360MountOffsetGrad = (config: { mount_offset?: number }): number => {
  const mountOffset = isFiniteNumber(config.mount_offset) ? config.mount_offset : 180;
  const grad = ((180 - mountOffset) * GRADIANS) / 360;
  return ((grad % GRADIANS) + GRADIANS) % GRADIANS;
};

export class Ping360MapFeed {
  // false pauses the feed: what is on the map stays, nothing new is written
  enabled = true;
  sender: MapMeshSender | undefined;

  private readonly post: MapMeshPost;
  private readonly onStatus: (status: MapMeshStatus) => void;
  private lat: number | undefined;
  private lon: number | undefined;
  private yawDeg: number | undefined;
  private yawAt = Number.NEGATIVE_INFINITY;
  private hdgDeg: number | undefined;
  private rangeM: number | undefined;
  private stepGrad = 1;
  private speedOfSound: number | undefined;
  private mountOffsetGrad = 0;
  private reversed = false;
  // whether a device config has set the two above yet
  private oriented = false;

  constructor(post: MapMeshPost, onStatus: (status: MapMeshStatus) => void) {
    this.post = post;
    this.onStatus = onStatus;
  }

  // Asks Cockpit to take the mesh of the Ping360 in `slot` of the server at `serverUrl`
  start(serverUrl: string, slot: number): void {
    this.sender?.dispose();
    const sender = new MapMeshSender(
      {
        id: ping360MeshId(serverUrl, slot),
        name: `Ping360 (${new URL(serverUrl).host}, slot ${slot})`,
        capacity: MAP_CAPACITY,
        texels: { format: 'r8', width: MAP_STRIP_WIDTH, height: 1 },
        filter: 'linear',
        palette: mapPalette(),
        opacity: 1,
      },
      this.post
    );
    sender.onStatus = this.onStatus;
    this.sender = sender;
    sender.start();
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
    this.yawAt = Date.now();
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
    const yawFresh = Date.now() - this.yawAt < YAW_STALE_MS;
    const headingDeg = yawFresh ? this.yawDeg : (this.hdgDeg ?? this.yawDeg);
    if (headingDeg === undefined) return undefined;
    return { lat: this.lat as number, lon: this.lon as number, headingDeg };
  }

  handleConfig(config: Ping360Config): void {
    if (isPositive(config.speed_of_sound)) this.speedOfSound = config.speed_of_sound;
    this.rangeM = this.rangeOf(config);
    this.stepGrad = isPositive(config.num_steps) ? config.num_steps : 1;
    // As Ping360Loader turns and mirrors its display from the device config
    const mountOffsetGrad = ping360MountOffsetGrad(config);
    const reversed = config.head_down === true;
    // The scan on the map was drawn for the old mount, so it no longer lines up with the new one.
    // The first config leaves the map as it is, as it may hold a scan from before a reload.
    const turned = mountOffsetGrad !== this.mountOffsetGrad || reversed !== this.reversed;
    if (this.oriented && turned && this.sender?.status.state === 'ready') this.sender.clear();
    this.oriented = true;
    this.mountOffsetGrad = mountOffsetGrad;
    this.reversed = reversed;
  }

  // One ping: the device's raw head angle in gradians, its bins, and the settings its message
  // carries. Those win over the last device config: a range or scan another client sets may never
  // reach this page as a config.
  handlePing(
    angleGrad: number,
    levels: ArrayLike<number>,
    settings: Partial<Ping360Config> = {}
  ): void {
    const sender = this.sender;
    if (!this.enabled || sender?.status.state !== 'ready' || !Number.isFinite(angleGrad)) return;
    const { rangeM, stepGrad } = this.geometryOf(settings);
    if (rangeM === undefined) return;
    const bins = levels?.length ?? 0;
    if (bins < 1 || bins > MAP_STRIP_WIDTH) return;
    const pose = this.pose();
    if (!pose) return;
    const quad = pingQuad(pose, angleGrad, stepGrad, rangeM, levels, {
      mountOffsetGrad: this.mountOffsetGrad,
      reversed: this.reversed,
      stripWidth: MAP_STRIP_WIDTH,
    });
    if (fitsMap(quad.corners)) sender.writeQuad(quad.corners, quad.uv, quad.texels);
  }

  handleReply(reply: MapMeshReply): boolean {
    return this.sender?.handleReply(reply) ?? false;
  }

  // Asks Cockpit again when it did not answer, could not take the mesh or refused it
  retry(): void {
    this.sender?.retry();
  }

  // Empties the map; it fills again from the next ping
  clear(): void {
    this.sender?.clear();
  }

  // Stops sending and removes the mesh from Cockpit's map
  dispose(): void {
    this.sender?.dispose();
    this.sender = undefined;
  }

  // The range, m, of a sample period and number of samples, or undefined without both
  private rangeOf({ sample_period, number_of_samples, speed_of_sound }: Ping360Config) {
    if (!isPositive(sample_period) || !isPositive(number_of_samples)) return undefined;
    const speed = isPositive(speed_of_sound) ? speed_of_sound : this.speedOfSound;
    const range = calculateRange({ sample_period, number_of_samples, speed_of_sound: speed });
    return isPositive(range) ? range : undefined;
  }

  // The range and head step of a ping: its message's when it carries a range, num_steps too when
  // it has one, and the last device config's otherwise
  private geometryOf(settings: Partial<Ping360Config>): {
    rangeM: number | undefined;
    stepGrad: number;
  } {
    const rangeM = this.rangeOf(settings);
    if (rangeM === undefined) return { rangeM: this.rangeM, stepGrad: this.stepGrad };
    const stepGrad = isPositive(settings.num_steps) ? settings.num_steps : this.stepGrad;
    return { rangeM, stepGrad };
  }
}
