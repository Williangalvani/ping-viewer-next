import { useLocalStorage } from '@vueuse/core';
import { computed } from 'vue';

export const MOUNT_ROTATIONS = [0, 90, 180, 270] as const;
export type MountRotation = (typeof MOUNT_ROTATIONS)[number];

export function sanitizeMountRotation(value: unknown): MountRotation {
  const degrees = typeof value === 'string' ? Number(value) : value;
  return MOUNT_ROTATIONS.find((allowed) => allowed === degrees) ?? 0;
}

export const mountRotationSerializer = {
  read: (raw: string): MountRotation => sanitizeMountRotation(raw),
  write: (value: number): string => String(sanitizeMountRotation(value)),
};

// Shared across all Ping360 widgets, like useHeadDown. Degrees, clockwise on screen.
const stored = useLocalStorage<MountRotation>('sonar360.mountRotation', 0, {
  serializer: mountRotationSerializer,
});

const mountRotation = computed<MountRotation>({
  get: () => sanitizeMountRotation(stored.value),
  set: (value) => {
    stored.value = sanitizeMountRotation(value);
  },
});

export function useMountRotation() {
  return mountRotation;
}
