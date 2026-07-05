// Sweetie /decide sidecar — the portable cognition core as an HTTP service. A real Unitree Go2 (onboard compute
// is modest) POSTs its telemetry frame here; the spiking brain + mouth run off-board and return motor INTENTS
// the robot executes with its own actuators + safety. This is the whole test-platform bet made concrete: the
// exact brain that drove the browser sim now answers a robot over the wire, unchanged.
//
//   GET  /health           → { ok, mouth }
//   POST /decide  { frame, prompt? } → a decision { arc, speech, intents:[{tool,args,ok,reason?}], emergency, ... }
//
// Run:  OLLAMA=1 node harness/sidecar.mjs      (mouth on; needs local Ollama)   |   node harness/sidecar.mjs (onboard-only)
import http from "node:http";
import { makeDecider } from "../src/decider.js";
import { makeOllamaMouth } from "./actor.mjs";

const mouth = process.env.OLLAMA ? makeOllamaMouth({ model: process.env.OLLAMA_MODEL || "gemma4:latest" }) : null;
const decider = makeDecider({ backend: mouth });
const PORT = +(process.env.PORT || 8130);

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, mouth: !!mouth });
  if (req.method === "POST" && req.url === "/decide") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => { try { const { frame = {}, prompt = null } = JSON.parse(body || "{}"); send(200, await decider.decide(frame, { prompt })); } catch (e) { send(400, { error: e.message }); } });
    return;
  }
  send(404, { error: "GET /health or POST /decide { frame, prompt? }" });
});

server.listen(PORT, () => console.log(`Sweetie /decide sidecar on :${PORT} — mouth: ${mouth ? "ollama" : "onboard-only"}`));
