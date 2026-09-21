// useRun owns everything the screen knows about one streamed reply:
// the text so far, the cursor, the connection state machine and the
// reconnect policy.
//
// The rules it enforces are:
//   - the cursor only ever moves forward, one sequence number at a time;
//   - an event at or below the cursor is ignored, so a replay that overlaps
//     what we already have cannot duplicate text on screen;
//   - a silent connection is treated as a broken connection, never as a
//     current one.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRun, sendMessage, type RunEvent, type RunStatus } from "./api";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

/** Where an event reached us from. Derived, never sent by the server. */
export type EventOrigin = "live" | "replayed";

/** A stored event plus the two facts only the client can know about it. */
export interface StreamEvent extends RunEvent {
  source: EventOrigin;
  receivedAt: number;
}

export interface RunView {
  runId: string | null;
  prompt: string;
  promptAt: number | null;
  replyStartedAt: number | null;
  text: string;
  cursor: number;
  log: StreamEvent[];
  connection: ConnectionState;
  status: RunStatus | "idle";
  attempt: number;
  notice: string | null;
  noticeKind: "info" | "warning" | "error" | "success";
  /** Deliveries dropped because their sequence was already known. */
  duplicatesSuppressed: number;
  /** Server's durable lastSeq when the current stream opened. */
  replayBoundary: number;
  /** Cursor sent on the most recent connect. */
  reconnectCursor: number | null;
  /** Cursor at the moment the last connection broke. */
  lastDisconnectedAt: number | null;
  /** True while the user has deliberately cut the connection (demo button). */
  cutByUser: boolean;
}

const initialView: RunView = {
  runId: null,
  prompt: "",
  promptAt: null,
  replyStartedAt: null,
  text: "",
  cursor: 0,
  log: [],
  connection: "idle",
  status: "idle",
  attempt: 0,
  notice: null,
  noticeKind: "info",
  duplicatesSuppressed: 0,
  replayBoundary: 0,
  reconnectCursor: null,
  lastDisconnectedAt: null,
  cutByUser: false,
};

/** Reconnect policy: exponential backoff with jitter, and a hard stop. */
const baseDelayMs = 400;
const maxDelayMs = 8000;
const maxAttempts = 6;

/**
 * If nothing at all arrives for this long — not a chunk, not the server's
 * five-second ping — the connection is assumed dead. A proxy or a sleeping
 * laptop can leave a socket that looks open but delivers nothing, and showing
 * "connected" in that state would be a lie.
 */
const silenceTimeoutMs = 12_000;

function backoff(attempt: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return exponential * (0.7 + Math.random() * 0.3); // jitter
}

function isTerminal(status: RunStatus | "idle"): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

/** Frames that carry no sequence number and must not move the cursor. */
type ControlFrame = { status: RunStatus; lastSeq: number };

export function useRun(conversationId: string) {
  const [view, setView] = useState<RunView>(initialView);

  const source = useRef<EventSource | null>(null);
  const cursor = useRef(0);
  const runId = useRef<string | null>(null);
  const status = useRef<RunStatus | "idle">("idle");
  const attempt = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const silenceTimer = useRef<number | null>(null);
  // Everything at or below this sequence was already durable when the current
  // stream opened, so it reached us as replay rather than live delivery.
  const replayBoundary = useRef(0);
  // Cursor the current stream was opened from. Zero means a first connection,
  // where nothing is being caught up, so nothing is called "replayed".
  const openedFrom = useRef(0);
  // pausedByUser marks a deliberate disconnect from the demo button. We do not
  // fight it with automatic retries; the user decides when to come back.
  const pausedByUser = useRef(false);
  // scheduleRetry, resumeFromDurableState and openStream call each other. Refs
  // let each reach the others without reading a binding before it exists.
  const resumeRef = useRef<() => void>(() => {});
  const openRef = useRef<() => void>(() => {});

  const closeStream = useCallback(() => {
    source.current?.close();
    source.current = null;
    for (const timer of [retryTimer, silenceTimer]) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  /** Bounded automatic reconnect. After maxAttempts we stop and say so. */
  const scheduleRetry = useCallback(() => {
    if (attempt.current >= maxAttempts) {
      setView((current) => ({
        ...current,
        connection: "disconnected",
        notice: `Gave up after ${maxAttempts} reconnect attempts. Press Reconnect to try again.`,
        noticeKind: "error",
      }));
      return;
    }
    const delay = backoff(attempt.current);
    attempt.current += 1;
    setView((current) => ({
      ...current,
      connection: "reconnecting",
      attempt: attempt.current,
      notice: `Connection lost — retrying in ${Math.round(delay)}ms (attempt ${attempt.current} of ${maxAttempts}).`,
      noticeKind: "warning",
    }));
    retryTimer.current = window.setTimeout(() => resumeRef.current(), delay);
  }, []);

  /** Called whenever the connection breaks or goes silent. */
  const handleConnectionLoss = useCallback(
    (reason: string) => {
      closeStream();
      const brokeAt = cursor.current;
      if (isTerminal(status.current)) {
        // The run finished and the server closed the stream: expected.
        setView((current) => ({ ...current, connection: "idle" }));
        return;
      }
      if (pausedByUser.current) {
        setView((current) => ({
          ...current,
          connection: "disconnected",
          lastDisconnectedAt: brokeAt,
        }));
        return;
      }
      setView((current) => ({
        ...current,
        notice: reason,
        noticeKind: "warning",
        lastDisconnectedAt: brokeAt,
      }));
      scheduleRetry();
    },
    [closeStream, scheduleRetry],
  );

  /** Restarts the silence watchdog. Any frame counts as a sign of life. */
  const armWatchdog = useCallback(() => {
    if (silenceTimer.current !== null) window.clearTimeout(silenceTimer.current);
    silenceTimer.current = window.setTimeout(
      () =>
        handleConnectionLoss(
          "No data from the server for 12s — treating the connection as lost.",
        ),
      silenceTimeoutMs,
    );
  }, [handleConnectionLoss]);

  /** Applies one event from the stream, ignoring anything already seen. */
  const applyEvent = useCallback((event: RunEvent) => {
    if (event.seq <= cursor.current) {
      // Replay overlapped live delivery. Count it, then drop it: this is the
      // client half of the deduplication contract.
      setView((current) => ({
        ...current,
        duplicatesSuppressed: current.duplicatesSuppressed + 1,
      }));
      return;
    }
    const entry: StreamEvent = {
      ...event,
      source:
        openedFrom.current > 0 && event.seq <= replayBoundary.current ? "replayed" : "live",
      receivedAt: Date.now(),
    };
    cursor.current = event.seq;
    if (event.type !== "chunk") {
      status.current = event.type;
    }
    setView((current) => ({
      ...current,
      cursor: event.seq,
      text: event.type === "chunk" ? current.text + (event.text ?? "") : current.text,
      status: event.type === "chunk" ? current.status : event.type,
      replyStartedAt: current.replyStartedAt ?? entry.receivedAt,
      log: [...current.log, entry],
      notice:
        event.type === "failed" || event.type === "interrupted"
          ? (event.reason ?? "The reply ended early.")
          : event.type === "completed"
            ? null
            : current.notice,
      noticeKind:
        event.type === "failed" || event.type === "interrupted" ? "error" : current.noticeKind,
    }));
  }, []);

  const openStream = useCallback(() => {
    const id = runId.current;
    if (!id) return;

    closeStream();
    const from = cursor.current;
    openedFrom.current = from;
    setView((current) => ({
      ...current,
      connection: attempt.current === 0 ? "connecting" : "reconnecting",
      attempt: attempt.current,
      reconnectCursor: from,
    }));

    const stream = new EventSource(`/api/runs/${id}/events?after=${from}`);
    source.current = stream;

    stream.onopen = () => {
      attempt.current = 0;
      armWatchdog();
      setView((current) => ({
        ...current,
        connection: "connected",
        attempt: 0,
        notice: current.noticeKind === "error" ? current.notice : null,
      }));
    };

    const frameTypes = [
      "state",
      "ping",
      "chunk",
      "completed",
      "failed",
      "interrupted",
      "reset",
    ] as const;

    for (const type of frameTypes) {
      stream.addEventListener(type, (message) => {
        armWatchdog(); // any frame proves the connection is alive
        const data = JSON.parse((message as MessageEvent).data);

        switch (type) {
          case "state":
          case "ping": {
            // The server's own view of the run. Carries no seq, so the cursor
            // is untouched. Its lastSeq marks where replay ends and live
            // delivery begins on this connection.
            const frame = data as ControlFrame;
            if (type === "state") {
              status.current = frame.status;
              replayBoundary.current = frame.lastSeq;
              setView((current) => ({
                ...current,
                status: frame.status,
                replayBoundary: frame.lastSeq,
              }));
            }
            return;
          }
          case "reset":
            // The server dropped us to protect the generator. Come straight
            // back from the cursor.
            closeStream();
            setView((current) => ({
              ...current,
              notice: "Server asked us to reconnect — this connection fell behind.",
              noticeKind: "warning",
            }));
            openRef.current();
            return;
          default:
            applyEvent(data as RunEvent);
            if (type !== "chunk") {
              closeStream();
              setView((current) => ({ ...current, connection: "idle" }));
            }
        }
      });
    }

    stream.onerror = () => handleConnectionLoss("Connection to the server was lost.");
  }, [applyEvent, armWatchdog, closeStream, handleConnectionLoss]);

  /**
   * Before resuming, ask the server what it actually has. If our cursor is
   * ahead of the stored history — a different server, a wiped database — we
   * restart this reply from zero instead of showing content that can never be
   * completed. This is the explicit, recoverable answer to a stale cursor.
   */
  const resumeFromDurableState = useCallback(async () => {
    const id = runId.current;
    if (!id) return;
    try {
      const run = await fetchRun(id);
      if (cursor.current > run.lastSeq) {
        cursor.current = 0;
        setView((current) => ({
          ...current,
          cursor: 0,
          text: "",
          log: [],
          duplicatesSuppressed: 0,
          notice:
            "Our cursor was ahead of the server's history — replaying this reply from the start.",
          noticeKind: "warning",
        }));
      }
    } catch {
      // Still unreachable; opening the stream will fail and retry again.
    }
    openStream();
  }, [openStream]);

  useEffect(() => {
    resumeRef.current = () => void resumeFromDurableState();
    openRef.current = openStream;
  }, [resumeFromDurableState, openStream]);

  /** Sends a message and starts following its reply. */
  const send = useCallback(
    async (text: string, failAfter: number) => {
      closeStream();
      cursor.current = 0;
      attempt.current = 0;
      status.current = "running";
      replayBoundary.current = 0;
      pausedByUser.current = false;
      setView({
        ...initialView,
        prompt: text,
        promptAt: Date.now(),
        connection: "connecting",
        status: "running",
      });

      try {
        const result = await sendMessage(conversationId, text, failAfter);
        runId.current = result.runId;
        setView((current) => ({ ...current, runId: result.runId }));
        openStream();
      } catch (error) {
        setView((current) => ({
          ...current,
          connection: "disconnected",
          notice: `Could not start the reply: ${(error as Error).message}`,
          noticeKind: "error",
        }));
      }
    },
    [closeStream, conversationId, openStream],
  );

  /** Demo control: pretend the network died. The server keeps generating. */
  const dropConnection = useCallback(() => {
    pausedByUser.current = true;
    closeStream();
    setView((current) => ({
      ...current,
      connection: "disconnected",
      lastDisconnectedAt: cursor.current,
      cutByUser: true,
      notice: `Disconnected at event ${cursor.current} — the server is still generating. Press Reconnect to continue.`,
      noticeKind: "warning",
    }));
  }, [closeStream]);

  /** Demo control: come back and resume from the cursor. */
  const reconnect = useCallback(() => {
    pausedByUser.current = false;
    attempt.current = 0;
    setView((current) => ({ ...current, cutByUser: false }));
    void resumeFromDurableState();
  }, [resumeFromDurableState]);

  useEffect(() => closeStream, [closeStream]);

  return { view, send, dropConnection, reconnect };
}
