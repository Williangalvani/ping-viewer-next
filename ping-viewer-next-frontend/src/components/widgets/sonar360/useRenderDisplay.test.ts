import { describe, expect, it } from 'vitest';
import { renderDisplaySerializer, useRenderDisplay } from './useRenderDisplay';

describe('renderDisplaySerializer', () => {
  it('reads what it wrote', () => {
    for (const value of [true, false]) {
      expect(renderDisplaySerializer.read(renderDisplaySerializer.write(value))).toBe(value);
    }
  });

  it('only turns the display off for an explicit false', () => {
    expect(renderDisplaySerializer.read('false')).toBe(false);
    for (const raw of ['true', '', 'null', 'garbage', '0']) {
      expect(renderDisplaySerializer.read(raw)).toBe(true);
    }
  });
});

describe('useRenderDisplay', () => {
  it('defaults to true and is shared', () => {
    const renderDisplay = useRenderDisplay();
    expect(renderDisplay.value).toBe(true);

    renderDisplay.value = false;
    expect(useRenderDisplay().value).toBe(false);
    renderDisplay.value = true;
  });
});
