import { useLocalStorage } from '@vueuse/core';

// Anything but an explicit 'false' keeps the display on, so a corrupt value can't hide it.
export const renderDisplaySerializer = {
  read: (raw: string): boolean => raw !== 'false',
  write: (value: boolean): string => String(value !== false),
};

// Shared across all Ping360 widgets, like useHeadDown. Turning it off skips the sonar
// drawing entirely; the data feed (map, recording) keeps running.
const renderDisplay = useLocalStorage('sonar360.renderDisplay', true, {
  serializer: renderDisplaySerializer,
});

export function useRenderDisplay() {
  return renderDisplay;
}
