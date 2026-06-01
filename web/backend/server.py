"""Token + config service for the React WebRTC client.

Mirrors the session configuration used by the Python CLI in src/protocol.py
so the browser-side realtime session behaves the same way (server_vad, near-field
noise reduction, PCM 24kHz audio, gpt-4o-transcribe input transcription, voice).

Endpoints:
  GET /api/config -> { azureResource, deployment, transcriptionModel }
  GET /api/token  -> { token, expiresAt }   (ephemeral key for WebRTC)
"""
from __future__ import annotations

import json
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
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from flask_cors import CORS
from src.schema import (
    ANAMNESE_JSON_SCHEMA,
    ANAMNESE_SCHEMA_NAME,
)

# Allow importing the existing prompts so the assistant persona stays in sync.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from src.prompts import (  
    DEFAULT_REALTIME_PROMPT_VARIANT,
    REALTIME_MODEL_PROMPTS,
    REALTIME_MODEL_TRANSCRIPTION_PROMPT,
    ANAMNESE_EXTRACT_PROMPT,
    ANAMNESE_EXTRACT_PROMPT_SCHEMA,
)

load_dotenv(ROOT / ".env")

ENDPOINT = os.environ["AZURE_OPENAI_ENDPOINT"].rstrip("/")
DEPLOYMENT = os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME"]
MINI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_MINI_REALTIME_DEPLOYMENT_NAME") or None
DEPLOYMENTS: dict[str, str] = {"full": DEPLOYMENT}
if MINI_DEPLOYMENT:
    DEPLOYMENTS["mini"] = MINI_DEPLOYMENT
DEFAULT_MODEL_TIER = "full"

# ---- Chat (text) deployments for the STT -> AOAI -> TTS pipeline ----
CHAT_DEPLOYMENT = os.environ.get("AZURE_OPENAI_CHAT_DEPLOYMENT_NAME") or None
MINI_CHAT_DEPLOYMENT = os.environ.get("AZURE_OPENAI_MINI_CHAT_DEPLOYMENT_NAME") or None
CHAT_DEPLOYMENTS: dict[str, str] = {}
if CHAT_DEPLOYMENT:
    CHAT_DEPLOYMENTS["full"] = CHAT_DEPLOYMENT
if MINI_CHAT_DEPLOYMENT:
    CHAT_DEPLOYMENTS["mini"] = MINI_CHAT_DEPLOYMENT
DEFAULT_CHAT_TIER = "full" if "full" in CHAT_DEPLOYMENTS else (
    next(iter(CHAT_DEPLOYMENTS), "")
)

# ---- Speech (STT/TTS) — endpoint-based, keyless AAD auth ----
SPEECH_ENDPOINT = (os.environ.get("AZURE_SPEECH_ENDPOINT") or ENDPOINT).rstrip("/")
SPEECH_RESOURCE_ID = os.environ.get("AZURE_SPEECH_RESOURCE_ID", "")
STT_LOCALES = [
    s.strip()
    for s in os.environ.get("STT_LOCALES", "es-CO,en-US").split(",")
    if s.strip()
]
# Per-language TTS voice, selected by the language ID STT returns for each turn.
# Override via TTS_VOICES="es-CO=es-CO-SalomeNeural,en-US=en-US-Andrew2:DragonHDLatestNeural".
_DEFAULT_TTS_VOICES = "es-CO=es-CO-SalomeNeural,en-US=en-US-Andrew2:DragonHDLatestNeural"
TTS_VOICES: dict[str, str] = {}
for _pair in os.environ.get("TTS_VOICES", _DEFAULT_TTS_VOICES).split(","):
    if "=" in _pair:
        _loc, _voice = _pair.split("=", 1)
        if _loc.strip() and _voice.strip():
            TTS_VOICES[_loc.strip()] = _voice.strip()
# Fallback voice when language ID returns a locale not in the map.
TTS_VOICE = os.environ.get(
    "TTS_VOICE", TTS_VOICES.get(STT_LOCALES[0]) if STT_LOCALES else "es-CO-SalomeNeural"
)

TRANSCRIPTION_MODEL = os.environ.get(
    "AZURE_OPENAI_INPUT_AUDIO_TRANSCRIPTION_MODEL", "gpt-4o-transcribe"
)
VOICE = os.environ.get("REALTIME_VOICE", "alloy")
SAMPLE_RATE = 24_000
TOKEN_SCOPE = "https://ai.azure.com/.default"
# Data-plane scope for AOAI chat completions and Speech STT/TTS token issuance.
COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"

# Resource hostname like "foundry-paschoaloto.openai.azure.com"
_AZURE_HOST = urlparse(ENDPOINT).netloc or ENDPOINT

# Built SPA assets (web/frontend/dist) — present in the container image.
SPA_DIR = ROOT / "web" / "frontend" / "dist"

app = Flask(__name__, static_folder=None)
CORS(app)

_credential = DefaultAzureCredential()
_token_lock = threading.Lock()
_cached: dict[str, Any] = {"token": None, "exp": 0.0}
# Per-scope token cache (e.g. cognitiveservices.azure.com for chat + speech).
_scope_cache: dict[str, dict[str, Any]] = {}


def _bearer_token() -> str:
    with _token_lock:
        now = time.time()
        if _cached["token"] and now < _cached["exp"] - 300:
            return _cached["token"]
        tok = _credential.get_token(TOKEN_SCOPE)
        _cached["token"] = tok.token
        _cached["exp"] = float(tok.expires_on)
        return _cached["token"]


def _scoped_token(scope: str) -> str:
    """Return a cached AAD token for an arbitrary scope (thread-safe)."""
    with _token_lock:
        now = time.time()
        entry = _scope_cache.get(scope)
        if entry and entry["token"] and now < entry["exp"] - 300:
            return entry["token"]
        tok = _credential.get_token(scope)
        _scope_cache[scope] = {"token": tok.token, "exp": float(tok.expires_on)}
        return tok.token


def _resolve_variant(value: str | None) -> str:
    """Pick a known prompt variant, falling back to the default."""
    if value and value in REALTIME_MODEL_PROMPTS:
        return value
    return DEFAULT_REALTIME_PROMPT_VARIANT


def _resolve_model(value: str | None) -> tuple[str, str]:
    """Return (tier, deployment_name) for the requested model tier.

    Falls back to the default tier if the requested one is not configured.
    """
    tier = (value or "").strip().lower()
    if tier in DEPLOYMENTS:
        return tier, DEPLOYMENTS[tier]
    return DEFAULT_MODEL_TIER, DEPLOYMENTS[DEFAULT_MODEL_TIER]


def _resolve_chat_model(value: str | None) -> tuple[str, str]:
    """Return (tier, deployment_name) for the requested chat (text) tier.

    Falls back to the default chat tier if the requested one is not configured.
    """
    tier = (value or "").strip().lower()
    if tier in CHAT_DEPLOYMENTS:
        return tier, CHAT_DEPLOYMENTS[tier]
    if DEFAULT_CHAT_TIER:
        return DEFAULT_CHAT_TIER, CHAT_DEPLOYMENTS[DEFAULT_CHAT_TIER]
    raise RuntimeError("No chat deployment configured (AZURE_OPENAI_CHAT_DEPLOYMENT_NAME).")


def _session_config(variant: str, deployment: str) -> dict[str, Any]:
    """Match src/protocol.build_session_update so browser session = CLI session."""
    audio_input: dict[str, Any] = {
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
    }

    if variant != "medical":
        audio_input["transcription"] = {"model": TRANSCRIPTION_MODEL}

    return {
        "session": {
            "type": "realtime",
            "model": deployment,
            "instructions": REALTIME_MODEL_PROMPTS[variant],
            "output_modalities": ["audio"],
            "audio": {
                "input": audio_input,
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
            "deployments": DEPLOYMENTS,
            "defaultModelTier": DEFAULT_MODEL_TIER,
            "transcriptionModel": TRANSCRIPTION_MODEL,
            "voice": VOICE,
            "transcriptionInstructions": REALTIME_MODEL_TRANSCRIPTION_PROMPT,
            "promptVariants": list(REALTIME_MODEL_PROMPTS.keys()),
            "defaultPromptVariant": DEFAULT_REALTIME_PROMPT_VARIANT,
            "anamneseExtractInstructions": ANAMNESE_EXTRACT_PROMPT,
            "anamneseJsonSchema": ANAMNESE_JSON_SCHEMA,
            "anamneseSchemaName": ANAMNESE_SCHEMA_NAME,
            # STT -> AOAI -> TTS pipeline config
            "chatDeployments": CHAT_DEPLOYMENTS,
            "defaultChatTier": DEFAULT_CHAT_TIER,
            "speechEndpoint": SPEECH_ENDPOINT,
            "sttLocales": STT_LOCALES,
            "ttsVoice": TTS_VOICE,
            "ttsVoices": TTS_VOICES,
        }
    )


@app.get("/api/token")
def get_token():
    variant = _resolve_variant(request.args.get("variant"))
    model_tier, deployment = _resolve_model(request.args.get("model"))
    app.logger.info(
        "session start variant=%s tier=%s deployment=%s remote=%s",
        variant, model_tier, deployment, request.remote_addr,
    )
    try:
        bearer = _bearer_token()
        url = f"https://{_AZURE_HOST}/openai/v1/realtime/client_secrets"
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            },
            json=_session_config(variant, deployment),
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
                "modelTier": model_tier,
                "deployment": deployment,
            }
        )
    except Exception as exc:  # pragma: no cover - surfaced to client
        app.logger.exception("token error")
        return jsonify({"error": str(exc)}), 500


@app.get("/api/speech-token")
def get_speech_token():
    """Mint a short-lived, keyless auth token for the browser Speech SDK.

    Returns the AAD-formatted authorization token (aad#<resourceId>#<token>),
    the Speech endpoint, and the configured STT locales / TTS voice. The SDK
    is configured client-side with SpeechConfig.fromEndpoint + this token.
    """
    if not SPEECH_RESOURCE_ID:
        return jsonify({"error": "AZURE_SPEECH_RESOURCE_ID not configured."}), 500
    try:
        aad = _scoped_token(COGNITIVE_SCOPE)
        return jsonify(
            {
                "token": f"aad#{SPEECH_RESOURCE_ID}#{aad}",
                "endpoint": SPEECH_ENDPOINT,
                "sttLocales": STT_LOCALES,
                "ttsVoice": TTS_VOICE,
                "ttsVoices": TTS_VOICES,
            }
        )
    except Exception as exc:  # pragma: no cover - surfaced to client
        app.logger.exception("speech-token error")
        return jsonify({"error": str(exc)}), 500


@app.post("/api/chat")
def post_chat():
    """Stream chat/completions from AOAI as SSE, keyless via managed identity.

    Body: { "messages": [...], "variant": "v1"|..., "model": "full"|"mini" }
    `messages` are conversation turns only (user/assistant); the persona system
    prompt is injected server-side by `variant` so prompt text never reaches the
    client. Proxies the upstream SSE straight through to the browser.
    """
    body = request.get_json(force=True, silent=True) or {}
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "messages[] is required."}), 400
    try:
        tier, deployment = _resolve_chat_model(body.get("model"))
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    variant = _resolve_variant(body.get("variant"))
    full_messages = [
        {"role": "system", "content": REALTIME_MODEL_PROMPTS[variant]},
        *messages,
    ]

    bearer = _scoped_token(COGNITIVE_SCOPE)
    url = f"https://{_AZURE_HOST}/openai/v1/chat/completions"
    payload: dict[str, Any] = {
        "model": deployment,
        "messages": full_messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    app.logger.info("chat stream tier=%s deployment=%s turns=%d", tier, deployment, len(messages))

    def generate():
        try:
            with requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {bearer}",
                    "Content-Type": "application/json",
                },
                json=payload,
                stream=True,
                timeout=120,
            ) as upstream:
                if upstream.status_code != 200:
                    detail = upstream.text
                    app.logger.error("chat upstream %s: %s", upstream.status_code, detail)
                    yield f"data: {json.dumps({'error': detail})}\n\n"
                    return
                for line in upstream.iter_lines(decode_unicode=True):
                    if line is None:
                        continue
                    # Pass SSE lines through unchanged (incl. blank separators).
                    yield f"{line}\n"
        except Exception as exc:  # pragma: no cover - surfaced to client
            app.logger.exception("chat stream error")
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/extract")
def post_extract():
    """Structured anamnesis extraction via native strict json_schema.

    Body: { "messages": [...], "model": "full"|"mini" }
    `messages` are the extraction context turns (a single user message with
    CURRENT STATE + the latest turn + the doctor's utterance). The extraction
    system prompt is injected server-side. Returns the COMPLETE anamnesis
    object (nulls for unknown fields) plus token usage.

    The shape is enforced by the API via a strict ``json_schema`` response
    format, so the prompt carries only the clinical extraction rules (no
    embedded schema, no additive contract). The UI merges the object,
    ignoring nulls and deduping arrays.
    """
    body = request.get_json(force=True, silent=True) or {}
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "messages[] is required."}), 400
    try:
        tier, deployment = _resolve_chat_model(body.get("model"))
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500

    full_messages = [
        {"role": "system", "content": ANAMNESE_EXTRACT_PROMPT_SCHEMA},
        *messages,
    ]

    bearer = _scoped_token(COGNITIVE_SCOPE)
    url = f"https://{_AZURE_HOST}/openai/v1/chat/completions"
    payload = {
        "model": deployment,
        "messages": full_messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": ANAMNESE_SCHEMA_NAME,
                "strict": True,
                "schema": ANAMNESE_JSON_SCHEMA,
            },
        },
    }
    try:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {bearer}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        if r.status_code != 200:
            app.logger.error("extract upstream %s: %s", r.status_code, r.text)
            return jsonify({"error": r.text}), r.status_code
        data = r.json()
        content = data["choices"][0]["message"].get("content") or "{}"
        try:
            patch = json.loads(content)
        except json.JSONDecodeError:
            return jsonify({"error": "Model returned non-JSON content.", "raw": content}), 502
        return jsonify({"patch": patch, "usage": data.get("usage"), "modelTier": tier})
    except Exception as exc:  # pragma: no cover - surfaced to client
        app.logger.exception("extract error")
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
