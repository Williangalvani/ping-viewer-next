import { Ping360MapFeed } from '@/cockpit/ping360MapFeed';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useCockpitMapMesh } from './useCockpitMapMesh';

vi.mock('@bluerobotics/cockpit-api', () => ({ listenToDatalakeVariable: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCockpitMapMesh', () => {
  it("recolours the map with the widget's palette as it changes", async () => {
    // onUnmounted warns outside a component
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setPalette = vi.spyOn(Ping360MapFeed.prototype, 'setPalette');
    const clear = vi.spyOn(Ping360MapFeed.prototype, 'clear');
    const dispose = vi.spyOn(Ping360MapFeed.prototype, 'dispose');
    const colorPalette = ref('Thermal Blue');
    const scope = effectScope();
    scope.run(() => useCockpitMapMesh(ref(0), colorPalette));

    await nextTick();
    expect(setPalette).not.toHaveBeenCalled();
    colorPalette.value = 'Ocean';
    await nextTick();
    expect(setPalette).toHaveBeenCalledTimes(1);
    expect(setPalette).toHaveBeenLastCalledWith('Ocean');
    expect(clear).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    scope.stop();
  });
});
