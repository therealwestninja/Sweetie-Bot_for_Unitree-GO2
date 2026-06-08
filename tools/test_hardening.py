"""Tests for the GitHub-mined hardening: AES key handling, SDK-call
serialization, and the pluggable LiDAR decoder seam. All synthetic."""

from __future__ import annotations

import asyncio
import base64

import pytest

from sweetie.core import go2_keys


# ── AES key ──────────────────────────────────────────────────────────────────


def test_normalize_accepts_hex_bytes_base64():
    raw = bytes(range(16))
    h = raw.hex()
    assert go2_keys.normalize_aes_key(h) == h
    assert go2_keys.normalize_aes_key(raw) == h
    assert go2_keys.normalize_aes_key(base64.b64encode(raw).decode()) == h


def test_normalize_rejects_wrong_length():
    with pytest.raises(ValueError):
        go2_keys.normalize_aes_key("deadbeef")          # 4 bytes
    with pytest.raises(ValueError):
        go2_keys.normalize_aes_key("not a key!!")


def test_generate_is_128_bit_hex_and_random():
    a, b = go2_keys.generate_aes_key(), go2_keys.generate_aes_key()
    assert len(a) == 32 and len(b) == 32
    assert go2_keys.normalize_aes_key(a) == a
    assert a != b


def test_resolve_precedence(monkeypatch):
    raw = bytes(range(16)).hex()
    # explicit wins
    monkeypatch.setenv(go2_keys.ENV_VAR, go2_keys.generate_aes_key())
    assert go2_keys.resolve_aes_key(raw) == raw
    # env when no explicit
    monkeypatch.setenv(go2_keys.ENV_VAR, raw)
    assert go2_keys.resolve_aes_key() == raw
    # none configured + no fetch -> None
    monkeypatch.delenv(go2_keys.ENV_VAR, raising=False)
    assert go2_keys.resolve_aes_key() is None


def test_resolve_uses_fetcher_only_when_allowed(monkeypatch):
    monkeypatch.delenv(go2_keys.ENV_VAR, raising=False)
    key = go2_keys.generate_aes_key()
    called = {"n": 0}

    def fake_fetcher(**kw):
        called["n"] += 1
        return key

    # not allowed -> fetcher untouched
    assert go2_keys.resolve_aes_key(fetcher=fake_fetcher) is None
    assert called["n"] == 0
    # allowed -> fetcher used
    assert go2_keys.resolve_aes_key(fetcher=fake_fetcher, allow_fetch=True) == key
    assert called["n"] == 1


# ── LiDAR decoder seam ──────────────────────────────────────────────────────


def test_registered_decoder_is_preferred_then_fallback():
    from sweetie.core import lidar_map
    try:
        lidar_map.register_voxel_decoder(lambda msg: [(9.0, 9.0, 0.5)])
        assert lidar_map.decode_voxel_map(object()) == [(9.0, 9.0, 0.5)]
        # a decoder that returns nothing -> falls back to built-in parsing
        lidar_map.register_voxel_decoder(lambda msg: [])
        assert lidar_map.decode_voxel_map([(1.0, 2.0, 3.0)]) == [(1.0, 2.0, 3.0)]
    finally:
        lidar_map.register_voxel_decoder(None)  # reset global


# ── SDK-call serialization ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sdk_calls_are_serialized():
    """Two concurrent _sdk_call invocations must not overlap (the SDK isn't
    concurrency-safe). We track peak concurrency through a blocking fake fn."""
    from unittest.mock import patch, MagicMock
    from sweetie.core.real_bridge import RealBridge

    sdk = {
        "ChannelFactoryInitialize": MagicMock(),
        "ChannelSubscriber": MagicMock(return_value=MagicMock()),
        "SportClient": MagicMock(return_value=MagicMock()),
        "SportModeState_": MagicMock,
        "LowState_": MagicMock,
    }
    state = {"cur": 0, "peak": 0}
    import time

    def blocking_fn():
        state["cur"] += 1
        state["peak"] = max(state["peak"], state["cur"])
        time.sleep(0.05)
        state["cur"] -= 1
        return 0

    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        b = RealBridge()
        await b.connect()
        results = await asyncio.gather(*[b._sdk_call(blocking_fn) for _ in range(4)])
        assert all(results)
        assert state["peak"] == 1  # never two SDK calls at once
        await b.disconnect()
