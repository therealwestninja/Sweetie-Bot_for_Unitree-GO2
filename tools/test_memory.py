"""MemoryStore tests — direct, against a temp DB."""

from __future__ import annotations

import pytest

from sweetie.cognition.memory import MemoryStore


@pytest.fixture
def store(tmp_path):
    """Fresh MemoryStore at a temp path. Closed automatically on teardown."""
    s = MemoryStore(path=tmp_path / "test_memory.db")
    yield s
    s.close()


# ── Schema bring-up ────────────────────────────────────────────────────────


def test_opens_creates_directory(tmp_path):
    """MemoryStore creates parent dir if it doesn't exist."""
    nested = tmp_path / "a" / "b" / "c" / "memory.db"
    s = MemoryStore(path=nested)
    try:
        assert nested.exists()
        assert nested.parent.exists()
    finally:
        s.close()


def test_open_twice_idempotent(tmp_path):
    """Opening the DB a second time doesn't error or wipe data."""
    s1 = MemoryStore(path=tmp_path / "m.db")
    s1.propose_fact("first fact", "world")
    s1.close()

    s2 = MemoryStore(path=tmp_path / "m.db")
    try:
        facts = s2.list_facts(status="pending")
        assert len(facts) == 1
        assert facts[0]["content"] == "first fact"
    finally:
        s2.close()


# ── Fact proposal / approval / rejection ──────────────────────────────────


def test_propose_fact_lands_pending(store):
    fid = store.propose_fact("Steve likes the apartment", "supervisor")
    facts = store.list_facts()
    assert len(facts) == 1
    assert facts[0]["id"] == fid
    assert facts[0]["status"] == "pending"
    assert facts[0]["content"] == "Steve likes the apartment"
    assert facts[0]["category"] == "supervisor"


def test_propose_fact_rejects_empty_content(store):
    with pytest.raises(ValueError):
        store.propose_fact("   ", "supervisor")


def test_propose_fact_rejects_invalid_category(store):
    with pytest.raises(ValueError):
        store.propose_fact("a fact", "not-a-category")


def test_approve_fact(store):
    fid = store.propose_fact("Pixel is the cat", "world")
    assert store.approve_fact(fid) is True
    approved = store.list_facts(status="approved")
    assert len(approved) == 1
    assert approved[0]["id"] == fid


def test_approve_fact_with_edit(store):
    fid = store.propose_fact("Pixel is the cat", "world")
    store.approve_fact(fid, edited_content="Pixel is the cat (likely a cat)")
    facts = store.list_facts(status="approved")
    assert facts[0]["content"] == "Pixel is the cat (likely a cat)"


def test_approve_unknown_id_returns_false(store):
    assert store.approve_fact(9999) is False


def test_reject_fact(store):
    fid = store.propose_fact("a fact", "world")
    assert store.reject_fact(fid) is True
    assert store.list_facts(status="approved") == []
    assert len(store.list_facts(status="rejected")) == 1


def test_update_approved_fact(store):
    fid = store.propose_fact("vague fact", "world")
    store.approve_fact(fid)
    assert store.update_fact(fid, "specific fact about the world")
    facts = store.list_facts(status="approved")
    assert facts[0]["content"] == "specific fact about the world"


def test_delete_fact(store):
    fid = store.propose_fact("oops", "world")
    assert store.delete_fact(fid) is True
    assert store.list_facts() == []


# ── Listing / filtering ────────────────────────────────────────────────────


def test_list_filtered_by_status_and_category(store):
    a = store.propose_fact("A about supervisor", "supervisor")
    b = store.propose_fact("B about world", "world")
    c = store.propose_fact("C about world", "world")
    store.approve_fact(a)
    store.approve_fact(b)
    # c remains pending

    sup_approved = store.list_facts(status="approved", category="supervisor")
    assert len(sup_approved) == 1 and sup_approved[0]["id"] == a

    world_pending = store.list_facts(status="pending", category="world")
    assert len(world_pending) == 1 and world_pending[0]["id"] == c

    all_approved = store.list_facts(status="approved")
    assert len(all_approved) == 2


def test_list_invalid_filter_raises(store):
    with pytest.raises(ValueError):
        store.list_facts(status="bogus")
    with pytest.raises(ValueError):
        store.list_facts(category="bogus")


def test_count_facts(store):
    store.propose_fact("a", "world")
    store.propose_fact("b", "world")
    fid = store.propose_fact("c", "world")
    store.approve_fact(fid)
    assert store.count_facts() == 3
    assert store.count_facts(status="pending") == 2
    assert store.count_facts(status="approved") == 1


# ── Batch ops ──────────────────────────────────────────────────────────────


def test_approve_all_pending_only_touches_pending(store):
    a = store.propose_fact("a", "world")
    b = store.propose_fact("b", "world")
    c = store.propose_fact("c", "world")
    store.reject_fact(c)  # already rejected — should be untouched

    n = store.approve_all_pending()
    assert n == 2
    assert store.count_facts(status="approved") == 2
    assert store.count_facts(status="rejected") == 1


def test_reject_all_pending(store):
    store.propose_fact("a", "world")
    store.propose_fact("b", "world")
    n = store.reject_all_pending()
    assert n == 2
    assert store.count_facts(status="pending") == 0
    assert store.count_facts(status="rejected") == 2


# ── Episodes ───────────────────────────────────────────────────────────────


def test_start_and_end_episode(store):
    eid = store.start_episode()
    assert eid > 0
    assert store.list_recent_episodes() == []  # not yet closed

    ok = store.end_episode_with_summary(eid, "we explored the apartment", "recalled")
    assert ok is True
    eps = store.list_recent_episodes()
    assert len(eps) == 1
    assert eps[0]["summary"] == "we explored the apartment"
    assert eps[0]["end_reason"] == "recalled"


def test_end_episode_idempotent(store):
    """Closing an already-closed episode returns False, doesn't overwrite."""
    eid = store.start_episode()
    store.end_episode_with_summary(eid, "first summary", "battery_low")
    second = store.end_episode_with_summary(eid, "second summary", "shutdown")
    assert second is False
    eps = store.list_recent_episodes()
    assert eps[0]["summary"] == "first summary"
    assert eps[0]["end_reason"] == "battery_low"


def test_end_episode_invalid_reason(store):
    eid = store.start_episode()
    with pytest.raises(ValueError):
        store.end_episode_with_summary(eid, "summary", "made-up-reason")


def test_list_recent_episodes_excludes_open(store):
    e1 = store.start_episode()
    e2 = store.start_episode()
    store.end_episode_with_summary(e1, "closed one", "shutdown")
    eps = store.list_recent_episodes()
    assert len(eps) == 1
    assert eps[0]["id"] == e1


def test_list_recent_episodes_respects_limit(store):
    for i in range(7):
        eid = store.start_episode()
        store.end_episode_with_summary(eid, f"summary {i}", "shutdown")
    eps = store.list_recent_episodes(limit=3)
    assert len(eps) == 3
    # most-recent-first
    assert eps[0]["summary"] == "summary 6"


def test_delete_episode(store):
    eid = store.start_episode()
    store.end_episode_with_summary(eid, "to forget", "manual")
    assert store.delete_episode(eid) is True
    assert store.list_recent_episodes() == []


# ── Forget / bulk delete ───────────────────────────────────────────────────


def test_forget_all_wipes_both_tables(store):
    fid = store.propose_fact("a", "world")
    store.approve_fact(fid)
    eid = store.start_episode()
    store.end_episode_with_summary(eid, "s", "shutdown")

    counts = store.forget_all()
    assert counts["facts"] == 1
    assert counts["episodes"] == 1
    assert store.list_facts() == []
    assert store.list_recent_episodes() == []


def test_forget_pending_only_drops_pending(store):
    a = store.propose_fact("a", "world")
    b = store.propose_fact("b", "world")
    store.approve_fact(a)
    # b stays pending

    n = store.forget_pending_facts()
    assert n == 1
    # Approved fact survives
    assert store.count_facts(status="approved") == 1
    assert store.count_facts(status="pending") == 0


def test_forget_episodes_does_not_touch_facts(store):
    fid = store.propose_fact("survives", "world")
    store.approve_fact(fid)
    eid = store.start_episode()
    store.end_episode_with_summary(eid, "doomed", "shutdown")

    n = store.forget_episodes()
    assert n == 1
    assert store.count_facts() == 1


# ── Source session linkage ─────────────────────────────────────────────────


def test_propose_fact_records_source_session(store):
    eid = store.start_episode()
    fid = store.propose_fact(
        "discovered during this session", "world", source_session=eid,
    )
    facts = store.list_facts()
    assert facts[0]["source_session"] == eid


# ── Cognition integration: remember tool, prompt block, summarize_session ──


@pytest.mark.asyncio
async def test_remember_tool_proposes_fact(monkeypatch, tmp_path):
    from sweetie.cognition.llm import Cognition
    from sweetie.core.bridge import SimBridge
    from sweetie.core.bus import bus
    from sweetie.core.safety import SafetyGuard

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    store = MemoryStore(path=tmp_path / "m.db")
    cog = Cognition(
        bridge=SimBridge(),
        safety=SafetyGuard(),
        memory_store=store,
        episode_id=1,
    )

    pendings: list[dict] = []

    async def collect(p):
        pendings.append(p)

    bus.subscribe("memory_pending", collect)
    try:
        result = await cog._do_remember(
            {"fact": "Steve likes the apartment", "category": "supervisor"}
        )
        assert "ok" in result
        # Bus event fired
        assert pendings and pendings[0]["fact"] == "Steve likes the apartment"
        # Fact landed in DB as pending
        facts = store.list_facts(status="pending")
        assert len(facts) == 1
        assert facts[0]["source_session"] == 1
    finally:
        bus._subs.clear()
        store.close()


@pytest.mark.asyncio
async def test_remember_tool_rejects_invalid_category(monkeypatch, tmp_path):
    from sweetie.cognition.llm import Cognition
    from sweetie.core.bridge import SimBridge
    from sweetie.core.safety import SafetyGuard

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    store = MemoryStore(path=tmp_path / "m.db")
    cog = Cognition(
        bridge=SimBridge(),
        safety=SafetyGuard(),
        memory_store=store,
        episode_id=1,
    )
    try:
        result = await cog._do_remember(
            {"fact": "something", "category": "made-up"}
        )
        assert result.startswith("error:")
        assert store.count_facts() == 0
    finally:
        store.close()


@pytest.mark.asyncio
async def test_remember_tool_no_op_when_no_store(monkeypatch):
    from sweetie.cognition.llm import Cognition
    from sweetie.core.bridge import SimBridge
    from sweetie.core.safety import SafetyGuard

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cog = Cognition(bridge=SimBridge(), safety=SafetyGuard())  # no memory_store
    result = await cog._do_remember(
        {"fact": "nowhere to go", "category": "world"}
    )
    assert "no-op" in result


def test_prompt_includes_approved_memory_block(tmp_path):
    """A prompt built with a memory store should include the 'what you
    remember' block, listing approved facts and recent episodes."""
    from sweetie.cognition.llm import build_system_prompt

    store = MemoryStore(path=tmp_path / "m.db")
    try:
        # Approved fact
        a = store.propose_fact("Steve is the supervisor's name", "supervisor")
        store.approve_fact(a)
        # Pending fact — should NOT appear
        store.propose_fact("the cat is named pixel", "world")
        # Closed episode
        eid = store.start_episode()
        store.end_episode_with_summary(
            eid, "we explored the agility area together", "recalled"
        )

        prompt = build_system_prompt(memory_store=store)
        assert "What you remember" in prompt
        assert "Steve is the supervisor's name" in prompt
        # Pending fact must not leak
        assert "pixel" not in prompt.lower()
        # Episode summary appears
        assert "agility area" in prompt
        # Honest framing about imperfect recall
        assert "I think we did" in prompt or "something like that" in prompt
    finally:
        store.close()


def test_prompt_omits_block_when_no_memory(tmp_path):
    """No memory store, or empty memory store, should not insert the block."""
    from sweetie.cognition.llm import build_system_prompt

    p1 = build_system_prompt()  # no store at all
    assert "What you remember" not in p1

    store = MemoryStore(path=tmp_path / "m.db")
    try:
        p2 = build_system_prompt(memory_store=store)  # empty store
        assert "What you remember" not in p2
    finally:
        store.close()


def test_prompt_groups_facts_by_category(tmp_path):
    """The memory block should label categories: supervisor, world,
    behavior, relationship."""
    from sweetie.cognition.llm import build_system_prompt

    store = MemoryStore(path=tmp_path / "m.db")
    try:
        for content, cat in [
            ("their name is Sam", "supervisor"),
            ("the agility area is hilly", "world"),
            ("I tend to start by exploring", "behavior"),
            ("Sam likes when I narrate", "relationship"),
        ]:
            fid = store.propose_fact(content, cat)
            store.approve_fact(fid)

        prompt = build_system_prompt(memory_store=store)
        assert "About your supervisor" in prompt
        assert "About the world" in prompt
        assert "About yourself" in prompt
        assert "About you and them" in prompt
    finally:
        store.close()


@pytest.mark.asyncio
async def test_summarize_session_returns_none_without_api_key(monkeypatch, tmp_path):
    from sweetie.cognition.llm import Cognition
    from sweetie.core.bridge import SimBridge
    from sweetie.core.safety import SafetyGuard

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    store = MemoryStore(path=tmp_path / "m.db")
    eid = store.start_episode()
    cog = Cognition(
        bridge=SimBridge(),
        safety=SafetyGuard(),
        memory_store=store,
        episode_id=eid,
    )
    try:
        result = await cog.summarize_session("recalled")
        assert result is None
    finally:
        store.close()


# ── Session lifecycle integration ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_battery_low_ends_session_exactly_once(monkeypatch, tmp_path):
    """When battery drops below threshold, _end_session fires once.
    Subsequent battery-low ticks must not fire it again."""
    monkeypatch.setenv("SWEETIE_MEMORY_DB", str(tmp_path / "m.db"))
    monkeypatch.setenv("SWEETIE_AUTONOMY", "off")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    # Reload server module fresh — it reads env at import time.
    import sys
    for mod in list(sys.modules.keys()):
        if mod.startswith("sweetie."):
            del sys.modules[mod]
    from sweetie.teleop import server as srv

    # Manually drive the lifecycle path. Force battery low.
    srv._battery_low_triggered = False
    srv._session_ended = False
    srv._session_lock = __import__("asyncio").Lock()

    await srv._end_session("battery_low")
    assert srv._session_ended is True

    # Calling again is a no-op (idempotent).
    await srv._end_session("battery_low")
    # Episode count should still be exactly 1, with 1 closed
    eps = srv._memory.list_recent_episodes()
    assert len(eps) == 1
    assert eps[0]["end_reason"] == "battery_low"

    if srv._memory is not None:
        srv._memory.close()


@pytest.mark.asyncio
async def test_supervisor_recall_ends_session(monkeypatch, tmp_path):
    """The 'recall' end reason is also closes the episode correctly."""
    monkeypatch.setenv("SWEETIE_MEMORY_DB", str(tmp_path / "m.db"))
    monkeypatch.setenv("SWEETIE_AUTONOMY", "off")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    import sys
    for mod in list(sys.modules.keys()):
        if mod.startswith("sweetie."):
            del sys.modules[mod]
    from sweetie.teleop import server as srv

    srv._session_ended = False
    srv._session_lock = __import__("asyncio").Lock()

    await srv._end_session("recalled")
    eps = srv._memory.list_recent_episodes()
    assert len(eps) == 1
    assert eps[0]["end_reason"] == "recalled"

    if srv._memory is not None:
        srv._memory.close()
