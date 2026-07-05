# Frame ↔ Go2 driver contract

The single seam between the **portable brain** (`/decide` sidecar) and a real **Unitree Go2**. Executable +
tested: [`src/go2/driver.js`](../src/go2/driver.js), [`tests/go2Driver.test.js`](../tests/go2Driver.test.js).
The SDK + Nav2 are injected (mock in tests, `unitree_sdk2` / Nav2 on hardware), so the whole contract runs with
zero robot in the loop.

## The loop (on the ROS 2 companion node, ~10 Hz)

```
sensors ──frameFromSensors()──▶ frame ──POST /decide {frame, prompt?}──▶ decision
                                                                            │
   sport-mode API + Nav2 ◀──driver.execute(decision,{live,frame})──────────┘
```

1. Gather sensors → `frameFromSensors()` → the frame.
2. POST it to `/decide` (add `prompt` only when a human actually spoke to her).
3. `driver.execute(decision, { live, frame })` → sport-mode calls + Nav2 goals. `speech` → TTS.

## SENSORS → FRAME

| frame field | source on the Go2 |
|---|---|
| `pose {x,y,yaw}` | Nav2/SLAM TF (map frame), or sport-mode odometry |
| `ranges [front,left,back,right]` | LiDAR (L1/Mid360) → `rangesFromScan()` (nearest obstacle per 90°) |
| `battery` | `bms_state` state-of-charge % |
| `imu {roll,pitch}` | IMU (used for the tilt veto) |
| `mode` | sport-mode state: `down`/`standing`/`moving`/`estop` |
| `safety` | derived: `estop` if latched, else `active` when armed+upright, else `idle` |
| `visible[]` | camera → a perception model (YOLO/etc on the Jetson) → `{name,distance_m,bearing_deg,category,dynamic}` |

## DECISION → GO2

| intent | Go2 sport-mode / Nav2 |
|---|---|
| `halt` | `StopMove()` — always allowed; also the **network-loss fail-safe** |
| `stand` | `StandUp()` → `BalanceStand()` |
| `sit` | `StandDown()` |
| `set_body_height(m)` | `BodyHeight(m − 0.30)` (Go2 wants a **relative** offset; input clamped 0.18–0.34) |
| `look_at(name)` | resolve bearing from `visible`; small yaw → `Euler(0,0,b)`, large → `Move(0,0,±turn)`. Not visible → fail, **no blind spin** |
| `go_to_pose(x,y)` | Nav2 `NavigateToPose` goal — Nav2 owns global path + obstacle avoidance |
| `gesture(name)` | canned sport action (`GESTURES` table: nod→Hello, wag→WiggleHips, …) |
| `speak(text)` | TTS (outside the driver) |

## Safety boundary (non-negotiable)

- **Hard safety is ONBOARD and never gated by the network.** E-STOP, tilt, battery-critical, foot-slip run on
  the robot regardless of what `/decide` says or whether it answered at all.
- The driver **re-checks every intent against the live body state** (`bodyAllows`) before moving — the body has
  the final veto even when the decider (or the mouth) said `ok`.
- **`EMERGENCY` short-circuits everything**: immediate `StopMove()`, all other intents skipped.
- **Network-loss fail-safe:** if `/decide` doesn't answer within the loop deadline, the node issues `StopMove()`
  and holds (the sidecar is advisory; onboard reflexes keep her safe).

## What's a mock today → what it is on hardware

- `sdk` mock → `unitree_sdk2` SportClient (DDS/CycloneDDS).
- `nav` mock → Nav2 `NavigateToPose` action client.
- `frameFromSensors` inputs → ROS 2 topics (odom/TF, `/scan` or point cloud, `bms_state`, camera + detector).
- `/decide` sidecar → runs on the Jetson Orin companion (or offboard on the LAN).
