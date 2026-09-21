// Shapes shared with the Go server, plus the two plain HTTP calls.
// The streaming half lives in useRun.ts.

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

export type RunEventType = "chunk" | "completed" | "failed" | "interrupted";

/** One ordered item of a run's durable history. `seq` is the client cursor. */
export interface RunEvent {
  seq: number;
  type: RunEventType;
  text?: string;
  reason?: string;
}

export interface Run {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: RunStatus;
  lastSeq: number;
}

export interface SendResult {
  runId: string;
  status: RunStatus;
  lastSeq: number;
  created: boolean;
}

/**
 * Starts one reply. The message id is generated here, so retrying a failed
 * send reaches the same run instead of starting a second reply.
 */
export async function sendMessage(
  conversationId: string,
  text: string,
  failAfter: number,
): Promise<SendResult> {
  const response = await fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      messageId: `msg_${crypto.randomUUID()}`,
      text,
      failAfter,
    }),
  });
  if (!response.ok) {
    throw new Error(`send failed with status ${response.status}`);
  }
  return response.json();
}

/** Reads durable run state. Used to decide what a broken connection means. */
export async function fetchRun(runId: string): Promise<Run> {
  const response = await fetch(`/api/runs/${runId}`);
  if (!response.ok) {
    throw new Error(`run lookup failed with status ${response.status}`);
  }
  return response.json();
}
