import { useEffect, useRef, useState, type ReactNode } from "react";
import { RealtimeClient, type RealtimeHandlers, type SessionTotals } from "./realtime";
import { PipelineClient, type PipelineTotals } from "./pipeline";
import { fmtTokens, fmtUnitPrice, fmtUsd, type CostBreakdown } from "./costs";

type SessionState = "idle" | "connecting" | "live" | "ended";
type ChatRole = "user" | "assistant";
type Mode = "realtime" | "pipeline";

/** Shared surface both clients expose, so the UI can drive either one. */
type VoiceClient = {
  start(variant?: string, modelTier?: string, extractTier?: string): Promise<void>;
  hangup(): SessionTotals | PipelineTotals;
  setAnamneseState(state: Record<string, unknown>): void;
};

interface ModeOption {
  id: Mode;
  label: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { id: "realtime", label: "Realtime (speech-to-speech)" },
  { id: "pipeline", label: "Pipeline (STT → AOAI → TTS)" },
];

interface PromptOption {
  id: string;
  label: string;
}

const PROMPT_OPTIONS: PromptOption[] = [
  { id: "v1", label: "v1 — Insurance intake" },
  { id: "v2", label: "v2 — Debt collection" },
  { id: "medical", label: "v3 — Medical Anamnesis" },
];

interface ModelOption {
  id: string;
  label: string;
}

/** Model tiers per mode: realtime speech model vs pipeline chat model. */
const MODEL_OPTIONS: Record<Mode, ModelOption[]> = {
  realtime: [
    { id: "full", label: "gpt-realtime-1.5" },
    { id: "mini", label: "gpt-realtime-mini" },
  ],
  pipeline: [
    { id: "full", label: "gpt-5.4" },
    { id: "mini", label: "gpt-5.4-mini" },
    { id: "gpt5mini", label: "gpt-5-mini" },
  ],
};

interface ChatMessage {
  id: string;
  /** For user messages, the realtime conversation item id. */
  itemId?: string;
  role: ChatRole;
  text: string;
  done: boolean;
}

/** One user turn: paired transcripts from both models, aligned by row. */
interface TurnRow {
  itemId: string;
  index: number;
  transcribe: string | null;
  realtime: string | null;
}

let nextId = 1;
const newId = () => `m${nextId++}`;

export default function App() {
  const [state, setState] = useState<SessionState>("idle");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [rows, setRows] = useState<TurnRow[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [costs, setCosts] = useState<SessionTotals | PipelineTotals | null>(null);
  const [mode, setMode] = useState<Mode>("realtime");
  const [promptVariant, setPromptVariant] = useState<string>(PROMPT_OPTIONS[0].id);
  const [modelTier, setModelTier] = useState<string>("full");
  const [extractModelTier, setExtractModelTier] = useState<string>("full");
  const [form, setForm] = useState<Record<string, any>>({});
  const clientRef = useRef<VoiceClient | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  const log = (m: string) =>
    setLogs((prev) => [...prev.slice(-50), `${new Date().toLocaleTimeString()}  ${m}`]);

  const reset = () => {
    setChat([]);
    setRows([]);
    setLogs([]);
    setCosts(null);
    setForm({});
    setState("idle");
  };

  const startCall = async () => {
    if (clientRef.current) return;
    reset();
    const handlers: RealtimeHandlers = {
      onLog: log,
      onStateChange: setState,
      onUserTurnStarted: (itemId) => {
        // Insert the user bubble + comparison row immediately so it appears
        // before the streaming assistant reply in the chat.
        setChat((prev) => {
          if (prev.some((m) => m.itemId === itemId)) return prev;
          return [
            ...prev,
            { id: newId(), itemId, role: "user", text: "", done: false },
          ];
        });
        setRows((prev) => {
          if (prev.some((r) => r.itemId === itemId)) return prev;
          return [
            ...prev,
            { itemId, index: prev.length + 1, transcribe: null, realtime: null },
          ];
        });
      },
      onUserTranscript: (itemId, text, source) => {
        setRows((prev) =>
          prev.map((r) =>
            r.itemId === itemId ? { ...r, [source]: text } : r,
          ),
        );
        if (source === "transcribe") {
          setChat((prev) =>
            prev.map((m) =>
              m.itemId === itemId ? { ...m, text, done: true } : m,
            ),
          );
        }
      },
      onAssistantTranscript: (delta, done) => {
        setChat((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && !last.done) {
            const updated = { ...last, text: last.text + delta, done };
            return [...prev.slice(0, -1), updated];
          }
          return [
            ...prev,
            { id: newId(), role: "assistant", text: delta, done },
          ];
        });
      },
      onAnamnesePatch: (patch, _itemId) => {
        if (!patch || typeof patch !== "object") return;
        const normalized = normalizeAnamnesePatch(patch);
        const filtered: Record<string, any> = {};
        for (const k of ANAMNESE_TOP_KEYS) {
          if (normalized[k] !== undefined) filtered[k] = normalized[k];
        }
        setForm((prev) => {
          const next = deepMerge(prev, filtered);
          clientRef.current?.setAnamneseState(next);
          return next;
        });
      },
    };
    const client: VoiceClient =
      mode === "pipeline"
        ? new PipelineClient(handlers)
        : new RealtimeClient(handlers);
    clientRef.current = client;
    try {
      await client.start(promptVariant, modelTier, extractModelTier);
    } catch (err) {
      log(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
      client.hangup();
      clientRef.current = null;
    }
  };

  const hangup = () => {
    const totals = clientRef.current?.hangup();
    clientRef.current = null;
    if (totals) setCosts(totals);
  };

  const inCall = state === "live" || state === "connecting";

  return (
    <div className="app">
      <header className="header">
        <h1>
          {promptVariant === "medical"
            ? "Live Medical Anamnesis"
            : mode === "pipeline"
              ? "Pipeline conversation: STT → AOAI → TTS"
              : "Transcribing User Audio: Separate Transcribe Model vs. Realtime"}
        </h1>
        <span className={`status status-${state}`}>{state}</span>
      </header>

      {promptVariant === "medical" ? (
        <AnamnesePanel form={form} />
      ) : mode === "realtime" ? (
        <section className="compare">
          <div className="compare-head">
            <div /> {/* index col */}
            <div className="col-title">
              Transcribe model
              <div className="col-sub">gpt-4o-transcribe (input_audio_transcription)</div>
            </div>
            <div className="col-title">
              Realtime model
              <div className="col-sub">gpt-realtime (out-of-band response)</div>
            </div>
          </div>
          <div className="compare-body">
            {rows.length === 0 && (
              <div className="placeholder">No turns yet — click Call to start.</div>
            )}
            {rows.map((r) => (
              <div key={r.itemId} className="row">
                <div className="row-idx">#{r.index}</div>
                <div className="row-cell">
                  {r.transcribe ?? <span className="placeholder">…</span>}
                </div>
                <div className="row-cell">
                  {r.realtime ?? <span className="placeholder">…</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {promptVariant !== "medical" && (
        <section className="chat">
          <div className="chat-header">Conversation</div>
          <div className="chat-body">
            {chat.length === 0 && (
              <div className="placeholder">
                Click <strong>Call</strong> to start.
              </div>
            )}
            {chat.map((m) => (
              <div key={m.id} className={`bubble bubble-${m.role}`}>
                <div className="role">{m.role === "user" ? "Customer" : "Agent"}</div>
                <div className="text">{m.text || "…"}</div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        </section>
      )}

      <footer className="controls">
        <label className="prompt-select" title="Choose the speech architecture">
          <span>Mode</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            disabled={inCall}
          >
            {MODE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="prompt-select" title="Choose the assistant prompt variant">
          <span>Prompt</span>
          <select
            value={promptVariant}
            onChange={(e) => setPromptVariant(e.target.value)}
            disabled={inCall}
          >
            {PROMPT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="prompt-select" title="Choose the model tier">
          <span>{mode === "pipeline" && promptVariant === "medical" ? "Conversation model" : "Model"}</span>
          <select
            value={modelTier}
            onChange={(e) => setModelTier(e.target.value)}
            disabled={inCall}
          >
            {MODEL_OPTIONS[mode].map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {mode === "pipeline" && promptVariant === "medical" && (
          <label className="prompt-select" title="Choose the anamnesis extraction model">
            <span>Extraction model</span>
            <select
              value={extractModelTier}
              onChange={(e) => setExtractModelTier(e.target.value)}
              disabled={inCall}
            >
              {MODEL_OPTIONS.pipeline.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="btn btn-call"
          onClick={startCall}
          disabled={inCall}
          title="Start the call"
        >
          📞 Call
        </button>
        <button
          className="btn btn-hangup"
          onClick={hangup}
          disabled={!inCall}
          title="End the call"
        >
          ✖ Hang up
        </button>
        <button
          className="btn btn-new"
          onClick={reset}
          disabled={inCall}
          title="Clear and start fresh"
        >
          🔄 New call
        </button>
      </footer>

      {costs && <CostPanel totals={costs} />}

      <details className="logs">
        <summary>Logs</summary>
        <pre>{logs.join("\n")}</pre>
      </details>

      {/* DEBUG:ANAMNESE — remove this block once extraction quality is verified. */}
      <details className="logs">
        <summary>Anamnese state (debug)</summary>
        <pre>{JSON.stringify(form, null, 2)}</pre>
      </details>
    </div>
  );
}

const COMPONENT_LABELS: Record<string, string> = {
  audio_input: "Audio input tokens",
  cached_audio_input: "Audio input tokens (cached)",
  audio_output: "Audio output tokens",
  text_input: "Text input tokens",
  cached_text_input: "Text input tokens (cached)",
  text_output: "Text output tokens",
  // Pipeline (chat / TTS / STT)
  input: "Input tokens",
  cached_input: "Input tokens (cached)",
  output: "Output tokens",
  characters: "Synthesized characters",
  audio_seconds: "Recognized audio (seconds)",
};

interface CostSection {
  key: string;
  label: string;
  sub: string;
  total: number;
  parts: CostBreakdown["parts"];
}

/** True for pipeline totals (which carry a `chat` breakdown). */
function isPipelineTotals(
  t: SessionTotals | PipelineTotals,
): t is PipelineTotals {
  return (t as PipelineTotals).chat !== undefined;
}

function buildSections(totals: SessionTotals | PipelineTotals): CostSection[] {
  if (isPipelineTotals(totals)) {
    return [
      {
        key: "chat",
        label: "Chat model · conversation",
        sub: `${totals.pricingName} · streamed text reply`,
        total: totals.chat.totalCost,
        parts: totals.chat.parts,
      },
      {
        key: "extract",
        label: "Chat model · anamnesis extraction",
        sub: `${totals.extractPricingName} · structured JSON per turn`,
        total: totals.extract.totalCost,
        parts: totals.extract.parts,
      },
      {
        key: "tts",
        label: "Speech · text-to-speech",
        sub: "Azure Speech neural synthesis (per character)",
        total: totals.tts.totalCost,
        parts: totals.tts.parts,
      },
      {
        key: "stt",
        label: "Speech · speech-to-text",
        sub: "Azure Speech continuous recognition (per audio hour)",
        total: totals.stt.totalCost,
        parts: totals.stt.parts,
      },
    ];
  }
  return [
    {
      key: "main",
      label: "Realtime model · main conversation",
      sub: `${totals.pricingName} · audio in/out + text`,
      total: totals.realtimeMain.totalCost,
      parts: totals.realtimeMain.parts,
    },
    {
      key: "oob",
      label: "Realtime model · out-of-band transcription",
      sub: `${totals.pricingName} · text-only re-transcription of each user turn`,
      total: totals.realtimeOob.totalCost,
      parts: totals.realtimeOob.parts,
    },
    {
      key: "transcribe",
      label: "Transcribe model · gpt-4o-transcribe",
      sub: "Streaming input transcription (canonical user text)",
      total: totals.transcribe.totalCost,
      parts: totals.transcribe.parts,
    },
  ];
}

function CostPanel({ totals }: { totals: SessionTotals | PipelineTotals }) {
  const sections = buildSections(totals);

  return (
    <section className="costs-panel">
      <div className="costs-head">
        <div className="costs-title">Session cost summary</div>
        <div className="costs-total">{fmtUsd(totals.total)}</div>
      </div>
      <div className="costs-body">
        {sections.map((s) => {
          const entries = Object.entries(s.parts).filter(([, v]) => v.cost > 0);
          return (
            <details key={s.key} className="cost-section">
              <summary>
                <span className="cost-label">
                  <span className="cost-label-main">{s.label}</span>
                  <span className="cost-label-sub">{s.sub}</span>
                </span>
                <span className="cost-amount">{fmtUsd(s.total)}</span>
              </summary>
              {entries.length === 0 ? (
                <div className="cost-empty">No usage recorded.</div>
              ) : (
                <table className="cost-breakdown">
                  <thead>
                    <tr>
                      <th>Component</th>
                      <th className="num">Tokens</th>
                      <th className="num">Unit price</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(([k, v]) => (
                      <tr key={k}>
                        <td>{COMPONENT_LABELS[k] ?? k}</td>
                        <td className="num">{fmtTokens(v.tokens)}</td>
                        <td className="num">{fmtUnitPrice(v.unitPricePerM)}</td>
                        <td className="num">{fmtUsd(v.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}

/** String fields that should ACCUMULATE across turns instead of being
 *  overwritten. New text is appended on a new line, deduped by trimmed
 *  content (case-insensitive) so the same vital isn't recorded twice. */
const APPEND_STRING_PATHS = new Set<string>([
  // (none right now — vitals are structured fields, not an append blob)
]);

/** Recursively merge `patch` into `base`.
 *  - null / undefined / empty string / empty array values in patch are ignored.
 *  - Arrays APPEND to existing array (deduped by JSON.stringify identity).
 *  - Objects recurse. Scalars overwrite, EXCEPT string fields whose dot-path
 *    is in APPEND_STRING_PATHS — those append on a new line (deduped). */
function deepMerge(
  base: Record<string, any>,
  patch: Record<string, any> | null | undefined,
  path = "",
): Record<string, any> {
  if (!patch || typeof patch !== "object") return base;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const childPath = path ? `${path}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const prev = Array.isArray(base[k]) ? base[k] : [];
      const seen = new Set(prev.map((x: unknown) => JSON.stringify(x)));
      const merged = [...prev];
      for (const item of v) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
      out[k] = merged;
    } else if (typeof v === "object") {
      out[k] = deepMerge(
        (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]))
          ? base[k]
          : {},
        v as Record<string, any>,
        childPath,
      );
    } else if (typeof v === "string" && APPEND_STRING_PATHS.has(childPath)) {
      const prev = typeof base[k] === "string" ? base[k] : "";
      const incoming = v.trim();
      const existingLines = prev
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);
      const seen = new Set(existingLines.map((l: string) => l.toLowerCase()));
      if (incoming && !seen.has(incoming.toLowerCase())) {
        out[k] = prev ? `${prev}\n${incoming}` : incoming;
      } else {
        out[k] = prev;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

const ANAMNESE_TOP_KEYS = [
  "identificacion",
  "motivo_consulta",
  "historia_enfermedad_actual",
  "antecedentes_personales",
  "antecedentes_familiares",
  "habitos_estilo_vida",
  "revision_sistemas",
  "observaciones_adicionales",
  "expectativas_plan",
] as const;

/** Reverse map: nested-key -> top-level section it belongs to.
 *  All nested keys in the schema are unique, so this is unambiguous. */
const NESTED_KEY_TO_SECTION: Record<string, string> = {
  // identificacion
  nombre: "identificacion",
  fecha_nacimiento: "identificacion",
  edad: "identificacion",
  telefono: "identificacion",
  email: "identificacion",
  direccion: "identificacion",
  responsable_legal: "identificacion",
  // historia_enfermedad_actual
  inicio: "historia_enfermedad_actual",
  evolucion: "historia_enfermedad_actual",
  localizacion: "historia_enfermedad_actual",
  intensidad_0_10: "historia_enfermedad_actual",
  duracion_frecuencia: "historia_enfermedad_actual",
  sintomas_asociados: "historia_enfermedad_actual",
  factores_mejora: "historia_enfermedad_actual",
  factores_empeoramiento: "historia_enfermedad_actual",
  tratamientos_previos: "historia_enfermedad_actual",
  impacto_rutina: "historia_enfermedad_actual",
  // antecedentes_personales
  enfermedades_previas: "antecedentes_personales",
  cirugias_hospitalizaciones: "antecedentes_personales",
  alergias: "antecedentes_personales",
  medicamentos_en_uso: "antecedentes_personales",
  vacunas: "antecedentes_personales",
  // habitos_estilo_vida
  sueno: "habitos_estilo_vida",
  alimentacion_hidratacion: "habitos_estilo_vida",
  actividad_fisica: "habitos_estilo_vida",
  tabaquismo: "habitos_estilo_vida",
  alcohol: "habitos_estilo_vida",
  estres_psicosocial: "habitos_estilo_vida",
  trabajo_rutina: "habitos_estilo_vida",
  // revision_sistemas
  respiratorio: "revision_sistemas",
  cardiovascular: "revision_sistemas",
  gastrointestinal: "revision_sistemas",
  neurologico: "revision_sistemas",
  genitourinario: "revision_sistemas",
  otros: "revision_sistemas",
  // observaciones_adicionales (vitals + physical exam)
  presion_arterial: "observaciones_adicionales",
  frecuencia_cardiaca: "observaciones_adicionales",
  frecuencia_respiratoria: "observaciones_adicionales",
  temperatura: "observaciones_adicionales",
  saturacion_oxigeno: "observaciones_adicionales",
  peso: "observaciones_adicionales",
  talla: "observaciones_adicionales",
  examen_fisico: "observaciones_adicionales",
  notas: "observaciones_adicionales",
  // expectativas_plan
  expectativas_paciente: "expectativas_plan",
  orientaciones_iniciales: "expectativas_plan",
  conducta_remisiones: "expectativas_plan",
  proximo_control: "expectativas_plan",
};

/** Re-route any stray nested keys at the patch root into the correct section.
 *  e.g. `{ direccion: "X" }` -> `{ identificacion: { direccion: "X" } }`.
 *  Also expands dotted keys like `"identificacion.edad": 41`. */
function normalizeAnamnesePatch(
  patch: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  const topKeys = new Set<string>(ANAMNESE_TOP_KEYS);
  for (const [k, v] of Object.entries(patch)) {
    // Dotted key e.g. "identificacion.edad": 41
    if (k.includes(".")) {
      const [head, ...rest] = k.split(".");
      if (topKeys.has(head) && rest.length > 0) {
        const nested: Record<string, any> = {};
        let cursor = nested;
        for (let i = 0; i < rest.length - 1; i++) {
          cursor[rest[i]] = {};
          cursor = cursor[rest[i]];
        }
        cursor[rest[rest.length - 1]] = v;
        out[head] = { ...(out[head] ?? {}), ...nested };
        continue;
      }
    }
    if (topKeys.has(k)) {
      out[k] = v;
      continue;
    }
    const section = NESTED_KEY_TO_SECTION[k];
    if (!section) continue; // unknown key — drop
    out[section] = { ...(out[section] ?? {}), [k]: v };
  }
  return out;
}

function AnamnesePanel({ form }: { form: Record<string, any> }) {
  const view = withDerivedAge(form);
  return (
    <section className="anamnese">
      <div className="anamnese-head">Anamnesis</div>
      <div className="anamnese-body">
        {ANAMNESE_SECTIONS.map((sec) => (
          <details key={sec.key} className="anamnese-section" open>
            <summary>{sec.label}</summary>
            <table className="anamnese-table">
              <tbody>
                {sec.rows.map((row) => (
                  <AnamneseRow
                    key={row.path}
                    label={row.label}
                    value={getPath(view, row.path)}
                    kind={row.kind}
                  />
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </div>
    </section>
  );
}

/** Return a shallow clone of `form` with `identificacion.edad` overwritten
 *  by an age derived from `identificacion.fecha_nacimiento` when that field
 *  parses as a valid date (YYYY-MM-DD or any Date-parsable string). */
function withDerivedAge(form: Record<string, any>): Record<string, any> {
  const dob = form?.identificacion?.fecha_nacimiento;
  const derived = computeAge(dob);
  if (derived === null) return form;
  return {
    ...form,
    identificacion: { ...(form.identificacion ?? {}), edad: derived },
  };
}

function computeAge(dob: unknown): number | null {
  if (typeof dob !== "string" || !dob.trim()) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  if (age < 0 || age > 130) return null;
  return age;
}

type RowKind = "text" | "list" | "meds" | "bool_detail";

interface AnamneseRowDef {
  path: string;
  label: string;
  kind: RowKind;
}

interface AnamneseSectionDef {
  key: string;
  label: string;
  rows: AnamneseRowDef[];
}

const ANAMNESE_SECTIONS: AnamneseSectionDef[] = [
  {
    key: "identificacion",
    label: "1. Identification",
    rows: [
      { path: "identificacion.nombre", label: "Full name", kind: "text" },
      { path: "identificacion.fecha_nacimiento", label: "Date of birth", kind: "text" },
      { path: "identificacion.edad", label: "Age", kind: "text" },
      { path: "identificacion.telefono", label: "Phone", kind: "text" },
      { path: "identificacion.email", label: "Email", kind: "text" },
      { path: "identificacion.direccion", label: "Address", kind: "text" },
      { path: "identificacion.responsable_legal", label: "Legal guardian", kind: "text" },
    ],
  },
  {
    key: "motivo_consulta",
    label: "2. Chief complaint",
    rows: [{ path: "motivo_consulta", label: "Reason for visit", kind: "text" }],
  },
  {
    key: "historia_enfermedad_actual",
    label: "3. History of present illness",
    rows: [
      { path: "historia_enfermedad_actual.inicio", label: "Onset", kind: "text" },
      { path: "historia_enfermedad_actual.evolucion", label: "Evolution", kind: "text" },
      { path: "historia_enfermedad_actual.localizacion", label: "Location", kind: "text" },
      { path: "historia_enfermedad_actual.intensidad_0_10", label: "Intensity (0–10)", kind: "text" },
      { path: "historia_enfermedad_actual.duracion_frecuencia", label: "Duration / frequency", kind: "text" },
      { path: "historia_enfermedad_actual.sintomas_asociados", label: "Associated symptoms", kind: "text" },
      { path: "historia_enfermedad_actual.factores_mejora", label: "Relieving factors", kind: "text" },
      { path: "historia_enfermedad_actual.factores_empeoramiento", label: "Aggravating factors", kind: "text" },
      { path: "historia_enfermedad_actual.tratamientos_previos", label: "Prior treatments", kind: "text" },
      { path: "historia_enfermedad_actual.impacto_rutina", label: "Impact on routine", kind: "text" },
    ],
  },
  {
    key: "antecedentes_personales",
    label: "4. Past medical history",
    rows: [
      { path: "antecedentes_personales.enfermedades_previas", label: "Previous conditions", kind: "list" },
      { path: "antecedentes_personales.cirugias_hospitalizaciones", label: "Surgeries / hospitalizations", kind: "list" },
      { path: "antecedentes_personales.alergias", label: "Allergies", kind: "list" },
      { path: "antecedentes_personales.medicamentos_en_uso", label: "Current medications", kind: "meds" },
      { path: "antecedentes_personales.vacunas", label: "Vaccinations", kind: "text" },
    ],
  },
  {
    key: "antecedentes_familiares",
    label: "5. Family history",
    rows: [{ path: "antecedentes_familiares", label: "Family history", kind: "text" }],
  },
  {
    key: "habitos_estilo_vida",
    label: "6. Lifestyle & habits",
    rows: [
      { path: "habitos_estilo_vida.sueno", label: "Sleep", kind: "text" },
      { path: "habitos_estilo_vida.alimentacion_hidratacion", label: "Diet & hydration", kind: "text" },
      { path: "habitos_estilo_vida.actividad_fisica", label: "Physical activity", kind: "text" },
      { path: "habitos_estilo_vida.tabaquismo", label: "Smoking", kind: "bool_detail" },
      { path: "habitos_estilo_vida.alcohol", label: "Alcohol", kind: "bool_detail" },
      { path: "habitos_estilo_vida.estres_psicosocial", label: "Stress / psychosocial", kind: "text" },
      { path: "habitos_estilo_vida.trabajo_rutina", label: "Work / routine", kind: "text" },
    ],
  },
  {
    key: "revision_sistemas",
    label: "7. Review of systems",
    rows: [
      { path: "revision_sistemas.respiratorio", label: "Respiratory", kind: "text" },
      { path: "revision_sistemas.cardiovascular", label: "Cardiovascular", kind: "text" },
      { path: "revision_sistemas.gastrointestinal", label: "Gastrointestinal", kind: "text" },
      { path: "revision_sistemas.neurologico", label: "Neurological", kind: "text" },
      { path: "revision_sistemas.genitourinario", label: "Genitourinary", kind: "text" },
      { path: "revision_sistemas.otros", label: "Other", kind: "text" },
    ],
  },
  {
    key: "observaciones_adicionales",
    label: "8. Additional observations",
    rows: [
      { path: "observaciones_adicionales.presion_arterial", label: "Blood pressure", kind: "text" },
      { path: "observaciones_adicionales.frecuencia_cardiaca", label: "Heart rate", kind: "text" },
      { path: "observaciones_adicionales.frecuencia_respiratoria", label: "Respiratory rate", kind: "text" },
      { path: "observaciones_adicionales.temperatura", label: "Temperature", kind: "text" },
      { path: "observaciones_adicionales.saturacion_oxigeno", label: "Oxygen saturation", kind: "text" },
      { path: "observaciones_adicionales.peso", label: "Weight", kind: "text" },
      { path: "observaciones_adicionales.talla", label: "Height", kind: "text" },
      { path: "observaciones_adicionales.examen_fisico", label: "Physical exam", kind: "text" },
      { path: "observaciones_adicionales.notas", label: "Other notes", kind: "text" },
    ],
  },
  {
    key: "expectativas_plan",
    label: "9. Expectations & plan",
    rows: [
      { path: "expectativas_plan.expectativas_paciente", label: "Patient expectations", kind: "text" },
      { path: "expectativas_plan.orientaciones_iniciales", label: "Initial guidance", kind: "text" },
      { path: "expectativas_plan.conducta_remisiones", label: "Plan / referrals", kind: "text" },
      { path: "expectativas_plan.proximo_control", label: "Next follow-up", kind: "text" },
    ],
  },
];

function AnamneseRow({
  label,
  value,
  kind,
}: {
  label: string;
  value: unknown;
  kind: RowKind;
}) {
  return (
    <tr>
      <td className="anamnese-label">{label}</td>
      <td className="anamnese-value">{renderValue(value, kind)}</td>
    </tr>
  );
}

function renderValue(value: unknown, kind: RowKind): ReactNode {
  const empty = <span className="placeholder">—</span>;
  if (value === null || value === undefined || value === "") return empty;
  if (kind === "list") {
    if (!Array.isArray(value) || value.length === 0) return empty;
    return value.map(String).join(", ");
  }
  if (kind === "meds") {
    if (!Array.isArray(value) || value.length === 0) return empty;
    return (
      <ul className="anamnese-meds">
        {value.map((m: any, i) => (
          <li key={i}>
            <strong>{m?.nombre ?? "—"}</strong>
            {m?.dosis ? ` · ${m.dosis}` : ""}
            {m?.horario ? ` · ${m.horario}` : ""}
          </li>
        ))}
      </ul>
    );
  }
  if (kind === "bool_detail") {
    if (typeof value !== "object" || value === null) return empty;
    const v = value as { consume?: boolean | null; detalle?: string | null };
    const yn =
      v.consume === true ? "Yes" : v.consume === false ? "No" : null;
    if (!yn && !v.detalle) return empty;
    return [yn, v.detalle].filter(Boolean).join(" — ");
  }
  // text
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getPath(obj: Record<string, any>, path: string): unknown {
  return path.split(".").reduce<any>(
    (acc, k) => (acc && typeof acc === "object" ? acc[k] : undefined),
    obj,
  );
}
