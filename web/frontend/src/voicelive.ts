/**
 * WebSocket client for the Azure Voice Live API.
 *
 * Audio is relayed through our backend (`/api/voicelive/ws`) rather than over
 * WebRTC: the browser captures mic PCM and streams it up as
 * `input_audio_buffer.append` frames, and the service streams the assistant's
 * voice back as `response.audio.delta` PCM frames that we schedule for
 * playback. The backend connects to the Azure Voice Live realtime WebSocket
 * (keyless, Entra auth) and injects the persona `session.update` so the prompt,
 * server VAD and voice never live in the client.
 *
 * Audio format (both directions): PCM16, 24 kHz, mono.
 *
 * Events handled:
 *   - session.created / session.updated  (configure + send greeting)
 *   - input_audio_buffer.speech_started  (barge-in: stop playback)
 *   - conversation.item.* / input_audio_transcription.completed (user bubbles)
 *   - response.audio.delta / response.output_audio.delta (assistant audio)
 *   - response.audio_transcript.delta / response.text.delta (assistant text)
 *   - response.done (usage -> cost)
 *   - error / response.error
 */

import {
  ChatPricing,
  computeChatCost,
  computeRealtimeCost,
  VoiceLivePricing,
  type ChatUsage,
  type CostBreakdown,
  type Usage,
} from "./costs";
import type { RealtimeHandlers } from "./realtime";

export interface VoiceLiveTotals {
  /** Per-response usage from the service (audio in/out + text). */
  conversation: CostBreakdown;
  /** Anamnesis extraction via /api/extract (structured JSON per turn). */
  extract: CostBreakdown;
  total: number;
  pricingName: string;
  extractPricingName: string;
}

interface VoiceLiveConfig {
  promptVariants: string[];
  defaultPromptVariant: string;
  voiceLivePromptVariants?: string[];
  defaultVoiceLivePromptVariant?: string;
  voiceLiveModels: string[];
  defaultVoiceLiveModel: string;
  voiceLiveGreeting: string;
}

/** Audio sample rate for Voice Live PCM16 frames (Hz). */
const SAMPLE_RATE = 24000;
/** Mic capture block size (frames) for the ScriptProcessor. */
const CAPTURE_BUFFER = 4096;

const EMPTY: CostBreakdown = { totalCost: 0, parts: {} };
const SPECIAL_TOKEN_RE = /<\|[^|>]+\|>/g;
/** Chat (text) pricing keyed by the model tier sent to /api/extract. */
const CHAT_PRICING_BY_TIER: Record<string, ChatPricing> = {
  full: ChatPricing.full,
  mini: ChatPricing.mini,
  gpt5mini: ChatPricing.gpt5mini,
  gpt54nano: ChatPricing.gpt54nano,
};

function clone(b: CostBreakdown): CostBreakdown {
  return { totalCost: b.totalCost, parts: { ...b.parts } };
}

function mergeCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const parts: CostBreakdown["parts"] = { ...a.parts };
  for (const [k, v] of Object.entries(b.parts)) {
    const prev = parts[k];
    if (prev) {
      parts[k] = {
        cost: prev.cost + v.cost,
        tokens: prev.tokens + v.tokens,
        unitPricePerM: v.unitPricePerM,
      };
    } else {
      parts[k] = { ...v };
    }
  }
  return { totalCost: a.totalCost + b.totalCost, parts };
}

function sanitize(s: string): string {
  return s.replace(SPECIAL_TOKEN_RE, "").trim();
}

/** Convert a Float32 [-1,1] audio block to little-endian PCM16 base64. */
function floatToPcm16Base64(input: Float32Array): string {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** Decode a base64 PCM16 frame to a Float32 [-1,1] array. */
function pcm16Base64ToFloat(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

export class VoiceLiveClient {
  private ws: WebSocket | null = null;

  // ---- Capture (mic -> service) ----
  private captureCtx: AudioContext | null = null;
  private localStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  // ---- Playback (service -> speakers) ----
  private playbackCtx: AudioContext | null = null;
  private playHead = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  private pricing: VoiceLivePricing = VoiceLivePricing.lite;
  private variant = "v1";
  private greeting = "";
  private greetingSent = false;
  private sessionReady = false;

  /** user audio item ids we've already shown a bubble for. */
  private seenUserItems = new Set<string>();
  private assistantCurrent = "";

  // ---- Anamnese (medical variant) extraction via /api/extract -----------
  /** Latest accumulated form, fed back from the UI after each merge. */
  private anamneseState: Record<string, unknown> = {};
  /** Last completed assistant utterance (the doctor's question being answered). */
  private lastAssistantUtterance = "";
  /** The patient's most recent finalized utterance and its item id. */
  private lastUserText = "";
  private lastUserItemId = "";
  /** Extraction model tier + pricing (passed from the UI). */
  private extractTier = "full";
  private extractPricing: ChatPricing = ChatPricing.full;

  private totals = {
    conversation: clone(EMPTY),
    extract: clone(EMPTY),
  };

  constructor(private handlers: RealtimeHandlers) {}

  /** Called by the UI after every merge so the extractor sees accumulated state. */
  setAnamneseState(state: Record<string, unknown>): void {
    this.anamneseState = state ?? {};
  }

  async start(variant?: string, modelTier?: string, extractTier?: string): Promise<void> {
    this.handlers.onStateChange("connecting");

    const cfg = await fetchJson<VoiceLiveConfig>("/api/config");
    const allowedVariants =
      cfg.voiceLivePromptVariants && cfg.voiceLivePromptVariants.length > 0
        ? cfg.voiceLivePromptVariants
        : (cfg.promptVariants ?? []);
    const defaultVariant =
      cfg.defaultVoiceLivePromptVariant ?? allowedVariants[0] ?? cfg.defaultPromptVariant;
    this.variant = variant && allowedVariants.includes(variant) ? variant : defaultVariant;
    this.greeting = cfg.voiceLiveGreeting ?? "";
    this.extractTier =
      extractTier && CHAT_PRICING_BY_TIER[extractTier] ? extractTier : "full";
    this.extractPricing = CHAT_PRICING_BY_TIER[this.extractTier] ?? ChatPricing.full;

    const models = cfg.voiceLiveModels ?? [];
    const model =
      modelTier && models.includes(modelTier)
        ? modelTier
        : cfg.defaultVoiceLiveModel || models[0] || "gpt-5-nano";
    this.pricing = VoiceLivePricing.forModel(model);

    // ---- Mic capture: PCM16 @ 24 kHz mono ----
    await this.setupCapture();

    // ---- Open the relayed audio WebSocket ----
    const params = new URLSearchParams();
    params.set("variant", this.variant);
    params.set("model", model);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/api/voicelive/ws?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        this.handlers.onLog(`Voice Live WebSocket open (model=${model})`);
        this.handlers.onStateChange("live");
        resolve();
      };
      ws.onerror = () => {
        this.handlers.onLog("Voice Live WebSocket error");
        reject(new Error("Voice Live WebSocket connection failed"));
      };
      ws.onclose = () => {
        this.handlers.onLog("Voice Live WebSocket closed");
        this.handlers.onStateChange("ended");
      };
      ws.onmessage = (ev) => this.handleEvent(ev.data);
    });
  }

  hangup(): VoiceLiveTotals {
    this.handlers.onLog("Hanging up...");
    this.stopPlayback();
    try { this.processor?.disconnect(); } catch { /* ignore */ }
    try { this.micSource?.disconnect(); } catch { /* ignore */ }
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    try { this.captureCtx?.close(); } catch { /* ignore */ }
    try { this.playbackCtx?.close(); } catch { /* ignore */ }
    try { this.ws?.close(); } catch { /* ignore */ }

    this.ws = null;
    this.processor = null;
    this.micSource = null;
    this.localStream = null;
    this.captureCtx = null;
    this.playbackCtx = null;
    this.sessionReady = false;
    this.greetingSent = false;
    this.handlers.onStateChange("idle");

    const total =
      this.totals.conversation.totalCost + this.totals.extract.totalCost;
    return {
      conversation: this.totals.conversation,
      extract: this.totals.extract,
      total,
      pricingName: this.pricing.name,
      extractPricingName: this.extractPricing.name,
    };
  }

  // ----------------------------------------------------------------------
  private async setupCapture(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.captureCtx = ctx;
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* ignore */ }
    }

    const source = ctx.createMediaStreamSource(this.localStream);
    this.micSource = source;
    const processor = ctx.createScriptProcessor(CAPTURE_BUFFER, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (ev) => {
      if (!this.sessionReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const input = ev.inputBuffer.getChannelData(0);
      const audio = floatToPcm16Base64(input);
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    };
    // ScriptProcessor needs a sink to fire; output is left silent.
    source.connect(processor);
    processor.connect(ctx.destination);
  }

  private ensurePlaybackCtx(): AudioContext {
    if (!this.playbackCtx || this.playbackCtx.state === "closed") {
      this.playbackCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.playHead = 0;
    }
    if (this.playbackCtx.state === "suspended") {
      this.playbackCtx.resume().catch(() => { /* ignore */ });
    }
    return this.playbackCtx;
  }

  /** Schedule a decoded PCM frame for gapless playback. */
  private enqueueAudio(b64: string): void {
    const samples = pcm16Base64ToFloat(b64);
    if (samples.length === 0) return;
    const ctx = this.ensurePlaybackCtx();
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.playHead);
    node.start(startAt);
    this.playHead = startAt + buffer.duration;
    this.activeSources.add(node);
    node.onended = () => this.activeSources.delete(node);
  }

  /** Stop and drop all scheduled audio (barge-in / hangup). */
  private stopPlayback(): void {
    for (const node of this.activeSources) {
      try { node.stop(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
    }
    this.activeSources.clear();
    if (this.playbackCtx) this.playHead = this.playbackCtx.currentTime;
  }

  private sendGreeting(): void {
    if (
      this.greetingSent ||
      !this.greeting ||
      !this.sessionReady ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    this.greetingSent = true;
    // Trigger the agent to open the conversation. We send a plain
    // response.create (no instructions override) so each prompt variant's own
    // system prompt drives the opening turn in the correct language.
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  private handleEvent(raw: unknown): void {
    if (typeof raw !== "string") return;
    let evt: any;
    try { evt = JSON.parse(raw); } catch {
      this.handlers.onLog("WS: non-JSON message");
      return;
    }
    const type: string = evt.type ?? "(no type)";

    // ---- Errors: dump the whole payload, it carries the reason ----
    if (type === "error" || type === "response.error") {
      this.handlers.onLog(`Voice Live error: ${JSON.stringify(evt.error ?? evt)}`);
      return;
    }

    // ---- Assistant audio frames (handle naming variants) ----
    if (/(?:output_)?audio\.delta$/.test(type)) {
      const delta: string = evt.delta ?? "";
      if (delta) this.enqueueAudio(delta);
      return;
    }
    if (/(?:output_)?audio\.done$/.test(type)) {
      return;
    }

    // ---- Assistant streaming transcript (handle all naming variants) ----
    if (/(?:audio_)?transcript\.delta$/.test(type) || type === "response.output_text.delta" || type === "response.text.delta") {
      const delta: string = evt.delta ?? "";
      if (delta) {
        this.assistantCurrent += delta;
        this.handlers.onAssistantTranscript(delta, false);
      }
      return;
    }
    if (/(?:audio_)?transcript\.done$/.test(type) || type === "response.output_text.done" || type === "response.text.done") {
      const finalText = sanitize(this.assistantCurrent);
      if (finalText) this.lastAssistantUtterance = finalText;
      this.assistantCurrent = "";
      this.handlers.onAssistantTranscript("", true);
      return;
    }

    switch (type) {
      case "session.created":
        return;
      case "session.updated": {
        // Session is configured (prompt, server VAD, voice). Safe to greet.
        this.sessionReady = true;
        this.handlers.onLog("─── Conversation started ───");
        this.sendGreeting();
        return;
      }

      case "response.created":
        return;

      // ---- User turn lifecycle ----
      case "conversation.item.added":
      case "conversation.item.created": {
        const item = evt.item ?? {};
        if (item.role === "user" && item.id) {
          this.ensureUserTurn(item.id);
        }
        return;
      }
      case "input_audio_buffer.speech_started":
        // Barge-in: the user started talking, so stop any assistant audio that
        // is still playing. The service (interrupt_response:true) cancels the
        // in-flight response on its side.
        this.stopPlayback();
        return;

      case "conversation.item.input_audio_transcription.completed": {
        const text = sanitize(evt.transcript ?? "");
        const itemId: string = evt.item_id ?? "";
        this.ensureUserTurn(itemId);
        if (text) {
          this.handlers.onUserTranscript(itemId, text, "transcribe");
        }
        // Extract the anamnesis from the patient's transcribed turn via the
        // backend REST endpoint (decoupled from the Voice Live conversation).
        if (itemId && text) {
          this.lastUserText = text;
          this.lastUserItemId = itemId;
          void this.runExtract();
        }
        return;
      }

      // ---- Usage / cost ----
      case "response.done": {
        const usage: Usage | undefined = evt.response?.usage;
        if (usage) {
          this.totals.conversation = mergeCost(
            this.totals.conversation,
            computeRealtimeCost(usage, this.pricing),
          );
        }
        return;
      }

      default:
        return;
    }
  }

  private ensureUserTurn(itemId: string): void {
    if (!itemId || this.seenUserItems.has(itemId)) return;
    this.seenUserItems.add(itemId);
    this.handlers.onUserTurnStarted(itemId);
  }

  // ---- Anamnese extraction (medical variant) -----------------------------
  /** Extract the anamnesis from the patient's latest turn via /api/extract.
   *  This is a plain HTTP call to the backend (the same path the pipeline mode
   *  uses), fully decoupled from the Voice Live WebSocket conversation. */
  private async runExtract(): Promise<void> {
    if (this.variant !== "medical") return;
    const itemId = this.lastUserItemId;
    const stateJson = JSON.stringify(this.anamneseState ?? {});
    const today = new Date().toISOString().slice(0, 10);
    const content =
      `DOCTOR'S MOST RECENT UTTERANCE (context; source for plan, vitals, exam, labs):\n` +
      `"${this.lastAssistantUtterance}"\n\n` +
      `PATIENT'S ANSWER (clinical data comes ONLY from here):\n` +
      `"${this.lastUserText}"\n\n` +
      `CURRENT STATE (already captured; reproduce and extend, do not drop):\n${stateJson}\n\n` +
      `TODAY: ${today}\n\n` +
      `Return the COMPLETE anamnesis object. Use null for any field not yet known.`;

    try {
      const r = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          model: this.extractTier,
        }),
      });
      if (!r.ok) {
        this.handlers.onLog(`Extract failed: ${r.status} ${await r.text()}`);
        return;
      }
      const data = (await r.json()) as {
        patch?: Record<string, unknown>;
        usage?: ChatUsage;
      };
      if (data.usage) {
        this.totals.extract = mergeCost(
          this.totals.extract,
          computeChatCost(data.usage, this.extractPricing),
        );
      }
      if (data.patch && typeof data.patch === "object") {
        this.handlers.onAnamnesePatch?.(data.patch, itemId);
      }
    } catch (err) {
      this.handlers.onLog(
        `Extract error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
