// Numbers shown in the status bar and the diagnostics panels.
//
// Everything here is derived from events the client actually received. None of
// it is reported by the server, and none of it is hardcoded: if the stream ever
// did lose or repeat an event, these values would say so.

import type { StreamEvent } from "./useRun";

export interface StreamMetrics {
  /** Events applied to the view. */
  received: number;
  /** Highest sequence the server has told us about, i.e. the cursor. */
  expected: number;
  /** Sequence numbers we should hold but do not. */
  missing: number[];
  /** Deliveries dropped because their sequence was already known. */
  duplicates: number;
  /** True when the log is strictly increasing with no holes. */
  orderingValid: boolean;
}

export function streamMetrics(
  log: StreamEvent[],
  cursor: number,
  duplicatesSuppressed: number,
): StreamMetrics {
  const held = new Set(log.map((event) => event.seq));
  const missing: number[] = [];
  for (let seq = 1; seq <= cursor; seq++) {
    if (!held.has(seq)) missing.push(seq);
  }

  let orderingValid = true;
  for (let i = 1; i < log.length; i++) {
    if (log[i].seq <= log[i - 1].seq) orderingValid = false;
  }

  return {
    received: log.length,
    expected: cursor,
    missing,
    duplicates: duplicatesSuppressed,
    orderingValid: orderingValid && missing.length === 0,
  };
}

/** Three-digit sequence numbers keep the columns from jumping about. */
export function seqLabel(value: number): string {
  return String(value).padStart(3, "0");
}

export function clockTime(epochMs: number | null): string {
  if (epochMs === null) return "—";
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Events that arrived as catch-up after the most recent disconnect. Both the
 * banner and the Recovery panel read this, so they cannot disagree.
 */
export function latestRecovery(log: StreamEvent[], lastDisconnectedAt: number | null): StreamEvent[] {
  if (lastDisconnectedAt === null) return [];
  return log.filter((event) => event.source === "replayed" && event.seq > lastDisconnectedAt);
}
