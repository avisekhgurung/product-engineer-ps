// One message, one reply. Words that were missed while offline and delivered
// after reconnecting are highlighted, so the recovery is visible in the text.

import { clockTime } from "../metrics";
import type { RunView } from "../useRun";

/** The assistant's label states the run's real condition. */
function replyHeading(view: RunView): string {
  switch (view.status) {
    case "running":
      // Offline is not streaming, so say so instead of claiming it is.
      return view.connection === "disconnected" || view.connection === "reconnecting"
        ? "Relay (paused)"
        : "Relay (streaming…)";
    case "failed":
      return "Relay (failed)";
    case "interrupted":
      return "Relay (interrupted)";
    default:
      return "Relay";
  }
}

export function Conversation({ view }: { view: RunView }) {
  if (!view.prompt) return null;

  const words = view.log.filter((event) => event.type === "chunk");
  const recovered = words.filter((event) => event.source === "replayed").length;
  const streamingNow = view.status === "running" && view.connection === "connected";

  return (
    <section className="card conversation" aria-label="Conversation">
      <article className="turn">
        <span className="avatar" aria-hidden="true">
          ●
        </span>
        <div className="turn-body">
          <header className="turn-head">
            <span className="turn-who">You</span>
            <time className="turn-time mono">{clockTime(view.promptAt)}</time>
          </header>
          <p className="bubble">{view.prompt}</p>
        </div>
      </article>

      <article className="turn">
        <span className={`avatar assistant status-${view.status}`} aria-hidden="true">
          ●
        </span>
        <div className="turn-body">
          <header className="turn-head">
            <span className={`turn-who assistant status-${view.status}`}>{replyHeading(view)}</span>
            <time className="turn-time mono">{clockTime(view.replyStartedAt)}</time>
          </header>
          <p className="bubble reply">
            {words.map((event) => (
              <span key={event.seq} className={event.source === "replayed" ? "recovered" : undefined}>
                {event.text}
              </span>
            ))}
            {streamingNow && <span className="caret" aria-hidden="true" />}
            {words.length === 0 && <span className="muted">waiting for the first event…</span>}
          </p>
          {recovered > 0 && (
            <p className="legend">
              <span className="recovered">Highlighted</span> = events you missed while
              disconnected, replayed when you reconnected.
            </p>
          )}
        </div>
      </article>
    </section>
  );
}
