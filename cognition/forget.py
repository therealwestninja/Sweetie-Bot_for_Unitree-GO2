"""Memory forget CLI.

Bulk-cleans entries from the persistent memory store. Use sparingly —
unlike approve/reject (which the supervisor can do via the dashboard),
this operates on the underlying SQLite directly and bypasses the
proposal workflow entirely.

Examples:

    # Clear everything (with confirmation prompt)
    python -m sweetie.tools.forget --all

    # Clear only the pending tray
    python -m sweetie.tools.forget --pending

    # Clear past episode summaries (facts untouched)
    python -m sweetie.tools.forget --episodes

    # Skip the confirmation prompt
    python -m sweetie.tools.forget --all --yes

    # Use a non-default DB
    python -m sweetie.tools.forget --all --db /custom/path/memory.db
"""

from __future__ import annotations

import argparse
import sys

from sweetie.cognition.memory import MemoryStore


def _confirm(prompt: str) -> bool:
    try:
        ans = input(f"{prompt} [y/N]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return ans in ("y", "yes")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="sweetie.tools.forget",
        description="Bulk-delete entries from sweetie's memory store.",
    )
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true",
                   help="Delete all facts AND episodes")
    g.add_argument("--pending", action="store_true",
                   help="Delete only pending facts (approved/rejected stay)")
    g.add_argument("--episodes", action="store_true",
                   help="Delete only episode summaries (facts stay)")
    p.add_argument("--db", default=None,
                   help="DB path (default: $SWEETIE_MEMORY_DB or ~/.sweetie/memory.db)")
    p.add_argument("--yes", action="store_true",
                   help="Skip the confirmation prompt")
    args = p.parse_args(argv)

    store = MemoryStore(path=args.db)
    try:
        # Safety checks: refuse to operate on a wholly-empty store, since
        # the supervisor probably ran the wrong command.
        approved = store.count_facts(status="approved")
        pending = store.count_facts(status="pending")
        rejected = store.count_facts(status="rejected")
        episodes = len(store.list_all_episodes())

        print(f"Memory store at: {store.path}")
        print(f"  approved facts:  {approved}")
        print(f"  pending facts:   {pending}")
        print(f"  rejected facts:  {rejected}")
        print(f"  episodes:        {episodes}")
        print()

        if args.all:
            if approved + pending + rejected + episodes == 0:
                print("Nothing to forget.")
                return 0
            if not args.yes and not _confirm(
                "Delete ALL facts and episodes? This cannot be undone."
            ):
                print("Aborted.")
                return 1
            counts = store.forget_all()
            print(f"Deleted {counts['facts']} facts and {counts['episodes']} episodes.")

        elif args.pending:
            if pending == 0:
                print("No pending facts to forget.")
                return 0
            if not args.yes and not _confirm(
                f"Delete {pending} pending fact(s)?"
            ):
                print("Aborted.")
                return 1
            n = store.forget_pending_facts()
            print(f"Deleted {n} pending fact(s).")

        elif args.episodes:
            if episodes == 0:
                print("No episodes to forget.")
                return 0
            if not args.yes and not _confirm(
                f"Delete {episodes} episode summary(ies)?"
            ):
                print("Aborted.")
                return 1
            n = store.forget_episodes()
            print(f"Deleted {n} episode summary(ies).")

        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
