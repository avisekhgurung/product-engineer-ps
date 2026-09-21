// The "Under the hood" panels. Every value is derived from live state or comes
// from ids the server already returned; nothing is invented. Where a value does
// not exist yet (no run, no disconnect) the row shows an em dash.

import { latestRecovery, seqLabel, type StreamMetrics } from "../metrics";
import type { RunView } from "../useRun";

function Row({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  title?: string;
}) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className={tone ? `kv-value mono ${tone}` : "kv-value mono"} title={title}>
        {value}
      </span>
    </div>
  );
}

/** Ids are long; show the start and keep the full id in the tooltip. */
function shortId(id: string | null): string {
  if (id === null) return "—";
  return id.length > 16 ? `${id.slice(0, 14)}…` : id;
}

export function RunInfo({ view }: { view: RunView }) {
  return (
    <section className="card panel" aria-label="Run details">
      <header className="card-head">
        <h2 className="card-title">Run details</h2>
      </header>
      <Row label="Conversation ID" value={shortId(view.conversationId)} title={view.conversationId ?? undefined} />
      <Row label="Message ID" value={shortId(view.messageId)} title={view.messageId ?? undefined} />
      <Row label="Run ID" value={shortId(view.runId)} title={view.runId ?? undefined} />
      <Row
        label="Run state"
        value={view.status === "idle" ? "no run" : view.status}
        tone={
          view.status === "completed"
            ? "good"
            : view.status === "failed" || view.status === "interrupted"
              ? "bad"
              : undefined
        }
      />
      <Row label="Cursor" value={`#${seqLabel(view.cursor)}`} />
    </section>
  );
}

export function StreamIntegrity({ metrics }: { metrics: StreamMetrics }) {
  return (
    <section className="card panel" aria-label="Stream integrity">
      <header className="card-head">
        <h2 className="card-title">Stream integrity</h2>
      </header>
      <Row label="Events received" value={seqLabel(metrics.received)} />
      <Row label="Expected events" value={seqLabel(metrics.expected)} />
      <Row
        label="Missing events"
        value={String(metrics.missing.length)}
        tone={metrics.missing.length === 0 ? undefined : "bad"}
      />
      <Row
        label="Duplicate events"
        value={String(metrics.duplicates)}
        tone={metrics.duplicates === 0 ? undefined : "bad"}
      />
      <Row
        label="Sequence"
        value={metrics.orderingValid ? "valid" : "invalid"}
        tone={metrics.orderingValid ? "good" : "bad"}
      />
      <p className="panel-note">
        Expected is the highest sequence the client has seen. Duplicate events counts
        deliveries the client dropped because it already held that sequence.
      </p>
    </section>
  );
}

/**
 * How the most recent recovery went. "replay → live" means catch-up came first
 * and live delivery followed; plain "live" means there was nothing to catch up.
 */
function transition(view: RunView): string {
  if (view.connection === "disconnected") return "offline";
  if (view.connection === "reconnecting" || view.connection === "connecting") return "resuming…";
  const replayed = latestRecovery(view.log, view.lastDisconnectedAt);
  if (replayed.length > 0) {
    const lastReplayed = replayed[replayed.length - 1].seq;
    const liveAfter = view.log.some((event) => event.source === "live" && event.seq > lastReplayed);
    return liveAfter ? "replay → live" : "replay";
  }
  return view.log.length > 0 ? "live" : "—";
}

export function ConnectionRecovery({ view }: { view: RunView }) {
  const replayed = latestRecovery(view.log, view.lastDisconnectedAt);
  const replayRange =
    replayed.length === 0
      ? "—"
      : `#${seqLabel(replayed[0].seq)} → #${seqLabel(replayed[replayed.length - 1].seq)}`;

  const disconnect = view.lastDisconnectedAt;
  // The cursor asked for on resume is the last event the client had acknowledged.
  const acknowledged = disconnect === null ? null : (view.reconnectCursor ?? disconnect);

  return (
    <section className="card panel" aria-label="Recovery">
      <header className="card-head">
        <h2 className="card-title">Recovery</h2>
      </header>
      <Row label="Disconnect event" value={disconnect === null ? "—" : `#${seqLabel(disconnect)}`} />
      <Row
        label="Last acknowledged cursor"
        value={acknowledged === null ? "—" : `#${seqLabel(acknowledged)}`}
      />
      <Row label="Replay range" value={replayRange} />
      <Row label="Transition" value={transition(view)} />
      <p className="panel-note">
        Disconnect event is the last sequence received before the connection broke. Replay
        range and transition describe the latest recovery only.
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

/** Static explanation of the server's real structure; not driven by state. */
export function Architecture() {
  return (
    <section className="card panel architecture" aria-label="Architecture">
      <header className="card-head">
        <h2 className="card-title">Architecture</h2>
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
      <p className="panel-note mono">reconnect(cursor=N) → replay N+1… → live stream</p>
    </section>
  );
}
