"""Auth + OpenAI-compatible gateway in front of a local Ollama server.

Runs inside the GPU container. Ollama itself has no authentication, so this
proxy is what makes the lane safe to expose on a public Modal URL:
  * requires  Authorization: Bearer <GPU_LANE_TOKEN>
  * pins the model, so a caller cannot swap in something the GPU has not pulled
  * reports the lane in every response so a caller can tell GPU work from CPU

Nothing here touches the locked agent model route (CLAUDE.md §22). This is a
separate, opt-in lane for heavy batch work only.
"""

import os
import time

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

UPSTREAM = os.environ.get("OLLAMA_UPSTREAM", "http://127.0.0.1:11434")
TOKEN = os.environ.get("GPU_LANE_TOKEN", "")
MODEL = os.environ.get("GPU_LANE_MODEL", "qwen2.5-coder:7b")

app = FastAPI(title="hakster-gpu-lane", docs_url=None, redoc_url=None)

_client = httpx.AsyncClient(base_url=UPSTREAM, timeout=600.0)


def _auth(authorization: str | None) -> None:
    if not TOKEN:
        raise HTTPException(status_code=503, detail="lane token not configured")
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
async def health():
    """Liveness + which model this GPU actually holds."""
    try:
        tags = await _client.get("/api/tags")
        names = [m.get("name") for m in tags.json().get("models", [])]
        ps = await _client.get("/api/ps")
        loaded = [m.get("name") for m in ps.json().get("models", [])]
    except Exception as exc:  # upstream not up yet
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=503)
    return {
        "ok": True,
        "lane": "gpu",
        "model": MODEL,
        "installed": names,
        "loaded": loaded,
    }


@app.get("/v1/models")
async def models(authorization: str | None = Header(default=None)):
    _auth(authorization)
    return {
        "object": "list",
        "data": [{"id": MODEL, "object": "model", "owned_by": "hakster-gpu-lane"}],
    }


@app.post("/v1/chat/completions")
async def chat(payload: dict, authorization: str | None = Header(default=None)):
    _auth(authorization)

    asked = payload.get("model")
    if asked and asked != MODEL:
        raise HTTPException(
            status_code=400,
            detail=f"this lane serves only {MODEL}; asked for {asked}",
        )
    payload = {**payload, "model": MODEL}

    started = time.time()
    try:
        upstream = await _client.post("/v1/chat/completions", json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"upstream failed: {exc}") from exc

    body = upstream.json()
    if isinstance(body, dict):
        body["x_gpu_lane"] = {
            "lane": "gpu",
            "model": MODEL,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    return JSONResponse(body, status_code=upstream.status_code)
