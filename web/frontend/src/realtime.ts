/**
 * WebRTC client for Azure OpenAI Realtime.
 *
 * We do NOT use webrtcfilter=on, because:
 *   - We need response.created (to tag OOB transcription responses by id)
 *   - We need response.done (to capture usage data for cost reporting)
 *
 * Out-of-band transcription is gated on no other response being active
 * (server_vad with create_response=true triggers the main audio response on
 * each user turn; concurrent responses are rejected by the server).
 */

import { computeRealtimeCost, computeTranscribeCost, RealtimePricing, type CostBreakdown, type Usage } from "./costs";

export const TRANSCRIPTION_PURPOSE = "User turn transcription";

export interface RealtimeConfig {
  azureHost: string;
  deployment: string;
  transcriptionModel: string;
  voice: string;
  transcriptionInstructions: string;
}

export interface SessionTotals {
  realtimeMain: CostBreakdown;
  realtimeOob: CostBreakdown;
  transcribe: CostBreakdown;
  total: number;
  pricingName: string;
}

export interface RealtimeHandlers {
  onLog: (msg: string) => void;
  onUserTurnStarted: (itemId: string) => void;
  onUserTranscript: (
    itemId: string,
    text: string,
    source: "transcribe" | "realtime",
  ) => void;
  onAssistantTranscript: (text: string, done: boolean) => void;
  onStateChange: (state: "idle" | "connecting" | "live" | "ended") => void;
}

const EMPTY: CostBreakdown = { totalCost: 0, parts: {} };

export class RealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private pricing: RealtimePricing = RealtimePricing.full;
  private transcriptionInstructions = "";

  /** user audio item ids waiting for an OOB transcription request. */
  private pendingUserItems: string[] = [];
  /** user item ids we've already shown a bubble for. */
  private seenUserItems = new Set<string>();
  /** user item ids we've already enqueued for OOB. */
  private queuedOobItems = new Set<string>();
  /** response.id -> the user item id it was created for (so OOB results map back). */
  private oobResponseToItem = new Map<string, string>();
  /** response.ids that we sent as OOB transcription (vs main audio responses). */
  private oobResponseIds = new Set<string>();
  /** number of active responses (main + oob). Used to gate OOB sends. */
  private activeResponses = 0;
  /** OOB requests we created locally but haven't sent yet. */
  private oobQueue: string[] = [];
  /** Per-response streaming text buffer for OOB. */
  private oobTextByResponse = new Map<string, string>();

  // Running cost totals
  private totals = {
    realtimeMain: { ...EMPTY, parts: { ...EMPTY.parts } } as CostBreakdown,
    realtimeOob: { ...EMPTY, parts: { ...EMPTY.parts } } as CostBreakdown,
    transcribe: { ...EMPTY, parts: { ...EMPTY.parts } } as CostBreakdown,
  };

  constructor(private handlers: RealtimeHandlers) {}

  async start(): Promise<void> {
    this.handlers.onStateChange("connecting");

    const cfg = await fetchJson<RealtimeConfig>("/api/config");
    this.pricing = /mini/i.test(cfg.deployment)
      ? RealtimePricing.mini
      : RealtimePricing.full;
    this.transcriptionInstructions = cfg.transcriptionInstructions ?? "";

    const { token } = await fetchJson<{ token: string }>("/api/token");
    if (!token) throw new Error("Token service returned no ephemeral key.");

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

    const dc = pc.createDataChannel("realtime-channel");
    this.dc = dc;
    dc.addEventListener("open", () => this.handlers.onLog("Data channel open"));
    dc.addEventListener("close", () => {
      this.handlers.onLog("Data channel closed");
      this.handlers.onStateChange("ended");
    });
    dc.addEventListener("message", (ev) => this.handleEvent(ev.data));

    pc.onconnectionstatechange = () => {
      this.handlers.onLog(`PeerConnection: ${pc.connectionState}`);
      if (pc.connectionState === "connected") this.handlers.onStateChange("live");
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.handlers.onStateChange("ended");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // No webrtcfilter: we need full server events for OOB tagging + usage.
    const callsUrl =
      `https://${cfg.azureHost}/openai/v1/realtime/calls` +
      `?model=${encodeURIComponent(cfg.deployment)}`;
    const sdpResp = await fetch(callsUrl, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdpResp.ok) {
      throw new Error(`SDP exchange failed: ${sdpResp.status} ${await sdpResp.text()}`);
    }
    const answer: RTCSessionDescriptionInit = {
      type: "answer",
      sdp: await sdpResp.text(),
    };
    await pc.setRemoteDescription(answer);
    this.handlers.onLog("WebRTC negotiated");
  }

  hangup(): SessionTotals {
    this.handlers.onLog("Hanging up...");
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    for (const t of this.localStream?.getTracks() ?? []) t.stop();
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
    }
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    this.audioEl = null;
    this.handlers.onStateChange("idle");

    const total =
      this.totals.realtimeMain.totalCost +
      this.totals.realtimeOob.totalCost +
      this.totals.transcribe.totalCost;
    return {
      realtimeMain: this.totals.realtimeMain,
      realtimeOob: this.totals.realtimeOob,
      transcribe: this.totals.transcribe,
      total,
      pricingName: this.pricing.name,
    };
  }

  // ----------------------------------------------------------------------
  private handleEvent(raw: string): void {
    let evt: any;
    try { evt = JSON.parse(raw); } catch { return; }
    const type: string = evt.type ?? "";

    switch (type) {
      case "conversation.item.added":
      case "conversation.item.created": {
        const item = evt.item ?? {};
        if (item.role !== "user" || !item.id) return;
        // Insert the user bubble the first time we see this item id
        // (regardless of status), so the chat keeps the right ordering.
        if (!this.seenUserItems.has(item.id)) {
          this.seenUserItems.add(item.id);
          this.handlers.onUserTurnStarted(item.id);
        }
        // Only enqueue an OOB transcription request once the audio is
        // actually attached to the item; otherwise the realtime model
        // gets an empty reference and answers with a generic reply.
        const content: any[] = item.content ?? [];
        const hasUserAudio = content.some((b) => b?.type === "input_audio");
        if (item.status === "completed" && hasUserAudio) {
          if (!this.queuedOobItems.has(item.id)) {
            this.queuedOobItems.add(item.id);
            this.pendingUserItems.push(item.id);
            this.maybeQueueOobForPendingItems();
          }
        }
        return;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const text = (evt.transcript ?? "").trim();
        const itemId: string = evt.item_id ?? "";
        if (text) this.handlers.onUserTranscript(itemId, text, "transcribe");
        // Capture transcribe-model usage if present.
        const usage: Usage | undefined = evt.usage;
   
        if (usage) {
          this.totals.transcribe = mergeCost(
            this.totals.transcribe,
            computeTranscribeCost(usage)
          );
        }
        return;
      }

      case "response.created": {
        const id: string | undefined = evt.response?.id;
        const meta = evt.response?.metadata ?? {};
        if (id && meta.purpose === TRANSCRIPTION_PURPOSE) {
          this.oobResponseIds.add(id);
          if (meta.item_id) this.oobResponseToItem.set(id, meta.item_id);
        }
        this.activeResponses++;
        return;
      }

      case "response.done": {
        const resp = evt.response ?? {};
        const id: string | undefined = resp.id;
        const usage: Usage | undefined = resp.usage;
        const isOob = id ? this.oobResponseIds.has(id) : false;
        if (usage) {
          const cost = computeRealtimeCost(usage, this.pricing);
          if (isOob) {
            this.totals.realtimeOob = mergeCost(this.totals.realtimeOob, cost);
          } else {
            this.totals.realtimeMain = mergeCost(this.totals.realtimeMain, cost);
          }
        }
        if (id) {
          this.oobTextByResponse.delete(id);
          this.oobResponseToItem.delete(id);
        }
        this.activeResponses = Math.max(0, this.activeResponses - 1);
        // Try to flush any queued OOB now that nothing is active.
        this.flushOobQueue();
        // Always schedule pending user items now.
        this.maybeQueueOobForPendingItems();
        return;
      }

      // Out-of-band transcription text (only OOB responses have output_text).
      case "response.output_text.delta":
      case "response.text.delta": {
        const id = evt.response_id ?? "";
        if (this.oobResponseIds.has(id)) {
          const buf = (this.oobTextByResponse.get(id) ?? "") + (evt.delta ?? "");
          this.oobTextByResponse.set(id, buf);
        }
        return;
      }
      case "response.output_text.done":
      case "response.text.done": {
        const id = evt.response_id ?? "";
        if (this.oobResponseIds.has(id)) {
          const text = sanitize(evt.text ?? this.oobTextByResponse.get(id) ?? "");
          this.oobTextByResponse.delete(id);
          const itemId = this.oobResponseToItem.get(id) ?? "";
          if (text) this.handlers.onUserTranscript(itemId, text, "realtime");
        }
        return;
      }

      // Assistant audio transcript -> chat bubble (skip OOB ids).
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (this.oobResponseIds.has(evt.response_id)) return;
        const delta = stripSpecialTokens(evt.delta ?? "");
        if (delta) this.handlers.onAssistantTranscript(delta, false);
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (this.oobResponseIds.has(evt.response_id)) return;
        this.handlers.onAssistantTranscript("", true);
        return;
      }

      case "error": {
        this.handlers.onLog(`Error: ${evt.error?.message ?? JSON.stringify(evt)}`);
        return;
      }

      default:
        return;
    }
  }

  // Pull pending user item ids into the OOB queue, then try to send.
  private maybeQueueOobForPendingItems(): void {
    while (this.pendingUserItems.length) {
      const itemId = this.pendingUserItems.shift()!;
      this.oobQueue.push(itemId);
    }
    this.flushOobQueue();
  }

  private flushOobQueue(): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    while (this.oobQueue.length && this.activeResponses === 0) {
      const itemId = this.oobQueue.shift()!;
      // Tag this OOB request with a client-side response_id we can correlate.
      // Server assigns its own id in response.created; we map server id -> itemId
      // there. For now, just remember the mapping by storing in a transient
      // "next OOB item" slot and resolving in response.created via metadata.
      const payload = {
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          metadata: { purpose: TRANSCRIPTION_PURPOSE, item_id: itemId },
          instructions: this.transcriptionInstructions,
          input: [{ type: "item_reference", id: itemId }],
        },
      };
      this.dc.send(JSON.stringify(payload));
      this.handlers.onLog(`OOB transcription requested for ${itemId}`);
      // activeResponses will be incremented by the server's response.created.
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const SPECIAL_TOKEN_RE = /<\|[^|>]+\|>/g;
function stripSpecialTokens(s: string): string {
  return s.replace(SPECIAL_TOKEN_RE, "");
}
function stripJsonWrapper(s: string): string {
  const trimmed = s.trim();
  // Try to parse a JSON wrapper like {"transcription": "..."} or ["..."]
  // and pull the inner string out. Falls back to the original text on failure.
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
      if (Array.isArray(parsed)) {
        return parsed.filter((x) => typeof x === "string").join(" ");
      }
      if (parsed && typeof parsed === "object") {
        const values = Object.values(parsed).filter(
          (v) => typeof v === "string",
        );
        if (values.length === 1) return values[0] as string;
        if (values.length > 1) return values.join(" ");
      }
    } catch {
      // not valid JSON; fall through
    }
  }
  // Strip a leading code fence like ```json ... ``` if present.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return stripJsonWrapper(fence[1]);
  return s;
}
function sanitize(s: string): string {
  return stripSpecialTokens(stripJsonWrapper(s)).trim();
}

function mergeCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const parts: CostBreakdown["parts"] = { ...a.parts };
  for (const [k, v] of Object.entries(b.parts)) {
    const prev = parts[k];
    if (prev) {
      parts[k] = {
        cost: prev.cost + v.cost,
        tokens: prev.tokens + v.tokens,
        unitPricePerM: v.unitPricePerM, // unit price is constant per component
      };
    } else {
      parts[k] = { ...v };
    }
  }
  return { totalCost: a.totalCost + b.totalCost, parts };
}
