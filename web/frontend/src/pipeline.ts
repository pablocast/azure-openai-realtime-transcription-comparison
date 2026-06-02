/**
 * Audio-only STT -> AOAI -> TTS pipeline client.
 *
 * A drop-in sibling of RealtimeClient (realtime.ts) that uses three decoupled
 * Azure services instead of one speech-to-speech model:
 *   1. Azure Speech SpeechRecognizer (continuous, language ID) for STT.
 *   2. Azure OpenAI chat/completions (gpt-5.4 / gpt-5.4-mini) via /api/chat SSE.
 *   3. Azure Speech SpeechSynthesizer for TTS (sentence-streamed).
 *
 * Behavior decisions (see /memories/repo/pipeline-pricing.md):
 *   - Anamnese extraction runs AFTER the assistant reply, using the doctor's
 *     question as context (per-turn + accumulated form state).
 *   - TTS voice is LOCKED to the language detected on the first user turn.
 *
 * Exposes the same RealtimeHandlers contract as RealtimeClient so App.tsx can
 * consume either client through one interface.
 */

import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";
import {
  ChatPricing,
  computeChatCost,
  computeSttCost,
  computeTtsCost,
  type ChatUsage,
  type CostBreakdown,
} from "./costs";
import type { RealtimeHandlers } from "./realtime";

/** Cost totals for one pipeline session (parallels SessionTotals). */
export interface PipelineTotals {
  chat: CostBreakdown;
  extract: CostBreakdown;
  tts: CostBreakdown;
  stt: CostBreakdown;
  total: number;
  pricingName: string;
  extractPricingName: string;
}

interface PipelineConfig {
  promptVariants: string[];
  defaultPromptVariant: string;
  anamneseSchemaName: string;
}

interface SpeechToken {
  token: string;
  endpoint: string;
  sttLocales: string[];
  ttsVoice: string;
  ttsVoices: Record<string, string>;
}

const EMPTY: CostBreakdown = { totalCost: 0, parts: {} };
const SENTENCE_PUNCT = /[.?!:;。？！]/;
/** Chat (text) pricing keyed by the model tier sent to /api/chat. */
const CHAT_PRICING_BY_TIER: Record<string, ChatPricing> = {
  full: ChatPricing.full,
  mini: ChatPricing.mini,
  gpt5mini: ChatPricing.gpt5mini,
};
/** Token-auth lifetime is ~10 min; refresh comfortably before expiry. */
const TOKEN_REFRESH_MS = 8 * 60 * 1000;

export class PipelineClient {
  private recognizer: SpeechSDK.SpeechRecognizer | null = null;
  private synthesizer: SpeechSDK.SpeechSynthesizer | null = null;
  private sttConfig: SpeechSDK.SpeechConfig | null = null;
  private ttsConfig: SpeechSDK.SpeechConfig | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private variant = "v1";
  private chatTier = "full";
  private pricing: ChatPricing = ChatPricing.full;
  private extractTier = "full";
  private extractPricing: ChatPricing = ChatPricing.full;
  private speechEndpoint = "";
  private sttLocales: string[] = [];
  private ttsVoices: Record<string, string> = {};
  private ttsVoiceFallback = "";

  /** Conversation turns (no system prompt — injected server-side). */
  private messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  /** Latest accumulated anamnese form, fed back from the UI. */
  private anamneseState: Record<string, unknown> = {};
  /** Language locked on the first recognized turn. */
  private lockedLanguage: string | null = null;
  /** The patient's most recent finalized utterance (awaiting a reply). */
  private lastUserText = "";
  private lastUserItemId = "";
  /** The assistant's last full reply (the question the patient answers next). */
  private lastAssistantUtterance = "";

  // TTS serial queue
  private ttsQueue: string[] = [];
  private isSpeaking = false;
  private sentenceBuffer = "";

  private userTurnSeq = 0;
  private isMedical = false;

  // Cost accumulators
  private totals = {
    chat: clone(EMPTY),
    extract: clone(EMPTY),
  };
  private ttsChars = 0;
  private sttSeconds = 0;

  constructor(private handlers: RealtimeHandlers) {}

  /** Called by the UI after every merge so the extractor sees current state. */
  setAnamneseState(state: Record<string, unknown>): void {
    this.anamneseState = state ?? {};
  }

  async start(variant?: string, modelTier?: string, extractTier?: string): Promise<void> {
    this.handlers.onStateChange("connecting");

    const cfg = await fetchJson<PipelineConfig>("/api/config");
    this.variant = variant ?? cfg.defaultPromptVariant;
    this.isMedical = this.variant === "medical";
    this.chatTier = (modelTier ?? "full").toLowerCase();
    this.pricing = CHAT_PRICING_BY_TIER[this.chatTier] ?? ChatPricing.full;
    // Extraction model defaults to the conversation model when not specified.
    this.extractTier = (extractTier ?? this.chatTier).toLowerCase();
    this.extractPricing = CHAT_PRICING_BY_TIER[this.extractTier] ?? this.pricing;

    const tok = await this.fetchSpeechToken();
    this.speechEndpoint = tok.endpoint;
    this.sttLocales = tok.sttLocales?.length ? tok.sttLocales : ["en-US"];
    this.ttsVoices = tok.ttsVoices ?? {};
    this.ttsVoiceFallback = tok.ttsVoice ?? this.ttsVoices[this.sttLocales[0]] ?? "";

    // ---- STT config (auth-token based, keyless) ----
    this.sttConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL(this.speechEndpoint));
    this.sttConfig.authorizationToken = tok.token;

    const autoDetect = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(
      this.sttLocales,
    );
    const audioInput = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    this.recognizer = SpeechSDK.SpeechRecognizer.FromConfig(
      this.sttConfig,
      autoDetect,
      audioInput,
    );

    // Barge-in: as soon as the patient starts speaking, stop the TTS.
    this.recognizer.recognizing = () => {
      if (this.isSpeaking || this.ttsQueue.length) this.stopSpeaking();
    };
    this.recognizer.recognized = (_s, e) => this.onRecognized(e);
    this.recognizer.canceled = (_s, e) => {
      this.handlers.onLog(`STT canceled: ${e.errorDetails ?? e.reason}`);
    };

    // ---- TTS config (voice set lazily once language is locked) ----
    this.ttsConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL(this.speechEndpoint));
    this.ttsConfig.authorizationToken = tok.token;

    // Periodic token refresh for long sessions.
    this.refreshTimer = setInterval(() => void this.refreshToken(), TOKEN_REFRESH_MS);

    await new Promise<void>((resolve, reject) => {
      this.recognizer!.startContinuousRecognitionAsync(
        () => {
          this.handlers.onLog(
            `STT started (locales: ${this.sttLocales.join(", ")})`,
          );
          this.handlers.onStateChange("live");
          resolve();
        },
        (err) => reject(new Error(`startContinuousRecognition failed: ${err}`)),
      );
    });
  }

  hangup(): PipelineTotals {
    this.handlers.onLog("Hanging up...");
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.stopSpeaking();
    // Mirror the avatar sample's disconnect: stop, then close, unconditionally.
    try {
      this.recognizer?.stopContinuousRecognitionAsync();
      this.recognizer?.close();
    } catch {
      /* ignore */
    }
    try {
      this.synthesizer?.close();
    } catch {
      /* ignore */
    }
    this.recognizer = null;
    this.synthesizer = null;
    this.handlers.onStateChange("idle");

    const tts = computeTtsCost(this.ttsChars);
    const stt = computeSttCost(this.sttSeconds);
    const total =
      this.totals.chat.totalCost +
      this.totals.extract.totalCost +
      tts.totalCost +
      stt.totalCost;
    return {
      chat: this.totals.chat,
      extract: this.totals.extract,
      tts,
      stt,
      total,
      pricingName: this.pricing.name,
      extractPricingName: this.extractPricing.name,
    };
  }

  // ----------------------------------------------------------------------
  private onRecognized(e: SpeechSDK.SpeechRecognitionEventArgs): void {
    if (e.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) return;
    const text = (e.result.text ?? "").trim();
    if (!text) return;

    // Accumulate recognized audio duration (ticks are 100ns units).
    this.sttSeconds += (e.result.duration ?? 0) / 10_000_000;

    // Lock the TTS language to the first detected language.
    if (!this.lockedLanguage) {
      let detected = this.sttLocales[0];
      try {
        detected =
          SpeechSDK.AutoDetectSourceLanguageResult.fromResult(e.result).language ||
          this.sttLocales[0];
      } catch {
        detected = this.sttLocales[0];
      }
      this.lockedLanguage = detected;
      const voice = this.ttsVoices[detected] ?? this.ttsVoiceFallback;
      this.ttsConfig!.speechSynthesisVoiceName = voice;
      this.synthesizer = new SpeechSDK.SpeechSynthesizer(this.ttsConfig!);
      this.handlers.onLog(`Language locked: ${detected} (voice ${voice})`);
    }

    const itemId = `u${++this.userTurnSeq}`;
    this.lastUserText = text;
    this.lastUserItemId = itemId;
    this.handlers.onUserTurnStarted(itemId);
    this.handlers.onUserTranscript(itemId, text, "transcribe");

    this.messages.push({ role: "user", content: text });
    void this.runChat();
  }

  // ---- LLM streaming + sentence-by-sentence TTS --------------------------
  private async runChat(): Promise<void> {
    this.sentenceBuffer = "";
    let assistantReply = "";
    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: this.messages,
          variant: this.variant,
          model: this.chatTier,
        }),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`/api/chat -> ${resp.status} ${await resp.text()}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.error) {
            this.handlers.onLog(`Chat error: ${json.error}`);
            continue;
          }
          // Final usage-only chunk has empty choices.
          if (json.usage && (!json.choices || json.choices.length === 0)) {
            this.totals.chat = mergeCost(
              this.totals.chat,
              computeChatCost(json.usage as ChatUsage, this.pricing),
            );
            continue;
          }
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            assistantReply += delta;
            this.handlers.onAssistantTranscript(delta, false);
            this.feedTts(delta);
          }
        }
      }
      // Flush any trailing partial sentence.
      this.flushSentence(true);
      this.handlers.onAssistantTranscript("", true);

      if (assistantReply.trim()) {
        this.lastAssistantUtterance = assistantReply.trim();
        this.messages.push({ role: "assistant", content: assistantReply });
        // Extraction runs AFTER the reply so the doctor's question is context.
        if (this.isMedical) void this.runExtract();
      }
    } catch (err) {
      this.handlers.onLog(
        `Chat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.handlers.onAssistantTranscript("", true);
    }
  }

  /** Append streamed text, flushing complete sentences to the TTS queue. */
  private feedTts(delta: string): void {
    this.sentenceBuffer += delta;
    if (delta.includes("\n") || SENTENCE_PUNCT.test(delta)) {
      this.flushSentence(false);
    }
  }

  private flushSentence(flushAll: boolean): void {
    if (flushAll) {
      const rest = this.sentenceBuffer.trim();
      this.sentenceBuffer = "";
      if (rest) this.enqueueSpeak(rest);
      return;
    }
    // Emit each complete sentence; keep the trailing remainder buffered.
    const parts = this.sentenceBuffer.split(/(?<=[.?!:;。？！\n])/);
    this.sentenceBuffer = parts.pop() ?? "";
    for (const p of parts) {
      const s = p.trim();
      if (s) this.enqueueSpeak(s);
    }
  }

  // ---- TTS serial queue --------------------------------------------------
  private enqueueSpeak(text: string): void {
    this.ttsQueue.push(text);
    if (!this.isSpeaking) this.speakNext();
  }

  private speakNext(): void {
    const next = this.ttsQueue.shift();
    if (!next || !this.synthesizer) {
      this.isSpeaking = false;
      return;
    }
    this.isSpeaking = true;
    this.ttsChars += next.length;
    this.synthesizer.speakTextAsync(
      next,
      () => this.speakNext(),
      (err) => {
        this.handlers.onLog(`TTS error: ${err}`);
        this.speakNext();
      },
    );
  }

  private stopSpeaking(): void {
    this.ttsQueue = [];
    this.sentenceBuffer = "";
    // A plain SpeechSynthesizer has no stop API, so to barge-in we tear the
    // current synthesizer down and recreate a fresh one with the same voice.
    if (this.isSpeaking && this.synthesizer && this.ttsConfig) {
      try {
        this.synthesizer.close();
      } catch {
        /* ignore */
      }
      this.synthesizer = new SpeechSDK.SpeechSynthesizer(this.ttsConfig);
    }
    this.isSpeaking = false;
  }

  // ---- Anamnese extraction (medical variant) -----------------------------
  private async runExtract(): Promise<void> {
    const itemId = this.lastUserItemId;
    const stateJson = JSON.stringify(this.anamneseState ?? {});
    const today = new Date().toISOString().slice(0, 10);
    const content =
      `DOCTOR'S MOST RECENT UTTERANCE (context; source for expectativas_plan):\n` +
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

  // ---- Token handling ----------------------------------------------------
  private async fetchSpeechToken(): Promise<SpeechToken> {
    return fetchJson<SpeechToken>("/api/speech-token");
  }

  private async refreshToken(): Promise<void> {
    try {
      const tok = await this.fetchSpeechToken();
      if (this.sttConfig) this.sttConfig.authorizationToken = tok.token;
      if (this.ttsConfig) this.ttsConfig.authorizationToken = tok.token;
    } catch (err) {
      this.handlers.onLog(
        `Token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

function clone(b: CostBreakdown): CostBreakdown {
  return { totalCost: b.totalCost, parts: { ...b.parts } };
}

function mergeCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const parts: CostBreakdown["parts"] = { ...a.parts };
  for (const [k, v] of Object.entries(b.parts)) {
    const prev = parts[k];
    parts[k] = prev
      ? {
          cost: prev.cost + v.cost,
          tokens: prev.tokens + v.tokens,
          unitPricePerM: v.unitPricePerM,
        }
      : { ...v };
  }
  return { totalCost: a.totalCost + b.totalCost, parts };
}
