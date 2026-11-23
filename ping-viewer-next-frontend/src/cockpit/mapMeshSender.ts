// Sends one mesh of textured quads to the map of the Cockpit embedding this page, with version 1 of
// Cockpit's map mesh commands. It knows nothing of what the quads show, so it can give way to the
// @bluerobotics/cockpit-api helpers once they are released.
//
// 1. cockpit:getMapCapabilities, and nothing else until Cockpit answers. A Cockpit without map
//    meshes never answers, so the query is repeated less and less often. The version, whether
//    Cockpit draws meshes and its limits decide whether this mesh can go.
// 2. cockpit:setMapMesh. Cockpit keeps the quads and head of a mesh set again with the same layout,
//    so a reloaded page carries on where it left off, writing from the head Cockpit answers with.
// 3. cockpit:setMapMeshQuads, batched, each with an explicit first slot. One message every
//    LIVENESS_INTERVAL_MS asks for an answer: if the mesh no longer exists, because something
//    removed it, it is set again and filled from then on. Nothing is replayed: a Cockpit that
//    reloads reloads this page with it, and a mesh something else removed comes back empty.
// cockpit:clearMapMesh only goes when the user clears the map, cockpit:removeMapMesh on dispose().

export const FORMAT_BYTES = { r8: 1, rgba8: 4 } as const;
export type TexelFormat = keyof typeof FORMAT_BYTES;
export const API_VERSION = 1;
export const MAX_QUADS_PER_MESSAGE = 4096;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const CORNER_BYTES = 8 * 8;
export const UV_BYTES = 8 * 4;
export const RESULT_TYPE = 'cockpit:mapMeshResult';
export const CAPABILITIES_TYPE = 'cockpit:mapCapabilities';
export const CAPABILITIES_QUERY = 'cockpit:getMapCapabilities';
export const SET_TYPE = 'cockpit:setMapMesh';
export const QUADS_TYPE = 'cockpit:setMapMeshQuads';
export const CLEAR_TYPE = 'cockpit:clearMapMesh';
export const REMOVE_TYPE = 'cockpit:removeMapMesh';
// how long to wait for an answer to the capabilities query or the set, ms
export const ANSWER_TIMEOUT_MS = 5000;
// how long to wait before asking again a Cockpit that did not answer, ms, the last one repeated
export const RETRY_DELAYS_MS = [5000, 10000, 30000];
// how often, at most, a quads message asks for an answer, ms
export const LIVENESS_INTERVAL_MS = 2000;
// quads requestIds left unanswered beyond which they are forgotten
export const MAX_OUTSTANDING = 256;
// a write is held at most this long, ms, to go out with the next ones
export const FLUSH_INTERVAL_MS = 100;
// Cockpit's answer to a write into a mesh it does not have
const MISSING_MESH = /^Mesh '.*' does not exist\.$/;

export interface MapMeshDefinition {
  id: string;
  name: string;
  capacity: number;
  texels: { format: TexelFormat; width: number; height: number };
  filter: 'nearest' | 'linear';
  // 256 RGBA entries, straight alpha, for r8 texels
  palette?: Uint8Array;
  opacity: number;
}

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
  maxStripBytes?: number;
  formats?: string[];
}

export interface MapMeshReply {
  type?: string;
  requestId?: unknown;
  ok?: boolean;
  error?: string;
  // 'budget' for a setMapMesh past Cockpit's map mesh memory limit, with the bytes below
  code?: string;
  usedBytes?: number;
  previousBytes?: number;
  requestedBytes?: number;
  budgetBytes?: number;
  head?: number;
  meshes?: MapMeshCapabilities;
}

// probing until Cockpit took the mesh, unavailable while it does not answer, unsupported when it
// cannot take this mesh, refused when it would not set it
export type MapMeshState = 'probing' | 'unavailable' | 'unsupported' | 'refused' | 'ready';

export interface MapMeshStatus {
  state: MapMeshState;
  // a word or two for the user
  message: string;
}

interface PendingQuad {
  slot: number;
  corners: Float64Array;
  uv: Float32Array;
  texels: Uint8Array;
}

// requestIds are numbered across senders, so a late answer for a replaced one is not taken for this
let requests = 0;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

const int = (value: unknown, fallback: number): number => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
};

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

// The buffers of the typed arrays in `message`, nested objects included, to transfer with it
const transferables = (message: object): Transferable[] => {
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

// The embedding page's origin, where the browser tells it (Firefox does not), so nothing reaches a
// page the parent frame navigated to since
const ancestor = typeof window === 'undefined' ? undefined : window.location.ancestorOrigins?.[0];
const parentOrigin = ancestor && ancestor !== 'null' ? ancestor : '*';

// Posts to the page embedding this one, its arrays' buffers transferred rather than copied
export const postToParent: MapMeshPost = (message, transfer) => {
  window.parent.postMessage(message, parentOrigin, transfer);
};

// Hands `handler` Cockpit's answers from the embedding page; returns what stops it
export const listenToParent = (handler: (reply: MapMeshReply) => void): (() => void) => {
  const listener = (event: MessageEvent): void => {
    const type = event.data?.type;
    if (event.source !== window.parent) return;
    if (parentOrigin !== '*' && event.origin !== parentOrigin) return;
    if (type === RESULT_TYPE || type === CAPABILITIES_TYPE) handler(event.data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
};

export class MapMeshSender {
  readonly mesh: MapMeshDefinition;
  status: MapMeshStatus = { state: 'probing', message: 'Connecting' };
  onStatus: ((status: MapMeshStatus) => void) | undefined;

  private readonly post: MapMeshPost;
  private readonly stripBytes: number;
  private maxQuadsPerMessage = MAX_QUADS_PER_MESSAGE;
  private maxMessageBytes = MAX_MESSAGE_BYTES;
  // quads written since the mesh was emptied; the next goes in slot seq % capacity
  private seq = 0;
  private pending: PendingQuad[] = [];
  // the command type of each requestId not yet answered
  private outstanding = new Map<string, string>();
  private retries = 0;
  // the answer timeout or the retry after it
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAskedAt = Number.NEGATIVE_INFINITY;
  private lastError = '';
  private defined = false;
  private disposed = false;

  constructor(mesh: MapMeshDefinition, post: MapMeshPost) {
    this.mesh = mesh;
    this.post = post;
    const { format, width, height } = mesh.texels;
    this.stripBytes = width * height * FORMAT_BYTES[format];
  }

  // Asks Cockpit whether it takes the mesh, then sets it
  start(): void {
    this.retries = 0;
    this.setStatus('probing', 'Connecting');
    this.probe();
  }

  // Starts again when Cockpit did not answer, could not take the mesh or refused it
  retry(): void {
    if (this.status.state !== 'ready' && this.status.state !== 'probing') this.start();
  }

  // Empties the mesh, here and in Cockpit, and writes from slot 0 again
  clear(): void {
    if (this.status.state !== 'ready') {
      this.retry();
      return;
    }
    this.cancelFlush();
    this.pending = [];
    this.seq = 0;
    this.send({ type: CLEAR_TYPE, id: this.mesh.id });
  }

  // Queues one quad for the next flush, while Cockpit has the mesh: 8 corner numbers lon, lat in
  // ring order, 8 uv numbers and a strip of texels. The arrays are the sender's from then on.
  writeQuad(corners: Float64Array, uv: Float32Array, texels: Uint8Array): void {
    if (this.status.state !== 'ready') return;
    if (corners.length !== 8 || uv.length !== 8 || texels.length !== this.stripBytes) {
      throw new RangeError(`A quad has 8 corner numbers, 8 uv and ${this.stripBytes} texels`);
    }
    this.pending.push({ slot: this.seq % this.mesh.capacity, corners, uv, texels });
    this.seq += 1;
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  // Takes an answer from Cockpit, true if it was to this mesh's commands
  handleReply(reply: MapMeshReply): boolean {
    const request = String(reply?.requestId ?? '');
    const command = this.outstanding.get(request);
    if (command === undefined) return false;
    this.outstanding.delete(request);
    if (command === CAPABILITIES_QUERY) this.takeCapabilities(reply.meshes);
    else if (command === SET_TYPE) this.takeSet(reply);
    else if (!reply.ok) this.takeRefusedWrite(String(reply.error ?? ''));
    return true;
  }

  // Stops sending and removes the mesh from Cockpit's map, without waiting for an answer
  dispose(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.cancelFlush();
    this.pending = [];
    if (this.defined) this.send({ type: REMOVE_TYPE, id: this.mesh.id });
    this.disposed = true;
  }

  private probe(): void {
    this.handshake({ type: CAPABILITIES_QUERY });
  }

  private define(): void {
    const { palette } = this.mesh;
    this.defined = true;
    this.handshake({ type: SET_TYPE, mesh: { ...this.mesh, palette: palette?.slice() } });
  }

  // Sends a command that has to be answered before anything else goes, forgetting older requests
  private handshake(message: MapMeshMessage): void {
    this.cancelTimer();
    this.cancelFlush();
    this.pending = [];
    this.outstanding.clear();
    this.send(message, true);
    this.timer = setTimeout(() => this.unanswered(), ANSWER_TIMEOUT_MS);
  }

  private unanswered(): void {
    this.setStatus('unavailable', 'Unavailable');
    const delay = RETRY_DELAYS_MS[Math.min(this.retries, RETRY_DELAYS_MS.length - 1)];
    this.retries += 1;
    this.timer = setTimeout(() => this.probe(), delay);
  }

  private takeCapabilities(meshes: MapMeshCapabilities | undefined): void {
    this.cancelTimer();
    const problem = this.unsupported(meshes ?? {});
    if (problem) {
      console.warn(`Cockpit cannot take map mesh ${this.mesh.id}: ${problem}`);
      this.setStatus('unsupported', problem);
      return;
    }
    const most = (value: unknown, limit: number) => clamp(int(value, limit), 1, limit);
    this.maxQuadsPerMessage = most(meshes?.maxQuadsPerMessage, MAX_QUADS_PER_MESSAGE);
    this.maxMessageBytes = most(meshes?.maxMessageBytes, MAX_MESSAGE_BYTES);
    this.define();
  }

  // What keeps Cockpit, by its capabilities, from showing the mesh, in a word or two
  private unsupported(meshes: MapMeshCapabilities): string | undefined {
    const { capacity, texels } = this.mesh;
    if (int(meshes.version, 0) !== API_VERSION) return 'Unsupported';
    if (meshes.drawn === false) return 'Not drawn';
    const fits =
      int(meshes.maxCapacity, 0) >= capacity &&
      int(meshes.maxTexelSide, 0) >= Math.max(texels.width, texels.height) &&
      int(meshes.maxStripBytes, 0) >= this.stripBytes &&
      (meshes.formats ?? []).includes(texels.format);
    return fits ? undefined : 'Too big';
  }

  private takeSet(reply: MapMeshReply): void {
    this.cancelTimer();
    if (!reply.ok) {
      console.warn(this.refusal(reply));
      this.setStatus('refused', reply.code === 'budget' ? 'No room' : 'Refused');
      return;
    }
    // the same layout as before keeps its quads, so carry on after them
    this.seq = clamp(int(reply.head, 0), 0, this.mesh.capacity - 1);
    this.lastError = '';
    this.setStatus('ready', '');
  }

  private takeRefusedWrite(error: string): void {
    if (this.status.state !== 'ready') return;
    if (MISSING_MESH.test(error)) {
      this.setStatus('probing', 'Connecting');
      this.define();
      return;
    }
    if (error === this.lastError) return;
    console.warn(`Cockpit refused quads of map mesh ${this.mesh.id}: ${error}`);
    this.lastError = error;
  }

  // The warning for Cockpit's refusal to set the mesh
  private refusal(reply: MapMeshReply): string {
    if (reply.code !== 'budget') {
      return `Cockpit refused map mesh ${this.mesh.id}: ${reply.error ?? ''}`;
    }
    const needed = mib(int(reply.requestedBytes, 0));
    const others = mib(int(reply.usedBytes, 0) - int(reply.previousBytes, 0));
    const limit = mib(int(reply.budgetBytes, 0));
    const raise = `Raise "Map mesh memory limit" in Cockpit's General settings.`;
    return `Cockpit's map mesh memory limit is too small for map mesh ${this.mesh.id}: it needs ${needed}, and other meshes reserve ${others} of the ${limit} limit. ${raise}`;
  }

  // Sends every queued quad, in as few messages as Cockpit takes
  private flush(): void {
    this.flushTimer = undefined;
    let start = 0;
    for (const count of this.batches()) {
      this.send(this.quadsMessage(start, count));
      start += count;
    }
    this.pending = [];
  }

  // How many queued quads go in each message, in order: consecutive slots, never across the end of
  // the ring, at most maxQuadsPerMessage and maxMessageBytes of arrays
  private batches(): number[] {
    const byBytes = Math.floor(this.maxMessageBytes / (CORNER_BYTES + UV_BYTES + this.stripBytes));
    const most = Math.min(this.maxQuadsPerMessage, Math.max(byBytes, 1));
    const runs: number[] = [];
    let count = 0;
    for (let n = 0; n < this.pending.length; n++) {
      if (count > 0 && (count >= most || this.pending[n].slot !== this.pending[n - 1].slot + 1)) {
        runs.push(count);
        count = 0;
      }
      count += 1;
    }
    if (count > 0) runs.push(count);
    return runs;
  }

  // The cockpit:setMapMeshQuads of `count` queued quads from the `start`th, in arrays of its own
  private quadsMessage(start: number, count: number): MapMeshMessage {
    const strip = this.stripBytes;
    const corners = new Float64Array(count * 8);
    const uv = new Float32Array(count * 8);
    const texels = new Uint8Array(count * strip);
    for (let n = 0; n < count; n++) {
      const quad = this.pending[start + n];
      corners.set(quad.corners, n * 8);
      uv.set(quad.uv, n * 8);
      texels.set(quad.texels, n * strip);
    }
    const first = this.pending[start].slot;
    return { type: QUADS_TYPE, id: this.mesh.id, first, corners, uv, texels };
  }

  // Posts `message`, with a requestId when `ask` or when a quads message is due to ask for one
  private send(message: MapMeshMessage, ask = false): void {
    if (this.disposed) return;
    const now = Date.now();
    const live = message.type === QUADS_TYPE && now - this.lastAskedAt >= LIVENESS_INTERVAL_MS;
    if (ask || live) {
      requests += 1;
      message.requestId = `${this.mesh.id}-${requests}`;
      if (this.outstanding.size >= MAX_OUTSTANDING) this.outstanding.clear();
      this.outstanding.set(message.requestId, message.type);
      this.lastAskedAt = now;
    }
    this.post(message, transferables(message));
  }

  private setStatus(state: MapMeshState, message: string): void {
    this.status = { state, message };
    this.onStatus?.(this.status);
  }

  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private cancelFlush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}
