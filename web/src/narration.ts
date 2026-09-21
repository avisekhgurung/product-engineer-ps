// Plain-English description of what the stream is doing right now.
//
// The engineering panels show numbers; this turns the same live state into the
// sentence a first-time viewer needs. It only reads state the app really has,
// so the words can never claim more than the stream did.

import { latestRecovery, seqLabel, streamMetrics } from "./metrics";
import type { RunView } from "./useRun";

export type Tone = "neutral" | "good" | "warn" | "bad";

export interface Narration {
  tone: Tone;
  title: string;
  detail: string;
}

/** Sequence of the last chunk received, i.e. where the text stopped. */
function lastChunkSeq(view: RunView): number {
  for (let i = view.log.length - 1; i >= 0; i--) {
    if (view.log[i].type === "chunk") return view.log[i].seq;
  }
  return 0;
}

export function narrate(view: RunView): Narration {
  const metrics = streamMetrics(view.log, view.cursor, view.duplicatesSuppressed);

  if (view.runId === null && view.connection === "disconnected") {
    return {
      tone: "bad",
      title: "Couldn't start the answer",
      detail: view.notice ?? "The server did not respond.",
    };
  }

  switch (view.status) {
    case "completed":
      // Never claim a clean finish the numbers do not support.
      return metrics.orderingValid
        ? {
            tone: "good",
            title: "Completed — nothing missing, nothing repeated",
            detail: `${metrics.received} events received in the correct order.`,
          }
        : {
            tone: "bad",
            title: "Completed, but the stream is not intact",
            detail: `${metrics.missing.length} missing events. Sequence is not valid.`,
          };
    case "failed":
      return {
        tone: "bad",
        title: "Generator failed",
        detail: `The stream stopped after event #${seqLabel(lastChunkSeq(view))}.`,
      };
    case "interrupted":
      return {
        tone: "bad",
        title: "Server restarted",
        detail: `The stream stopped after event #${seqLabel(lastChunkSeq(view))}. Stored events are intact; generation did not resume.`,
      };
    case "idle":
      return {
        tone: "neutral",
        title: "Ready",
        detail: "Press Send. The answer will arrive one event at a time.",
      };
    case "running":
      break;
  }

  switch (view.connection) {
    case "connecting":
      return { tone: "warn", title: "Connecting…", detail: "Starting the answer." };
    case "reconnecting":
      return {
        tone: "warn",
        title: "Reconnecting",
        detail: `Resuming from event #${seqLabel(view.cursor)}…`,
      };
    case "disconnected":
      return {
        tone: view.cutByUser ? "warn" : "bad",
        title: "Connection interrupted",
        detail: view.cutByUser
          ? "The server is still generating. Reconnect to resume from the last acknowledged event."
          : "Automatic retries stopped. The server is still generating. Reconnect to resume from the last acknowledged event.",
      };
    default:
      break;
  }

  // Connected and running. If this connection is catching up after a drop, say
  // so until it has reached the point the server held when it opened.
  const replayed = latestRecovery(view.log, view.lastDisconnectedAt).length;
  if (view.lastDisconnectedAt !== null && view.cursor < view.replayBoundary) {
    return {
      tone: "warn",
      title: "Catching up",
      detail: `Replaying missed events: #${seqLabel(view.cursor)} of #${seqLabel(view.replayBoundary)}.`,
    };
  }
  if (replayed > 0) {
    return {
      tone: "good",
      title: "Stream recovered",
      detail: `${replayed} events replayed. Live delivery restored.`,
    };
  }
  return {
    tone: "warn",
    title: "Answer is arriving live",
    detail: "Events arrive as the server generates them. Try pressing “Drop connection”.",
  };
}

/** Events that reached the client as catch-up, across every recovery. */
export function recoveredCount(view: RunView): number {
  return view.log.filter((event) => event.source === "replayed").length;
}

/**
 * Which of the three demo steps the viewer is on. 4 means all done.
 *
 * A step only counts as done if the viewer actually did it. A run that failed,
 * or finished without a reconnect, sends them back to step 1 to try again
 * rather than ticking steps they never performed.
 */
export function activeStep(view: RunView): 1 | 2 | 3 | 4 {
  if (view.status === "idle") return 1;
  if (view.status !== "running") {
    return view.status === "completed" && recoveredCount(view) > 0 ? 4 : 1;
  }
  if (view.connection === "disconnected" || view.connection === "reconnecting") return 3;
  return recoveredCount(view) > 0 ? 4 : 2;
}
