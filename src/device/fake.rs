use std::{
    pin::Pin,
    task::{ready, Poll},
    time::{Duration, Instant},
};

use actix_web::web::BytesMut;
use bluerobotics_ping::{
    message::{DeserializePayload, ProtocolMessage},
    ping360::{AutoDeviceDataStruct, AutoTransmitStruct},
};
use rand::{rngs::StdRng, Rng, SeedableRng};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc::{self, Receiver, Sender},
    task::JoinHandle,
    time::interval,
};
use tokio_util::codec::Decoder;
use tracing::{debug, info, warn};

use crate::{device::manager::DeviceSelection, vehicle::SharedVehicleData};

mod nes;

pub use nes::HeadOrientation;

pub struct FakeStream {
    writer: Sender<ProtocolMessage>,
    writer_buf: BytesMut,
    /// Whether the poll_write data has been consumed on the current
    /// polling attempts.
    writer_buf_consumed: bool,
    /// Message that couldn't be sent in the latest poll_write/poll_flush attempt.
    writer_pending: Option<ProtocolMessage>,
    reader: Receiver<ProtocolMessage>,
    /// Data that couldn't be sent in the latest poll_read attempt.
    reader_pending: Option<Vec<u8>>,
}

impl FakeStream {
    pub fn new(
        device_selection: DeviceSelection,
        vehicle_data: SharedVehicleData,
        head: HeadOrientation,
    ) -> Self {
        let (writer, rx) = mpsc::channel(64);
        let (tx, reader) = mpsc::channel(64);
        tokio::spawn(FakeStream::run_loop(
            device_selection,
            vehicle_data,
            head,
            tx,
            rx,
        ));

        FakeStream {
            writer,
            writer_buf: BytesMut::with_capacity(4096),
            writer_buf_consumed: false,
            writer_pending: None,
            reader,
            reader_pending: None,
        }
    }

    /// Generate a parabolic echo bump profile surrounded by noise
    fn fake_echo_profile(
        points: usize,
        bump_start: f32,
        bump_stop: f32,
        rng: &mut StdRng,
    ) -> Vec<u8> {
        let bump_width = bump_stop - bump_start;

        (0..points)
            .map(|index| {
                let index = index as f32;
                let point = if index < bump_start {
                    0.1 * ((rng.next_u32() >> 24) as f32)
                } else if index < bump_stop {
                    255.0
                        * ((-4.0 / bump_width.powi(2))
                            * (index - bump_start - bump_width / 2.0).powi(2)
                            + 1.0)
                } else {
                    0.45 * ((rng.next_u32() >> 24) as f32)
                };
                point as u8
            })
            .collect()
    }

    /// Simulates a Ping1D parabolic echo bump with oscillating bump and scan range
    fn fake_profile_ping1d(
        ping_number: u32,
        rng: &mut StdRng,
    ) -> bluerobotics_ping::ping1d::ProfileStruct {
        const POINTS: usize = 200;
        const MAX_SCAN_LENGTH: f32 = 120_000.0;

        let counter = ping_number as f32;
        let bump_start = POINTS as f32 / 2.0 - 10.0 * (counter / 10.0).sin();
        let bump_stop = 3.0 * POINTS as f32 / 5.0 + 6.0 * (counter / 5.5).cos();
        let bump_width = bump_stop - bump_start;
        let scan_length = MAX_SCAN_LENGTH * (1.3 + (counter / 40.0).cos()) / 2.3;
        let profile_data = FakeStream::fake_echo_profile(POINTS, bump_start, bump_stop, rng);

        bluerobotics_ping::ping1d::ProfileStruct {
            distance: (scan_length * (bump_stop + bump_start) / (POINTS as f32 * 2.0)) as u32,
            confidence: (400.0 / bump_width) as u16,
            transmit_duration: 200,
            ping_number,
            scan_start: 0,
            scan_length: scan_length as u32,
            gain_setting: 4,
            profile_data_length: profile_data.len() as u16,
            profile_data,
        }
    }

    /// Simulates a Ping360 full-length echo profile at a device angle that wraps every
    /// 400 gradians, with world-fixed north/east echoes placed by the vehicle heading
    fn fake_device_data_ping360(
        payload: &AutoTransmitStruct,
        counter: u32,
        number_of_samples: u16,
        heading_deg: Option<f32>,
        head: HeadOrientation,
        rng: &mut StdRng,
    ) -> AutoDeviceDataStruct {
        const ANGULAR_RESOLUTION: u32 = 400;

        let points = number_of_samples.max(1) as usize;
        let angle = (counter % ANGULAR_RESOLUTION) as u16;

        let data = nes::ping360_profile(points, angle, heading_deg, head, rng);
        bluerobotics_ping::ping360::AutoDeviceDataStruct {
            mode: payload.mode,
            gain_setting: payload.gain_setting,
            angle,
            transmit_duration: payload.transmit_duration,
            sample_period: payload.sample_period,
            transmit_frequency: payload.transmit_frequency,
            start_angle: payload.start_angle,
            stop_angle: payload.stop_angle,
            num_steps: payload.num_steps,
            delay: payload.delay,
            number_of_samples,
            data_length: data.len() as u16,
            data,
        }
    }

    /// Runs a simulated device loop for the given device selection (Ping1D or Ping360).
    async fn run_loop(
        device_selection: DeviceSelection,
        vehicle_data: SharedVehicleData,
        head: HeadOrientation,
        tx: Sender<ProtocolMessage>,
        mut rx: Receiver<ProtocolMessage>,
    ) {
        let mut ping1d_profile_task: Option<JoinHandle<()>> = None;
        let mut ping360_auto_device_data_task: Option<JoinHandle<()>> = None;

        while let Some(message) = rx.recv().await {
            if !message.has_valid_crc() {
                continue;
            }
            match message.message_id {
                // general_request (must reply immediately)
                6 => {
                    if let Some(chunk) = message.payload().first_chunk::<2>() {
                        match u16::from_le_bytes(*chunk) {
                            // device_information
                            4 => {
                                // https://docs.bluerobotics.com/ping-protocol/pingmessage-common/#get
                                let reply = bluerobotics_ping::common::Messages::DeviceInformation(
                                    bluerobotics_ping::common::DeviceInformationStruct {
                                        device_type: match device_selection {
                                            // ping1d simulation
                                            DeviceSelection::Common
                                            | DeviceSelection::Ping1D
                                            | DeviceSelection::Auto => 1,
                                            // ping360 simulation
                                            DeviceSelection::Ping360 => 2,
                                        },
                                        device_revision: 1,
                                        firmware_version_major: 3,
                                        firmware_version_minor: 3,
                                        firmware_version_patch: 0,
                                        reserved: 0,
                                    },
                                );

                                let mut msg = ProtocolMessage::new();
                                msg.set_message(&reply);
                                let _ = tx.send(msg).await;
                            }

                            // protocol_version
                            5 => {
                                // https://docs.bluerobotics.com/ping-protocol/pingmessage-common/#5-protocol_version
                                let reply = bluerobotics_ping::common::Messages::ProtocolVersion(
                                    bluerobotics_ping::common::ProtocolVersionStruct {
                                        version_major: 1,
                                        version_minor: 1,
                                        version_patch: 0,
                                        reserved: 0,
                                    },
                                );

                                let mut msg = ProtocolMessage::new();
                                msg.set_message(&reply);
                                let _ = tx.send(msg).await;
                            }

                            // ping360 device_data
                            2300 => {
                                // https://docs.bluerobotics.com/ping-protocol/pingmessage-ping360/#2300-device_data
                                let reply = bluerobotics_ping::ping360::Messages::DeviceData(
                                    bluerobotics_ping::ping360::DeviceDataStruct {
                                        mode: 1,
                                        gain_setting: 1,
                                        angle: 0,
                                        transmit_duration: 1_000,
                                        sample_period: 80,
                                        transmit_frequency: 650,
                                        number_of_samples: 1_200,
                                        data_length: 0,
                                        data: vec![],
                                    },
                                );

                                let mut msg = ProtocolMessage::new();
                                msg.set_message(&reply);
                                let _ = tx.send(msg).await;
                            }

                            _ => debug!(?message, "FakeStream: Unhandled general_request message"),
                        }
                    } else {
                        warn!("FakeStream: Invalid payload for general_request message");
                    }
                }

                // ping1d continuous_start (starts an event stream)
                1400 if matches!(
                    device_selection,
                    DeviceSelection::Common | DeviceSelection::Ping1D | DeviceSelection::Auto
                ) =>
                {
                    if let Some(chunk) = message.payload().first_chunk::<2>() {
                        match u16::from_le_bytes(*chunk) {
                            // profile
                            1300 => {
                                let tx = tx.clone();
                                if let Some(handle) =
                                    ping1d_profile_task.replace(tokio::spawn(async move {
                                        let mut rng = StdRng::seed_from_u64(0x426c7565);
                                        let mut interval = interval(Duration::from_millis(50));
                                        interval.tick().await;

                                        for i in 0.. {
                                            // https://docs.bluerobotics.com/ping-protocol/pingmessage-ping1d/#1300-profile
                                            let reply =
                                                bluerobotics_ping::ping1d::Messages::Profile(
                                                    FakeStream::fake_profile_ping1d(i, &mut rng),
                                                );

                                            let mut msg = ProtocolMessage::new();
                                            msg.set_message(&reply);
                                            let _ = tx.send(msg).await;

                                            interval.tick().await;
                                        }

                                        std::future::pending::<()>().await
                                    }))
                                {
                                    handle.abort();
                                }
                            }

                            _ => debug!(
                                ?message,
                                "FakeStream: Unhandled ping1d continuous_start message"
                            ),
                        }
                    } else {
                        warn!("FakeStream: Invalid payload for ping1d continuous_start message");
                    }
                }

                // ping1d continuous_stop (stops an event stream)
                1401 if matches!(
                    device_selection,
                    DeviceSelection::Common | DeviceSelection::Ping1D | DeviceSelection::Auto
                ) =>
                {
                    if let Some(chunk) = message.payload().first_chunk::<2>() {
                        match u16::from_le_bytes(*chunk) {
                            // profile
                            1300 => {
                                if let Some(handle) = ping1d_profile_task.take() {
                                    handle.abort();
                                }
                            }

                            _ => debug!(
                                ?message,
                                "FakeStream: Unhandled ping1d continuous_stop message"
                            ),
                        }
                    } else {
                        warn!("FakeStream: Invalid payload for ping1d continuous_stop message");
                    }
                }

                // ping360 auto_transmit (starts an auto_device_data stream)
                2602 if matches!(device_selection, DeviceSelection::Ping360) => {
                    let payload = bluerobotics_ping::ping360::AutoTransmitStruct::deserialize(
                        message.payload(),
                    );

                    let tx = tx.clone();
                    let vehicle_data = vehicle_data.clone();

                    if let Some(handle) =
                        ping360_auto_device_data_task.replace(tokio::spawn(async move {
                            let mut rng = StdRng::seed_from_u64(0x426c7565);
                            let mut interval = interval(Duration::from_millis(7));
                            interval.tick().await;

                            let number_of_samples = payload.number_of_samples.max(1);
                            let mut heading_known: Option<bool> = None;
                            for i in 0.. {
                                let heading = nes::fresh_heading_deg(
                                    vehicle_data.read().await.as_ref(),
                                    Instant::now(),
                                );
                                if heading_known != Some(heading.is_some()) {
                                    heading_known = Some(heading.is_some());
                                    if heading.is_some() {
                                        info!(?head, "FakeStream: vehicle heading available, Ping360 north/east cues on");
                                    } else {
                                        warn!("FakeStream: no fresh vehicle heading, Ping360 north/east cues off");
                                    }
                                }

                                // https://docs.bluerobotics.com/ping-protocol/pingmessage-ping360/#2301-auto_device_data
                                let reply = bluerobotics_ping::ping360::Messages::AutoDeviceData(
                                    FakeStream::fake_device_data_ping360(
                                        &payload,
                                        i,
                                        number_of_samples,
                                        heading,
                                        head,
                                        &mut rng,
                                    ),
                                );

                                let mut msg = ProtocolMessage::new();
                                msg.set_message(&reply);
                                let _ = tx.send(msg).await;

                                interval.tick().await;
                            }
                        }))
                    {
                        handle.abort();
                    }
                }

                // ping360 motor_off (replies with ack and cancels the auto_device_data stream)
                2903 if matches!(device_selection, DeviceSelection::Ping360) => {
                    if let Some(handle) = ping360_auto_device_data_task.take() {
                        handle.abort();
                    }

                    // https://docs.bluerobotics.com/ping-protocol/pingmessage-common/#1-ack
                    let reply = bluerobotics_ping::common::Messages::Ack(
                        bluerobotics_ping::common::AckStruct {
                            acked_id: message.message_id,
                        },
                    );

                    let mut msg = ProtocolMessage::new();
                    msg.set_message(&reply);
                    let _ = tx.send(msg).await;
                }

                _ => debug!(?message, "FakeStream: Unhandled message"),
            }
        }

        if let Some(handle) = ping1d_profile_task.take() {
            handle.abort();
        }
        if let Some(handle) = ping360_auto_device_data_task.take() {
            handle.abort();
        }
    }

    /// Helper method to send Ping protocol messages to the channel in the FakeStream's loop.
    fn poll_send_message(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        message: ProtocolMessage,
    ) -> Poll<Result<(), std::io::Error>> {
        // Reserve a slot for the writer
        let mut poll_sender = tokio_util::sync::PollSender::new(self.writer.clone());
        match poll_sender.poll_reserve(cx) {
            // Slot has been reserved or channel is closed
            Poll::Ready(result) => result
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::BrokenPipe, error))?,
            // All slots are occupied; save message to retry later
            Poll::Pending => {
                self.writer_pending = Some(message);
                return Poll::Pending;
            }
        }

        // Send decoded message to writer
        poll_sender
            .send_item(message)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::BrokenPipe, error))?;

        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for FakeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let mut data = if let Some(data) = self.reader_pending.take() {
            data
        } else if let Some(message) = ready!(self.reader.poll_recv(cx)) {
            message.serialized()
        } else {
            // Channel is closed
            return Poll::Ready(Ok(()));
        };

        if buf.remaining() == 0 {
            // Buffer is full
            self.reader_pending = Some(data);
            return Poll::Ready(Ok(()));
        } else if buf.remaining() < data.len() {
            // Buffer doesn't have enough capacity; write until we fill it
            // and save the rest to reader_pending
            self.reader_pending = Some(data.split_off(buf.remaining()));
        }
        buf.put_slice(&data);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for FakeStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        if !self.writer_buf_consumed {
            self.writer_buf.extend_from_slice(buf);
            self.writer_buf_consumed = true;
        }

        if let Some(message) = self.writer_pending.take() {
            ready!(self.as_mut().poll_send_message(cx, message))?;
        }

        // Attempt to decode one or more messages
        let mut codec = bluerobotics_ping::codec::PingCodec::new();
        loop {
            match codec.decode(&mut self.writer_buf) {
                Err(error) => {
                    return Poll::Ready(Err(std::io::Error::other(format!("{:?}", error))))
                }
                // Frame isn't finished yet
                Ok(None) => break,
                // Frame is finished
                Ok(Some(message)) => ready!(self.as_mut().poll_send_message(cx, message))?,
            }
        }

        self.writer_buf_consumed = false;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        if let Some(message) = self.writer_pending.take() {
            self.as_mut().poll_send_message(cx, message)
        } else {
            Poll::Ready(Ok(()))
        }
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::RwLock,
    };

    use super::*;
    use crate::vehicle::VehicleData;

    const PING1D_DIGEST_AT_160C18CA: u64 = 0x362cee22181470c9;

    #[test]
    fn ping1d_profiles_are_unchanged() {
        let mut rng = StdRng::seed_from_u64(0x426c7565);
        let mut digest: u64 = 0xcbf29ce484222325;
        for i in 0..64 {
            let p = FakeStream::fake_profile_ping1d(i, &mut rng);
            let fields = [p.distance.to_le_bytes(), p.scan_length.to_le_bytes()].concat();
            for b in fields
                .iter()
                .chain(&p.confidence.to_le_bytes())
                .chain(&p.profile_data)
            {
                digest = (digest ^ u64::from(*b)).wrapping_mul(0x100000001b3);
            }
        }
        assert_eq!(digest, PING1D_DIGEST_AT_160C18CA, "digest {digest:#x}");
    }

    async fn start_ping360(pose: SharedVehicleData) -> FakeStream {
        start_ping360_head(pose, HeadOrientation::Upright).await
    }

    async fn start_ping360_head(pose: SharedVehicleData, head: HeadOrientation) -> FakeStream {
        let mut stream = FakeStream::new(DeviceSelection::Ping360, pose, head);
        let mut msg = ProtocolMessage::new();
        msg.set_message(&bluerobotics_ping::ping360::Messages::AutoTransmit(
            AutoTransmitStruct {
                mode: 1,
                gain_setting: 1,
                transmit_duration: 1000,
                sample_period: 80,
                transmit_frequency: 650,
                number_of_samples: 1200,
                start_angle: 0,
                stop_angle: 399,
                num_steps: 1,
                delay: 0,
            },
        ));
        stream.write_all(&msg.serialized()).await.unwrap();
        stream
    }

    async fn next_device_data(stream: &mut FakeStream, buf: &mut BytesMut) -> AutoDeviceDataStruct {
        let read = async {
            let mut codec = bluerobotics_ping::codec::PingCodec::new();
            loop {
                if let Some(msg) = codec.decode(buf).unwrap() {
                    if msg.message_id == 2301 {
                        return AutoDeviceDataStruct::deserialize(msg.payload());
                    }
                    continue;
                }
                stream.read_buf(buf).await.unwrap();
            }
        };
        tokio::time::timeout(Duration::from_secs(5), read)
            .await
            .expect("no auto_device_data within 5 s")
    }

    fn fresh_pose(heading_deg: f32) -> Option<VehicleData> {
        Some(VehicleData {
            roll: 0.0,
            pitch: 0.0,
            yaw: heading_deg.to_radians(),
            heading: None,
            alt: 0.0,
            lat: 0.0,
            lon: 0.0,
            attitude_received_at: Some(Instant::now()),
        })
    }

    fn argmax(data: &[u8]) -> usize {
        data.iter()
            .enumerate()
            .max_by_key(|(_, value)| **value)
            .map(|(index, _)| index)
            .unwrap()
    }

    fn has_cue(data: &[u8]) -> bool {
        data.iter().any(|value| *value > nes::NOISE_MAX)
    }

    #[tokio::test]
    async fn ping360_uses_injected_heading() {
        let pose = SharedVehicleData::new(RwLock::new(fresh_pose(180.0)));
        let mut stream = start_ping360(pose).await;
        let mut buf = BytesMut::new();

        let first = next_device_data(&mut stream, &mut buf).await;
        assert_eq!(first.angle, 0);
        assert!((528..=552).contains(&argmax(&first.data)));
        assert!(*first.data.iter().max().unwrap() >= 230);
    }

    #[tokio::test]
    async fn ping360_without_pose_has_no_cues() {
        let mut stream = start_ping360(SharedVehicleData::default()).await;
        let mut buf = BytesMut::new();

        for angle in 0..=209 {
            let data = next_device_data(&mut stream, &mut buf).await;
            assert_eq!(data.angle, angle);
            assert!(!has_cue(&data.data), "angle {angle} has a cue");
        }
    }

    // Heading 0: an upright head sees east at 300 grad, an inverted one at 100 (and north at 200 for both).
    #[tokio::test]
    async fn ping360_inverted_head_mirrors_east() {
        for (head, east, empty) in [
            (HeadOrientation::Inverted, 100, 300),
            (HeadOrientation::Upright, 300, 100),
        ] {
            let pose = SharedVehicleData::new(RwLock::new(fresh_pose(0.0)));
            let mut stream = start_ping360_head(pose.clone(), head).await;
            let mut buf = BytesMut::new();
            for angle in 0..=300 {
                // 300 pings outlast HEADING_STALE, so keep the heading fresh
                *pose.write().await = fresh_pose(0.0);
                let data = next_device_data(&mut stream, &mut buf).await;
                assert_eq!(data.angle, angle);
                if angle == east {
                    assert!(
                        (888..=912).contains(&argmax(&data.data)),
                        "{head:?} angle {angle}"
                    );
                }
                if angle == empty {
                    assert!(!has_cue(&data.data), "{head:?} angle {angle} has a cue");
                }
                if angle == 200 {
                    assert!((528..=552).contains(&argmax(&data.data)), "{head:?} north");
                }
            }
        }
    }

    #[tokio::test]
    async fn ping360_follows_heading_change() {
        let pose = SharedVehicleData::new(RwLock::new(fresh_pose(180.0)));
        let mut stream = start_ping360(pose.clone()).await;
        let mut buf = BytesMut::new();

        let first = next_device_data(&mut stream, &mut buf).await;
        assert_eq!(first.angle, 0);
        assert!(has_cue(&first.data));

        *pose.write().await = fresh_pose(162.0);
        loop {
            let data = next_device_data(&mut stream, &mut buf).await;
            if data.angle == 10 {
                assert!(!has_cue(&data.data), "angle 10 has a cue");
            }
            if data.angle == 20 {
                assert!((528..=552).contains(&argmax(&data.data)));
                break;
            }
        }
    }
}
