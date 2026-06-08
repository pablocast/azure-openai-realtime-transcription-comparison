# <img src="docs/img/ai-foundry.png" height="32" alt="Azure AI Foundry" /> Transcribing User Audio using gpt-realtime and gpt-transcribe in Microsoft Foundry

Browser demo for Azure OpenAI **Realtime** voice with **side-by-side transcription**:
the Realtime model's own out-of-band (OOB) user-turn transcript is shown next to a parallel
`gpt-4o-transcribe` transcript so you can compare quality, latency, and cost in real time.

The web app is a single Container App that serves a React SPA and a small Flask token service.
Authentication to Azure OpenAI uses **managed identity** (no keys).

![App screenshot](docs/img/app.png)

---

## Architecture

![Architecture diagram](docs/img/architecture.png)

The diagram contrasts the two approaches this app runs side-by-side:

- **Left — Realtime + Transcription Model.** Audio is fanned out to both a dedicated transcription model (e.g. `gpt-4o-transcribe`) and the Realtime model. The transcription model produces the user-turn text; the Realtime model produces the spoken/text reply.
- **Right — Realtime OOB transcription.** The Realtime model is asked, via an out-of-band response with `metadata=transcription`, to transcribe the same audio it just answered. No separate transcription model is needed; the session context is reused.

Both transcripts are rendered in adjacent columns so you can compare quality, latency, and cost per turn.

### Other components:
- **Frontend** — Vite + React + TypeScript. Captures mic audio, opens a WebRTC peer connection
  to Azure OpenAI Realtime, renders the assistant transcript, the Realtime-OOB user transcript,
  and the `gpt-4o-transcribe` user transcript in three aligned columns plus a per-source cost panel.
- **Backend** — Flask. Mints ephemeral Realtime client secrets via
  `POST /openai/v1/realtime/client_secrets` and exposes them at `/api/token`. Also serves the built
  SPA from the same origin.
- **Azure OpenAI / Foundry** — `gpt-realtime`, `gpt-realtime-mini`, `gpt-4o-transcribe`
  deployments created automatically by the Bicep.
- **Hosting** — Azure Container Apps with a user-assigned managed identity that has:
  - `AcrPull` on the Azure Container Registry (image pull)
  - `Cognitive Services OpenAI User` on the Foundry account (token minting)

---

## Scenarios

The app lets you mix and match three independent dimensions from the footer controls,
so you can compare approaches, prompts, and model tiers without redeploying.

### 1. Conversation mode

| Mode | Transport | How it works | Best for |
| --- | --- | --- | --- |
| **Realtime (speech-to-speech)** | WebRTC peer connection to Azure OpenAI Realtime | A single `gpt-realtime` model does STT + reasoning + TTS in one session. User-turn text comes from the model's own out-of-band (OOB) transcript. | Lowest-latency natural conversation; barge-in; the side-by-side transcription comparison. |
| **Pipeline (STT → AOAI → TTS)** | Azure Speech SDK (WebSocket) + chat completions (SSE) | Decoupled stages: Azure Speech `SpeechRecognizer` (auto language ID) → Azure OpenAI chat completions → Azure Speech `SpeechSynthesizer` (locked voice). | Swapping models per stage, strict structured outputs, and full control over each step. |
| **Voice Live** | Azure Voice Live realtime WebSocket, relayed through the backend | One Voice Live session does STT (`azure-speech`) + reasoning + neural TTS, with server VAD, noise suppression and echo cancellation handled by the service. The browser streams mic PCM up and plays the returned PCM; the persona `session.update` lives server-side. Anamnesis extraction is **decoupled** — it runs as a separate `/api/extract` call (see below). | A managed speech-to-speech stack with Azure neural voices, where extraction is kept independent of the conversation model. |


### 2. Prompt / use case

| Prompt | Description |
| --- | --- |
| **v1 — Insurance intake** | Voice agent that collects insurance intake details. |
| **v2 — Debt collection** | Voice agent for a debt-collection conversation. |
| **v3 — Medical Anamnesis** | Clinical interview that extracts a structured anamnesis. Renders the live anamnesis panel instead of the transcription-compare table, and runs schema-native extraction after each assistant reply. |

### 3. Model tier

The model list adapts to the selected mode:

| Mode | Full | Mini |
| --- | --- | --- |
| Realtime | `gpt-realtime-1.5` | `gpt-realtime-mini` |
| Pipeline | `gpt-5.4` | `gpt-5.4-mini` |

The pipeline mode also offers a third, lower-cost `gpt-5-mini` option
(`AZURE_OPENAI_GPT5_MINI_CHAT_DEPLOYMENT_NAME`).

The **Cost** panel breaks down token/character usage and price per source for whichever
combination you pick, so you can compare quality, latency, and cost side by side.

---

## Anamnesis extraction over Voice Live

In the **v3 — Medical Anamnesis** prompt, the panel on the right is a live,
structured anamnesis that fills in as the consultation progresses. In **Voice
Live** mode the spoken conversation and the structured extraction run on two
independent paths, so the extraction never interferes with the realtime audio.

### Why it's decoupled

The Azure Voice Live realtime API does not accept `item_reference` in a
`response.create` (unlike the WebRTC Realtime path, which can ask the model to
re-emit a structured tool call out-of-band). So instead of extracting *inside*
the voice session, Voice Live mode feeds the transcribed text to a separate,
plain HTTP endpoint (`POST /api/extract`) that runs a strict `json_schema`
chat completion. This is the same extraction backend the Pipeline mode uses.

### Flow per turn

1. **Audio relay.** The browser ([`web/frontend/src/voicelive.ts`](frontend/src/voicelive.ts))
   captures mic audio as PCM16 @ 24 kHz and streams it to the backend
   WebSocket relay (`/api/voicelive/ws`), which forwards it to the Azure Voice
   Live realtime endpoint. The persona prompt, server VAD, voice and
   transcription config are injected server-side via `session.update`
   (`_voice_live_session_update` in [`web/backend/server.py`](backend/server.py)),
   so they never live in the client.
2. **Transcription.** Voice Live runs Azure Speech (`azure-speech`) input
   transcription and emits
   `conversation.item.input_audio_transcription.completed` for each finished
   patient turn. The frontend uses that transcript both for the chat bubble and
   to trigger extraction.
3. **Extract call.** On each completed patient turn, `runExtract()` POSTs a
   single user message to `/api/extract` containing:
   - the **doctor's most recent utterance** (context — the source for plan,
     vitals, exam and labs the doctor reads aloud),
   - the **patient's answer** (the only source of patient-reported clinical
     data),
   - the **current accumulated anamnesis** as JSON (so the model reproduces and
     extends it rather than dropping fields),
   - **today's date** (to resolve ages and relative dates).
4. **Strict schema response.** The backend injects the extraction system prompt
   and calls Azure OpenAI chat completions with
   `response_format = json_schema` (strict), enforcing the full anamnesis
   shape (`ANAMNESE_JSON_SCHEMA`). It returns the **complete** object — `null`
   for anything not yet known — plus token usage.
5. **Merge + cost.** The frontend deep-merges the returned object into the live
   panel (ignoring `null`s, deduping array entries) and adds the extraction's
   token usage to the **Cost** panel under a separate "extract" line, priced by
   the selected extraction model tier.

Because extraction is just HTTP, you can pick its model tier independently of
the voice model (e.g. a `gpt-realtime-mini` conversation with a `gpt-5-mini`
extractor), and a slow or failed extraction never blocks or delays the spoken
reply.

### Resilience

The Azure Voice Live session has a service-side maximum duration (around
~15 minutes). When the upstream socket closes, the client logs the close
code/reason and **auto-reconnects** with exponential backoff, re-injecting the
session config and reseeding the already-collected anamnesis so a long
consultation continues seamlessly. Because the structured state lives in the UI
(and extraction is decoupled), no captured data is lost across a reconnect.

---

## Prerequisites

- An Azure subscription with permission to create resources and role assignments.
- Tools installed locally:
  - [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`)
  - [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) (`azd`) ≥ 1.23
  - Python 3.12 + `pip` (only needed to run the backend locally)
  - Node.js 20 + `npm` (only needed to run the frontend locally)
- A region with the `gpt-realtime` family available — typically **`eastus2`** or **`swedencentral`**.

---

## Deployment

The full stack (Foundry account + project + 3 model deployments, ACR, Container Apps env,
Container App, managed identity, RBAC) is provisioned by `azd up`. The image is built **remotely
in ACR** — no local Docker daemon required.

```bash
# 1) Sign in
az login --tenant <your-tenant-id>
az account set --subscription <your-subscription-id>

azd auth login --tenant-id <your-tenant-id>
# (optional) reuse az CLI auth instead of azd's:
azd config set auth.useAzCliAuth true

# 2) Create / select an azd environment
azd env new <your-environment-name>

# 3) Required env vars
azd env set AZURE_LOCATION       eastus2
azd env set AZURE_RESOURCE_GROUP <your-resource-group-name>

# 4) Provision + build + deploy
azd up
```

When it finishes, azd prints `SERVICE_WEB_URI` — open it in a browser.

### Redeploy after code changes

```bash
azd deploy        # rebuilds image in ACR + rolls Container App
# or
azd up            # also re-runs Bicep
```

### Tail logs

```bash
az containerapp logs show \
  --name $(azd env get-values | grep SERVICE_WEB_NAME | cut -d= -f2 | tr -d '"') \
  --resource-group $(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d= -f2 | tr -d '"') \
  --follow
```

---

## Local development

For iterating without redeploying.

### 1) Grant your user access to the Foundry account

```bash
ME=$(az ad signed-in-user show --query id -o tsv)
ACCT=$(az cognitiveservices account show -g <rg> -n <foundry-account> --query id -o tsv)
az role assignment create \
  --assignee-object-id $ME --assignee-principal-type User \
  --role "Cognitive Services OpenAI User" --scope $ACCT
```

### 2) Configure `.env` at the repo root

```dotenv
AZURE_OPENAI_ENDPOINT=https://<your-foundry-account>.openai.azure.com/
AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME=gpt-realtime-1.5-1
AZURE_OPENAI_INPUT_AUDIO_TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize-1
AZURE_OPENAI_MINI_REALTIME_DEPLOYMENT_NAME=gpt-realtime-mini-1
```

### 3) Backend

```bash
python -m venv .venv && source .venv/Scripts/activate   # Windows bash
pip install -r web/backend/requirements.txt
python web/backend/server.py        # http://127.0.0.1:5050
```

### 4) Frontend

```bash
cd web/frontend
npm install
npm run dev                         # http://localhost:5173
```

Vite proxies `/api/*` → `http://127.0.0.1:5050`.

### 5) Python CLI (optional)

```bash
pip install -r requirements.txt
python main.py                      # uses AZURE_OPENAI_REALTIME_DEPLOYMENT_NAME
python main.py --use-mini           # uses AZURE_OPENAI_MINI_REALTIME_DEPLOYMENT_NAME
```

---

## Usage

1. Open the deployed URL (or `http://localhost:5173` locally) in **Chrome / Edge**. The browser will
   ask for microphone permission.
2. Click **Call**. Once the WebRTC connection is established, status switches to *Connected*.
3. Speak. Each user turn shows up in three columns:
   - **Assistant** — what the Realtime model says back (audio + text).
   - **Realtime OOB** — the Realtime model's own transcript of your turn.
   - **gpt-4o-transcribe** — the parallel transcription model's transcript of the same turn.
4. The **Cost** panel updates after every turn with token-level breakdowns per source.
5. Click **Hangup** to end the call, or **🔄 New call** to reset all transcripts and costs.

![Conversation example](docs/img/app.png)

![Cost panel](docs/img/app_2.png)

---

## Repository layout

```
.
├── azure.yaml                  # azd service definition (Container Apps + remote build)
├── Dockerfile                  # multi-stage: Vite build + Python runtime
├── infra/                      # Bicep (subscription scope)
│   ├── main.bicep              # RG, Foundry, resources, role assignments
│   ├── foundry.bicep           # AI Services account + project + model deployments
│   ├── resources.bicep         # ACR, Log Analytics, UAMI, ACA env, Container App
│   ├── aoai-role.bicep         # Cognitive Services OpenAI User on Foundry
│   └── main.parameters.json
├── src/                        # shared prompts + protocol used by CLI and backend
├── web/
│   ├── backend/server.py       # Flask token service + SPA host
│   └── frontend/               # React + Vite SPA
└── main.py                     # Python CLI realtime client
```
