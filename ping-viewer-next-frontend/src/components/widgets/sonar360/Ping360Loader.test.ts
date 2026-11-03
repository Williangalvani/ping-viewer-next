import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Component, createRenderer, defineComponent, nextTick } from 'vue';
import Ping360Loader from './Ping360Loader.vue';
import { useRenderDisplay } from './useRenderDisplay';

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: { name, render: () => null } }),
}));

vi.mock('./Ping360.vue', async () => {
  const { h } = await import('vue');
  return { default: { name: 'Ping360', render: () => h('ping360') } };
});
vi.mock('./Ping360Settings.vue', () => stub('Ping360Settings'));
vi.mock('../DataRecorder.vue', () => stub('DataRecorder'));
vi.mock('../FloatingControls.vue', () => stub('FloatingControls'));

interface TestNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
}

const createNode = (tag: string, text = ''): TestNode => ({
  tag,
  text,
  props: {},
  children: [],
  parent: null,
});

const detach = (child: TestNode) => {
  if (!child.parent) return;
  child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
};

// Minimal non-DOM renderer, enough to mount the Loader under node.
const { createApp } = createRenderer<TestNode, TestNode>({
  createElement: (tag) => createNode(tag),
  createText: (text) => createNode('#text', text),
  createComment: (text) => createNode('#comment', text),
  setText: (node, text) => {
    node.text = text;
  },
  setElementText: (el, text) => {
    for (const child of [...el.children]) detach(child);
    const textNode = createNode('#text', text);
    textNode.parent = el;
    el.children.push(textNode);
  },
  insert: (child, parent, anchor) => {
    detach(child);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
    child.parent = parent;
  },
  remove: detach,
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    const siblings = node.parent?.children ?? [];
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
  patchProp: (el, key, _prev, next) => {
    el.props[key] = next;
  },
});

const find = (node: TestNode, tag: string): TestNode | null => {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
};
const textOf = (node: TestNode): string => node.text + node.children.map(textOf).join('');

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const config = {
  sample_period: 80,
  number_of_samples: 1200,
  gain_setting: 1,
  start_angle: 0,
  stop_angle: 399,
};
const configMessage = { DeviceConfig: { Ping360Config: config } };
const ping = { angle: 10, data: [1, 2, 3] };
const pingMessage = { DeviceMessage: { PingMessage: { Ping360: { DeviceData: ping } } } };

function mountLoader() {
  const handlers = {
    onSettingsChange: vi.fn(),
    onPing360Config: vi.fn(),
    onPing360Data: vi.fn(),
  };
  const app = createApp(Ping360Loader as Component, {
    device: { device_type: 'Ping360', slot: 0 },
    websocketUrl: 'ws://localhost/ws?device_type=Ping360&slot=0',
    colorPalette: 'Thermal Blue',
    showControls: false,
    ...handlers,
  });
  for (const name of ['v-tooltip', 'v-btn', 'v-icon', 'v-dialog']) {
    app.component(name, defineComponent({ render: () => null }));
  }
  const root = createNode('root');
  app.mount(root);
  const socket = FakeWebSocket.instances.at(-1)!;
  return { app, root, socket, ...handlers };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  useRenderDisplay().value = true;
  vi.unstubAllGlobals();
});

describe('Ping360Loader', () => {
  it('draws the sonar display by default', async () => {
    const { app, root, socket, onPing360Data } = mountLoader();

    socket.receive(configMessage);
    socket.receive(pingMessage);
    await nextTick();

    const sonar = find(root, 'ping360');
    expect(sonar).not.toBeNull();
    expect(sonar?.props.measurement).toMatchObject({ angle: 10 });
    expect(textOf(root)).not.toContain('Sonar display off');
    expect(onPing360Data).toHaveBeenCalledWith(ping);
    app.unmount();
  });

  it('keeps streaming data without mounting the display when it is off', async () => {
    useRenderDisplay().value = false;
    const { app, root, socket, onSettingsChange, onPing360Config, onPing360Data } = mountLoader();

    expect(find(root, 'ping360')).toBeNull();
    expect(textOf(root)).toContain('Sonar display off');

    socket.receive(configMessage);
    socket.receive(pingMessage);

    expect(onSettingsChange).toHaveBeenCalledWith({ range: 2, gain: 1, sector: 360 });
    expect(onPing360Config).toHaveBeenCalledWith(config);
    expect(onPing360Data).toHaveBeenCalledWith(ping);

    useRenderDisplay().value = true;
    await nextTick();
    const sonar = find(root, 'ping360');
    expect(sonar).not.toBeNull();
    expect(sonar?.props.measurement).toBeNull();
    expect(textOf(root)).not.toContain('Sonar display off');

    socket.receive(pingMessage);
    await nextTick();
    expect(sonar?.props.measurement).toMatchObject({ angle: 10 });
    app.unmount();
  });
});
