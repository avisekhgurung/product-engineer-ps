// The event log: the proof that the protocol works.
//
// Newest first. Every row shows the server-assigned sequence, the event type,
// the payload, the time it reached this client, and whether it arrived live or
// was replayed from durable history after a reconnect.
//
// A lost connection is not a stored event, so it never gets a sequence number.
// It appears as a divider at the point in the stream where it happened.

import { clockTime, seqLabel } from "../metrics";
import type { StreamEvent } from "../useRun";

type Item =
  | { kind: "event"; event: StreamEvent }
  | { kind: "lost"; after: number };

/** Oldest first: each loss sits right after the last event received before it. */
function withLossMarkers(log: StreamEvent[], disconnects: number[]): Item[] {
  const items: Item[] = [];
  if (disconnects.includes(0)) items.push({ kind: "lost", after: 0 });
  for (const event of log) {
    items.push({ kind: "event", event });
    if (disconnects.includes(event.seq)) items.push({ kind: "lost", after: event.seq });
  }
  return items;
}

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

export function EventStream({ log, disconnects }: { log: StreamEvent[]; disconnects: number[] }) {
  const items = withLossMarkers(log, disconnects).reverse();

  return (
    <section className="card event-stream" aria-label="Event log">
      <header className="card-head">
        <h2 className="card-title">Event log</h2>
        <span className="card-meta mono">{log.length} events</span>
      </header>

      {items.length === 0 ? (
        <p className="empty-note">No events yet.</p>
      ) : (
        <ol className="event-rows">
          {items.map((item) =>
            item.kind === "lost" ? (
              <li key={`lost-${item.after}`} className="row lost">
                connection lost after #{seqLabel(item.after)} &mdash; server kept generating
              </li>
            ) : (
              <li
                key={item.event.seq}
                className={item.event.type === "chunk" ? "row" : `row ${item.event.type}`}
              >
                <span className="seq mono">{seqLabel(item.event.seq)}</span>
                <span className={`type-badge ${item.event.type}`}>{item.event.type}</span>
                <span className="event-text">{item.event.text ?? item.event.reason}</span>
                <time className="event-time mono">{clockTime(item.event.receivedAt)}</time>
                <SourceBadge event={item.event} />
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}
