// Sends one mesh of textured quads to Cockpit's maps through its map mesh commands. It knows nothing
// of what the quads show: a sonar's pings, a grid or an image are all quads with lon/lat corners, uv
// and a strip of texels each. A port of BlueSim's cockpit_map_mesh.gd, kept free of Vue and of
// ping-viewer so it can move into @bluerobotics/cockpit-api as it is.
//
// Message flow, every message an object with a "type", from the sender to Cockpit:
//   1. cockpit:setMapMesh {mesh: {id, name, capacity, texels: {format, width, height}, filter,
//      palette, opacity}} creates the mesh. Sent again with the same capacity and texels it keeps
//      the quads and only changes name, filter, palette and opacity; with others Cockpit drops the
//      mesh and makes it afresh.
//   2. cockpit:clearMapMesh {id} empties every slot: the sender's ring restarted, so must Cockpit's.
//   3. cockpit:setMapMeshQuads {id, first, corners, uv, texels, tint?} for every batch of quads, at
//      most 60 a second: corners are 8 float64 per quad (lon, lat of 4 corners in ring order), uv 8
//      float32 per quad in texels of the quad's own strip (texel centres at +0.5), texels
//      width * height * bytes per texel per quad, tint 4 RGBA bytes per quad. Each message writes
//      consecutive slots first .. first + n - 1, at most MAX_QUADS_PER_MESSAGE quads and
//      MAX_MESSAGE_BYTES of arrays, never across the end of the ring. Without first Cockpit writes
//      after its previous write, wrapping at capacity, but a Cockpit that joins late only converges
//      on explicit slots, so they are sent unless explicitFirst is false.
//   4. cockpit:removeMapMeshQuads {id, first, count} empties slots; cockpit:setMapMeshPalette {id,
//      palette} recolours an r8 mesh; cockpit:removeMapMesh {id} removes the mesh.
//   Cockpit keeps meshes in memory only, so a Cockpit that connects later (or lost the mesh) gets
//   replay(): steps 1 and 2, then every slot this side wrote, oldest first.
// The arrays go as typed arrays (Float64Array, Float32Array, Uint8Array) through postMessage with
// their buffers transferred. Every message gets arrays of its own, so transferring them never
// detaches what the sender keeps.
//
// Answers, from Cockpit to the sender, to the window the command came from, in the order the
// commands were sent. create() and replay() first send
//   0. cockpit:getMapCapabilities {requestId}, answered with cockpit:mapCapabilities {requestId,
//      meshes: {version, drawn, maxCapacity, maxQuadsPerMessage, maxMessageBytes, maxTexelSide,
//      formats}}: a version other than API_VERSION stops the quads, the limits are followed, and
//      drawn is false where Cockpit keeps meshes but cannot show them (no WebGL2). No answer means a
//      Cockpit without meshes, which ignores every one of these commands.
// A command with a requestId is answered with cockpit:mapMeshResult {requestId, id, ok, error?,
// capacity?, head?, first?, count?}, capacity and head only while the mesh exists. Every command
// but the quads, which go many times a second, carries one, and so does one quads message every
// livenessIntervalMs, so a Cockpit that lost the mesh is noticed and given replay().
// handleReply() takes both answers.

export const FORMAT_BYTES = { r8: 1, rgba8: 4 } as const;
export type TexelFormat = keyof typeof FORMAT_BYTES;
export const MAX_CAPACITY = 1 << 20;
export const MAX_QUADS_PER_MESSAGE = 4096;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_STRIP_SIDE = 2048;
export const PALETTE_BYTES = 256 * 4;
export const CORNER_BYTES = 8 * 8;
export const UV_BYTES = 8 * 4;
export const TINT_BYTES = 4;
export const API_VERSION = 1;
export const RESULT_TYPE = 'cockpit:mapMeshResult';
export const CAPABILITIES_TYPE = 'cockpit:mapCapabilities';
export const QUADS_TYPE = 'cockpit:setMapMeshQuads';
export const SET_TYPE = 'cockpit:setMapMesh';
export const CLEAR_TYPE = 'cockpit:clearMapMesh';
export const REMOVE_TYPE = 'cockpit:removeMapMesh';
export const REMOVE_QUADS_TYPE = 'cockpit:removeMapMeshQuads';
export const PALETTE_TYPE = 'cockpit:setMapMeshPalette';
export const CAPABILITIES_QUERY = 'cockpit:getMapCapabilities';
// requestIds waiting for an answer, beyond which an old Cockpit that never answers is assumed
export const MAX_OUTSTANDING = 256;
// how often, at most, a quads message asks for an answer, ms
export const LIVENESS_INTERVAL_MS = 2000;
const WHITE = [255, 255, 255, 255];

export interface MapMeshMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export type MapMeshPost = (message: MapMeshMessage, transfer: Transferable[]) => void;

export interface MapMeshCapabilities {
  version?: number;
  drawn?: boolean;
  maxCapacity?: number;
  maxQuadsPerMessage?: number;
  maxMessageBytes?: number;
  maxTexelSide?: number;
  formats?: string[];
}

export interface MapMeshReply {
  type?: string;
  requestId?: unknown;
  ok?: boolean;
  error?: string;
  capacity?: number;
  head?: number;
  meshes?: MapMeshCapabilities;
  [key: string]: unknown;
}

interface PendingQuad {
  slot: number;
  corners: Float64Array;
  uv: Float32Array;
  texels: Uint8Array;
  tint: Uint8Array;
}

// requestIds are numbered across meshes, so a late answer for a replaced one is not taken for this
let requests = 0;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

const int = (value: unknown, fallback: number): number => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
};

const isWhite = (tint: ArrayLike<number>): boolean => WHITE.every((value, k) => tint[k] === value);

// A typed array of `source`'s numbers by its constructor: Ctor.from() copies a typed array tens of
// times slower in Chrome, too slow for a 1200 texel quad many times a second
const copy = <T>(Ctor: new (source: ArrayLike<number>) => T, source: ArrayLike<number>): T =>
  new Ctor(source);

// The buffers of the typed arrays in `message`, nested objects included, to transfer with it
export const transferables = (message: object): Transferable[] => {
  const buffers: Transferable[] = [];
  for (const value of Object.values(message)) {
    if (ArrayBuffer.isView(value)) {
      buffers.push(value.buffer as ArrayBuffer);
    } else if (value && typeof value === 'object') {
      buffers.push(...transferables(value));
    }
  }
  return buffers;
};

// Posts to the page embedding this one, its arrays' buffers transferred rather than copied
export const postToParent: MapMeshPost = (message, transfer) => {
  window.parent.postMessage(message, '*', transfer);
};

// Hands `handler` Cockpit's answers from the embedding page; returns what stops it
export const listenToParent = (handler: (reply: MapMeshReply) => void): (() => void) => {
  const listener = (event: MessageEvent): void => {
    const type = event.data?.type;
    if (event.source === window.parent && (type === RESULT_TYPE || type === CAPABILITIES_TYPE)) {
      handler(event.data);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
};

export class MapMeshSender {
  readonly id: string;
  name: string;
  readonly capacity: number;
  readonly format: TexelFormat;
  readonly width: number;
  readonly height: number;
  filter: 'nearest' | 'linear' = 'linear';
  // 256 RGBA entries, straight alpha, for r8 texels; empty for Cockpit's grey ramp
  palette: Uint8Array = new Uint8Array(0);
  opacity = 1;
  // sends `first` with every write, so a Cockpit that joined late converges
  explicitFirst = true;
  // keeps every slot's last write for replay()
  keepHistory = true;
  // a write is held at most this long, ms, to go out with the next ones
  flushIntervalMs = 1000 / 60;
  maxQuadsPerMessage = MAX_QUADS_PER_MESSAGE;
  maxMessageBytes = MAX_MESSAGE_BYTES;
  askCapabilities = true;
  // gives every command but the quads a requestId, or the quads too
  askResults = true;
  askQuadResults = false;
  // a quads message asks for an answer once this long, ms, has passed without one asked; 0 never
  livenessIntervalMs = LIVENESS_INTERVAL_MS;
  post: MapMeshPost | undefined;
  now: () => number = () => Date.now();
  // quads written to the ring since the mesh was last emptied; the next goes in slot seq % capacity
  seq = 0;
  // what Cockpit said it can do, from cockpit:mapCapabilities
  capabilities: MapMeshCapabilities = {};
  // false once Cockpit has said it takes no mesh like this one: quads are then kept but not sent
  supported = true;
  // whether Cockpit shows the mesh, as far as it said
  drawn = true;
  // the slot Cockpit's next write without `first` goes in, from its last answer, -1 before one
  head = -1;
  messages = 0;
  quadsSent = 0;
  replays = 0;
  results = 0;
  errors = 0;
  lastError = '';

  private readonly stripBytesValue: number;
  private pending: PendingQuad[] = [];
  private tinted = false;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private lastAskedAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  // the last write of each slot, and the order it was written in, -1 for an empty slot
  private historyCorners = new Float64Array(0);
  private historyUv = new Float32Array(0);
  private historyTexels = new Uint8Array(0);
  private historyTints = new Uint8Array(0);
  private historyOrder = new Float64Array(0);
  private order = 0;
  private written = 0;
  // the type of each command sent with a requestId and not yet answered
  private outstanding = new Map<string, string>();

  constructor(
    id: string,
    name: string,
    capacity: number,
    format: TexelFormat,
    width: number,
    height = 1,
    post?: MapMeshPost
  ) {
    if (!(format in FORMAT_BYTES)) throw new RangeError(`Unknown texel format ${format}`);
    this.id = id;
    this.name = name;
    this.capacity = clamp(Math.trunc(capacity), 1, MAX_CAPACITY);
    this.format = format;
    this.width = clamp(Math.trunc(width), 1, MAX_STRIP_SIDE);
    this.height = clamp(Math.trunc(height), 1, MAX_STRIP_SIDE);
    this.stripBytesValue = this.width * this.height * FORMAT_BYTES[format];
    this.post = post;
    this.resetHistory();
  }

  // Bytes of one quad's strip of texels
  stripBytes(): number {
    return this.stripBytesValue;
  }

  // The mesh as cockpit:setMapMesh carries it
  definition(): Record<string, unknown> {
    const mesh: Record<string, unknown> = {
      id: this.id,
      name: this.name,
      capacity: this.capacity,
      texels: { format: this.format, width: this.width, height: this.height },
      filter: this.filter,
      opacity: this.opacity,
    };
    if (this.format === 'r8' && this.palette.length === PALETTE_BYTES) {
      mesh.palette = this.palette.slice();
    }
    return mesh;
  }

  // Has Cockpit make the mesh, empty, and starts the ring again from slot 0
  create(): void {
    this.dropPending();
    this.resetHistory();
    this.seq = 0;
    this.announce();
  }

  // Empties the mesh, here and in Cockpit, and starts the ring again from slot 0
  clear(): void {
    this.dropPending();
    this.resetHistory();
    this.seq = 0;
    this.send({ type: CLEAR_TYPE, id: this.id });
  }

  remove(): void {
    this.dropPending();
    this.send({ type: REMOVE_TYPE, id: this.id });
  }

  setPalette(colours: ArrayLike<number>): void {
    if (colours.length !== PALETTE_BYTES) throw new RangeError('A palette has 256 RGBA entries');
    this.palette = Uint8Array.from(colours);
    this.send({ type: PALETTE_TYPE, id: this.id, palette: this.palette.slice() });
  }

  // Queues one quad for the next flush: 8 corner numbers lon, lat in ring order, 8 uv numbers and
  // stripBytes() texels, with an optional RGBA tint. It goes in the ring's next slot, or in `slot`
  // for a sender keying slots itself, and the slot is returned.
  writeQuad(
    corners: ArrayLike<number>,
    uv: ArrayLike<number>,
    texels: ArrayLike<number>,
    tint?: ArrayLike<number>,
    slot = -1
  ): number {
    if (corners.length !== 8 || uv.length !== 8 || texels.length !== this.stripBytesValue) {
      throw new RangeError(`A quad has 8 corner numbers, 8 uv and ${this.stripBytesValue} texels`);
    }
    let at = slot;
    if (at < 0) {
      at = this.seq % this.capacity;
      this.seq += 1;
    }
    if (at >= this.capacity) throw new RangeError(`Slot ${at} beyond capacity ${this.capacity}`);
    const colour = copy(Uint8Array, tint?.length === TINT_BYTES ? tint : WHITE);
    this.tinted = this.tinted || !isWhite(colour);
    const quad: PendingQuad = {
      slot: at,
      corners: copy(Float64Array, corners),
      uv: copy(Float32Array, uv),
      texels: copy(Uint8Array, texels),
      tint: colour,
    };
    this.pending.push(quad);
    if (this.keepHistory) this.remember(quad);
    this.schedule();
    return at;
  }

  // Empties `count` slots from `first`, after sending what is queued
  removeQuads(first: number, count: number): void {
    this.flush();
    const from = clamp(Math.trunc(first), 0, this.capacity - 1);
    const n = clamp(Math.trunc(count), 1, this.capacity - from);
    for (let slot = from; slot < from + n; slot++) {
      if (this.historyOrder.length && this.historyOrder[slot] >= 0) {
        this.historyOrder[slot] = -1;
        this.written -= 1;
      }
    }
    this.send({ type: REMOVE_QUADS_TYPE, id: this.id, first: from, count: n });
  }

  // Sends every queued quad now, in as few messages as Cockpit takes
  flush(): void {
    this.cancelTimer();
    this.lastFlushAt = this.now();
    if (!this.supported) {
      this.dropPending();
      return;
    }
    const slots = this.pending.map((quad) => quad.slot);
    let start = 0;
    for (const run of this.batches(slots, this.stripBytesValue + (this.tinted ? TINT_BYTES : 0))) {
      this.send(this.quadsMessage(start, run));
      start += run;
    }
    this.dropPending();
  }

  // How many quads go in each message, in order, for quads in `slots`: consecutive slots, at most
  // maxQuadsPerMessage and maxMessageBytes of arrays at `quadBytes` of texels and tint each
  batches(slots: ArrayLike<number>, quadBytes: number): number[] {
    const byBytes = Math.max(
      Math.floor(this.maxMessageBytes / (CORNER_BYTES + UV_BYTES + quadBytes)),
      1
    );
    const most = Math.min(this.maxQuadsPerMessage, byBytes);
    const runs: number[] = [];
    let count = 0;
    for (let n = 0; n < slots.length; n++) {
      if (count > 0 && (count >= most || slots[n] !== slots[n - 1] + 1)) {
        runs.push(count);
        count = 0;
      }
      count += 1;
    }
    if (count > 0) runs.push(count);
    return runs;
  }

  // Sends the mesh afresh, as to a Cockpit that has none of it: made and emptied, then every slot
  // written since the last create() or clear(), oldest first
  replay(): void {
    this.replays += 1;
    this.dropPending();
    this.announce();
    const order: number[] = [];
    for (let slot = 0; slot < this.historyOrder.length; slot++) {
      if (this.historyOrder[slot] >= 0) order.push(slot);
    }
    order.sort((a, b) => this.historyOrder[a] - this.historyOrder[b]);
    const strip = this.stripBytesValue;
    for (const slot of order) {
      const tint = this.historyTints.subarray(slot * TINT_BYTES, (slot + 1) * TINT_BYTES);
      this.pending.push({
        slot,
        corners: this.historyCorners.subarray(slot * 8, slot * 8 + 8),
        uv: this.historyUv.subarray(slot * 8, slot * 8 + 8),
        texels: this.historyTexels.subarray(slot * strip, (slot + 1) * strip),
        tint,
      });
      this.tinted = this.tinted || !isWhite(tint);
    }
    this.flush();
  }

  requestCapabilities(): void {
    this.send({ type: CAPABILITIES_QUERY });
  }

  // Takes an answer from Cockpit, true if it was to this mesh's commands
  handleReply(message: MapMeshReply): boolean {
    const request = String(message?.requestId ?? '');
    const command = this.outstanding.get(request);
    if (command === undefined) return false;
    this.outstanding.delete(request);
    if (message.type === CAPABILITIES_TYPE) {
      this.takeCapabilities(message.meshes);
      return true;
    }
    if (message.type !== RESULT_TYPE) return true;
    this.results += 1;
    if ('head' in message) this.head = int(message.head, this.head);
    if (message.ok) return true;
    this.errors += 1;
    this.lastError = String(message.error ?? '');
    console.warn(`Cockpit refused ${command} of map mesh ${this.id}: ${this.lastError}`);
    if (command === SET_TYPE) {
      // replaying would only be refused again
      this.supported = false;
    } else if (this.supported && command !== REMOVE_TYPE && !('capacity' in message)) {
      // Cockpit has no such mesh: it reloaded, or something removed it
      this.replay();
    }
    return true;
  }

  // Stops sending: drops what is queued and posts nothing more
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.dropPending();
  }

  stats(): Record<string, unknown> {
    return {
      id: this.id,
      capacity: this.capacity,
      seq: this.seq,
      slotsWritten: this.written,
      pending: this.pending.length,
      messages: this.messages,
      quadsSent: this.quadsSent,
      replays: this.replays,
      supported: this.supported,
      drawn: this.drawn,
      head: this.head,
      results: this.results,
      errors: this.errors,
      lastError: this.lastError,
      capabilities: this.capabilities,
    };
  }

  // The cockpit:setMapMeshQuads of the `count` queued quads from the `start`th, in arrays of its own
  private quadsMessage(start: number, count: number): MapMeshMessage {
    const strip = this.stripBytesValue;
    const corners = new Float64Array(count * 8);
    const uv = new Float32Array(count * 8);
    const texels = new Uint8Array(count * strip);
    const tint = this.tinted ? new Uint8Array(count * TINT_BYTES) : undefined;
    for (let n = 0; n < count; n++) {
      const quad = this.pending[start + n];
      corners.set(quad.corners, n * 8);
      uv.set(quad.uv, n * 8);
      texels.set(quad.texels, n * strip);
      tint?.set(quad.tint, n * TINT_BYTES);
    }
    const message: MapMeshMessage = { type: QUADS_TYPE, id: this.id };
    if (this.explicitFirst) message.first = this.pending[start].slot;
    message.corners = corners;
    message.uv = uv;
    message.texels = texels;
    if (tint) message.tint = tint;
    return message;
  }

  private send(message: MapMeshMessage): void {
    if (this.disposed) return;
    const now = this.now();
    const quads = message.type === QUADS_TYPE;
    const live =
      quads &&
      this.askResults &&
      this.livenessIntervalMs > 0 &&
      now - this.lastAskedAt >= this.livenessIntervalMs;
    const ask = quads ? this.askQuadResults || live : this.askResults;
    if (message.type === CAPABILITIES_QUERY || ask) {
      requests += 1;
      message.requestId = `${this.id}-${requests}`;
      if (this.outstanding.size >= MAX_OUTSTANDING) this.outstanding.clear();
      this.outstanding.set(message.requestId, message.type);
      this.lastAskedAt = now;
    }
    this.messages += 1;
    if (quads) this.quadsSent += (message.corners as Float64Array).length / 8;
    this.post?.(message, transferables(message));
  }

  // What a Cockpit with none of the mesh needs first: whether it takes meshes, then the mesh, empty
  private announce(): void {
    if (this.askCapabilities) this.requestCapabilities();
    this.send({ type: SET_TYPE, mesh: this.definition() });
    this.send({ type: CLEAR_TYPE, id: this.id });
  }

  private takeCapabilities(meshes: MapMeshCapabilities | undefined): void {
    if (!meshes || typeof meshes !== 'object') return;
    this.capabilities = meshes;
    if (int(meshes.version, 0) !== API_VERSION) {
      console.warn(`Cockpit's map meshes are version ${meshes.version}, not ${API_VERSION}`);
      this.supported = false;
      return;
    }
    this.drawn = Boolean(meshes.drawn ?? true);
    if (!this.drawn) {
      console.warn(`Cockpit keeps map mesh ${this.id} but cannot draw it (no WebGL2)`);
    }
    this.maxQuadsPerMessage = clamp(
      int(meshes.maxQuadsPerMessage, MAX_QUADS_PER_MESSAGE),
      1,
      MAX_QUADS_PER_MESSAGE
    );
    this.maxMessageBytes = clamp(
      int(meshes.maxMessageBytes, MAX_MESSAGE_BYTES),
      1,
      MAX_MESSAGE_BYTES
    );
    const tooBig =
      int(meshes.maxCapacity, this.capacity) < this.capacity ||
      int(meshes.maxTexelSide, MAX_STRIP_SIDE) < Math.max(this.width, this.height) ||
      !(meshes.formats ?? [this.format]).includes(this.format);
    if (tooBig) {
      console.warn(`Cockpit takes no map mesh like ${this.id}`);
      this.supported = false;
    }
  }

  private remember(quad: PendingQuad): void {
    const { slot } = quad;
    if (this.historyOrder[slot] < 0) this.written += 1;
    this.historyOrder[slot] = this.order;
    this.order += 1;
    this.historyCorners.set(quad.corners, slot * 8);
    this.historyUv.set(quad.uv, slot * 8);
    this.historyTexels.set(quad.texels, slot * this.stripBytesValue);
    this.historyTints.set(quad.tint, slot * TINT_BYTES);
  }

  private resetHistory(): void {
    this.written = 0;
    this.order = 0;
    if (!this.keepHistory) {
      this.historyOrder = new Float64Array(0);
      return;
    }
    if (this.historyOrder.length !== this.capacity) {
      this.historyCorners = new Float64Array(this.capacity * 8);
      this.historyUv = new Float32Array(this.capacity * 8);
      this.historyTexels = new Uint8Array(this.capacity * this.stripBytesValue);
      this.historyTints = new Uint8Array(this.capacity * TINT_BYTES);
      this.historyOrder = new Float64Array(this.capacity);
    }
    this.historyOrder.fill(-1);
  }

  // Holds a write at most flushIntervalMs since the last flush, to go out with the next ones
  private schedule(): void {
    if (this.timer !== undefined || this.disposed) return;
    const wait = Math.max(0, this.lastFlushAt + this.flushIntervalMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private dropPending(): void {
    this.pending = [];
    this.tinted = false;
  }
}
