"""
Go2 WebRTC AES-128 key handling.

Recent Go2 firmware (V3-capable, Go2 >= 1.1.15) encrypts the WebRTC signaling
with a **per-device AES-128 key** (the `data2=3` auth flow). That key is *not*
something we mint — it is provisioned by Unitree and tied to the robot/owner
account. The supported way to obtain it is the official tooling
(`unitree-fetch-aes-key`, exposed by `unitree_webrtc_connect.fetch_aes_key`),
which authenticates with the owner's account. This module does NOT reimplement
that crypto or attempt to derive/recover a device key — it only:

  * loads a key you already have (`UNITREE_AES_128_KEY` env, or passed in),
  * validates/normalizes its format (128-bit, hex or base64),
  * delegates fetching to the official library if installed, and
  * can *generate* a fresh random 128-bit key — for your own uses (local test
    transports, encrypting Sweetie's own data at rest), NOT for impersonating a
    Go2. A generated key will not authenticate to a real robot.

This keeps the WebRTC transport ready to plug a real key into, on the right side
of the line: we manage the owner's legitimate key, we don't crack one.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import secrets

logger = logging.getLogger(__name__)

ENV_VAR = "UNITREE_AES_128_KEY"
KEY_BYTES = 16  # AES-128


def normalize_aes_key(key: str | bytes) -> str:
    """Validate a 128-bit key and return canonical lowercase hex (32 chars).

    Accepts 32-char hex, 16 raw bytes, or base64 of 16 bytes. Raises ValueError
    on anything that isn't exactly 128 bits."""
    if isinstance(key, bytes):
        raw = key
    else:
        s = key.strip()
        # try hex first (32 hex chars), then base64
        try:
            if len(s) == KEY_BYTES * 2:
                raw = bytes.fromhex(s)
            else:
                raise ValueError
        except ValueError:
            try:
                raw = base64.b64decode(s, validate=True)
            except (binascii.Error, ValueError) as e:
                raise ValueError("AES key is neither 32-char hex nor valid base64") from e
    if len(raw) != KEY_BYTES:
        raise ValueError(f"AES-128 key must be {KEY_BYTES} bytes, got {len(raw)}")
    return raw.hex()


def generate_aes_key() -> str:
    """Mint a fresh random 128-bit key (hex). For your own transports/tests —
    a generated key will NOT authenticate to a real Go2 (its key is
    device-provisioned)."""
    return secrets.token_hex(KEY_BYTES)


def fetch_device_key(fetcher=None, **kwargs) -> str:
    """Obtain the robot's per-device key via the official flow.

    Delegates to a provided `fetcher(**kwargs)` callable, else to
    `unitree_webrtc_connect.fetch_aes_key` if installed. Never derives a key
    locally — if neither is available, raise with guidance."""
    if fetcher is not None:
        return normalize_aes_key(fetcher(**kwargs))
    try:
        from unitree_webrtc_connect import fetch_aes_key  # type: ignore[import-not-found]
    except Exception as e:
        raise RuntimeError(
            "No AES-key fetcher available. Install `unitree_webrtc_connect` and use "
            "its `fetch_aes_key` / the `unitree-fetch-aes-key` CLI (authenticates with "
            "your Unitree account), then pass the key via the "
            f"{ENV_VAR} env var or set_aes_key()."
        ) from e
    return normalize_aes_key(fetch_aes_key(**kwargs))


def resolve_aes_key(explicit: str | bytes | None = None, *,
                    env_var: str = ENV_VAR, fetcher=None,
                    allow_fetch: bool = False) -> str | None:
    """Resolve the key by precedence: explicit -> env -> (optional) fetch.

    Returns canonical hex, or None if nothing is configured (older firmware /
    AP mode may not need a key). Only contacts the fetcher when allow_fetch."""
    if explicit is not None:
        return normalize_aes_key(explicit)
    env = os.getenv(env_var)
    if env:
        return normalize_aes_key(env)
    if allow_fetch:
        return fetch_device_key(fetcher=fetcher)
    return None
