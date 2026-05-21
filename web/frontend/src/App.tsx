import { useEffect, useRef, useState } from "react";
import { RealtimeClient, type SessionTotals } from "./realtime";
import { fmtTokens, fmtUnitPrice, fmtUsd } from "./costs";

type SessionState = "idle" | "connecting" | "live" | "ended";
type ChatRole = "user" | "assistant";

interface PromptOption {
  id: string;
  label: string;
}

const PROMPT_OPTIONS: PromptOption[] = [
  { id: "v1", label: "v1 — Insurance intake" },
  { id: "v2", label: "v2 — Debt collection" },
];

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
  const [costs, setCosts] = useState<SessionTotals | null>(null);
  const [promptVariant, setPromptVariant] = useState<string>(PROMPT_OPTIONS[0].id);
  const clientRef = useRef<RealtimeClient | null>(null);
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
    setState("idle");
  };

  const startCall = async () => {
    if (clientRef.current) return;
    reset();
    const client = new RealtimeClient({
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
    });
    clientRef.current = client;
    try {
      await client.start(promptVariant);
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
        <h1>Transcribing User Audio: Separate Transcribe Model vs. Realtime</h1>
        <span className={`status status-${state}`}>{state}</span>
      </header>

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
              <div className="role">{m.role === "user" ? "Cliente" : "Atendente"}</div>
              <div className="text">{m.text || "…"}</div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      </section>

      <footer className="controls">
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
};

function CostPanel({ totals }: { totals: SessionTotals }) {
  const sections: Array<{
    key: string;
    label: string;
    sub: string;
    total: number;
    parts: SessionTotals["realtimeMain"]["parts"];
  }> = [
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
