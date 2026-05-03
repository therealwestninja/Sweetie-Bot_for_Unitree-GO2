"""CLI entry point: `python -m sweetie` or `sweetie` (if installed)."""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv


def run() -> None:
    load_dotenv()
    host = os.getenv("SWEETIE_HOST", "127.0.0.1")
    port = int(os.getenv("SWEETIE_PORT", "8000"))
    uvicorn.run(
        "sweetie.teleop.server:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    run()
