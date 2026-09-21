// One message, one reply. Words that were missed while offline and delivered
// after reconnecting are highlighted, so the recovery is visible in the text.

import { clockTime } from "../metrics";
import type { RunView } from "../useRun";

const replyHeading: Record<RunView["status"], string> = {
  idle: "Relay",
  running: "Relay (writing…)",
  completed: "Relay",
  failed: "Relay (failed)",
  interrupted: "Relay (interrupted)",
};

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
            <span className={`turn-who assistant status-${view.status}`}>{replyHeading[view.status]}</span>
            <time className="turn-time mono">{clockTime(view.replyStartedAt)}</time>
          </header>
          <p className="bubble reply">
            {words.map((event) => (
              <span key={event.seq} className={event.source === "replayed" ? "recovered" : undefined}>
                {event.text}
              </span>
            ))}
            {streamingNow && <span className="caret" aria-hidden="true" />}
            {words.length === 0 && <span className="muted">waiting for the first word…</span>}
          </p>
          {recovered > 0 && (
            <p className="legend">
              <span className="recovered">Highlighted</span> = words you missed while offline,
              delivered when you came back.
            </p>
          )}
        </div>
      </article>
    </section>
  );
}
