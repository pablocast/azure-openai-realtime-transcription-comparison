/**
 * WebRTC client for the Azure Voice Live API — **Lite** tier.
 *
 * Unlike the AOAI Realtime client (which POSTs its SDP offer straight to Azure
 * using an ephemeral key), Voice Live negotiates over a WebSocket signaling
 * channel that requires an Entra `Authorization` header the browser can't set.
 * So the control channel is relayed (keyless) through our backend at
 * `/api/voicelive/ws`, which also injects the persona `session.update`.
 *
 * Two event streams reach us:
 *   - Signaling WS (relayed):  rtc.call.sdp.created, rtc.call.error,
 *                              session.created / session.updated, error
 *   - Data channel "voice-live-events" (peer-to-peer): conversation items,
 *     input_audio_buffer.*, conversation.item.input_audio_transcription.*,
 *     response.* (response.done carries usage for cost reporting)
 *
 * Audio (RTP) flows peer-to-peer and never touches the backend.
 */

import {
  computeRealtimeCost,
  VoiceLivePricing,
  type CostBreakdown,
  type Usage,
} from "./costs";
import type { RealtimeHandlers } from "./realtime";

export interface VoiceLiveTotals {
  /** Per-response usage from the data channel (audio in/out + text). */
  conversation: CostBreakdown;
  total: number;
  pricingName: string;
}

interface VoiceLiveConfig {
  promptVariants: string[];
  defaultPromptVariant: string;
  voiceLiveModels: string[];
  defaultVoiceLiveModel: string;
  voiceLiveGreeting: string;
}

const EMPTY: CostBreakdown = { totalCost: 0, parts: {} };
const SPECIAL_TOKEN_RE = /<\|[^|>]+\|>/g;

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

export class VoiceLiveClient {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private offerSdp = "";

  private pricing: VoiceLivePricing = VoiceLivePricing.nano;
  private variant = "v1";
  private greeting = "";
  private greetingSent = false;
  private sessionReady = false;

  /** user audio item ids we've already shown a bubble for. */
  private seenUserItems = new Set<string>();
  private assistantCurrent = "";

  private totals = {
    conversation: clone(EMPTY),
  };

  constructor(private handlers: RealtimeHandlers) {}

  /** Called by the UI after every merge so the extractor sees the latest state. */
  setAnamneseState(_state: Record<string, unknown>): void {}

  async start(variant?: string, modelTier?: string, _extractTier?: string): Promise<void> {
    this.handlers.onStateChange("connecting");

    const cfg = await fetchJson<VoiceLiveConfig>("/api/config");
    this.variant = variant ?? cfg.defaultPromptVariant;
    this.greeting = cfg.voiceLiveGreeting ?? "";

    const models = cfg.voiceLiveModels ?? [];
    const model =
      modelTier && models.includes(modelTier)
        ? modelTier
        : cfg.defaultVoiceLiveModel || models[0] || "gpt-5-nano";
    this.pricing = VoiceLivePricing.forModel(model);

    // ---- Set up the peer connection before signaling ----
    const pc = new RTCPeerConnection();
    this.pc = pc;

    const audio = document.createElement("audio");
    audio.autoplay = true;
    document.body.appendChild(audio);
    this.audioEl = audio;
    pc.ontrack = (ev) => {
      if (ev.streams[0]) audio.srcObject = ev.streams[0];
    };

    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream);
    }

    const dc = pc.createDataChannel("voice-live-events");
    this.dc = dc;
    dc.addEventListener("open", () => {
      this.handlers.onLog("Voice Live data channel open");
      this.sendGreeting();
    });
    dc.addEventListener("message", (ev) => this.handleEvent(ev.data, "datachannel"));

    pc.onconnectionstatechange = () => {
      this.handlers.onLog(`PeerConnection: ${pc.connectionState}`);
      if (pc.connectionState === "connected") this.handlers.onStateChange("live");
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.handlers.onStateChange("ended");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.offerSdp = offer.sdp ?? "";

    // ---- Open the relayed signaling WebSocket ----
    const params = new URLSearchParams();
    params.set("variant", this.variant);
    params.set("model", model);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/api/voicelive/ws?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        this.handlers.onLog(`Voice Live signaling open (model=${model})`);
        // Send the SDP offer; the backend injects session.update right after.
        ws.send(JSON.stringify({ type: "rtc.call.sdp.create", sdp_offer: this.offerSdp }));
        resolve();
      };
      ws.onerror = () => {
        this.handlers.onLog("Voice Live signaling error");
        reject(new Error("Voice Live signaling connection failed"));
      };
      ws.onclose = () => {
        this.handlers.onLog("Voice Live signaling closed");
      };
      ws.onmessage = (ev) => this.handleEvent(ev.data, "signaling");
    });
  }

  hangup(): VoiceLiveTotals {
    this.handlers.onLog("Hanging up...");
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
    }
    this.ws = null;
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    this.audioEl = null;
    this.handlers.onStateChange("idle");

    const total = this.totals.conversation.totalCost;
    return {
      conversation: this.totals.conversation,
      total,
      pricingName: this.pricing.name,
    };
  }

  // ----------------------------------------------------------------------
  private sendGreeting(): void {
    if (
      this.greetingSent ||
      !this.greeting ||
      !this.sessionReady ||
      !this.dc ||
      this.dc.readyState !== "open"
    ) {
      return;
    }
    this.greetingSent = true;
    this.handlers.onLog("Sending greeting (response.create)");
    // Trigger the agent to open the conversation. We send a plain
    // response.create (no instructions override) so each prompt variant's own
    // system prompt drives the opening turn in the correct language.
    this.dc.send(JSON.stringify({ type: "response.create" }));
  }

  private handleEvent(raw: unknown, source: "signaling" | "datachannel"): void {
    if (typeof raw !== "string") return;
    let evt: any;
    try { evt = JSON.parse(raw); } catch {
      this.handlers.onLog(`${source}: non-JSON message`);
      return;
    }
    const type: string = evt.type ?? "(no type)";
    // Trace every event so the Logs panel shows the full event flow.
    this.handlers.onLog(`${source === "signaling" ? "WS" : "DC"} ◀ ${type}`);

    // ---- Errors: dump the whole payload, it carries the reason ----
    if (type === "rtc.call.error" || type === "error" || type === "response.error") {
      this.handlers.onLog(`Voice Live error: ${JSON.stringify(evt.error ?? evt)}`);
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
      this.assistantCurrent = "";
      this.handlers.onAssistantTranscript("", true);
      return;
    }

    switch (type) {
      // ---- Signaling: SDP answer ----
      case "rtc.call.sdp.created": {
        const sdp = evt.sdp_answer ?? evt.sdp ?? evt.answer?.sdp;
        if (sdp && this.pc) {
          this.pc
            .setRemoteDescription({ type: "answer", sdp })
            .then(() => this.handlers.onLog("WebRTC negotiated"))
            .catch((e) => this.handlers.onLog(`setRemoteDescription failed: ${e}`));
        } else {
          this.handlers.onLog(`sdp.created without answer sdp: ${JSON.stringify(evt).slice(0, 200)}`);
        }
        return;
      }
      case "session.created":
        return;
      case "session.updated": {
        // Send the proactive greeting only after the session is configured,
        // so it doesn't race the backend-injected session.update. session.updated
        // usually arrives on the signaling WS before the data channel opens, so
        // the dc "open" handler also calls sendGreeting() — whichever is last wins.
        this.sessionReady = true;
        this.sendGreeting();
        return;
      }

      // ---- User turn lifecycle ----
      case "conversation.item.added":
      case "conversation.item.created": {
        const item = evt.item ?? {};
        if (item.role === "user" && item.id) this.ensureUserTurn(item.id);
        return;
      }
      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.speech_stopped":
        return;

      case "conversation.item.input_audio_transcription.completed": {
        const text = sanitize(evt.transcript ?? "");
        const itemId: string = evt.item_id ?? "";
        this.ensureUserTurn(itemId);
        if (text) {
          this.handlers.onUserTranscript(itemId, text, "transcribe");
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
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
