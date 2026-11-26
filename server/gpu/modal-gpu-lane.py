"""HaksterAI remote GPU lane — Modal Starter (free tier), NVIDIA T4.

Why this provider: on the Starter plan Modal gives $30/month of free compute and
a T4 is $0.59/hr, so the lane costs nothing until it has been awake for roughly
50 hours in a month. It is the only free tier that is a real server (HTTP
endpoints, no per-session cap, 10 GPU concurrency) instead of a notebook.

Deploy
------
    pip install modal
    modal setup
    modal secret create hakster-gpu-lane \
        GPU_LANE_TOKEN=<long random string> \
        GPU_LANE_MODEL=qwen2.5-coder:7b
    modal deploy server/gpu/modal-gpu-lane.py

Modal prints a URL. Call it like any OpenAI endpoint:

    curl -s https://<your-url>.modal.run/health
    curl -s https://<your-url>.modal.run/v1/chat/completions \
      -H "Authorization: Bearer $GPU_LANE_TOKEN" \
      -H 'Content-Type: application/json' \
      -d '{"messages":[{"role":"user","content":"hi"}]}'

The container scales to zero when idle, so an unused lane bills nothing. First
request after idle pays a cold start (image pull is cached; model load is the
slow part), which is why scaledown_window keeps it warm for two minutes.

This lane is additive. It does not read or change cli/src/models/ladder.js,
providers.js, the 127.0.0.1:11434 relay or the locked wire model (CLAUDE.md
§22). Use it for batch work — embeddings, transcription, bulk classification,
image analysis — never as the agent's answer route.
"""

import os
import subprocess

import modal

MODEL = os.environ.get("GPU_LANE_MODEL", "qwen2.5-coder:7b")

# Ollama's own image, so the binary and its CPU/GPU libs are already present.
image = (
    modal.Image.from_registry("ollama/ollama:0.40.4", add_python="3.11")
    .entrypoint([])  # the image's entrypoint would fight our own process launch
    .pip_install("fastapi==0.115.6", "uvicorn==0.34.0", "httpx==0.28.1")
    # Pull the model at build time so a cold start never downloads weights.
    .run_commands(
        "nohup ollama serve >/tmp/pull.log 2>&1 & "
        "for i in $(seq 1 90); do ollama list >/dev/null 2>&1 && break; sleep 2; done; "
        f"ollama pull {MODEL}; "
        "pkill -f 'ollama serve' || true"
    )
    .add_local_file("gateway.py", "/root/gateway.py", copy=True)
)

app = modal.App("hakster-gpu-lane", image=image)


@app.function(
    gpu="T4",              # 16 GB VRAM; swap to "L4" (~$0.80/hr) for more headroom
    scaledown_window=120,  # stay warm 2 min after the last request
    timeout=1800,
    secrets=[modal.Secret.from_name("hakster-gpu-lane")],
)
@modal.web_server(port=8080, startup_timeout=900)
def serve():
    env = {
        **os.environ,
        "OLLAMA_HOST": "0.0.0.0:11434",
        "OLLAMA_KEEP_ALIVE": "10m",
    }
    subprocess.Popen(["ollama", "serve"], env=env)

    # Wait for the runner to answer before the gateway starts taking traffic.
    import time

    import httpx

    for _ in range(300):
        try:
            if httpx.get("http://127.0.0.1:11434/api/version", timeout=2).status_code == 200:
                break
        except Exception:
            pass
        time.sleep(2)

    subprocess.Popen(
        [
            "uvicorn",
            "gateway:app",
            "--host", "0.0.0.0",
            "--port", "8080",
            "--app-dir", "/root",
        ],
        env=env,
    )
