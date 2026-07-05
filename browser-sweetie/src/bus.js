// Tiny topic pub/sub (port of Legacy_Sweetie-Bot/core/bus.py). The seam the brain uses to receive body
// events (perception, zone_changed, telemetry) without tight coupling. Per-handler try/catch so one bad
// subscriber can't kill the loop. Sync (sim handlers do no I/O).
export function makeBus() {
  const topics = new Map(); // topic -> Set(handler)
  return {
    subscribe(topic, handler) { if (!topics.has(topic)) topics.set(topic, new Set()); topics.get(topic).add(handler); return () => this.unsubscribe(topic, handler); },
    unsubscribe(topic, handler) { const set = topics.get(topic); if (set) set.delete(handler); },
    publish(topic, payload) {
      const set = topics.get(topic);
      if (!set) return;
      for (const h of set) { try { h(payload); } catch (e) { /* isolate a bad handler */ if (typeof console !== "undefined") console.error("bus handler error on", topic, e); } }
    },
  };
}
