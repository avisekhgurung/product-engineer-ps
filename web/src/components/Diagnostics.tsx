// The "Under the hood" panels: the run, what the stream delivered, and how the
// last recovery went. Every value is derived from live state; nothing here is
// reported by the server beyond the run id and status it already sends.

import { seqLabel, type StreamMetrics } from "../metrics";
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

/** Run ids are long; show the start and keep the full id in the tooltip. */
function shortId(id: string | null): string {
  if (id === null) return "—";
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

export function RunInfo({ view }: { view: RunView }) {
  return (
    <section className="card panel" aria-label="Run">
      <header className="card-head">
        <h2 className="card-title">Run</h2>
      </header>
      <Row label="Run ID" value={shortId(view.runId)} title={view.runId ?? undefined} />
      <Row
        label="Status"
        value={view.status === "idle" ? "no run" : view.status}
        tone={
          view.status === "completed" ? "good" : view.status === "failed" || view.status === "interrupted" ? "bad" : undefined
        }
      />
      <Row label="Cursor" value={seqLabel(view.cursor)} />
    </section>
  );
}

export function StreamIntegrity({ metrics }: { metrics: StreamMetrics }) {
  return (
    <section className="card panel" aria-label="Stream integrity">
      <header className="card-head">
        <h2 className="card-title">Stream integrity</h2>
      </header>
      <Row label="Expected" value={seqLabel(metrics.expected)} />
      <Row label="Received" value={seqLabel(metrics.received)} />
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
      <p className="panel-note">
        Duplicates counts deliveries this client suppressed because it already held that
        sequence &mdash; the client half of the deduplication contract.
      </p>
    </section>
  );
}

/** Events that arrived as catch-up after the most recent disconnect. */
function lastRecovery(view: RunView) {
  const since = view.lastDisconnectedAt ?? Infinity;
  return view.log.filter((event) => event.source === "replayed" && event.seq > since);
}

/** First and last sequence replayed by the most recent recovery. */
function replayRange(view: RunView): string {
  const replayed = lastRecovery(view);
  if (replayed.length === 0) return "—";
  return `#${seqLabel(replayed[0].seq)} → #${seqLabel(replayed[replayed.length - 1].seq)}`;
}

/**
 * How the most recent recovery went. "replay → live" means catch-up came first
 * and live delivery followed; plain "live" means there was nothing to catch up.
 */
function recoveryMode(view: RunView): string {
  if (view.connection === "disconnected") return "offline";
  if (view.connection === "reconnecting" || view.connection === "connecting") return "resuming…";
  const replayed = lastRecovery(view);
  if (replayed.length > 0) {
    const lastReplayed = replayed[replayed.length - 1].seq;
    const liveAfter = view.log.some((event) => event.source === "live" && event.seq > lastReplayed);
    return liveAfter ? "replay → live" : "replay";
  }
  return view.log.length > 0 ? "live" : "—";
}

export function ConnectionRecovery({ view }: { view: RunView }) {
  return (
    <section className="card panel" aria-label="Recovery">
      <header className="card-head">
        <h2 className="card-title">Recovery</h2>
      </header>
      <Row
        label="Disconnected"
        value={view.lastDisconnectedAt === null ? "—" : `#${seqLabel(view.lastDisconnectedAt)}`}
      />
      <Row
        label="Reconnect"
        value={
          // The first connection is not a reconnect, so it has no reconnect cursor.
          view.lastDisconnectedAt === null || view.reconnectCursor === null
            ? "—"
            : `#${seqLabel(view.reconnectCursor)}`
        }
      />
      <Row label="Replay" value={replayRange(view)} />
      <Row label="Mode" value={recoveryMode(view)} />
      <p className="panel-note">
        Disconnected is the last sequence received before the connection broke. Reconnect is
        the cursor sent when asking to resume. Replay and mode describe the latest recovery.
      </p>
    </section>
  );
}
