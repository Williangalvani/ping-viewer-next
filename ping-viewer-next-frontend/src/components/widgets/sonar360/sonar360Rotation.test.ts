import { describe, expect, it } from 'vitest';
import { plotRotation, screenSector, sonarToScreenAngle } from './sonar360Rotation';

describe('plotRotation', () => {
  it('adds the mount rotation to the heading', () => {
    expect(plotRotation(0, 0, false)).toBe(0);
    expect(plotRotation(30, 90, false)).toBe(120);
  });

  it('reverses the mount rotation inside the head-down mirror', () => {
    expect(plotRotation(0, 90, true)).toBe(-90);
    expect(plotRotation(30, 90, true)).toBe(-60);
  });
});

describe('sonarToScreenAngle', () => {
  it('turns the sonar forward clockwise on screen, head-down or not', () => {
    for (const headDown of [false, true]) {
      expect(sonarToScreenAngle(0, 0, headDown)).toBe(0);
      expect(sonarToScreenAngle(0, 90, headDown)).toBe(90);
      expect(sonarToScreenAngle(0, 270, headDown)).toBe(270);
    }
  });

  it('mirrors sonar angles when head-down', () => {
    expect(sonarToScreenAngle(45, 0, false)).toBe(45);
    expect(sonarToScreenAngle(45, 0, true)).toBe(315);
    expect(sonarToScreenAngle(45, 90, false)).toBe(135);
    expect(sonarToScreenAngle(45, 90, true)).toBe(45);
  });

  // Matches the CSS: the plot rotated by plotRotation, then mirrored when head-down.
  it('agrees with plotRotation', () => {
    for (const headDown of [false, true]) {
      for (const mount of [0, 90, 180, 270]) {
        for (const angle of [0, 45, 135, 300]) {
          const local = angle + plotRotation(0, mount, headDown);
          const onScreen = (((headDown ? -local : local) % 360) + 360) % 360;
          expect(sonarToScreenAngle(angle, mount, headDown)).toBe(onScreen);
        }
      }
    }
  });
});

describe('screenSector', () => {
  it('leaves the full circle alone', () => {
    expect(screenSector(0, 360, 90, true)).toEqual({ startAngle: 0, endAngle: 360 });
  });

  it('rotates a sector clockwise', () => {
    expect(screenSector(315, 45, 0, false)).toEqual({ startAngle: 315, endAngle: 45 });
    expect(screenSector(315, 45, 90, false)).toEqual({ startAngle: 45, endAngle: 135 });
    expect(screenSector(270, 90, 270, false)).toEqual({ startAngle: 180, endAngle: 0 });
  });

  it('keeps the start edge first clockwise when head-down', () => {
    expect(screenSector(0, 90, 0, true)).toEqual({ startAngle: 270, endAngle: 0 });
    expect(screenSector(315, 45, 90, true)).toEqual({ startAngle: 45, endAngle: 135 });
  });
});
