// Five status cards. Each one reads a value the stream actually produced, and
// each one states its meaning in words as well as colour.

import type { RunStatus } from "../api";
import { seqLabel, type StreamMetrics } from "../metrics";
import type { ConnectionState, RunView } from "../useRun";

type Tone = "neutral" | "good" | "warn" | "bad";

const connectionTone: Record<ConnectionState, Tone> = {
  idle: "neutral",
  connecting: "warn",
  connected: "good",
  reconnecting: "warn",
  disconnected: "bad",
};

const runTone: Record<RunStatus | "idle", Tone> = {
  idle: "neutral",
  running: "warn",
  completed: "good",
  failed: "bad",
  interrupted: "bad",
};

const runLabels: Record<RunStatus | "idle", string> = {
  idle: "no run",
  running: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

interface StatusCardProps {
  label: string;
  value: string;
  tone: Tone;
  icon: string;
  mono?: boolean;
  detail?: string;
}

function StatusCard({ label, value, tone, icon, mono, detail }: StatusCardProps) {
  return (
    <article className={`status-card tone-${tone}`}>
      <span className="status-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="status-body">
        <p className="status-label">{label}</p>
        <p className={mono ? "status-value mono" : "status-value"}>{value}</p>
      </div>
      {detail && <span className="status-detail">{detail}</span>}
    </article>
  );
}

export function StatusBar({ view, metrics }: { view: RunView; metrics: StreamMetrics }) {
  const connectionValue =
    view.connection === "reconnecting" && view.attempt > 0
      ? `reconnecting (try ${view.attempt})`
      : view.connection;

  const integrityOk = metrics.orderingValid && metrics.duplicates === 0;

  return (
    <section className="status-bar" aria-label="Stream status">
      <StatusCard
        label="Connection"
        value={connectionValue}
        tone={connectionTone[view.connection]}
        icon="◉"
      />
      <StatusCard
        label="Run state"
        value={runLabels[view.status]}
        tone={runTone[view.status]}
        icon="◍"
      />
      <StatusCard label="Cursor" value={seqLabel(view.cursor)} tone="neutral" icon="#" mono />
      <StatusCard
        label="Event count"
        value={seqLabel(metrics.received)}
        tone="neutral"
        icon="≡"
        mono
      />
      <StatusCard
        label={integrityOk ? "No gaps, no duplicates" : "Stream integrity"}
        value={integrityOk ? "verified" : `${metrics.missing.length} missing`}
        tone={integrityOk ? "good" : "bad"}
        icon={integrityOk ? "✓" : "!"}
      />
    </section>
  );
}
