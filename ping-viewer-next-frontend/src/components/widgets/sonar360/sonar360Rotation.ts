// Angles are in degrees, clockwise from straight up, like the sonar's own angles.
// When head-down, Ping360.vue mirrors the whole plot with scaleX(-1), so a CSS rotate(r)
// applied inside it shows up as -r on screen. A positive mount rotation always turns the
// plot clockwise on screen, mirrored or not, and so does a positive heading: a head mounted
// upside down reports bearings counter-clockwise, and only then does the mirror keep the
// disc north-up while the vehicle turns.

const normalize = (degrees: number) => ((degrees % 360) + 360) % 360;

/** CSS rotation to apply to the plot inside the (possibly mirrored) container. */
export function plotRotation(yaw: number, mountRotation: number, headDown: boolean): number {
  return headDown ? -(yaw + mountRotation) : yaw + mountRotation;
}

/** Where a sonar angle is drawn on screen, ignoring heading. */
export function sonarToScreenAngle(angle: number, mountRotation: number, headDown: boolean) {
  return normalize(headDown ? mountRotation - angle : angle + mountRotation);
}

/** The sector as seen on screen; mirroring swaps which edge comes first clockwise. */
export function screenSector(
  startAngle: number,
  endAngle: number,
  mountRotation: number,
  headDown: boolean
) {
  if (startAngle === 0 && endAngle === 360) return { startAngle, endAngle };
  const start = sonarToScreenAngle(startAngle, mountRotation, headDown);
  const end = sonarToScreenAngle(endAngle, mountRotation, headDown);
  return headDown ? { startAngle: end, endAngle: start } : { startAngle: start, endAngle: end };
}
