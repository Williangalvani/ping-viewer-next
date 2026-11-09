use std::sync::Arc;
use std::time::Instant;

use mavlink::ardupilotmega::ATTITUDE_DATA;
use mavlink::ardupilotmega::GLOBAL_POSITION_INT_DATA;
use mavlink::ardupilotmega::VFR_HUD_DATA;

use serde::Deserialize;
use serde::Serialize;
use tokio::sync::RwLock;
use tracing::{error, info};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct VehicleData {
    #[schemars(description = "Roll angle in radians")]
    pub roll: f32,
    #[schemars(description = "Pitch angle in radians")]
    pub pitch: f32,
    #[schemars(description = "Yaw angle in radians")]
    pub yaw: f32,
    #[schemars(description = "Compass heading in degrees (0-360, 0=north), from VFR_HUD")]
    pub heading: Option<f32>,
    #[schemars(description = "Altitude in meters above sea level")]
    pub alt: f64,
    #[schemars(description = "Latitude in decimal degrees")]
    pub lat: f64,
    #[schemars(description = "Longitude in decimal degrees")]
    pub lon: f64,
    /// When the ATTITUDE that `roll`, `pitch` and `yaw` came from arrived. The pose is
    /// rewritten on every GLOBAL_POSITION_INT/VFR_HUD too, so this is what dates the yaw.
    #[serde(skip)]
    #[schemars(skip)]
    pub attitude_received_at: Option<Instant>,
}

pub type SharedVehicleData = Arc<RwLock<Option<VehicleData>>>;

#[derive(Deserialize)]
struct Envelope<T> {
    message: T,
}

fn make_default_config(node_name: &str) -> zenoh::Config {
    let mut config = zenoh::Config::default();

    // Set client mode (common to both)
    config
        .insert_json5("mode", r#""client""#)
        .expect("Failed to insert client mode");
    config
        .insert_json5("metadata", &format!(r#"{{"name": "{}"}}"#, node_name))
        .expect("Failed to insert metadata");
    config
        .insert_json5("adminspace/enabled", r#"true"#)
        .expect("Failed to insert adminspace/enabled");
    let endpoint = crate::cli::manager::zenoh_server_address();
    config
        .insert_json5("connect/endpoints", &format!(r#"["tcp/{endpoint}"]"#))
        .expect("Failed to insert endpoints");
    info!("Generated zenoh config connecting to tcp/{endpoint}");
    config
}

pub async fn zenoh_client_bridge(latest_pose: Arc<RwLock<Option<VehicleData>>>) {
    use tokio::time::{sleep, Duration};
    let node_name = env!("CARGO_PKG_NAME");

    let reconnect_delay_secs = 5;
    let reconnect_delay = Duration::from_secs(reconnect_delay_secs);

    loop {
        let config = make_default_config(node_name);

        sleep(reconnect_delay).await;

        let session = match zenoh::open(config).await {
            Ok(session) => session,
            Err(error) => {
                error!(error, reconnect_delay_secs, "Zenoh session error, retrying");
                continue;
            }
        };
        let attitude_sub = match session.declare_subscriber("mavlink/**/1/ATTITUDE").await {
            Ok(subscription) => subscription,
            Err(error) => {
                error!(
                    error,
                    reconnect_delay_secs, "Zenoh subscribe error for ATTITUDE, retrying"
                );
                continue;
            }
        };
        let position_sub = match session
            .declare_subscriber("mavlink/**/1/GLOBAL_POSITION_INT")
            .await
        {
            Ok(subscription) => subscription,
            Err(error) => {
                error!(
                    error,
                    reconnect_delay_secs, "Zenoh subscribe error for GLOBAL_POSITION_INT, retrying"
                );
                continue;
            }
        };
        let vfr_hud_sub = match session.declare_subscriber("mavlink/**/1/VFR_HUD").await {
            Ok(subscription) => subscription,
            Err(error) => {
                error!(
                    error,
                    reconnect_delay_secs, "Zenoh subscribe error for VFR_HUD, retrying"
                );
                continue;
            }
        };
        info!("Subscribed to mavlink/**/1/ATTITUDE, mavlink/**/1/GLOBAL_POSITION_INT and mavlink/**/1/VFR_HUD");

        let mut latest_attitude: Option<ATTITUDE_DATA> = None;
        let mut latest_attitude_at: Option<Instant> = None;
        let mut latest_position: Option<GLOBAL_POSITION_INT_DATA> = None;
        let mut latest_heading: Option<f32> = None;

        loop {
            tokio::select! {
                res = attitude_sub.recv_async() => {
                    match res {
                        Ok(sample) => {
                            if let Ok(env) = serde_json5::from_slice::<Envelope<ATTITUDE_DATA>>(&sample.payload().to_bytes()) {
                                latest_attitude = Some(env.message);
                                latest_attitude_at = Some(Instant::now());
                            }
                        },
                        Err(error) => {
                            error!(error, reconnect_delay_secs, "Zenoh ATTITUDE recv error, reconnecting");
                            break;
                        }
                    }
                }
                res = position_sub.recv_async() => {
                    match res {
                        Ok(sample) => {
                            if let Ok(env) = serde_json5::from_slice::<Envelope<GLOBAL_POSITION_INT_DATA>>(&sample.payload().to_bytes()) {
                                latest_position = Some(env.message);
                            }
                        },
                        Err(error) => {
                            error!(error, reconnect_delay_secs, "Zenoh POSITION recv error, reconnecting");
                            break;
                        }
                    }
                }
                res = vfr_hud_sub.recv_async() => {
                    match res {
                        Ok(sample) => {
                            if let Ok(env) = serde_json5::from_slice::<Envelope<VFR_HUD_DATA>>(&sample.payload().to_bytes()) {
                                latest_heading = Some(env.message.heading as f32);
                            }
                        },
                        Err(error) => {
                            error!(error, reconnect_delay_secs, "Zenoh VFR_HUD recv error, reconnecting");
                            break;
                        }
                    }
                }
            }

            if let (Some(att), Some(pos)) = (&latest_attitude, &latest_position) {
                let pose = VehicleData {
                    roll: att.roll,
                    pitch: att.pitch,
                    yaw: att.yaw,
                    heading: latest_heading,
                    alt: pos.alt as f64 / 1000.0,
                    lat: pos.lat as f64 / 1e7,
                    lon: pos.lon as f64 / 1e7,
                    attitude_received_at: latest_attitude_at,
                };
                let mut pose_guard = latest_pose.write().await;
                *pose_guard = Some(pose);
            }
        }

        error!(
            reconnect_delay_secs,
            "Zenoh client bridge disconnected, retrying"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attitude_envelope_with_type_field_parses() {
        let payload = br#"{
            "message": {
                "pitch": 0.008952283300459385,
                "pitchspeed": 0.00014409935101866722,
                "roll": -1.5255012512207031,
                "rollspeed": -0.00015358044765889645,
                "time_boot_ms": 1074822100,
                "type": "ATTITUDE",
                "yaw": -0.40520748496055603,
                "yawspeed": 0.0005934527143836021
            }
        }"#;
        let env = serde_json5::from_slice::<Envelope<ATTITUDE_DATA>>(payload).unwrap();
        assert!((env.message.yaw - -0.40520748).abs() < 1e-6);
    }
}
