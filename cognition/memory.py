"""
Persistent memory store for sweetie.

Two tables — `facts` (things sweetie knows about the supervisor, the
world, herself, and the relationship) and `episodes` (one-paragraph
summaries of past sessions). Both backed by a single SQLite database
at `~/.sweetie/memory.db` by default; override with the `SWEETIE_MEMORY_DB`
env var or by passing `path=` explicitly.

Workflow for facts:
1. Sweetie calls the `remember` tool, which calls `propose_fact()`.
   Fact lands with `status='pending'`.
2. The supervisor sees it in the dashboard's pending tray and either
   approves, rejects, or edits-then-approves it.
3. Only `approved` facts are loaded into the system prompt at session
   start. `rejected` facts stay in the DB for audit; `pending` facts
   persist across sessions until the supervisor acts on them.

Workflow for episodes:
1. `start_episode()` returns a new episode id; called when the
   autonomy loop attaches.
2. `end_episode_with_summary()` is called on session end (battery low,
   explicit recall, or best-effort on shutdown) with a one-paragraph
   reflection from the LLM and an `end_reason`.
3. `list_recent_episodes(limit=N)` returns the most recent N for the
   "what you remember from prior sessions" prompt block.

The store is single-process by design — sweetie runs in one process,
one event loop. We enable `WAL` journal mode anyway because it's free
resilience against the supervisor poking the file with `sqlite3` from
a separate shell while sweetie is running.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)


VALID_CATEGORIES: frozenset[str] = frozenset({
    "supervisor",
    "world",
    "behavior",
    "relationship",
})

VALID_STATUSES: frozenset[str] = frozenset({"pending", "approved", "rejected"})

VALID_END_REASONS: frozenset[str] = frozenset({
    "battery_low",
    "recalled",
    "shutdown",
    "manual",
})


def _default_db_path() -> Path:
    """Resolve the default DB path with override priority:

    1. `SWEETIE_MEMORY_DB` env var (full path).
    2. `~/.sweetie/memory.db`.
    """
    env = os.getenv("SWEETIE_MEMORY_DB")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".sweetie" / "memory.db"


def _now_iso() -> str:
    """ISO-8601 timestamp with timezone, suitable for sqlite TEXT storage.

    Always UTC — the supervisor's local timezone is a presentation concern,
    not a storage one.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class MemoryStore:
    """SQLite-backed memory store. Thread-safe via a single per-store lock.

    Sweetie runs single-event-loop, single-process — but `sqlite3`
    connections are not safe to share across threads by default, and we
    occasionally do work from background tasks that may run in
    different threads. The lock keeps things simple.
    """

    SCHEMA_VERSION = 1

    def __init__(self, path: Path | str | None = None) -> None:
        self._path: Path = (
            Path(path).expanduser() if path is not None else _default_db_path()
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

        # `check_same_thread=False` because we serialize via _lock anyway,
        # and this lets background asyncio tasks share the connection
        # without per-thread setup boilerplate.
        self._conn = sqlite3.connect(
            str(self._path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we manage transactions manually
        )
        self._conn.row_factory = sqlite3.Row

        # WAL is more resilient to crashes and lets the supervisor read
        # the DB from a separate process while sweetie is running.
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._init_schema()

        logger.info("MemoryStore opened at %s", self._path)

    @property
    def path(self) -> Path:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ── Schema ─────────────────────────────────────────────────────────────

    def _init_schema(self) -> None:
        # All `IF NOT EXISTS` so opening the DB a second time is a no-op.
        # Foreign-key from facts→episodes is intentionally *not* enforced —
        # facts may be proposed during a session whose episode hasn't yet
        # been created in the DB (e.g. before the autonomy loop attaches).
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS facts (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                content         TEXT NOT NULL,
                category        TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'pending',
                source_session  INTEGER,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_facts_status   ON facts(status);
            CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);

            CREATE TABLE IF NOT EXISTS episodes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at  TEXT NOT NULL,
                ended_at    TEXT,
                summary     TEXT,
                end_reason  TEXT
            );

            CREATE TABLE IF NOT EXISTS schema_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        # Stamp schema version. Only matters if/when we need migrations.
        self._conn.execute(
            "INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)",
            ("schema_version", str(self.SCHEMA_VERSION)),
        )

    # ── Facts: proposal / approval / listing ───────────────────────────────

    def propose_fact(
        self,
        content: str,
        category: str,
        source_session: int | None = None,
    ) -> int:
        """Sweetie's `remember` tool calls this. Returns the new fact id.

        The fact lands with `status='pending'` — invisible to the prompt
        builder until the supervisor approves it.
        """
        content = content.strip()
        if not content:
            raise ValueError("fact content cannot be empty")
        if category not in VALID_CATEGORIES:
            raise ValueError(
                f"unknown category {category!r}; "
                f"valid: {sorted(VALID_CATEGORIES)}"
            )
        now = _now_iso()
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO facts (content, category, status, source_session,
                                   created_at, updated_at)
                VALUES (?, ?, 'pending', ?, ?, ?)
                """,
                (content, category, source_session, now, now),
            )
            return int(cur.lastrowid)

    def approve_fact(self, fact_id: int, *, edited_content: str | None = None) -> bool:
        """Mark a fact as approved. Optionally edits the content first.

        Returns True if a row was updated, False if the id didn't exist
        or the fact was already in a terminal state and didn't change.
        """
        return self._set_fact_status(fact_id, "approved", edited_content)

    def reject_fact(self, fact_id: int) -> bool:
        """Reject — kept in DB for audit but never loaded into prompts."""
        return self._set_fact_status(fact_id, "rejected", None)

    def update_fact(self, fact_id: int, new_content: str) -> bool:
        """Edit a fact's content in-place without changing its status.

        Used for editing approved facts the supervisor wants to refine.
        For edit-then-approve, use `approve_fact(..., edited_content=...)`.
        """
        new_content = new_content.strip()
        if not new_content:
            raise ValueError("fact content cannot be empty")
        with self._lock:
            cur = self._conn.execute(
                "UPDATE facts SET content=?, updated_at=? WHERE id=?",
                (new_content, _now_iso(), fact_id),
            )
            return cur.rowcount > 0

    def delete_fact(self, fact_id: int) -> bool:
        """Hard delete. Used by the CLI forget tool. Approve/reject are
        the normal operations; delete is for "this should never have
        existed" cleanup."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM facts WHERE id=?", (fact_id,))
            return cur.rowcount > 0

    def _set_fact_status(
        self,
        fact_id: int,
        new_status: str,
        edited_content: str | None,
    ) -> bool:
        if new_status not in VALID_STATUSES:
            raise ValueError(f"invalid status {new_status!r}")
        with self._lock:
            if edited_content is not None:
                edited_content = edited_content.strip()
                if not edited_content:
                    raise ValueError("edited_content cannot be empty")
                cur = self._conn.execute(
                    "UPDATE facts SET status=?, content=?, updated_at=? WHERE id=?",
                    (new_status, edited_content, _now_iso(), fact_id),
                )
            else:
                cur = self._conn.execute(
                    "UPDATE facts SET status=?, updated_at=? WHERE id=?",
                    (new_status, _now_iso(), fact_id),
                )
            return cur.rowcount > 0

    def list_facts(
        self,
        *,
        status: str | None = None,
        category: str | None = None,
    ) -> list[dict[str, Any]]:
        """List facts, optionally filtered by status and/or category.

        Returns a list of dicts with the column names as keys. Sorted
        oldest-first within status, so the supervisor sees the longest-pending
        items at the top of the tray and the foundational approved facts
        at the top of the approved list.
        """
        clauses: list[str] = []
        args: list[Any] = []
        if status is not None:
            if status not in VALID_STATUSES:
                raise ValueError(f"invalid status {status!r}")
            clauses.append("status = ?")
            args.append(status)
        if category is not None:
            if category not in VALID_CATEGORIES:
                raise ValueError(f"invalid category {category!r}")
            clauses.append("category = ?")
            args.append(category)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = f"SELECT * FROM facts {where} ORDER BY created_at ASC, id ASC"
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]

    def count_facts(self, *, status: str | None = None) -> int:
        clauses: list[str] = []
        args: list[Any] = []
        if status is not None:
            if status not in VALID_STATUSES:
                raise ValueError(f"invalid status {status!r}")
            clauses.append("status = ?")
            args.append(status)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._lock:
            row = self._conn.execute(
                f"SELECT COUNT(*) AS n FROM facts {where}", args,
            ).fetchone()
        return int(row["n"])

    # Batch ops on the pending tray. Single-statement updates; less
    # round-tripping than calling approve_fact in a loop.

    def approve_all_pending(self) -> int:
        """Approve every currently-pending fact. Returns count affected."""
        with self._lock:
            cur = self._conn.execute(
                "UPDATE facts SET status='approved', updated_at=? WHERE status='pending'",
                (_now_iso(),),
            )
            return cur.rowcount

    def reject_all_pending(self) -> int:
        """Reject every currently-pending fact. Returns count affected."""
        with self._lock:
            cur = self._conn.execute(
                "UPDATE facts SET status='rejected', updated_at=? WHERE status='pending'",
                (_now_iso(),),
            )
            return cur.rowcount

    # ── Episodes: session-summary lifecycle ────────────────────────────────

    def start_episode(self) -> int:
        """Open a new episode. Returns its id, which sweetie passes as
        `source_session` when proposing facts during this session.
        """
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO episodes (started_at) VALUES (?)",
                (_now_iso(),),
            )
            return int(cur.lastrowid)

    def end_episode_with_summary(
        self,
        episode_id: int,
        summary: str,
        end_reason: str,
    ) -> bool:
        """Close an episode with a reflection summary and reason.

        Idempotent on `ended_at`: if the episode is already closed, this
        no-ops and returns False. That's important — both the battery-low
        path and the shutdown path may try to close the same episode,
        and only the first one should win.
        """
        if end_reason not in VALID_END_REASONS:
            raise ValueError(
                f"invalid end_reason {end_reason!r}; "
                f"valid: {sorted(VALID_END_REASONS)}"
            )
        summary = summary.strip()
        with self._lock:
            cur = self._conn.execute(
                """
                UPDATE episodes
                SET ended_at=?, summary=?, end_reason=?
                WHERE id=? AND ended_at IS NULL
                """,
                (_now_iso(), summary, end_reason, episode_id),
            )
            return cur.rowcount > 0

    def list_recent_episodes(self, limit: int = 5) -> list[dict[str, Any]]:
        """Most-recent-first list of CLOSED episodes only.

        Open episodes (an in-flight session) are excluded — they don't
        have summaries yet, so they have nothing to contribute to the
        "what you remember" block.
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM episodes
                WHERE ended_at IS NOT NULL
                ORDER BY ended_at DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def list_all_episodes(self) -> list[dict[str, Any]]:
        """Full episode list (oldest first), for the dashboard memory panel."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM episodes ORDER BY started_at ASC, id ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_episode(self, episode_id: int) -> bool:
        """Hard delete an episode. Used by the dashboard's 'forget this
        episode' action and the CLI."""
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM episodes WHERE id=?", (episode_id,)
            )
            return cur.rowcount > 0

    # ── Bulk forget ops (used by the CLI) ──────────────────────────────────

    def forget_all(self) -> dict[str, int]:
        """Wipe both tables. Returns counts of rows deleted."""
        with self._lock:
            f = self._conn.execute("DELETE FROM facts").rowcount
            e = self._conn.execute("DELETE FROM episodes").rowcount
        return {"facts": f, "episodes": e}

    def forget_pending_facts(self) -> int:
        """Hard delete pending-only facts. Approved and rejected stay."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM facts WHERE status='pending'")
            return cur.rowcount

    def forget_episodes(self) -> int:
        """Wipe all episode summaries. Facts are untouched."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM episodes")
            return cur.rowcount
