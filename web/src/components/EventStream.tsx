// The event log: the proof that the protocol works.
//
// Newest first. Every row shows the server-assigned sequence, the event type,
// the payload, the time it reached this client, and whether it arrived live or
// was replayed from durable history after a reconnect.

import { clockTime, seqLabel } from "../metrics";
import type { StreamEvent } from "../useRun";

function SourceBadge({ event }: { event: StreamEvent }) {
  if (event.type !== "chunk") {
    return <span className="source-badge none">—</span>;
  }
  return (
    <span className={`source-badge ${event.source}`}>
      {event.source === "live" ? "LIVE" : "REPLAYED"}
    </span>
  );
}

export function EventStream({ log }: { log: StreamEvent[] }) {
  const rows = [...log].reverse();

  return (
    <section className="card event-stream" aria-label="Event stream">
      <header className="card-head">
        <h2 className="card-title">Event stream</h2>
        <span className="card-meta mono">{log.length} events</span>
      </header>

      {rows.length === 0 ? (
        <p className="empty-note">No events yet.</p>
      ) : (
        <ol className="event-rows">
          {rows.map((event) => (
            <li key={event.seq} className={event.type === "chunk" ? "row" : `row ${event.type}`}>
              <span className="seq mono">{seqLabel(event.seq)}</span>
              <span className={`type-badge ${event.type}`}>{event.type}</span>
              <span className="event-text">{event.text ?? event.reason}</span>
              <time className="event-time mono">{clockTime(event.receivedAt)}</time>
              <SourceBadge event={event} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
