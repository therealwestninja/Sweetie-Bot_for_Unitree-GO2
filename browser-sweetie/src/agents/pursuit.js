// Pursuit — the deliberate TASK layer that sits ON TOP of the emergent creature (it does NOT replace the
// spiking substrate; a bot still broods and drifts underneath). It consolidates the genuinely-useful parts of
// the two architecture specs for this project, and drops the rest:
//   KEPT   → L1 hard INVARIANTS + a SHORTCUT FILTER (the means matter, not just the ends); L3 VERIFY-against-
//            reality (no hallucinated progress) + typed errors + an audit TRACE; L4 a progress WATCHDOG +
//            step budget (no loop-of-death); L2 as a TASK loop only (act→verify→replan), never as cognition.
//   DROPPED → tokenomics/escrow, crypto signing/ZK proofs, DAG-planner-as-mind, trustless-swarm ceremony
//            (one trusted process; coordination is social, per Float-knights).
// Fully dependency-injected so it drives the robot's motor codec in the sim and is deterministically testable.

export const ErrorType = { NONE: "none", BLOCKED: "blocked", TIMEOUT: "timeout", MISMATCH: "mismatch", FATAL: "fatal" };
const RETRYABLE = new Set([ErrorType.BLOCKED, ErrorType.TIMEOUT]);

// A goal is { steps: [{ action, describe?, ...args }], measure?(state)->number }. `measure` (optional) reports
// task progress so the watchdog can tell "working" from "spinning". Hooks: act(step,ctx) executes; verify(step,
// ctx)->{ok,state,error?} checks REALITY; invariants:[(step,ctx)->{violated,reason}?]; shortcutFilter(step,
// verified,ctx)->{rejected,reason}?; replan(step,type,ctx)->newSteps|null; classify(verified)->ErrorType.
export function makePursuit({ act, verify, invariants = [], shortcutFilter = null, replan = null, classify = null, budget = {}, now = () => 0 } = {}) {
  const B = { steps: 40, retries: 2, noProgress: 6, ...budget };
  const classifyErr = classify || ((v) => v.error || ErrorType.MISMATCH);

  return {
    async run(goal, ctx = {}) {
      const trace = [];
      let steps = goal.steps ? [...goal.steps] : [];
      const measure = goal.measure || null;
      let stepBudget = B.steps, bestProgress = -Infinity, sinceProgress = 0;
      const finish = (status, reason) => ({ status, reason, trace, executed: trace.filter((e) => e.result === "verified").length });

      while (steps.length) {
        if (stepBudget-- <= 0) return finish("aborted", "step budget exhausted (loop-of-death guard)");
        const step = steps.shift();
        const entry = { step: step.describe || step.action, at: now() };

        // L1 — hard invariants that reasoning cannot bypass (budget caps, boundaries, permissions)
        const viol = invariants.map((inv) => inv(step, ctx)).find((r) => r && r.violated);
        if (viol) { entry.result = "rejected-invariant"; entry.reason = viol.reason; trace.push(entry); return finish("aborted", `invariant: ${viol.reason}`); }

        // L4 execute + L3 verify against REALITY (with bounded retries on retryable failures)
        let verified = null, attempt = 0, replanned = false;
        for (;;) {
          await act(step, ctx);
          verified = await verify(step, ctx);                    // the actual world state, NOT the bot's claim
          if (verified.ok) break;
          const type = classifyErr(verified); entry.error = type;
          if (RETRYABLE.has(type) && attempt < B.retries) { attempt++; continue; }
          if (replan) { const np = await replan(step, type, ctx); if (np && np.length) { steps = np; entry.result = "replanned"; trace.push(entry); replanned = true; break; } }
          entry.result = "failed"; trace.push(entry); return finish(type === ErrorType.FATAL ? "aborted" : "escalated", `${type} on "${entry.step}"`);
        }
        if (replanned) continue;

        // L1 — SHORTCUT FILTER: even a "successful" step is rejected if it hit the target by a forbidden route
        if (shortcutFilter) { const sc = shortcutFilter(step, verified, ctx); if (sc && sc.rejected) { entry.result = "shortcut-rejected"; entry.reason = sc.reason; trace.push(entry); return finish("aborted", `shortcut: ${sc.reason}`); } }

        entry.result = "verified"; entry.state = verified.state; trace.push(entry);

        // L4 — progress watchdog: real progress resets the counter; spinning trips the loop-of-death guard
        if (measure) { const p = measure(verified.state); if (p > bestProgress + 1e-9) { bestProgress = p; sinceProgress = 0; } else if (++sinceProgress >= B.noProgress) return finish("escalated", "no progress (loop-of-death guard)"); }
      }
      return finish("done", "all steps verified");
    },
  };
}
