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
