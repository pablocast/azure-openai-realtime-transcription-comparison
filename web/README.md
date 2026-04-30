# Realtime Web UI

React + WebRTC client for the Azure OpenAI Realtime session, plus a small Flask
service that mints ephemeral keys via Microsoft Entra ID (same auth path as the
Python CLI in `../main.py`).

## Layout

- `backend/` — Flask token service (`/api/config`, `/api/token`).
- `frontend/` — Vite + React + TS app (Call / Hangup, side-by-side transcripts,
  chat panel).

## Prereqs

- The repo `.env` already at the workspace root with `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME`,
  `AZURE_OPENAI_INPUT_AUDIO_TRANSCRIPTION_MODEL`.
- `az login` (DefaultAzureCredential is used) with the **Cognitive Services
  OpenAI User** role on the resource.
- Node 18+, Python 3.10+.

## Run

In two terminals from the workspace root:

```bash
# 1. Backend (port 5050)
python -m venv .venv-web
.venv-web\Scripts\activate         # Windows
pip install -r web/backend/requirements.txt
python web/backend/server.py
```

```bash
# 2. Frontend (port 5173, proxies /api -> 5050)
cd web/frontend
npm install
npm run dev
```

Open <http://localhost:5173>, click **Call**, allow the microphone, and speak
in pt-BR. Click **Hang up** to end.

## What you see

- **Transcribe model** column — what `gpt-4o-transcribe-diarize-1` heard for
  each user turn (`conversation.item.input_audio_transcription.completed`).
- **Realtime model** column — same audio re-transcribed by the realtime model
  via an out-of-band `response.create` (`metadata.purpose = "User turn
  transcription"`), matching the Python CLI behavior.
- **Conversation** — chat-style bubbles: user transcript on the right,
  assistant audio transcript on the left (streamed from
  `response.output_audio_transcript.delta` / `.done`).

The WebRTC URL uses `webrtcfilter=on` so the data channel only receives the
events the UI actually needs.
