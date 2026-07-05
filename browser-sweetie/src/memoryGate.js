// Memory approval gate — W3's genuinely-new build (new-build #1). The brain's declarative store writes a
// fact the moment it's proposed, but a fact the ROBOT proposes about the world/you shouldn't silently become
// ground truth she'll act on. So a model-proposed fact lands with stateRole "pending": the store's default
// recall (state:"current") already filters it out, so it can't ground a reply until a supervisor APPROVES it,
// which flips it to "current". Rejecting removes it. Facts YOU author are trusted → straight to "current".
//
// This reuses NM2a stateRole (current/historical/transition) — we just add "pending" as a pre-current stage.
// Thin wrapper over declarativeStore: no new persistence, no new recall path, so approved facts ground replies
// through the exact same hybrid recall the chat brain uses. Pure async logic; storage/embedder are injected.

export function makeMemoryGate({ store } = {}) {
  return {
    // The robot proposes a fact it inferred → quarantined as "pending" (invisible to recall until approved).
    async proposeModel(text, { tags = [], sig = null } = {}) {
      const f = await store.addFact(text, { source: "model", tags, sig });
      await store.update(f.id, { stateRole: "pending" });
      return { ...f, stateRole: "pending" };
    },
    // A supervisor-authored fact is trusted → straight to "current" (recallable immediately).
    async addUserFact(text, { tags = [], pinned = false, sig = null } = {}) {
      return store.addFact(text, { source: "user", tags, pinned, sig });
    },

    // The tray the supervisor reviews — newest first.
    pending() {
      return store.list({ type: "fact" }).filter((r) => r.stateRole === "pending").sort((a, b) => b.timestamp - a.timestamp);
    },
    // Approved, live facts (what actually grounds replies).
    facts() {
      return store.list({ type: "fact" }).filter((r) => (r.stateRole || "current") === "current").sort((a, b) => b.timestamp - a.timestamp);
    },
    pendingCount() { return this.pending().length; },

    // Supervisor verdicts.
    approve(id) { return store.update(id, { stateRole: "current" }); },
    reject(id) { return store.remove(id); },
    // Retract an already-approved fact WITHOUT losing history (kept "historical", out of recall) — reversible.
    retract(id) { return store.update(id, { stateRole: "historical" }); },

    // Grounding: only current facts ever surface. This is the SAME recall the mouth reads for context, so a
    // pending fact provably cannot influence a reply until approved.
    recall(query, k = 3, opts = {}) { return store.recall(query, k, { ...opts, state: "current" }); },

    store,
  };
}
