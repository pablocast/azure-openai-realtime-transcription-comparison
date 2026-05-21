"""Token + config service for the React WebRTC client.

Mirrors the session configuration used by the Python CLI in src/protocol.py
so the browser-side realtime session behaves the same way (server_vad, near-field
noise reduction, PCM 24kHz audio, gpt-4o-transcribe input transcription, voice).

Endpoints:
  GET /api/config -> { azureResource, deployment, transcriptionModel }
  GET /api/token  -> { token, expiresAt }   (ephemeral key for WebRTC)
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# Allow importing the existing prompts so the assistant persona stays in sync.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from src.prompts import (  # noqa: E402
    DEFAULT_REALTIME_PROMPT_VARIANT,
    REALTIME_MODEL_PROMPTS,
    REALTIME_MODEL_TRANSCRIPTION_PROMPT,
)

load_dotenv(ROOT / ".env")

ENDPOINT = os.environ["AZURE_OPENAI_ENDPOINT"].rstrip("/")
DEPLOYMENT = os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME"]
TRANSCRIPTION_MODEL = os.environ.get(
    "AZURE_OPENAI_INPUT_AUDIO_TRANSCRIPTION_MODEL", "gpt-4o-transcribe"
)
VOICE = os.environ.get("REALTIME_VOICE", "alloy")
SAMPLE_RATE = 24_000
TOKEN_SCOPE = "https://ai.azure.com/.default"

# Resource hostname like "foundry-paschoaloto.openai.azure.com"
_AZURE_HOST = urlparse(ENDPOINT).netloc or ENDPOINT

# Built SPA assets (web/frontend/dist) — present in the container image.
SPA_DIR = ROOT / "web" / "frontend" / "dist"

app = Flask(__name__, static_folder=None)
CORS(app)

_credential = DefaultAzureCredential()
_token_lock = threading.Lock()
_cached: dict[str, Any] = {"token": None, "exp": 0.0}


def _bearer_token() -> str:
    with _token_lock:
        now = time.time()
        if _cached["token"] and now < _cached["exp"] - 300:
            return _cached["token"]
        tok = _credential.get_token(TOKEN_SCOPE)
        _cached["token"] = tok.token
        _cached["exp"] = float(tok.expires_on)
        return _cached["token"]


def _resolve_variant(value: str | None) -> str:
    """Pick a known prompt variant, falling back to the default."""
    if value and value in REALTIME_MODEL_PROMPTS:
        return value
    return DEFAULT_REALTIME_PROMPT_VARIANT


def _session_config(variant: str) -> dict[str, Any]:
    """Match src/protocol.build_session_update so browser session = CLI session."""
    return {
        "session": {
            "type": "realtime",
            "model": DEPLOYMENT,
            "instructions": REALTIME_MODEL_PROMPTS[variant],
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "noise_reduction": {"type": "near_field"},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.6,
                        "silence_duration_ms": 800,
                        "prefix_padding_ms": 300,
                        "create_response": True,
                        "interrupt_response": True,
                    },
                    "transcription": {"model": TRANSCRIPTION_MODEL},
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "voice": VOICE,
                },
            },
        }
    }


@app.get("/api/config")
def get_config():
    return jsonify(
        {
            "azureHost": _AZURE_HOST,
            "deployment": DEPLOYMENT,
            "transcriptionModel": TRANSCRIPTION_MODEL,
            "voice": VOICE,
            "transcriptionInstructions": REALTIME_MODEL_TRANSCRIPTION_PROMPT,
            "promptVariants": list(REALTIME_MODEL_PROMPTS.keys()),
            "defaultPromptVariant": DEFAULT_REALTIME_PROMPT_VARIANT,
        }
    )


@app.get("/api/token")
def get_token():
    variant = _resolve_variant(request.args.get("variant"))
    try:
        bearer = _bearer_token()
        url = f"https://{_AZURE_HOST}/openai/v1/realtime/client_secrets"
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            },
            json=_session_config(variant),
            timeout=30,
        )
        if r.status_code != 200:
            app.logger.error("client_secrets failed %s: %s", r.status_code, r.text)
            return jsonify({"error": r.text}), r.status_code
        data = r.json()
        return jsonify(
            {
                "token": data.get("value", ""),
                "expiresAt": data.get("expires_at"),
                "promptVariant": variant,
            }
        )
    except Exception as exc:  # pragma: no cover - surfaced to client
        app.logger.exception("token error")
        return jsonify({"error": str(exc)}), 500


@app.get("/")
@app.get("/<path:path>")
def serve_spa(path: str = ""):
    """Serve the built React SPA, falling back to index.html for client routes."""
    if not SPA_DIR.exists():
        return jsonify({"error": "SPA not built; run `npm run build` in web/frontend"}), 404
    target = SPA_DIR / path
    if path and target.is_file():
        return send_from_directory(SPA_DIR, path)
    return send_from_directory(SPA_DIR, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"Token service on http://{host}:{port}  (resource={_AZURE_HOST})")
    app.run(host=host, port=port, debug=False)
