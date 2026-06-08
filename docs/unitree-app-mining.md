# Mining notes — the Unitree Go app (decompiled APK)

Investigated the unpacked `UnitreeGo` APK (`com.unitree.doggo2`) from the project repo. The Java/
Kotlin is **packed with baiduprotect** (encrypted dex in `assets/baiduprotect*.jar`), so the comms
code isn't directly readable — but the **manifest, native libs, and unpacked web assets** give a
clear, evidence-backed picture that *confirms and sharpens* the public-SDK analysis.

## How the app is built

- **AgentWeb webview** (`com.just.agentweb`) hosting an embedded **Vite + Vue + TypeScript** web app
  (`assets/dist/`): a **Three.js + ammo.js physics simulator** with a rigged **Go2 GLB model**, a
  **Blockly** visual-programming UI, a **SLAM** worker (`slam.worker` + `libvoxel-*.wasm` +
  `111.pcd`), and a **video-transform** worker. The web layer talks to the native layer through the
  AgentWeb JS bridge; the native layer does the actual robot I/O.
- **Native libs:** the **ffmpeg** suite (`libavcodec/format/util`, `libffmpegkit`) for the FPV video
  stream; **iFlytek** (`libmsc.so` + `iflytek/`) for voice/ASR/TTS; `libmmkv` (storage); plus
  `baiduprotect` (hardening) and **aliyun EMAS** crash/telemetry.

## Real communication model (evidence-backed)

The transport isn't a private protocol — it lines up with the public `unitree_sdk2`:

- **Local WiFi, UDP + multicast -> DDS/RTPS.** The manifest requests
  **`CHANGE_WIFI_MULTICAST_STATE`** and ships a **`TestUdpActivity`**; the assets reference `dds`,
  `udp`, `rtps`, and `.proto`. Multicast + UDP + RTPS = **CycloneDDS-style pub/sub over the robot's
  local network** (default `192.168.123.x` on the robot AP, or a shared LAN), with IDL/protobuf
  messages. `FOREGROUND_SERVICE_CONNECTED_DEVICE` keeps the link alive.
- **BLE for pairing / provisioning / the remote.** A whole `com.unitree.lib_ble` stack
  (`BluetoothService`, `RemoteActivity`) + BLUETOOTH_SCAN/CONNECT/ADVERTISE. Initial setup and the
  hardware remote/beacon go over Bluetooth; high-bandwidth control + telemetry go over WiFi/DDS.
- **OTA firmware** via `HardwareUpdateActivity` / `HardwareUpdate2Activity`.
- **Cloud:** iFlytek (voice) + aliyun (telemetry) + Baidu (hardening) — the stock app phones home.

## Telemetry / control surface (from the diagnostic screens)

Native activities map 1:1 to the SDK's state/command surface: `A2ImuActivity` (IMU),
`A2LegActivity` (per-leg/joint), `BatteryActivity` (BMS), `MainboardActivity`, `A2MotorOffsetActivity`
(motor calibration), `A2DataActivity` (raw data), `A2InfoActivity`. That is exactly
`LowState` (12 motors: q/dq/torque/**temperature**) + `BmsState` (battery) + IMU + the sport-mode
command service — the same things Sweetie's body / energy / thermal models already simulate.

## Permissions = the IRL capability + security model

INTERNET, ACCESS/CHANGE_WIFI_STATE, **CHANGE_WIFI_MULTICAST_STATE**, NEARBY_WIFI_DEVICES,
ACCESS_NETWORK_STATE; full **Bluetooth** set; FINE/COARSE **LOCATION** (needed for WiFi/BLE scan +
GNSS); **CAMERA** (FPV), **RECORD_AUDIO** + MODIFY_AUDIO_SETTINGS (voice); FOREGROUND_SERVICE_*.
Reinforces the security-mining posture: the stock app is cloud-connected and hardened/obfuscated,
so **treat it and the stock firmware as untrusted** — run Sweetie's brain on separate compute, on an
**isolated VLAN**, talking to the robot over DDS, with audited/blocked egress.

## Ideas to adopt (this is the high-value part)

1. **Their app validates Sweetie's whole approach:** an embedded **3D sim + Blockly "program the
   robot"** layer, sim-first. Confirms milestone direction and the **H6 "rehearse a plan in sim
   before executing"** backlog item.
2. **Reusable 3D assets (in the repo):** `Go2.glb` / `Go2Root.glb` (rigged), **`charge.glb`** (a
   charger dock model — perfect for the RTH/charger feature), `environment.glb`, and an HDR. These
   could drive a future **3D Sweetie view** instead of the 2-D canvas, with the real robot mesh.
3. **SLAM / voxel mapping.** The app builds a live voxel/point-cloud map from the L1 LiDAR
   (`slam.worker` + `libvoxel.wasm`). Sweetie uses a hand-authored static grid; the IRL path is to
   **build the occupancy grid from LiDAR SLAM** (new backlog item P-SLAM) so the map is learned, not
   drawn. A* / smoothing / avoidance sit unchanged on top.
4. **Video pipeline.** `videoTransform.worker` + ffmpeg = the FPV camera stream (likely undistort +
   re-encode). This is the real input behind the perception/FOV model; IRL, the camera-recognition
   cone becomes a real (undistorted) camera feed and the LiDAR feeds presence.
5. **The AgentWeb JS-bridge pattern is literally the RealBridge seam.** A JS UI/brain calling a thin
   native bridge that owns DDS is the same architecture I want: keep Sweetie's JS cognition, put DDS
   behind a small native/Python bridge. Confirms the C-seam / RealBridge design.

## RealBridge mapping (DDS surface <-> Sweetie modules)

- `bridge.drive(vx,vy,vyaw)`  <- driveTick velocity  -> sport `Move`
- `bridge.gesture(name)`      <- doGesture           -> sport `Hello/Stretch/Dance/Heart/Sit/Pose/...`
- `bridge.recover()` / `bridge.damp()` <- failsafe   -> `RecoveryStand` / `Damp`  (fast loop, never the LLM)
- `bridge.state()`            -> body/energy/thermal  <- `LowState`(q,dq,torque,**temp**) + `BmsState` + IMU
- `bridge.lidar()` / `bridge.camera()` -> perception  <- L1 LiDAR cloud + camera stream
- map/grid                    -> pathing              <- **LiDAR SLAM voxel map** (replaces static grid)

## Caveats

- The dex is packed, so exact DDS topic names / API ids / default IPs are not in plaintext here;
  use the **public `unitree_sdk2` / `unitree_sdk2_python` / `unitree_ros2`** repos as the source of
  truth for the precise topic names, message IDL, and the sport-mode API id table. The APK confirms
  the *shape* (UDP/multicast/DDS + BLE + the telemetry surface), not the literal constants.
- Reverse-engineering the packed app further isn't worth it (and is legally/ToS fraught); the open
  SDK gives everything needed, supported and stable.
