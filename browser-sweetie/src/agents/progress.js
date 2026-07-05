// A tiny, reusable PROGRESS BAR for long runs — the same one the Disorders Lab, a headless harness, and any future
// batch job share. Environment-agnostic: point it at a DOM node (sets textContent), a function (gets each line), or
// leave it to auto-pick — an in-place `\r` line in Node, console.log in a bare browser. Tracks a live ETA. No deps.

const defaultNow = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function resolveSink(sink) {
  if (typeof sink === "function") return sink;
  if (sink && typeof sink === "object" && "textContent" in sink) return (s) => { sink.textContent = s; };        // a DOM node
  if (typeof process !== "undefined" && process.stdout && process.stdout.write) return (s, done) => process.stdout.write("\r" + s + (done ? "\n" : "")); // Node, in place
  return (s) => { if (typeof console !== "undefined") console.log(s); };
}

const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);

export function makeProgress({ total = 100, label = "", width = 24, sink = null, now = defaultNow } = {}) {
  const start = now();
  let current = 0, lastLine = "";
  const write = resolveSink(sink);

  function compose(done = false) {
    const frac = total > 0 ? Math.min(1, current / total) : 1;
    const filled = Math.round(frac * width);
    const gauge = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled)); // █ / ░
    const el = (now() - start) / 1000;
    const eta = done ? `· ${fmtSecs(el)}` : (current > 0 ? `· ETA ${fmtSecs(el * (total - current) / current)}` : "");
    return `${label ? label + " " : ""}[${gauge}] ${Math.round(frac * 100)}% · ${current}/${total} ${eta}`.trim();
  }

  return {
    tick(n = 1) { current = Math.min(total, current + n); lastLine = compose(); write(lastLine, false); return current; },
    set(n) { current = Math.max(0, Math.min(total, n)); lastLine = compose(); write(lastLine, false); return current; },
    done(msg = "") { current = total; lastLine = compose(true) + (msg ? ` · ${msg}` : ""); write(lastLine, true); return lastLine; },
    line: () => lastLine,
    value: () => current,
    total,
  };
}
