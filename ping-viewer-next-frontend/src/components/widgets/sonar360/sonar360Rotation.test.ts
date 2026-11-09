import { describe, expect, it } from 'vitest';
import { plotRotation, screenSector, sonarToScreenAngle } from './sonar360Rotation';

describe('plotRotation', () => {
  it('adds the mount rotation to the heading', () => {
    expect(plotRotation(0, 0, false)).toBe(0);
    expect(plotRotation(30, 90, false)).toBe(120);
  });

  it('reverses the mount rotation inside the head-down mirror', () => {
    expect(plotRotation(0, 90, true)).toBe(-90);
    // An upside-down head at heading 30 reports north at +30; -(30 - 120) puts it at the mount, 90.
    expect(plotRotation(30, 90, true)).toBe(-120);
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

// Screen angle of a ray at sonar angle `angle` (clockwise from the head's forward), as the CSS
// draws it: rotate(rotation) inside the plot, then the container's scaleX(-1) when head-down.
type Rotation = (yaw: number, mountRotation: number, headDown: boolean) => number;
const drawnAt = (
  rotation: Rotation,
  angle: number,
  yaw: number,
  mount: number,
  headDown: boolean
) => {
  const local = angle + rotation(yaw, mount, headDown);
  return (((headDown ? -local : local) % 360) + 360) % 360;
};
const offBy = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
// Seen from above, an upright head reports a world bearing clockwise from its forward, a head
// mounted upside down reports it counter-clockwise.
const uprightAngle = (bearing: number, yaw: number) => bearing - yaw;
const invertedAngle = (bearing: number, yaw: number) => yaw - bearing;

const MOUNTS = [0, 90, 180, 270];
const CARDINAL_YAWS = [0, 90, 180, 270];
const CONTINUOUS_YAWS = [
  ...Array.from({ length: 1440 }, (_, i) => i * 0.25),
  -179.75,
  -90,
  -0.1,
  359.99,
  405.5,
  720.3,
];

/** Every (yaw, mount) where world north is not at the mount rotation or east not 90 clockwise of it. */
function northUpFailures(rotation: Rotation, yaws: number[]) {
  const failures: string[] = [];
  for (const mount of MOUNTS) {
    for (const yaw of yaws) {
      const north = drawnAt(rotation, invertedAngle(0, yaw), yaw, mount, true);
      const east = drawnAt(rotation, invertedAngle(90, yaw), yaw, mount, true);
      if (offBy(north, mount) > 1e-6 || offBy(east, mount + 90) > 1e-6) {
        failures.push(
          `yaw ${yaw} mount ${mount}: north ${north.toFixed(2)} east ${east.toFixed(2)}`
        );
      }
    }
  }
  return failures;
}

describe('a physically inverted head shown head-down', () => {
  it('is north-up at the cardinal headings, for every mount rotation', () => {
    expect(northUpFailures(plotRotation, CARDINAL_YAWS)).toEqual([]);
  });

  it('is north-up at every heading while turning, for every mount rotation', () => {
    expect(northUpFailures(plotRotation, CONTINUOUS_YAWS)).toEqual([]);
  });

  // The wrong sign of yaw inside the mirror turns the disc by -2 yaw: the check must catch it.
  it('rejects rotate(yaw - mount) inside the mirror (negative control)', () => {
    const wrongSign: Rotation = (yaw, mount, headDown) => yaw + (headDown ? -mount : mount);
    const failures = northUpFailures(wrongSign, CARDINAL_YAWS);
    for (const mount of MOUNTS) {
      for (const yaw of [90, 270]) {
        expect(failures.some((f) => f.startsWith(`yaw ${yaw} mount ${mount}:`))).toBe(true);
        const north = drawnAt(wrongSign, invertedAngle(0, yaw), yaw, mount, true);
        expect(offBy(north, mount - 2 * yaw)).toBeLessThan(1e-6);
      }
    }
    // -2 yaw is a whole turn at 0 and 180, so those headings cannot tell the signs apart
    expect(failures).toHaveLength(MOUNTS.length * 2);
    expect(northUpFailures(wrongSign, CONTINUOUS_YAWS).length).toBeGreaterThan(
      MOUNTS.length * 1400
    );
  });
});

// The Cockpit map places a ray at yaw + s, or yaw - s with head-down (ping360MapMesh `reversed`),
// and does not apply the widget's mount rotation. The disc is the same picture turned by the mount.
describe('the disc and the map', () => {
  it('draw every ray at the same world bearing, head-down or not', () => {
    const failures: string[] = [];
    for (const headDown of [false, true]) {
      for (const mount of MOUNTS) {
        for (const yaw of [0, 37.5, 90, 181, 270, 333.25]) {
          for (const angle of [0, 45, 135, 300]) {
            const mapBearing = yaw + (headDown ? -angle : angle);
            const screen = drawnAt(plotRotation, angle, yaw, mount, headDown);
            if (offBy(screen, mapBearing + mount) > 1e-6) {
              failures.push(
                `headDown ${headDown} yaw ${yaw} mount ${mount} angle ${angle}: ${screen}`
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('is north-up for an upright head, not head-down', () => {
    for (const mount of MOUNTS) {
      for (const yaw of CONTINUOUS_YAWS) {
        const north = drawnAt(plotRotation, uprightAngle(0, yaw), yaw, mount, false);
        const east = drawnAt(plotRotation, uprightAngle(90, yaw), yaw, mount, false);
        expect(offBy(north, mount)).toBeLessThan(1e-6);
        expect(offBy(east, mount + 90)).toBeLessThan(1e-6);
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
