// Three small explanatory panels under the main columns:
// what the stream delivered, how the last recovery went, and where the parts
// of the system sit. The first two are derived from live state; the third is
// static documentation of the server's real structure.

import { seqLabel, type StreamMetrics } from "../metrics";
import type { RunView } from "../useRun";

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className={tone ? `kv-value mono ${tone}` : "kv-value mono"}>{value}</span>
    </div>
  );
}

export function StreamIntegrity({ metrics }: { metrics: StreamMetrics }) {
  const healthy = metrics.orderingValid && metrics.duplicates === 0;
  return (
    <section className="card panel" aria-label="Stream integrity">
      <header className="card-head">
        <h2 className="card-title">
          <span className={healthy ? "dot good" : "dot bad"} aria-hidden="true" /> Stream integrity
        </h2>
      </header>
      <div className="kv-grid">
        <div>
          <Row label="Cursor" value={seqLabel(metrics.expected)} />
          <Row label="Events received" value={seqLabel(metrics.received)} />
          <Row label="Events expected" value={seqLabel(metrics.expected)} />
        </div>
        <div>
          <Row
            label="Missing"
            value={String(metrics.missing.length)}
            tone={metrics.missing.length === 0 ? undefined : "bad"}
          />
          <Row
            label="Duplicates"
            value={String(metrics.duplicates)}
            tone={metrics.duplicates === 0 ? undefined : "bad"}
          />
          <Row
            label="Ordering"
            value={metrics.orderingValid ? "valid" : "broken"}
            tone={metrics.orderingValid ? "good" : "bad"}
          />
        </div>
      </div>
      <p className="panel-note">
        Duplicates counts deliveries this client suppressed because it already held that
        sequence &mdash; the client half of the deduplication contract.
      </p>
    </section>
  );
}

/** Words for what the server is doing, taken from the run's real status. */
const serverState: Record<RunView["status"], string> = {
  idle: "idle",
  running: "generating",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

function recoveryMode(view: RunView): string {
  if (view.connection === "reconnecting" || view.connection === "connecting") {
    return "resuming…";
  }
  if (view.connection !== "connected") return "—";
  return view.cursor < view.replayBoundary ? "replay → live" : "live";
}

export function ConnectionRecovery({ view }: { view: RunView }) {
  return (
    <section className="card panel" aria-label="Connection recovery">
      <header className="card-head">
        <h2 className="card-title">
          <span className="dot neutral" aria-hidden="true" /> Connection recovery
        </h2>
      </header>
      <Row
        label="Last disconnected"
        value={view.lastDisconnectedAt === null ? "—" : `#${seqLabel(view.lastDisconnectedAt)}`}
      />
      <Row
        label="Reconnect cursor"
        value={view.reconnectCursor === null ? "—" : `#${seqLabel(view.reconnectCursor)}`}
      />
      <Row label="Server state" value={serverState[view.status]} />
      <Row label="Recovery mode" value={recoveryMode(view)} />
      <p className="panel-note">
        Replay ends at the sequence the server held when this connection opened; everything
        after it is live delivery.
      </p>
    </section>
  );
}

const pipeline = [
  { name: "Client", detail: "Web app" },
  { name: "Stream API", detail: "HTTP / SSE" },
  { name: "Run Manager", detail: "State & cursor" },
  { name: "Event Store", detail: "Durable log" },
  { name: "Generator", detail: "Produces events" },
];

export function Architecture() {
  return (
    <section className="card panel architecture" aria-label="Architecture">
      <header className="card-head">
        <h2 className="card-title">
          <span className="dot neutral" aria-hidden="true" /> Architecture (high level)
        </h2>
      </header>
      <ol className="pipeline">
        {pipeline.map((stage, index) => (
          <li key={stage.name}>
            <div className="stage">
              <p className="stage-name">{stage.name}</p>
              <p className="stage-detail">{stage.detail}</p>
            </div>
            {index < pipeline.length - 1 && (
              <span className="arrow" aria-hidden="true">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="panel-note mono">
        reconnect(cursor=N) → replay N+1… → live stream
      </p>
    </section>
  );
}
