# Go2 Python ecosystem — findings & actioned wins

A scan of the open-source Go2 Python projects, the ideas worth taking, and the
items already folded into sweetie this pass.

## Security resolution: the app's encryption is (very likely) legitimate auth

Earlier the APK analysis flagged AES-encrypted WebView JS + packed DEX and could
not rule out a backdoor. The ecosystem explains it: recent firmware (V3-capable,
**Go2 >= 1.1.15**) encrypts the WebRTC signaling with a **per-device AES-128
key** via a `data2=3` auth flow. The community driver `unitree_webrtc_connect`
documents needing `UNITREE_AES_128_KEY` (fetched with `unitree-fetch-aes-key`,
which authenticates against the owner's Unitree account). So the encrypted key
material in the stock app is consistent with normal per-device device-auth, not
evidence of malware. This **lowers the "hidden backdoor" prior** while keeping
the S7 stance intact: the code is still opaque, so verify *behaviour* (isolated
VLAN, egress capture). Net: distrust-but-now-explained.

Deployment consequence: a real WebRTC bring-up on current firmware needs that
per-device key. It is **provisioned by Unitree (account-bound), not minted by
us** — we load/validate it, we do not derive or crack it.

## Actioned this pass

- **AES key handling — `core/go2_keys.py`.** Loads (`UNITREE_AES_128_KEY` env or
  explicit), validates/normalizes 128-bit hex/base64, *delegates* fetching to the
  official `unitree_webrtc_connect.fetch_aes_key` flow, and can `generate` a fresh
  random key for our own transports/tests (a generated key will NOT authenticate
  to a real robot). Precedence: explicit -> env -> optional fetch. Prereq for the
  WebRTC transport.
- **Real LiDAR decoder seam — `core/lidar_map.register_voxel_decoder()`.** The
  community WebRTC drivers ship a verified voxel/point-cloud decoder
  (go2_webrtc_connect, unitree_webrtc_connect). We now prefer a registered real
  decoder and fall back to the tolerant built-in only when none is set — removing
  the biggest unknown in the hardware nav loop.
- **SDK concurrency fix — `RealBridge._sdk_lock`.** Field reports show the Python
  SDK isn't concurrency-safe (one project wrapped it in a serializing service).
  Every `_sdk_call` now runs under an `asyncio.Lock`, so LLM/joystick/autonomy
  commands can't race the SDK.

## Worth taking next (not yet done)

- **DONE (this pass): WebRTC transport** — `core/webrtc_bridge.py` adds account-free
  LocalAP/LocalSTA control on AIR/PRO/EDU (same `BridgeBase` surface as `RealBridge`),
  with `core/go2_keys.py` for the optional one-time per-device key. See
  `docs/transport-and-firmware-policy.md` for the base-model / no-account policy.
- **Audio/VUI**: `vui_client` (LED/brightness/volume) + AudioHub file management
  give an expressive feedback channel and a second `speak_through_robot` path
  beyond onboard `TtsMaker`.
- **Auto-charging / docking** to close the energy-aware RTH loop (OpenMind OM1
  "BrainPack" demonstrates Go2 nav + SLAM + auto-charge + face anonymization).
- **MCP server** wrapping sweetie's guard-gated tools (cf. lpigeon's
  unitree-go2-mcp-server), so external agents drive her through the *same*
  SafetyGuard.
- **Higher-fidelity sim** by targeting `unitree_mujoco` (same DDS interface as the
  real robot), shrinking the sim/hardware gap further.
- **Built-in obstacle-avoidance API** (unitree_webrtc_connect) as a robot-side
  reflex beneath SafetyGuard (defense in depth).

## Key references

- legion1581/unitree_webrtc_connect, legion1581/go2_python_sdk, legion1581/go2_firmware_tools
- phospho-app/go2_webrtc_connect (PyPI `go2-webrtc-connect`)
- grasp-lyrl/unitree_go2w_agent_sdk (LLM-agent SDK + Nav2)
- lpigeon/unitree-go2-mcp-server; OpenMind/OM1
- unitreerobotics/unitree_sdk2_python, unitree_mujoco
