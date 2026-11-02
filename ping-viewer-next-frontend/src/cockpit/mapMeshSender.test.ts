import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/bluesim.json';
import {
  MAX_MESSAGE_BYTES,
  type MapMeshMessage,
  MapMeshSender,
  PALETTE_BYTES,
  postToParent,
} from './mapMeshSender';

const ID = 'test-mesh';
const palette = (): Uint8Array => Uint8Array.from(fixture.palette);

interface Posted {
  message: MapMeshMessage;
  transfer: Transferable[];
}

// A mesh posting into `posted`, which asks Cockpit nothing unless `asking`
const mesh = (capacity: number, posted: Posted[], asking = false, width = 3): MapMeshSender => {
  const sender = new MapMeshSender(ID, 'Test', capacity, 'r8', width, 1, (message, transfer) =>
    posted.push({ message, transfer })
  );
  sender.askCapabilities = asking;
  sender.askResults = asking;
  return sender;
};

// The quads of make_fixtures.gd: a unit square n east, its texels n, n + 1, n + 2 unless given
const write = (sender: MapMeshSender, n: number, texels = [n, n + 1, n + 2]): number =>
  sender.writeQuad([n, 0, n, 1, n + 1, 1, n + 1, 0], [0, 0.5, 0, 0.5, 3, 0.5, 3, 0.5], texels);

const range = (count: number): number[] => Array.from({ length: count }, (_, n) => n);

// The message as JSON would hold it, typed arrays as plain ones
const plain = (value: unknown): unknown => {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
};

const types = (posted: Posted[]): string[] => posted.map(({ message }) => message.type);

// What Cockpit answers to a command of `posted`
const result = (posted: Posted, outcome: Record<string, unknown>) => ({
  type: 'cockpit:mapMeshResult',
  requestId: posted.message.requestId,
  id: ID,
  ...outcome,
});

const capabilities = (posted: Posted, meshes: Record<string, unknown>) => ({
  type: 'cockpit:mapCapabilities',
  requestId: posted.message.requestId,
  meshes: {
    version: 1,
    drawn: true,
    maxCapacity: 1 << 20,
    maxQuadsPerMessage: 4096,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    maxTexelSide: 2048,
    formats: ['r8', 'rgba8'],
    ...meshes,
  },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MapMeshSender messages', () => {
  it('posts what BlueSim posts for the same writes', () => {
    const posted: Posted[] = [];
    const sender = mesh(5, posted, true);
    sender.palette = palette();
    sender.create();
    for (let n = 0; n < 7; n++) write(sender, n);
    sender.flush();
    sender.replay();
    sender.maxQuadsPerMessage = 2;
    for (let n = 0; n < 3; n++) write(sender, n, [9, 9, 9]);
    sender.flush();

    const expected = fixture.sender.messages as Record<string, unknown>[];
    expect(types(posted)).toEqual(expected.map((message) => message.type));
    // requestIds are numbered across every mesh, so only their pattern is BlueSim's
    const number = (requestId: unknown): number =>
      Number(/^test-mesh-(\d+)$/.exec(String(requestId))?.[1]);
    const base = number(posted[0].message.requestId) - number(expected[0].requestId);
    posted.forEach(({ message }, k) => {
      const { requestId, ...rest } = expected[k];
      if (requestId === undefined) {
        expect(message.requestId).toBeUndefined();
      } else {
        expect(number(message.requestId) - base).toBe(number(requestId));
      }
      const { requestId: _, ...ours } = plain(message) as Record<string, unknown>;
      expect(ours).toEqual(rest);
    });
  });

  it('batches like BlueSim', () => {
    const sender = mesh(5, []);
    sender.maxQuadsPerMessage = 2;
    expect(sender.batches([0, 1, 2, 4, 5, 0], 3)).toEqual(fixture.sender.batches_4096);
    const wide = new MapMeshSender('b', 'b', 8000, 'r8', 1200);
    expect(wide.batches(range(3000), 1200)).toEqual(fixture.sender.batches_small);
  });

  it('splits batches at the ring end, at 4096 quads and at 2 MiB', () => {
    const sender = mesh(10000, [], false, 200);
    const slots = range(9000).map((n) => (n + 9000) % 10000);
    expect(sender.batches(slots, 200)).toEqual([1000, 4096, 3904]);
    expect(sender.batches([3, 4, 5, 9, 10, 2], 200)).toEqual([3, 2, 1]);
    const big = new MapMeshSender(ID, 'Test', 1000, 'rgba8', 2048);
    expect(big.batches(range(600), big.stripBytes())).toEqual([253, 253, 94]);
  });

  it('wraps the ring and restarts it on clear', () => {
    const posted: Posted[] = [];
    const sender = mesh(5, posted);
    sender.create();
    expect(range(12).map((n) => write(sender, n))).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1]);
    expect(sender.stats().slotsWritten).toBe(5);
    sender.clear();
    write(sender, 99);
    sender.flush();
    expect(types(posted).slice(-2)).toEqual(['cockpit:clearMapMesh', 'cockpit:setMapMeshQuads']);
    expect(posted.at(-1)?.message.first).toBe(0);
  });

  it('transfers arrays of the message only, never the palette or history it keeps', () => {
    const posted: Posted[] = [];
    const sender = mesh(4, posted);
    sender.palette = palette();
    sender.create();
    write(sender, 1);
    sender.flush();
    const [set, , quads] = posted;
    const definition = set.message.mesh as { palette: Uint8Array };
    expect(set.transfer).toEqual([definition.palette.buffer]);
    expect(definition.palette.buffer).not.toBe(sender.palette.buffer);
    const { corners, uv, texels } = quads.message as Record<string, Uint8Array>;
    expect(quads.transfer).toEqual([corners.buffer, uv.buffer, texels.buffer]);
  });

  it('sends a tint for every quad once one is tinted', () => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted);
    sender.create();
    write(sender, 0);
    sender.writeQuad(range(8), range(8), [1, 2, 3], [255, 0, 0, 128]);
    sender.flush();
    expect(Array.from(posted.at(-1)?.message.tint as Uint8Array)).toEqual([
      255, 255, 255, 255, 255, 0, 0, 128,
    ]);
  });

  it('sends a quad as written, whatever then happens to the arrays it came in', () => {
    const posted: Posted[] = [];
    const sender = mesh(4, posted);
    sender.create();
    const corners = Float64Array.of(1, 0, 1, 1, 2, 1, 2, 0);
    const uv = Float32Array.of(0, 0.5, 0, 0.5, 3, 0.5, 3, 0.5);
    const texels = Uint8Array.of(7, 8, 9);
    const tint = Uint8Array.of(255, 0, 0, 128);
    sender.writeQuad(corners, uv, texels, tint);
    for (const source of [corners, uv, texels, tint]) source.fill(42);
    sender.flush();
    expect(plain(posted.at(-1)?.message)).toMatchObject({
      corners: [1, 0, 1, 1, 2, 1, 2, 0],
      uv: [0, 0.5, 0, 0.5, 3, 0.5, 3, 0.5],
      texels: [7, 8, 9],
      tint: [255, 0, 0, 128],
    });
  });

  it('holds writes at most flushIntervalMs, to go out together', () => {
    const posted: Posted[] = [];
    const sender = mesh(16, posted);
    sender.create();
    write(sender, 1);
    write(sender, 2);
    expect(posted).toHaveLength(2);
    vi.advanceTimersByTime(0);
    expect(posted).toHaveLength(3);
    expect((posted[2].message.corners as Float64Array).length).toBe(16);
    write(sender, 3);
    vi.advanceTimersByTime(10);
    expect(posted).toHaveLength(3);
    vi.advanceTimersByTime(7);
    expect(posted).toHaveLength(4);
  });

  it('posts nothing once disposed', () => {
    const posted: Posted[] = [];
    const sender = mesh(16, posted);
    sender.create();
    write(sender, 1);
    sender.dispose();
    vi.advanceTimersByTime(100);
    sender.clear();
    expect(posted).toHaveLength(2);
  });
});

describe('MapMeshSender replies', () => {
  it('asks capabilities first, then answers for all but the quads', () => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted, true);
    sender.create();
    write(sender, 1);
    sender.flush();
    expect(posted.map(({ message }) => message.requestId !== undefined)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(sender.handleReply(capabilities(posted[0], {}))).toBe(true);
    sender.handleReply(result(posted[1], { ok: true, head: 0, capacity: 6 }));
    sender.handleReply(result(posted[2], { ok: true, head: 0, capacity: 6 }));
    expect(sender.supported && sender.drawn).toBe(true);
    expect(sender.results).toBe(2);
    expect(sender.capabilities.version).toBe(1);
  });

  it('replays to a Cockpit that lost the mesh', () => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted, true);
    sender.create();
    for (let n = 10; n < 13; n++) write(sender, n);
    sender.flush();
    const clear = posted[2];
    posted.length = 0;
    sender.handleReply(result(clear, { ok: false, error: "No mesh 'test-mesh'." }));
    expect(sender.replays).toBe(1);
    expect(types(posted)).toEqual([
      'cockpit:getMapCapabilities',
      'cockpit:setMapMesh',
      'cockpit:clearMapMesh',
      'cockpit:setMapMeshQuads',
    ]);
    expect(Array.from(posted[3].message.texels as Uint8Array)).toEqual([
      10, 11, 12, 11, 12, 13, 12, 13, 14,
    ]);
  });

  it('does not replay where the mesh still exists, or on removeMapMesh', () => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted, true);
    sender.create();
    sender.handleReply(result(posted[2], { ok: false, error: 'Invalid', capacity: 6, head: 0 }));
    sender.remove();
    sender.handleReply(result(posted[3], { ok: false, error: "No mesh 'test-mesh'." }));
    expect(sender.errors).toBe(2);
    expect(sender.replays).toBe(0);
    expect(sender.supported).toBe(true);
  });

  it('stops on a refused setMapMesh', () => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted, true);
    sender.create();
    sender.handleReply(result(posted[1], { ok: false, error: 'Invalid command.' }));
    expect(sender.supported).toBe(false);
    expect(sender.replays).toBe(0);
    const sent = posted.length;
    write(sender, 1);
    sender.flush();
    expect(posted).toHaveLength(sent);
  });

  it('leaves answers to other meshes alone', () => {
    const sender = mesh(6, [], true);
    sender.create();
    expect(sender.handleReply({ type: 'cockpit:mapMeshResult', requestId: 'other-9' })).toBe(false);
    expect(sender.handleReply({ type: 'cockpit:mapMeshResult' })).toBe(false);
    expect(sender.errors).toBe(0);
  });

  it.each([
    ['a newer version', { version: 2 }],
    ['too small a capacity', { maxCapacity: 4 }],
    ['too narrow strips', { maxTexelSide: 2 }],
    ['no r8', { formats: ['rgba8'] }],
  ])('keeps the quads but sends none to a Cockpit with %s', (_, meshes) => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted, true);
    sender.create();
    sender.handleReply(capabilities(posted[0], meshes));
    const sent = posted.length;
    write(sender, 1);
    sender.flush();
    expect(sender.supported).toBe(false);
    expect(posted).toHaveLength(sent);
    expect(sender.replays).toBe(0);
  });

  it('follows lower limits, and keeps sending where Cockpit cannot draw', () => {
    const posted: Posted[] = [];
    const sender = mesh(6, posted, true);
    sender.create();
    sender.handleReply(
      capabilities(posted[0], { drawn: false, maxQuadsPerMessage: 512, maxMessageBytes: 100000 })
    );
    expect(sender.supported).toBe(true);
    expect(sender.drawn).toBe(false);
    expect(sender.maxQuadsPerMessage).toBe(512);
    expect(sender.batches(range(600), 200)).toEqual([337, 263]);
  });

  it('asks for an answer to a quads message every livenessIntervalMs, and replays on an error', () => {
    const posted: Posted[] = [];
    const sender = mesh(16, posted, true);
    sender.create();
    write(sender, 1);
    sender.flush();
    // create() has just asked
    expect(posted.at(-1)?.message.requestId).toBeUndefined();
    vi.advanceTimersByTime(sender.livenessIntervalMs);
    write(sender, 2);
    sender.flush();
    const checked = posted.at(-1) as Posted;
    expect(checked.message.requestId).toBeDefined();
    sender.handleReply(result(checked, { ok: true, first: 1, count: 1, head: 2, capacity: 16 }));
    expect(sender.head).toBe(2);
    vi.advanceTimersByTime(sender.livenessIntervalMs / 2);
    write(sender, 3);
    sender.flush();
    expect(posted.at(-1)?.message.requestId).toBeUndefined();
    vi.advanceTimersByTime(sender.livenessIntervalMs);
    write(sender, 4);
    sender.flush();
    const lost = posted.at(-1) as Posted;
    posted.length = 0;
    sender.handleReply(result(lost, { ok: false, error: "No mesh 'test-mesh'." }));
    expect(sender.replays).toBe(1);
    expect(types(posted).slice(0, 3)).toEqual([
      'cockpit:getMapCapabilities',
      'cockpit:setMapMesh',
      'cockpit:clearMapMesh',
    ]);
    expect(posted[3].message.first).toBe(0);
    expect((posted[3].message.corners as Float64Array).length).toBe(4 * 8);
  });
});

describe('postToParent', () => {
  it('posts to the embedding page with the buffers transferred', () => {
    const postMessage = vi.fn();
    vi.stubGlobal('window', { parent: { postMessage } });
    const corners = new Float64Array(8);
    postToParent({ type: 'cockpit:setMapMeshQuads', corners }, [corners.buffer]);
    expect(postMessage).toHaveBeenCalledWith({ type: 'cockpit:setMapMeshQuads', corners }, '*', [
      corners.buffer,
    ]);
  });

  it('carries a full palette only', () => {
    const sender = mesh(4, []);
    sender.palette = new Uint8Array(PALETTE_BYTES - 4);
    expect(sender.definition()).not.toHaveProperty('palette');
  });
});
