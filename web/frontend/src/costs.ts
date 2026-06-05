/**
 * Cost calculations mirroring src/costs.py (USD per 1M tokens).
 * Source: https://azure.microsoft.com/pricing/details/azure-openai/
 */

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: {
      text_tokens?: number;
      audio_tokens?: number;
    };
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  };
}

/** Usage shape returned by the chat/completions API (text models). */
export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface CostPart {
  cost: number;
  tokens: number;
  /** Unit price in USD per 1M tokens. */
  unitPricePerM: number;
}

export interface CostBreakdown {
  totalCost: number;
  /** Named cost components (e.g. "audio_input", "text_output"). */
  parts: Record<string, CostPart>;
}

export class RealtimePricing {
  constructor(
    public name: string,
    public textInput: number,
    public cachedTextInput: number,
    public textOutput: number,
    public audioInput: number,
    public cachedAudioInput: number,
    public audioOutput: number,
  ) {}

  static full = new RealtimePricing(
    "gpt-realtime-1.5",
    4.0,
    0.4,
    16.0,
    32.0,
    0.4,
    64.0,
  );
  static mini = new RealtimePricing(
    "gpt-realtime-mini",
    0.6,
    0.06,
    2.4,
    10.0,
    0.3,
    20.0,
  );
}

/**
 * Azure Speech Voice Live API pricing (Lite tier), USD per 1M tokens.
 * Source: https://azure.microsoft.com/en-us/pricing/details/speech/
 */
export class VoiceLivePricing extends RealtimePricing {
  static nano = new VoiceLivePricing(
    "gpt-5-nano",
    0.11,
    0.04,
    0.44,
    15.0,
    0.04,
    25.0,
  );

  static phiMini = new VoiceLivePricing(
    "phi4-mini",
    0.11,
    0.04,
    0.44,
    15.0,
    0.04,
    25.0,
  );

  static phiRealtime = new VoiceLivePricing(
    "phi4-mm-realtime",
    0.11,
    0.04,
    0.44,
    4.0,
    0.04,
    25.0,
  );

  static forModel(model: string): VoiceLivePricing {
    const m = (model || "").toLowerCase();
    if (m.includes("phi4-mm")) return VoiceLivePricing.phiRealtime;
    if (m.includes("phi4-mini")) return VoiceLivePricing.phiMini;
    return VoiceLivePricing.nano;
  }
}

/**
 * Pricing for the STT -> AOAI -> TTS pipeline chat (text) models.
 * USD per 1M tokens.
 */
export class ChatPricing {
  constructor(
    public name: string,
    public input: number,
    public cachedInput: number,
    public output: number,
  ) {}

  static full = new ChatPricing("gpt-5.4", 2.5, 0.25, 15.0);
  static mini = new ChatPricing("gpt-5.4-mini", 0.75, 0.08, 4.5);
  static gpt5mini = new ChatPricing("gpt-5-mini", 0.25, 0.025, 2.0);
}

// TTS: USD per 1M characters synthesized (HD voice; standard neural assumed same).
export const TTS_PER_M_CHARS = 15.0;
// STT: USD per audio hour (Azure Speech standard continuous recognition).
export const STT_PER_HOUR = 1.0;

// gpt-4o-transcribe-diarize
const TRANSCRIBE_AUDIO_INPUT = 6.0;
const TRANSCRIBE_TEXT_INPUT = 2.5;
const TRANSCRIBE_TEXT_OUTPUT = 10.0;

const PER_M = (tokens: number, pricePerM: number) => (tokens * pricePerM) / 1_000_000;
const part = (tokens: number, unitPricePerM: number): CostPart => ({
  tokens,
  unitPricePerM,
  cost: PER_M(tokens, unitPricePerM),
});

export function computeTranscribeCost(usage: Usage): CostBreakdown {
  const inDet = usage.input_token_details ?? {};
  const audioIn = inDet.audio_tokens ?? 0;
  const textIn = inDet.text_tokens ?? 0;
  const out = usage.output_tokens ?? 0;

  const parts = {
    audio_input: part(audioIn, TRANSCRIBE_AUDIO_INPUT),
    text_input: part(textIn, TRANSCRIBE_TEXT_INPUT),
    text_output: part(out, TRANSCRIBE_TEXT_OUTPUT),
  };
  const totalCost = parts.audio_input.cost + parts.text_input.cost + parts.text_output.cost;
  return { totalCost, parts };
}

export function computeRealtimeCost(usage: Usage, p: RealtimePricing): CostBreakdown {
  const inDet = usage.input_token_details ?? {};
  const outDet = usage.output_token_details ?? {};
  const cached = inDet.cached_tokens_details ?? {};

  const textIn = inDet.text_tokens ?? 0;
  const cachedTextIn =
    (cached.text_tokens ?? 0) ||
    (textIn === 0 ? 0 : Math.min(textIn, inDet.cached_tokens ?? 0));
  const nonCachedTextIn = Math.max(textIn - cachedTextIn, 0);

  const audioIn = inDet.audio_tokens ?? 0;
  const cachedAudioIn = cached.audio_tokens ?? 0;
  const nonCachedAudioIn = Math.max(audioIn - cachedAudioIn, 0);

  const textOut = outDet.text_tokens ?? 0;
  const audioOut = outDet.audio_tokens ?? 0;

  const parts = {
    text_input: part(nonCachedTextIn, p.textInput),
    cached_text_input: part(cachedTextIn, p.cachedTextInput),
    audio_input: part(nonCachedAudioIn, p.audioInput),
    cached_audio_input: part(cachedAudioIn, p.cachedAudioInput),
    text_output: part(textOut, p.textOutput),
    audio_output: part(audioOut, p.audioOutput),
  };
  const totalCost = Object.values(parts).reduce((a, b) => a + b.cost, 0);
  return { totalCost, parts };
}

/**
 * Cost of one chat/completions call (text models gpt-5.4 / gpt-5.4-mini).
 * Splits prompt tokens into cached vs non-cached using prompt_tokens_details.
 */
export function computeChatCost(usage: ChatUsage, p: ChatPricing): CostBreakdown {
  const prompt = usage.prompt_tokens ?? 0;
  const cachedIn = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const nonCachedIn = Math.max(prompt - cachedIn, 0);
  const out = usage.completion_tokens ?? 0;

  const parts = {
    input: part(nonCachedIn, p.input),
    cached_input: part(cachedIn, p.cachedInput),
    output: part(out, p.output),
  };
  const totalCost = parts.input.cost + parts.cached_input.cost + parts.output.cost;
  return { totalCost, parts };
}

/** Cost of synthesizing `chars` characters of TTS. */
export function computeTtsCost(chars: number): CostBreakdown {
  const cost = PER_M(chars, TTS_PER_M_CHARS);
  return {
    totalCost: cost,
    parts: { characters: { tokens: chars, unitPricePerM: TTS_PER_M_CHARS, cost } },
  };
}

/** Cost of `seconds` of STT continuous recognition. */
export function computeSttCost(seconds: number): CostBreakdown {
  const cost = (seconds / 3600) * STT_PER_HOUR;
  return {
    totalCost: cost,
    parts: {
      audio_seconds: { tokens: seconds, unitPricePerM: STT_PER_HOUR, cost },
    },
  };
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  return n.toLocaleString();
}

/** Pretty-print a unit price like "$32.00 / 1M". */
export function fmtUnitPrice(perM: number): string {
  return `$${perM.toFixed(2)} / 1M`;
}
