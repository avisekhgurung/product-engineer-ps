// Plain-English description of what the stream is doing right now.
//
// The engineering panels show numbers; this turns the same live state into the
// sentence a first-time viewer needs. It only reads state the app really has,
// so the words can never claim more than the stream did.

import type { RunView } from "./useRun";

export type Tone = "neutral" | "good" | "warn" | "bad";

export interface Narration {
  tone: Tone;
  title: string;
  detail: string;
}

function chunkCount(view: RunView): number {
  return view.log.filter((event) => event.type === "chunk").length;
}

/** Words that arrived as catch-up after a reconnect, not live. */
export function recoveredCount(view: RunView): number {
  return view.log.filter((event) => event.type === "chunk" && event.source === "replayed").length;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function narrate(view: RunView): Narration {
  const words = chunkCount(view);
  const recovered = recoveredCount(view);

  switch (view.status) {
    case "completed":
      return {
        tone: "good",
        title: "Done — nothing missing, nothing repeated",
        detail:
          recovered > 0
            ? `You were offline for part of it. The ${plural(recovered, "word")} you missed came back in the right order.`
            : `All ${plural(words, "word")} arrived in order.`,
      };
    case "failed":
      return {
        tone: "bad",
        title: "The server stopped writing the answer",
        detail: `It failed after ${plural(words, "word")}. Those words are safe, and this answer can never be marked as finished.`,
      };
    case "interrupted":
      return {
        tone: "bad",
        title: "The server restarted while writing",
        detail: `The ${plural(words, "word")} saved before the restart are kept. It did not carry on by itself.`,
      };
    case "idle":
      return {
        tone: "neutral",
        title: "Ready",
        detail: "Press Send. The answer will appear one word at a time.",
      };
    case "running":
      break;
  }

  if (view.runId === null && view.connection === "disconnected") {
    return {
      tone: "bad",
      title: "Couldn't start the answer",
      detail: view.notice ?? "The server did not respond.",
    };
  }

  switch (view.connection) {
    case "connecting":
      return { tone: "warn", title: "Connecting…", detail: "Starting the answer." };
    case "reconnecting":
      return {
        tone: "warn",
        title: "Connection lost — trying again",
        detail: `Attempt ${view.attempt}. The server is still writing, so nothing is lost.`,
      };
    case "disconnected":
      return view.cutByUser
        ? {
            tone: "warn",
            title: "Internet is off",
            detail: `The server is still writing the answer without you. You have ${plural(words, "word")} so far. Press “Turn internet back on” to get the rest.`,
          }
        : {
            tone: "bad",
            title: "Couldn't reconnect",
            detail: "Automatic retries stopped. Nothing is lost. Press “Turn internet back on” to try again.",
          };
    default:
      return recovered > 0
        ? {
            tone: "good",
            title: "Back online — live again",
            detail: `${plural(recovered, "missed word")} came back first (highlighted below), then new words kept arriving.`,
          }
        : {
            tone: "warn",
            title: "Answer is arriving live",
            detail: "Words come from the server as it writes them. Try pressing “Cut the internet”.",
          };
  }
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
  if (view.status !== "running") return recoveredCount(view) > 0 && view.status === "completed" ? 4 : 1;
  if (view.connection === "disconnected" || view.connection === "reconnecting") return 3;
  return recoveredCount(view) > 0 ? 4 : 2;
}
