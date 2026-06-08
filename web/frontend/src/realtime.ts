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
export const ANAMNESE_PURPOSE = "Anamnese extraction";


export interface RealtimeConfig {
  azureHost: string;
  deployment: string;
  deployments?: Record<string, string>;
  defaultModelTier?: string;
  transcriptionModel: string;
  voice: string;
  transcriptionInstructions: string;
  promptVariants: string[];
  defaultPromptVariant: string;
  anamneseJsonSchema: object | null;
  anamneseExtractInstructions: string;
  anamneseSchemaName: string;
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
  onAnamnesePatch?: (patch: unknown, itemId: string) => void;
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

  // ---- Anamnese (medical variant) OOB extraction ------------------------
  /** Extraction system prompt (from /api/config). */
  private anamneseInstructions = "";
  /** JSON schema (strict) — currently used only as a presence flag; the
   * Realtime API does not accept structured output config on response.create. */
  private anamneseSchema: any = null;
  /** Selected prompt variant for this session ("v1" | "v2" | "medical"). */
  private variant = "v1";
  /** user item ids waiting for an anamnese OOB request. */
  private anamneseQueue: string[] = [];
  /** Doctor-authored turns waiting for an anamnese OOB request. The doctor
   *  measures vitals / reads labs / states the plan in her own speech, so
   *  those sections must be extracted from the DOCTOR's utterance (there may
   *  be no patient turn afterwards to trigger extraction). */
  private anamneseDoctorQueue: Array<{ id: string; text: string }> = [];
  /** user item ids we've already enqueued for anamnese extraction. */
  private queuedAnamneseItems = new Set<string>();
  /** response.ids that we sent as anamnese OOB (vs transcription OOB / main). */
  private anamneseResponseIds = new Set<string>();
  /** anamnese response.id -> user item id (to correlate the patch). */
  private anamneseResponseToItem = new Map<string, string>();
  /** Per-response streaming JSON buffer for anamnese OOB. */
  private anamneseTextByResponse = new Map<string, string>();
  /** Per-response streaming buffer for anamnese tool-call arguments. */
  private anamneseArgsByResponse = new Map<string, string>();
  /** Latest accumulated anamnese form, injected into each extraction prompt. */
  private anamneseState: Record<string, any> = {};
  /** Streaming buffer for the assistant's current spoken turn. */
  private assistantCurrentTranscript = "";
  /** Last fully-completed assistant utterance (the doctor's question/prompt
   *  that the patient is now answering). Injected into OOB anamnese
   *  instructions so the extractor can correctly attribute the answer to
   *  the right field. */
  private lastAssistantUtterance = "";

  /** Called by the UI after every merge so the extractor sees the accumulated state. */
  setAnamneseState(state: Record<string, any>): void {
    this.anamneseState = state ?? {};
  }

  // Running cost totals
  private totals = {
    realtimeMain: { ...EMPTY, parts: { ...EMPTY.parts } } as CostBreakdown,
    realtimeOob: { ...EMPTY, parts: { ...EMPTY.parts } } as CostBreakdown,
    transcribe: { ...EMPTY, parts: { ...EMPTY.parts } } as CostBreakdown,
  };

  constructor(private handlers: RealtimeHandlers) {}

  async start(variant?: string, modelTier?: string): Promise<void> {
    this.handlers.onStateChange("connecting");

    const cfg = await fetchJson<RealtimeConfig>("/api/config");
    const tiers = cfg.deployments ?? { full: cfg.deployment };
    const resolvedTier =
      modelTier && tiers[modelTier]
        ? modelTier
        : (cfg.defaultModelTier && tiers[cfg.defaultModelTier]) || "full";
    const deployment = tiers[resolvedTier] ?? cfg.deployment;
    this.pricing = /mini/i.test(deployment)
      ? RealtimePricing.mini
      : RealtimePricing.full;
    this.transcriptionInstructions = cfg.transcriptionInstructions ?? "";
    this.variant = variant ?? cfg.defaultPromptVariant;
    this.anamneseInstructions = cfg.anamneseExtractInstructions ?? "";
    this.anamneseSchema = cfg.anamneseJsonSchema ?? null;

    const params = new URLSearchParams();
    if (variant) params.set("variant", variant);
    params.set("model", resolvedTier);
    const tokenUrl = `/api/token?${params.toString()}`;
    const { token } = await fetchJson<{ token: string }>(tokenUrl);
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
      `?model=${encodeURIComponent(deployment)}`;
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
          if (
            this.variant === "medical" &&
            this.anamneseSchema &&
            !this.queuedAnamneseItems.has(item.id)
          ) {
            this.queuedAnamneseItems.add(item.id);
            this.anamneseQueue.push(item.id);
            this.flushOobQueue();
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
        if (id && meta.purpose === ANAMNESE_PURPOSE) {
          this.anamneseResponseIds.add(id);
          if (meta.item_id) this.anamneseResponseToItem.set(id, meta.item_id);
        }
        this.activeResponses++;
        return;
      }

      case "response.done": {
        const resp = evt.response ?? {};
        const id: string | undefined = resp.id;
        const usage: Usage | undefined = resp.usage;
        const isOob = id ? this.oobResponseIds.has(id) : false;
        const isAnamnese = id ? this.anamneseResponseIds.has(id) : false;
        if (usage) {
          const cost = computeRealtimeCost(usage, this.pricing);
          if (isOob) {
            this.totals.realtimeOob = mergeCost(this.totals.realtimeOob, cost);
          } else {
            this.totals.realtimeMain = mergeCost(this.totals.realtimeMain, cost);
          }
        }
        // Diagnostics: surface the actual output composition + status of every
        // anamnese OOB response so we can see when the model returns nothing,
        // returns text instead of a tool call, or fails.
        if (isAnamnese && id) {
          const itemId = this.anamneseResponseToItem.get(id) ?? "";
          const status = resp.status ?? "unknown";
          const statusDetail =
            resp.status_details?.error?.message ??
            resp.status_details?.reason ??
            "";
          const outputs: any[] = Array.isArray(resp.output) ? resp.output : [];
          const kinds = outputs
            .map((o) => o?.type ?? "?")
            .join(",") || "(no output)";
          const argsBuf = (this.anamneseArgsByResponse.get(id) ?? "").trim();
          const textBuf = (this.anamneseTextByResponse.get(id) ?? "").trim();
          if (
            status !== "completed" ||
            (!argsBuf && !textBuf) ||
            outputs.length === 0
          ) {
            this.handlers.onLog(
              `Anamnese OOB [${itemId}] status=${status} outputs=[${kinds}]` +
                (statusDetail ? ` detail="${statusDetail}"` : "") +
                ` args=${argsBuf.length}B text=${textBuf.length}B`,
            );
          }
          // Fallback: if the model emitted plain text (instead of calling the
          // tool) and that text happens to be JSON, try to parse it as a patch.
          if (!argsBuf && textBuf) {
            const patch = parseAnamneseReply(textBuf);
            if (patch) {
              this.handlers.onLog(
                `Anamnese OOB [${itemId}] recovered patch from text fallback`,
              );
              this.handlers.onAnamnesePatch?.(patch, itemId);
            }
          }
        }
        if (id) {
          this.oobTextByResponse.delete(id);
          this.oobResponseToItem.delete(id);
        }
        if (id && this.anamneseResponseIds.has(id)) {
          this.anamneseTextByResponse.delete(id);
          this.anamneseArgsByResponse.delete(id);
          this.anamneseResponseToItem.delete(id);
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
        if (this.anamneseResponseIds.has(id)) {
          const buf = (this.anamneseTextByResponse.get(id) ?? "") + (evt.delta ?? "");
          this.anamneseTextByResponse.set(id, buf);
        }
        return;
      }

      // Anamnese tool-call arguments (preferred structured-output path).
      case "response.function_call_arguments.delta": {
        const id = evt.response_id ?? "";
        if (this.anamneseResponseIds.has(id)) {
          const buf =
            (this.anamneseArgsByResponse.get(id) ?? "") + (evt.delta ?? "");
          this.anamneseArgsByResponse.set(id, buf);
        }
        return;
      }
      case "response.function_call_arguments.done": {
        const id = evt.response_id ?? "";
        if (!this.anamneseResponseIds.has(id)) return;
        const raw =
          (evt.arguments ?? this.anamneseArgsByResponse.get(id) ?? "").trim();
        this.anamneseArgsByResponse.delete(id);
        const itemId = this.anamneseResponseToItem.get(id) ?? "";
        const preview = raw.replace(/\s+/g, " ").slice(0, 240);
        this.handlers.onLog(
          `Anamnese tool-call for ${itemId}: ${preview || "(empty)"}`,
        );
        const patch = parseAnamneseReply(raw);
        if (patch) {
          this.handlers.onAnamnesePatch?.(patch, itemId);
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
        if (this.anamneseResponseIds.has(id)) {
          const raw = (evt.text ?? this.anamneseTextByResponse.get(id) ?? "").trim();
          this.anamneseTextByResponse.delete(id);
          const itemId = this.anamneseResponseToItem.get(id) ?? "";
          // DEBUG:ANAMNESE — log raw extractor reply (truncated) per turn.
          const preview = raw.replace(/\s+/g, " ").slice(0, 240);
          this.handlers.onLog(
            `Anamnese reply for ${itemId}: ${preview || "(empty)"}`,
          );
          const patch = parseAnamneseReply(raw);
          if (patch) {
            this.handlers.onAnamnesePatch?.(patch, itemId);
          }
        }
        return;
      }

      // Assistant audio transcript -> chat bubble (skip OOB ids).
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (this.oobResponseIds.has(evt.response_id)) return;
        const delta = stripSpecialTokens(evt.delta ?? "");
        if (delta) {
          this.assistantCurrentTranscript += delta;
          this.handlers.onAssistantTranscript(delta, false);
        }
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (this.oobResponseIds.has(evt.response_id)) return;
        const finalText =
          (typeof evt.transcript === "string" && evt.transcript) ||
          this.assistantCurrentTranscript;
        const cleaned = stripSpecialTokens(finalText).trim();
        if (cleaned) this.lastAssistantUtterance = cleaned;
        // The doctor authors signos_vitales / examen_fisico / laboratorios /
        // plan in her own speech. Extract those from THIS doctor turn, since
        // there may be no patient turn afterwards to trigger extraction.
        if (
          cleaned &&
          this.variant === "medical" &&
          this.anamneseSchema
        ) {
          this.anamneseDoctorQueue.push({
            id: `doctor-${Date.now()}`,
            text: cleaned,
          });
          this.flushOobQueue();
        }
        this.assistantCurrentTranscript = "";
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
    while (this.anamneseQueue.length && this.activeResponses === 0) {
      const itemId = this.anamneseQueue.shift()!;
      // Force structured output via tool calling. The model MUST emit a
      // function_call to save_anamnesis whose arguments validate against
      // the schema. This eliminates the prose/JSON-formatting failure modes
      // that affected the text-only path.
      // Build a compact CURRENT STATE: drop empty / null branches and use
      // compact JSON (no indentation) so it doesn't balloon the input token
      // budget as the form fills up. Mini's context window is tighter than
      // full's, and we were hitting "too many tokens" mid-conversation.
      const compactState = compactNonEmpty(this.anamneseState ?? {}) ?? {};
      const stateJson = JSON.stringify(compactState);
      const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const todayBlock =
        "\n\nTODAY: " +
        todayIso +
        " (use this date to compute `identificacion.edad` in completed " +
        "years whenever `fecha_nacimiento` is known).";
      const doctorContext = this.lastAssistantUtterance
        ? "\n\nDOCTOR'S MOST RECENT UTTERANCE (the question the patient is " +
          "answering in this turn — use it ONLY to decide which schema field " +
          "the patient's answer belongs to. Do NOT extract the doctor's own " +
          "words into any section here; vitals, exam, labs and plan are " +
          "captured separately from the doctor's turn):\n\"" +
          this.lastAssistantUtterance +
          "\""
        : "";
      const instructions =
        this.anamneseInstructions +
        "\n\nCURRENT STATE (already captured; do NOT re-emit unchanged values):\n" +
        stateJson +
        todayBlock +
        doctorContext +
        "\n\nCRITICAL ANTI-HALLUCINATION RULES:\n" +
        "- Extract ONLY information the PATIENT explicitly said in this turn.\n" +
        "- NEVER invent, infer, guess, or assume any value.\n" +
        "- If the patient did not mention a field, OMIT it entirely from the " +
        "tool arguments (do not include the key at all, or pass null).\n" +
        "- Do NOT fill plausible-sounding defaults (e.g. \"dieta balanceada\", " +
        "\"duerme 7-8 horas\", \"hace 3 semanas\") unless the patient literally " +
        "said them.\n" +
        "- Do NOT carry over examples from the system prompt as if they were " +
        "real patient data.\n\n" +
        "Call the function `save_anamnesis` EXACTLY ONCE with ONLY the fields " +
        "that are NEW or CORRECTED in this turn. Omit (or set to null) every " +
        "other field. Do NOT speak. Do NOT emit any text.";
      // Build a relaxed schema: keep types/structure but drop `required`
      // arrays so the model can OMIT fields it has no information for,
      // instead of being forced to invent plausible values.
      const relaxed = relaxSchemaForTool(this.anamneseSchema);
      const tool: any = {
        type: "function",
        name: "save_anamnesis",
        description:
          "Persist ONLY fields the patient explicitly mentioned in this last " +
          "turn. Omit (or set to null) any field that was not said. NEVER " +
          "invent or infer values. NEVER repeat already-captured values.",
        parameters: relaxed,
      };
      const payload = {
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          // Cap output to keep total tokens well below mini's context limit.
          // Patches are always small JSON objects; 512 tokens is plenty.
          max_output_tokens: 512,
          metadata: { purpose: ANAMNESE_PURPOSE, item_id: itemId },
          instructions,
          input: [{ type: "item_reference", id: itemId }],
          tools: [tool],
          tool_choice: { type: "function", name: "save_anamnesis" },
        },
      };
      this.dc!.send(JSON.stringify(payload));
      this.handlers.onLog(`OOB anamnese requested for ${itemId}`);
    }
    // Doctor-authored extraction: vitals / exam / labs / plan come from the
    // doctor's own speech, so reference her transcript text directly (there
    // is no patient audio item to point at).
    while (this.anamneseDoctorQueue.length && this.activeResponses === 0) {
      const { id: doctorId, text: doctorText } = this.anamneseDoctorQueue.shift()!;
      const compactState = compactNonEmpty(this.anamneseState ?? {}) ?? {};
      const stateJson = JSON.stringify(compactState);
      const todayIso = new Date().toISOString().slice(0, 10);
      const todayBlock =
        "\n\nTODAY: " +
        todayIso +
        " (use this date to compute `identificacion.edad` in completed " +
        "years whenever `fecha_nacimiento` is known).";
      const instructions =
        this.anamneseInstructions +
        "\n\nCURRENT STATE (already captured; do NOT re-emit unchanged values):\n" +
        stateJson +
        todayBlock +
        "\n\nTHIS INPUT IS THE DOCTOR'S OWN UTTERANCE (not the patient). The " +
        "doctor measures vitals, performs the physical exam, reads lab " +
        "results and states the plan in her own words. Extract ONLY the " +
        "DOCTOR-AUTHORED sections from this input: `signos_vitales`, " +
        "`examen_fisico`, `laboratorios` and `plan`. Do NOT touch any " +
        "patient-history section (identificacion, motivo_consulta, " +
        "enfermedad_actual, antecedentes_*, medicamentos_actuales, habitos) " +
        "from this input.\n" +
        "\n\nCRITICAL ANTI-HALLUCINATION RULES:\n" +
        "- Extract ONLY values the DOCTOR explicitly said in this turn.\n" +
        "- NEVER invent, infer, guess, or assume any value.\n" +
        "- If a field was not stated, OMIT it entirely (or pass null).\n" +
        "- Do NOT carry over examples from the system prompt as real data.\n\n" +
        "Call the function `save_anamnesis` EXACTLY ONCE with ONLY the " +
        "doctor-authored fields that are NEW or CORRECTED in this turn. Omit " +
        "every other field. Do NOT speak. Do NOT emit any text.";
      const relaxed = relaxSchemaForTool(this.anamneseSchema);
      const tool: any = {
        type: "function",
        name: "save_anamnesis",
        description:
          "Persist ONLY doctor-authored fields (signos_vitales, examen_fisico, " +
          "laboratorios, plan) explicitly stated in this doctor turn. Omit any " +
          "field not said. NEVER invent or repeat already-captured values.",
        parameters: relaxed,
      };
      const payload = {
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          max_output_tokens: 512,
          metadata: { purpose: ANAMNESE_PURPOSE, item_id: doctorId },
          instructions,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: doctorText }],
            },
          ],
          tools: [tool],
          tool_choice: { type: "function", name: "save_anamnesis" },
        },
      };
      this.dc!.send(JSON.stringify(payload));
      this.handlers.onLog(`OOB anamnese (doctor) requested for ${doctorId}`);
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

/** Recursively drop empty / null / "" / [] / {} branches from an object so
 *  the serialized form is as short as possible. Used to keep CURRENT STATE
 *  small in OOB extractor prompts (especially for mini's tighter context). */
function compactNonEmpty(value: any): any {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? undefined : t;
  }
  if (Array.isArray(value)) {
    const out = value
      .map((v) => compactNonEmpty(v))
      .filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactNonEmpty(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** Deep-clone a JSON schema and remove all `required` arrays so the model
 *  is free to OMIT fields it has no information for, instead of being
 *  forced to invent plausible values to satisfy required constraints. */
function relaxSchemaForTool(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(relaxSchemaForTool);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "required") continue; // drop required arrays
    out[k] = relaxSchemaForTool(v);
  }
  return out;
}

/** Best-effort JSON recovery from the extractor's raw text reply.
 *  Returns the parsed patch object, or null if no usable JSON was found. */
function parseAnamneseReply(raw: string): Record<string, any> | null {
  let text = stripSpecialTokens(raw).trim();
  if (!text) return null;
  // Strip ```json ... ``` fences.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  // Unwrap a double-encoded JSON string, e.g. `"{ \"identificacion\": ... }"`.
  // Some models hand back the whole object as a JSON-encoded string.
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const inner = JSON.parse(text);
      if (typeof inner === "string") text = inner.trim();
    } catch {
      /* fall through with original text */
    }
  }

  const tryParse = (s: string): Record<string, any> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };

  // 1) Direct parse.
  let obj = tryParse(text);
  if (obj) return obj;

  // 2) Slice from first "{" to last "}" (handles prose wrappers).
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    obj = tryParse(text.slice(first, last + 1));
    if (obj) return obj;
  }

  // 3) Bare nested fragment like `"direccion": "Manizales, Caldas"`.
  //    Wrap in braces.
  if (/^\s*"[A-Za-z_][\w]*"\s*:/.test(text)) {
    obj = tryParse(`{${text}}`);
    if (obj) return obj;
  }

  // 4) Array of candidate objects like `[{"telefono":"a"},{"telefono":"b"}]`
  //    — keep the first object as a best guess.
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) {
      const firstObj = arr.find(
        (x) => x && typeof x === "object" && !Array.isArray(x),
      );
      if (firstObj) return firstObj as Record<string, any>;
    }
  } catch {
    /* ignore */
  }

  return null;
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
