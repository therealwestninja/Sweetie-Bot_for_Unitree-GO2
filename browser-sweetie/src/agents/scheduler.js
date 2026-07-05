// Generation scheduler — one gate in front of ALL model calls in the colony. Without it, N bots each firing
// their own fetch would stampede Ollama (which the project rules say to treat gently). With it, generations
// are serialised (concurrency cap), PRIORITISED (a booth reply outranks idle gossip re-wording), rate-limited
// (a min interval between starts), and — crucially — the physics loop never waits on any of it: you enqueue
// and get a promise, the bodies keep ticking, and the reply attaches whenever it resolves.
//
// It also supports STALE-SKIP (commit-point revalidation, same idea as the idle driver): a job carries an
// optional `stale()` predicate; if it's no longer relevant when it reaches the front (the bot walked off, the
// conversation moved on), it's dropped unrun. DI clock+defer so it's deterministically testable.

export function makeScheduler({ concurrency = 1, minIntervalMs = 0, now = () => 0, defer = (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); } } = {}) {
  const q = [];
  let inFlight = 0, lastStart = -Infinity, seq = 0, cancelRepump = null, dropped = 0, ran = 0;

  function pump() {
    if (cancelRepump) { cancelRepump(); cancelRepump = null; }
    while (inFlight < concurrency && q.length) {
      const wait = minIntervalMs - (now() - lastStart);
      if (wait > 0) { cancelRepump = defer(pump, wait); return; }        // too soon → re-pump after the gap
      q.sort((a, b) => b.priority - a.priority || a.seq - b.seq);        // highest priority, then FIFO
      const job = q.shift();
      if (job.stale && job.stale()) { dropped++; job.resolve(null); continue; } // no longer relevant → drop
      inFlight++; lastStart = now(); ran++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { inFlight--; pump(); });
    }
  }

  return {
    // Enqueue a unit of work. `run` is an async fn (the actual model call); returns a promise that resolves
    // with run's result, or null if the job was dropped as stale. Higher priority runs sooner.
    enqueue({ run, priority = 0, stale = null, tag = null } = {}) {
      return new Promise((resolve, reject) => { q.push({ run, priority, stale, tag, seq: seq++, resolve, reject }); pump(); });
    },
    stats: () => ({ queued: q.length, inFlight, ran, dropped }),
    get inFlight() { return inFlight; },
    get queued() { return q.length; },
  };
}
