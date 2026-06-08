# Transport & firmware policy — running on base models, account-free

Goal: sweetie's controller must run on **base Go2 models (AIR/PRO), on the
owner's own hardware, without a Unitree account or cloud dependency.** This is
achievable. The transport is fully isolated in the bridge, so it's a deployment
choice, not an architecture change.

## The three transports

| Transport | Models | Account? | Notes |
|---|---|---|---|
| **WebRTC LocalAP** | AIR/PRO/EDU | no | Client joins the robot's own Wi-Fi AP. Fully offline. Same protocol as the Unitree Go app; no jailbreak/firmware mod. |
| **WebRTC LocalSTA** | AIR/PRO/EDU | no | Robot + client on the same LAN; connect by IP or by serial (multicast discovery). Offline. |
| **WebRTC Remote (STA-T)** | AIR/PRO/EDU | **yes** | Relays through Unitree's TURN server for cross-network control. Needs account creds. **Avoid for sweetie.** |
| **DDS (unitree_sdk2py)** | EDU (AIR/PRO need custom firmware) | no | Low-level + high-level, local. EDU out of the box; AIR/PRO require community custom firmware to unlock dev access. |

sweetie uses only **high-level sport commands + state**, which the WebRTC
local methods fully support (reads `rt/lf/sportmodestate`/`lowstate`; no
`rt/lowcmd`). So **WebRTC LocalAP/LocalSTA is the default for base models** and
needs no account.

## The AES-128 key (firmware ≥ 1.1.15) — avoidable, and one-time at worst

- Firmware **< 1.1.15 needs no per-device key** (static-key handshake). The
  community drivers support the pre-key line (1.0.19–1.0.25, 1.1.1–~1.1.14).
- Firmware **≥ 1.1.15** adds a per-device AES-128 key (`data2=3`) for the LAN
  handshake. It is **per-device, stable across re-pairings, stored on the robot
  at `/unitree/etc/key/aes_key.bin`**, and listed in the cloud bind list. The
  `unitree-fetch-aes-key` tool reads it via a one-time account login; afterwards
  you pass the 32-hex key to a **local** connection and never touch the cloud
  again.
- A security token (separate from the key) is only needed to run **multiple
  clients at once** (e.g. phone app + sweetie). sweetie is the sole controller,
  so no token is needed for single-client local control.

**Policy:**
1. Prefer **WebRTC LocalAP/LocalSTA**. Account-free on AIR/PRO/EDU.
2. **Stay on firmware ≤ 1.1.14** to avoid the per-device key entirely. Document
   this so a stray OTA doesn't lock you in. (Downgrading later is risky — a 1.1.2
   OTA is known to break Secure Boot into a loader loop — so "don't update past
   1.1.14" is far safer than "downgrade.")
3. If you are already on ≥ 1.1.15: fetch the key **once** with the official tool,
   store it (env `UNITREE_AES_128_KEY` or a file), and run offline thereafter.
   `core/go2_keys.py` loads it; the app has no ongoing cloud dependency.
4. Keep **DDS** for EDU (or AIR/PRO + community custom firmware) when low-level
   control is wanted.

## How this maps to the code

- `core/webrtc_bridge.py` — `WebRTCBridge(BridgeBase)`: account-free LocalAP/
  LocalSTA transport. Same surface as `RealBridge` (move/stand/gestures/state/
  nav), so cognition/teleop don't care which transport is live.
- `core/go2_keys.py` — loads/validates/(optionally one-time)fetches the key.
- `core/real_bridge.py` — DDS transport (EDU / custom firmware).
- Bridge selection is a deployment config; the controller logic is unchanged.

## Honest caveats

- WebRTC is **high-level only** — no raw joint/torque control (that needs DDS +
  EDU/custom firmware). Fine for sweetie's behaviour set.
- Firmware modification (to unlock DDS on AIR/PRO) carries brick/warranty risk.
- Independent researchers have repeatedly flagged weak auth across Unitree's
  stack — another reason for the isolated-VLAN / verify-behaviour posture (S7).
