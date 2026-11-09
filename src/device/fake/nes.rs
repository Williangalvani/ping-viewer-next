//! World-fixed north/east echo cues for the simulated Ping360, rotated into device
//! gradians by the vehicle heading.

use std::time::{Duration, Instant};

use rand::{rngs::StdRng, Rng};

use crate::vehicle::VehicleData;

/// Matches the frontend map's `YAW_STALE_MS`.
pub(super) const HEADING_STALE: Duration = Duration::from_millis(2000);

/// Device gradian the Ping360 points at when looking along the vehicle's forward axis.
pub(super) const PING360_FORWARD_GRAD: f32 = 200.0;
pub(super) const DEGREES_PER_GRADIAN: f32 = 0.9;

/// Wraps into `[0, modulus)`. `rem_euclid` alone can return `modulus` for tiny
/// negative inputs because of f32 rounding.
fn wrap(value: f32, modulus: f32) -> f32 {
    let wrapped = value.rem_euclid(modulus);
    if wrapped >= modulus {
        0.0
    } else {
        wrapped
    }
}

pub(super) fn wrap_degrees(deg: f32) -> f32 {
    wrap(deg, 360.0)
}

pub(super) fn wrap_gradians(grad: f32) -> f32 {
    wrap(grad, 400.0)
}

/// Shortest wrapped distance between two gradian angles, in `[0, 200]`.
pub(super) fn angular_distance_grad(a: f32, b: f32) -> f32 {
    let d = wrap_gradians(a - b);
    d.min(400.0 - d)
}

/// Device gradian that looks at world bearing `bearing_deg` (clockwise from north)
/// while the vehicle heads `heading_deg`.
pub(super) fn world_to_device_grad(bearing_deg: f32, heading_deg: f32) -> f32 {
    wrap_gradians(PING360_FORWARD_GRAD + (bearing_deg - heading_deg) / DEGREES_PER_GRADIAN)
}

/// How the simulated Ping360 head is mounted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HeadOrientation {
    #[default]
    Upright,
    /// Rolled 180° about the vehicle's forward axis (head pointing down)
    Inverted,
}

/// `world_to_device_grad` for a head mounted `head`. Inverted, forward is still
/// `PING360_FORWARD_GRAD` but the head turns the other way relative to the vehicle.
pub(super) fn world_to_device_grad_for_head(
    bearing_deg: f32,
    heading_deg: f32,
    head: HeadOrientation,
) -> f32 {
    let upright = world_to_device_grad(bearing_deg, heading_deg);
    match head {
        HeadOrientation::Upright => upright,
        HeadOrientation::Inverted => wrap_gradians(2.0 * PING360_FORWARD_GRAD - upright),
    }
}

/// Same conversion as the frontend map's `Ping360MapFeed.setYawRadians`.
pub(super) fn heading_deg_from_yaw(yaw_rad: f32) -> Option<f32> {
    yaw_rad
        .is_finite()
        .then(|| wrap_degrees(yaw_rad * 180.0 / std::f32::consts::PI))
}

/// Heading from the pose's ATTITUDE yaw, or `None` when the yaw is missing, stale or
/// not finite. VFR_HUD `heading` is deliberately not used as a fallback.
pub(super) fn fresh_heading_deg(pose: Option<&VehicleData>, now: Instant) -> Option<f32> {
    let pose = pose?;
    let age = now.saturating_duration_since(pose.attitude_received_at?);
    if age >= HEADING_STALE {
        return None;
    }
    heading_deg_from_yaw(pose.yaw)
}

/// An echo fixed in the world at `bearing_deg`, seen as a parabolic bump in range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct WorldCue {
    pub bearing_deg: f32,
    /// Bump centre, as a fraction of the scanned range
    pub centre_fraction: f32,
    /// Bump thickness, as a fraction of the scanned range
    pub thickness_fraction: f32,
    /// Rays within this distance of the cue's device angle see the bump
    pub half_width_grad: f32,
    pub peak: f32,
}

pub(super) const NORTH_CUE: WorldCue = WorldCue {
    bearing_deg: 0.0,
    centre_fraction: 0.45,
    thickness_fraction: 0.05,
    half_width_grad: 4.0,
    peak: 255.0,
};

pub(super) const EAST_CUE: WorldCue = WorldCue {
    bearing_deg: 90.0,
    centre_fraction: 0.75,
    thickness_fraction: 0.03,
    half_width_grad: 3.0,
    peak: 160.0,
};

pub(super) const WORLD_CUES: [WorldCue; 2] = [NORTH_CUE, EAST_CUE];

/// Highest background noise level `ping360_profile` can produce.
#[cfg(test)]
pub(super) const NOISE_MAX: u8 = 25;

/// Cues seen by the ray at `ray_grad`. Without a heading there is no world frame, so none.
pub(super) fn cue_hits(
    ray_grad: f32,
    heading_deg: Option<f32>,
    head: HeadOrientation,
) -> Vec<WorldCue> {
    let Some(heading_deg) = heading_deg else {
        return Vec::new();
    };
    WORLD_CUES
        .into_iter()
        .filter(|cue| {
            let cue_grad = world_to_device_grad_for_head(cue.bearing_deg, heading_deg, head);
            // The slack keeps rays exactly at the half-width inside despite f32 rounding
            angular_distance_grad(ray_grad, cue_grad) <= cue.half_width_grad + 1e-3
        })
        .collect()
}

/// Simulated Ping360 echo profile for one ray: noise everywhere, plus the bumps of
/// the world cues that ray sees.
pub(super) fn ping360_profile(
    points: usize,
    ray_grad: u16,
    heading_deg: Option<f32>,
    head: HeadOrientation,
    rng: &mut StdRng,
) -> Vec<u8> {
    let mut data: Vec<u8> = (0..points)
        .map(|_| ((rng.next_u32() >> 24) as f32 * 0.1) as u8)
        .collect();

    for cue in cue_hits(f32::from(ray_grad), heading_deg, head) {
        let centre = cue.centre_fraction * points as f32;
        let half_thickness = (cue.thickness_fraction * points as f32 / 2.0).max(0.5);
        for (index, value) in data.iter_mut().enumerate() {
            let x = (index as f32 + 0.5 - centre) / half_thickness;
            if x.abs() < 1.0 {
                *value = (*value).max((cue.peak * (1.0 - x * x)) as u8);
            }
        }
    }

    data
}

#[cfg(test)]
mod tests {
    use std::f32::consts::{FRAC_PI_2, PI};

    use rand::SeedableRng;

    use super::*;

    const UP: HeadOrientation = HeadOrientation::Upright;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    const CARDINALS: [(f32, f32, f32); 4] = [
        (0.0, 200.0, 300.0),
        (90.0, 100.0, 200.0),
        (180.0, 0.0, 100.0),
        (270.0, 300.0, 0.0),
    ];

    #[test]
    fn cardinal_headings_place_north_and_east() {
        for (h, n, e) in CARDINALS {
            let north = world_to_device_grad(0.0, h);
            let east = world_to_device_grad(90.0, h);
            assert!(approx(north, n), "heading {h}: north at {north}, want {n}");
            assert!(
                angular_distance_grad(north, n) < 1e-3,
                "heading {h}: north at {north}, want {n}"
            );
            assert!(approx(east, e), "heading {h}: east at {east}, want {e}");
        }
    }

    #[test]
    fn headings_wrap() {
        assert!(approx(world_to_device_grad(0.0, -90.0), 300.0));
        assert!(approx(world_to_device_grad(0.0, 450.0), 100.0));
        assert!(approx(world_to_device_grad(0.0, 720.0), 200.0));
        assert!(approx(world_to_device_grad(360.0, 0.0), 200.0));
        assert!(approx(world_to_device_grad(-270.0, 0.0), 300.0));
    }

    #[test]
    fn wraps_stay_in_range() {
        assert!(wrap_degrees(-1e-6) < 360.0);
        assert!(wrap_gradians(-1e-6) < 400.0);
        assert!(approx(wrap_degrees(-90.0), 270.0));
        assert!(approx(wrap_gradians(-100.0), 300.0));
        assert!(approx(wrap_gradians(800.0), 0.0));
    }

    #[test]
    fn angular_distance_wraps() {
        assert!(approx(angular_distance_grad(399.0, 1.0), 2.0));
        assert!(approx(angular_distance_grad(1.0, 399.0), 2.0));
        assert!(approx(angular_distance_grad(0.0, 200.0), 200.0));
        assert!(approx(angular_distance_grad(100.0, 350.0), 150.0));
    }

    #[test]
    fn yaw_to_heading() {
        assert!(approx(heading_deg_from_yaw(0.0).unwrap(), 0.0));
        assert!(approx(heading_deg_from_yaw(-FRAC_PI_2).unwrap(), 270.0));
        assert!(approx(heading_deg_from_yaw(3.0 * PI).unwrap(), 180.0));
        assert!(approx(heading_deg_from_yaw(-0.40520748).unwrap(), 336.784));
        assert_eq!(heading_deg_from_yaw(f32::NAN), None);
        assert_eq!(heading_deg_from_yaw(f32::INFINITY), None);
    }

    fn rng() -> StdRng {
        StdRng::seed_from_u64(0x426c7565)
    }

    fn argmax(data: &[u8]) -> usize {
        data.iter()
            .enumerate()
            .max_by_key(|(_, value)| **value)
            .map(|(index, _)| index)
            .unwrap()
    }

    fn assert_noise_outside(data: &[u8], cue_bins: std::ops::Range<usize>) {
        for (index, value) in data.iter().enumerate() {
            if !cue_bins.contains(&index) {
                assert!(*value <= NOISE_MAX, "bin {index} = {value} above noise");
            }
        }
    }

    fn bins_above_noise(data: &[u8]) -> usize {
        data.iter().filter(|value| **value > NOISE_MAX).count()
    }

    #[test]
    fn north_bump_bin_range() {
        let data = ping360_profile(1200, 200, Some(0.0), UP, &mut rng());
        assert!(
            (528..=552).contains(&argmax(&data)),
            "argmax {}",
            argmax(&data)
        );
        assert!(*data.iter().max().unwrap() >= 230);
        assert_noise_outside(&data, 510..570);
    }

    #[test]
    fn east_bump_is_weaker_and_thinner() {
        let data = ping360_profile(1200, 300, Some(0.0), UP, &mut rng());
        assert!(
            (888..=912).contains(&argmax(&data)),
            "argmax {}",
            argmax(&data)
        );
        assert!((144..=160).contains(data.iter().max().unwrap()));
        assert_noise_outside(&data, 882..918);

        let north = ping360_profile(1200, 200, Some(0.0), UP, &mut rng());
        assert!(bins_above_noise(&data) < bins_above_noise(&north));
    }

    #[test]
    fn cardinal_rays_hit() {
        for (h, n, e) in CARDINALS {
            assert_eq!(cue_hits(n, Some(h), UP), vec![NORTH_CUE], "heading {h}");
            assert_eq!(cue_hits(e, Some(h), UP), vec![EAST_CUE], "heading {h}");
            assert_eq!(
                cue_hits(wrap_gradians(n + 50.0), Some(h), UP),
                vec![],
                "heading {h}"
            );
        }
    }

    #[test]
    fn cue_straddles_seam() {
        for ray in (396..=399).chain(0..=4) {
            assert_eq!(
                cue_hits(ray as f32, Some(180.0), UP),
                vec![NORTH_CUE],
                "ray {ray}"
            );
        }
        assert_eq!(cue_hits(395.0, Some(180.0), UP), vec![]);
        assert_eq!(cue_hits(5.0, Some(180.0), UP), vec![]);
    }

    #[test]
    fn missing_heading_has_no_cues() {
        let mut rng = rng();
        for ray in 0..400 {
            let data = ping360_profile(1200, ray, None, UP, &mut rng);
            assert_noise_outside(&data, 0..0);
        }
        let forward = ping360_profile(1200, 200, None, UP, &mut rng);
        assert_noise_outside(&forward, 0..0);
    }

    #[test]
    fn noise_independent_of_heading() {
        assert_eq!(
            ping360_profile(1200, 100, Some(0.0), UP, &mut rng()),
            ping360_profile(1200, 100, None, UP, &mut rng())
        );
    }

    fn pose(yaw: f32, at: Option<Instant>) -> VehicleData {
        VehicleData {
            roll: 0.0,
            pitch: 0.0,
            yaw,
            heading: None,
            alt: 0.0,
            lat: 0.0,
            lon: 0.0,
            attitude_received_at: at,
        }
    }

    #[test]
    fn fresh_heading_none_without_pose() {
        assert_eq!(fresh_heading_deg(None, Instant::now()), None);
    }

    #[test]
    fn fresh_heading_none_without_attitude_time() {
        let t0 = Instant::now();
        assert_eq!(fresh_heading_deg(Some(&pose(0.0, None)), t0), None);
    }

    #[test]
    fn fresh_heading_staleness() {
        let t0 = Instant::now();
        let pose = pose(FRAC_PI_2, Some(t0));
        let fresh = fresh_heading_deg(Some(&pose), t0 + Duration::from_millis(1999));
        assert!(approx(fresh.unwrap(), 90.0), "{fresh:?}");
        assert_eq!(
            fresh_heading_deg(Some(&pose), t0 + Duration::from_millis(2000)),
            None
        );
        assert_eq!(
            fresh_heading_deg(Some(&pose), t0 + Duration::from_secs(3)),
            None
        );
    }

    #[test]
    fn fresh_heading_nan_yaw() {
        let t0 = Instant::now();
        assert_eq!(fresh_heading_deg(Some(&pose(f32::NAN, Some(t0))), t0), None);
    }

    // Heading, then the device gradians of north and east for a head mounted upside down.
    const INVERTED_CARDINALS: [(f32, f32, f32); 4] = [
        (0.0, 200.0, 100.0),
        (90.0, 300.0, 200.0),
        (180.0, 0.0, 300.0),
        (270.0, 100.0, 0.0),
    ];

    #[test]
    fn inverted_head_places_north_and_east() {
        for (h, n, e) in INVERTED_CARDINALS {
            let north = world_to_device_grad_for_head(0.0, h, HeadOrientation::Inverted);
            let east = world_to_device_grad_for_head(90.0, h, HeadOrientation::Inverted);
            assert!(
                angular_distance_grad(north, n) < 1e-3,
                "heading {h}: north at {north}, want {n}"
            );
            assert!(
                angular_distance_grad(east, e) < 1e-3,
                "heading {h}: east at {east}, want {e}"
            );
        }
    }

    #[test]
    fn upright_head_keeps_the_upright_mapping() {
        for (h, n, e) in CARDINALS {
            let north = world_to_device_grad_for_head(0.0, h, HeadOrientation::Upright);
            let east = world_to_device_grad_for_head(90.0, h, HeadOrientation::Upright);
            assert!(
                angular_distance_grad(north, n) < 1e-3,
                "heading {h}: north at {north}, want {n}"
            );
            assert!(
                angular_distance_grad(east, e) < 1e-3,
                "heading {h}: east at {east}, want {e}"
            );
        }
    }

    // An inverted head turns the other way, so only forward (and aft) agree with an upright one.
    #[test]
    fn inverted_head_is_not_the_upright_mapping() {
        for h in [0.0, 45.0, 90.0, 180.0, 270.0, 333.0] {
            let east_up = world_to_device_grad_for_head(h + 90.0, h, HeadOrientation::Upright);
            let east_inv = world_to_device_grad_for_head(h + 90.0, h, HeadOrientation::Inverted);
            assert!(
                approx(angular_distance_grad(east_up, east_inv), 200.0),
                "heading {h}"
            );
            let ahead_up = world_to_device_grad_for_head(h, h, HeadOrientation::Upright);
            let ahead_inv = world_to_device_grad_for_head(h, h, HeadOrientation::Inverted);
            assert!(
                angular_distance_grad(ahead_up, ahead_inv) < 1e-3,
                "heading {h}"
            );
        }
    }

    /// World bearing the frontend map draws a ray at, as `pingQuad` in
    /// `ping-viewer-next-frontend/src/cockpit/ping360MapMesh.ts` does with mount offset 0:
    /// `headingDeg + (reversed ? -1 : 1) * (angleGrad - 200) * 0.9`, `reversed` being the head-down setting.
    fn frontend_map_bearing(grad: f32, heading_deg: f32, reversed: bool) -> f32 {
        let sign = if reversed { -1.0 } else { 1.0 };
        wrap_degrees(heading_deg + sign * (grad - PING360_FORWARD_GRAD) * DEGREES_PER_GRADIAN)
    }

    fn degrees_apart(a: f32, b: f32) -> f32 {
        let d = wrap_degrees(a - b);
        d.min(360.0 - d)
    }

    #[test]
    fn map_finds_the_world_bearing_when_head_down_matches_the_head() {
        for h in (0..360).step_by(15).map(|h| h as f32) {
            for beta in [0.0, 90.0, 180.0, 270.0, 12.5] {
                let up = world_to_device_grad_for_head(beta, h, HeadOrientation::Upright);
                let inv = world_to_device_grad_for_head(beta, h, HeadOrientation::Inverted);
                assert!(
                    degrees_apart(frontend_map_bearing(up, h, false), beta) < 1e-2,
                    "upright h {h} beta {beta}"
                );
                assert!(
                    degrees_apart(frontend_map_bearing(inv, h, true), beta) < 1e-2,
                    "inverted h {h} beta {beta}"
                );
            }
        }
    }

    // Setting head-down for an upright head mirrors the map about the heading (2h - beta), so it only agrees
    // with the world where the cue lies dead ahead or astern. These headings keep both cues >= 30° off that axis.
    #[test]
    fn map_head_down_on_an_upright_head_mirrors_about_the_heading() {
        for h in [30.0, 135.0, 225.0, 300.0] {
            for beta in [0.0, 90.0] {
                let up = world_to_device_grad_for_head(beta, h, HeadOrientation::Upright);
                let drawn = frontend_map_bearing(up, h, true);
                assert!(
                    degrees_apart(drawn, 2.0 * h - beta) < 1e-2,
                    "h {h} beta {beta}: {drawn}"
                );
                assert!(
                    degrees_apart(drawn, beta) > 15.0,
                    "h {h} beta {beta}: {drawn}"
                );
            }
        }
    }

    #[test]
    fn inverted_cue_rays_hit() {
        for (h, n, e) in INVERTED_CARDINALS {
            assert_eq!(
                cue_hits(n, Some(h), HeadOrientation::Inverted),
                vec![NORTH_CUE],
                "heading {h}"
            );
            assert_eq!(
                cue_hits(e, Some(h), HeadOrientation::Inverted),
                vec![EAST_CUE],
                "heading {h}"
            );
        }
        // the upright east ray at heading 0 sees nothing on an inverted head
        assert_eq!(
            cue_hits(300.0, Some(0.0), HeadOrientation::Inverted),
            vec![]
        );
    }

    #[test]
    fn inverted_profile_puts_east_at_grad_100() {
        let data = ping360_profile(1200, 100, Some(0.0), HeadOrientation::Inverted, &mut rng());
        assert!(
            (888..=912).contains(&argmax(&data)),
            "argmax {}",
            argmax(&data)
        );
        let upright = ping360_profile(1200, 100, Some(0.0), HeadOrientation::Upright, &mut rng());
        assert_noise_outside(&upright, 0..0);
    }

    #[test]
    fn tiny_sample_counts() {
        for points in [1, 2, 10] {
            for ray in [200, 300] {
                let data = ping360_profile(points, ray, Some(0.0), UP, &mut rng());
                assert_eq!(data.len(), points);
            }
        }
    }
}
