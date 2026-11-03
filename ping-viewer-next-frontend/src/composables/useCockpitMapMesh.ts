import { listenToParent, postToParent } from '@/cockpit/mapMeshSender';
import { type Ping360Config, Ping360MapFeed } from '@/cockpit/ping360MapFeed';
import { useHeadDown } from '@/components/widgets/sonar360/useHeadDown';
import { listenToDatalakeVariable } from '@bluerobotics/cockpit-api';
import { type MaybeRefOrGetter, type Ref, onUnmounted, ref, toValue, watch } from 'vue';

const FALSE_VALUES = ['0', 'false', 'off', 'no'];
const POSE_RATE_HZ = 20;
const DEFAULT_SYSTEM_ID = 1;

// A Ping360 DeviceData or AutoDeviceData message; only AutoDeviceData has num_steps
export interface Ping360Message extends Partial<Ping360Config> {
  angle?: number;
  data?: ArrayLike<number>;
}

// Whether this page draws its Ping360 on the map of the Cockpit embedding it: not on its own, and
// not with map=0 in its URL
export const cockpitMapAvailable = (): boolean => {
  if (typeof window === 'undefined' || window.parent === window) return false;
  const map = new URLSearchParams(window.location.search).get('map');
  return map === null || !FALSE_VALUES.includes(map.toLowerCase());
};

// Sends a Ping360's scan to the map of the Cockpit embedding this page, as one map mesh per device,
// in the widget's colour palette `colorPalette`
export function useCockpitMapMesh(
  slot: Ref<number>,
  colorPalette?: MaybeRefOrGetter<string | undefined>
) {
  const available = cockpitMapAvailable();
  const enabled = ref(true);
  const headDown = useHeadDown();
  const feed = new Ping360MapFeed({
    slot: slot.value,
    post: postToParent,
    reversed: headDown.value,
    palette: toValue(colorPalette),
  });
  let active = available;
  let systemId = DEFAULT_SYSTEM_ID;
  const listenedSystems = new Set<number>();
  let stopReplies: (() => void) | undefined;

  watch(slot, (value) => {
    feed.slot = Number(value);
  });
  watch(enabled, (value) => {
    feed.enabled = value;
  });
  watch(headDown, (value) => {
    feed.reversed = value;
  });
  watch(
    () => toValue(colorPalette),
    (name) => feed.setPalette(name)
  );

  // The Cockpit API cannot stop listening, so the callbacks of a vehicle no longer followed, or of
  // an unmounted page, just do nothing
  const listenToVehicle = (id: number) => {
    if (listenedSystems.has(id)) return;
    listenedSystems.add(id);
    const from = (setter: (value: unknown) => void) => (value: unknown) => {
      if (active && systemId === id) setter(value);
    };
    const prefix = `/mavlink/${id}/1`;
    listenToDatalakeVariable(
      `${prefix}/GLOBAL_POSITION_INT/lat`,
      from((value) => feed.setLatitudeE7(value)),
      POSE_RATE_HZ
    );
    listenToDatalakeVariable(
      `${prefix}/GLOBAL_POSITION_INT/lon`,
      from((value) => feed.setLongitudeE7(value)),
      POSE_RATE_HZ
    );
    listenToDatalakeVariable(
      `${prefix}/ATTITUDE/yaw`,
      from((value) => feed.setYawRadians(value)),
      POSE_RATE_HZ
    );
    listenToDatalakeVariable(
      `${prefix}/GLOBAL_POSITION_INT/hdg`,
      from((value) => feed.setHdgCentidegrees(value)),
      POSE_RATE_HZ
    );
  };

  if (available) {
    stopReplies = listenToParent((reply) => feed.handleReply(reply));
    listenToDatalakeVariable(
      'autopilotSystemId',
      (value: unknown) => {
        const id = Number(value);
        if (!active || !Number.isInteger(id) || id < 1 || id === systemId) return;
        systemId = id;
        feed.resetPose();
        listenToVehicle(id);
      },
      1
    );
    listenToVehicle(systemId);
  }

  const handleConfig = (config: Ping360Config) => {
    if (active) feed.handleConfig(config);
  };

  // Takes the raw head angle, not the one the widget turns for display
  const handlePing = (message: Ping360Message) => {
    if (!active || message?.angle === undefined || !message.data) return;
    feed.handlePing(message.angle, message.data, message);
  };

  const clear = () => {
    if (active) feed.clear();
  };

  onUnmounted(() => {
    active = false;
    stopReplies?.();
    feed.dispose();
  });

  return { available, enabled, handleConfig, handlePing, clear };
}
