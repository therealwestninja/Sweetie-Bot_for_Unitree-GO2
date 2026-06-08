"""
FastAPI routes that expose the Perchance fallback bridge to the browser
userscript. Mounted by teleop/server.py.

Endpoints:
  GET  /api/perchance/poll      long-poll for the next pending prompt
                                -> {"id","prompt"} or 204 (idle)
  POST /api/perchance/complete  {"id","text"}  submit a completion
  POST /api/perchance/fail      {"id","reason"} report a failure (unblocks)
  GET  /api/perchance/status    {"consumer_online","pending","queued"}
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel


class _Completion(BaseModel):
    id: str
    text: str


class _Failure(BaseModel):
    id: str
    reason: str = "error"


def make_perchance_router(bridge) -> APIRouter:
    router = APIRouter(prefix="/api/perchance", tags=["perchance"])

    @router.get("/poll")
    async def poll():
        job = await bridge.poll()
        if job is None:
            return Response(status_code=204)
        return JSONResponse(job)

    @router.post("/complete")
    async def complete(c: _Completion):
        return {"ok": bridge.complete(c.id, c.text)}

    @router.post("/fail")
    async def fail(f: _Failure):
        return {"ok": bridge.fail(f.id, f.reason)}

    @router.get("/status")
    async def status():
        return bridge.status()

    return router
