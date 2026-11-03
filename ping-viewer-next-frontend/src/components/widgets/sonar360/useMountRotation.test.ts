import { describe, expect, it } from 'vitest';
import {
  type MountRotation,
  mountRotationSerializer,
  sanitizeMountRotation,
  useMountRotation,
} from './useMountRotation';

describe('sanitizeMountRotation', () => {
  it('keeps the allowed rotations', () => {
    for (const degrees of [0, 90, 180, 270]) {
      expect(sanitizeMountRotation(degrees)).toBe(degrees);
    }
  });

  it('falls back to 0 for anything else', () => {
    for (const value of [45, -90, 360, 450, 90.5, Number.NaN, null, undefined, true, {}, 'abc']) {
      expect(sanitizeMountRotation(value)).toBe(0);
    }
  });
});

describe('mountRotationSerializer', () => {
  it('reads what it wrote', () => {
    for (const degrees of [0, 90, 180, 270] as const) {
      expect(mountRotationSerializer.read(mountRotationSerializer.write(degrees))).toBe(degrees);
    }
  });

  it('sanitises stored values', () => {
    expect(mountRotationSerializer.read('180')).toBe(180);
    expect(mountRotationSerializer.read('45')).toBe(0);
    expect(mountRotationSerializer.read('')).toBe(0);
    expect(mountRotationSerializer.read('null')).toBe(0);
    expect(mountRotationSerializer.read('garbage')).toBe(0);
    expect(mountRotationSerializer.write(45)).toBe('0');
  });
});

describe('useMountRotation', () => {
  it('defaults to 0, is shared and sanitises writes', () => {
    const rotation = useMountRotation();
    expect(rotation.value).toBe(0);

    rotation.value = 270;
    expect(useMountRotation().value).toBe(270);

    rotation.value = 45 as MountRotation;
    expect(rotation.value).toBe(0);
  });
});
