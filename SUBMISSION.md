# Product Engineering Challenge Submission

## Candidate

- **Name:** _TODO: your full name_
- **Email:** _TODO: your email_
- **GitHub:** _TODO: link to your fork_
- **Selected problem:** Problem 1 — Resumable Realtime Conversation
- **Demo video:** _TODO: paste the Loom / YouTube / Drive link here (must be viewable by anyone with the link)_

## Run the project

**Prerequisites:** Go 1.22 or newer (built with 1.27) and Node 20 or newer (built with 22). No API keys, no Docker, no external services. SQLite is embedded through a pure-Go driver, so there is nothing to install or run separately.

```bash
# terminal 1 — API on :8080
cd server && go run ./cmd/server

# terminal 2 — UI on :5173 (its dev server proxies /api to :8080)
cd web && npm install && npm run dev
```

Then open <http://localhost:5173>.

Useful flags: `go run ./cmd/server -db chat.db -addr :8080 -chunk-interval 120ms`. A slower
`-chunk-interval` gives you more time to interrupt the stream by hand.

### Successful scenario

1. Press **Send**. The reply streams in word by word. A banner states in plain words what is happening, and a three-step guide shows where you are.
2. Let it finish. The banner says "Done — nothing missing, nothing repeated", and the proof row shows the word count, 0 missing, and order correct. Open **Under the hood** for the numbered event log (each event's sequence number, type and LIVE/REPLAYED source) and the integrity checks.

### Failure and recovery scenarios

| Scenario | How to trigger it |
| --- | --- |
| **Reconnect mid-reply** | Press **Send**, then **Cut the internet**, wait a few seconds, then **Turn internet back on**. Generation continued while you were away; the words you missed come back first (highlighted in the reply), then live delivery resumes with no repeated or missing words. |
| **Generator failure after partial output** | Tick **Simulate a server error halfway**, then **Send**. The run ends as `failed` after 12 chunks, keeps its history, and can never become `completed`. |
| **Service restart mid-reply** | Press **Send**, then stop the server with Ctrl+C and start it again. The banner says the connection was lost and shows retry attempts with bounded backoff; on startup the server reports `marked 1 in-flight run(s) as interrupted` and the client resumes to a terminal `interrupted` state rather than a stale "still running" screen. |
| **Stale cursor** | `curl -i "localhost:8080/api/runs/<runId>/events?after=99999"` returns `409` with `{"error":"cursor_unavailable","lastSeq":N}`. The UI handles the same case by checking durable run state before resuming and replaying from 0 when its cursor is ahead of history. |

## Run the tests

```bash
cd server && go test -race ./...
```

Everything is deterministic: a scripted generator, no model API, no arbitrary sleeps
(the longest wait in the suite is a 20 ms-per-chunk run used by the restart test).

## Acceptance scenarios and verification

| AC | Status | Where it is proven |
| --- | --- | --- |
| AC1 ordered live stream | Done | `TestLiveStreamIsOrderedAndCompletes` |
| AC2 missed-event recovery | Done | `TestReconnectRecoversMissedEvents`, `TestReplayAfterCursor` |
| AC3 replay/live overlap | Done | `TestReplayAndLiveDoNotOverlap` (reconnects with a deliberately rewound cursor) |
| AC4 service restart | Done | `TestRestartRecoversDurableState`, `TestRecoverInterruptedRunsAcrossReopen` |
| AC5 generation failure | Done | `TestGeneratorFailureIsTerminalAndInspectable`, `TestFinishHappensOnlyOnce` |
| AC6 unknown or stale cursor | Done | `TestUnknownOrStaleCursorIsExplicit` (409 for a future cursor, 400 for a malformed one, 404 for an unknown run) |
| Reconnect at end of a finished run | Done | `TestReconnectAtEndOfFinishedRunClosesStream` (found during manual testing: the server used to hold that stream open forever) |

**AC4 policy:** an interrupted generator does **not** resume. On startup every run still
marked `running` is moved to `interrupted` and given a terminal `interrupted` event. The
durable history stays correct and the client is told plainly that the reply ended early.
Resuming generation would mean restarting a model call from a partial prefix, which is a
product decision rather than a protocol one, so it is deliberately out of scope here.

### Verification benchmark

```bash
cd server && go run ./cmd/bench
```

It starts a real server in-process, streams one run, disconnects twice while generation is
still active, resumes from the client's cursor each time, and compares the reconstructed
reply against the generator's own output.

Observed output on this machine:

```
Resumable realtime conversation — verification benchmark
  expected events : 91 chunks + 1 terminal
  chunk interval  : 15ms

  interruption 1 : disconnected at seq 6, staying away 150ms
  interruption 2 : disconnected at seq 18, staying away 150ms

  reconnects      : 2
  events delivered: 91
  unique events   : 91 (expected 91)
  missing events  : 0
  duplicate events: 0
  terminal event  : completed
  final run state : completed (lastSeq 92)

  reply matches generator output exactly.
PASS: 91 events, 0 missing, 0 duplicates, state=completed
```

The command exits non-zero if a single event is missing, duplicated, or out of order.

## Architecture and data flow

```
browser (React + TypeScript)                  Go service
┌──────────────────────────────┐              ┌───────────────────────────────────────┐
│ App.tsx        view only     │  POST        │ api      HTTP + SSE framing           │
│ useRun.ts      cursor,       │─ /api/... ──▶│ runner   drives one reply             │
│                connection    │              │ generator deterministic fake model    │
│                state machine │◀─ SSE ───────│ hub      live fan-out (disposable)    │
└──────────────────────────────┘  id: <seq>   │ store    SQLite: runs + run_events    │
                                              └───────────────────────────────────────┘
```

- **store** owns identity, ordering and the run state machine. It assigns every event a
  gapless `seq` inside a transaction, and terminal transitions are guarded by
  `UPDATE runs SET status = ? WHERE id = ? AND status = 'running'`, so exactly one terminal
  state can ever win.
- **runner** is the only writer of a run's events. For each chunk it **stores first, then
  publishes**. A live listener can therefore never see an event that a reconnecting client
  would fail to find in history.
- **hub** is in-memory pub/sub for currently connected clients. It is deliberately
  disposable: losing a subscription loses nothing, because the store has everything. A
  subscriber that cannot keep up is dropped with a `reset` frame instead of blocking the
  generator.
- **api** frames events as SSE. The stream handler subscribes to the hub *before* reading
  history, replays stored events after the cursor, then switches to live and skips anything
  replay already covered.
- **useRun** holds the client cursor, ignores any event at or below it, and runs the
  connection state machine (`connecting → connected → reconnecting → disconnected`) with
  bounded exponential backoff and a silence watchdog.

### What the UI derives, and how

The screen is driven only by `useRun` state and by numbers computed from events that actually
arrived (`web/src/metrics.ts`). Nothing is hardcoded and the server sends no extra data for it.

- **LIVE / REPLAYED badge:** the `state` frame the server sends when a stream opens carries the
  run's durable `lastSeq`. Events at or below it were already stored, so they arrive as replay;
  events above it were produced after the connection opened, so they are live.
- **Missing / Duplicates / Ordering:** missing is any sequence at or below the cursor that the
  log does not hold; duplicates counts deliveries the client dropped because it already held
  that sequence; ordering checks the log is strictly increasing.
- **Timestamps** are the time the event reached this client, not server time.

Limit worth knowing: "events expected" is the highest sequence the client has seen, so it can
detect holes *inside* the stream but not a truncated tail. The terminal event is what tells the
client the tail is complete.

### The protocol in one paragraph

`POST /api/messages` takes a client-generated `messageId` and returns a `runId`
(retrying the same `messageId` returns the same run instead of starting a second reply).
`GET /api/runs/{runId}/events?after=<seq>` is an SSE stream: each event carries
`id: <seq>` plus a typed payload (`chunk`, `completed`, `failed`, `interrupted`). Control
frames (`state`, `ping`, `reset`) carry no `id`, so they can never move the cursor. A
cursor ahead of stored history is answered with `409 cursor_unavailable` and the server's
`lastSeq`, never with a stream that silently skips content.

## Technology choices

**Go + net/http, no web framework.** Caygnus works in Go, and this problem is mostly
concurrency and state: goroutines, channels and `context` are the language's strengths, and
`net/http` with Go 1.22 pattern routing covers three endpoints without a dependency.

**SQLite via `modernc.org/sqlite`** (pure Go, no cgo): durability across restarts is a hard
requirement here, and this is a single file with no service to install — important for a
reviewer's ten-minute setup. Transactions give me atomic "assign sequence, append event,
update state", which is the core correctness primitive.

**SSE rather than WebSockets.** The reply only travels server → client, so a duplex
protocol would add framing, ping/pong and reconnect code I would have to write and test
myself. SSE is plain HTTP, resumable by design (`Last-Event-ID`, which this server accepts
alongside the explicit `?after=` query parameter), and easy to inspect with `curl`. The
trade-off: no client → server channel on the same connection, so cancellation would need a
separate `POST` — acceptable, since cancellation is out of scope.

**React + TypeScript + Vite** for the client, because the interesting part is client state
and types across the wire, and Vite's proxy keeps the browser on a single origin.

Alternatives considered: Postgres plus `LISTEN/NOTIFY` (better for multiple servers, worse
for a ten-minute setup), Redis Streams for fan-out (an extra service for something the
store already does correctly), and WebSockets (justified once the client needs to send
during a run).

## Important decisions

1. **The database defines order; the connection only delivers it.** Sequence numbers are
   assigned in a transaction and events are stored before they are published. That single
   rule is what makes replay, live delivery and restart recovery agree with each other.
2. **Subscribe before replaying, then skip what replay already covered.** The reconnect
   race — an event produced between "read history" and "start listening" — is closed by
   ordering those two steps and deduplicating on `seq` at the handover. The client
   deduplicates again on its own cursor, so a duplicate can never reach the screen.
3. **A restart is reported, not hidden.** Runs left `running` by a dead process become
   `interrupted` with a terminal event. Combined with the terminal-state guard, a run that
   failed or was interrupted can never later be presented as completed.
4. **Silence counts as a failure.** Native `EventSource` reconnects silently and
   indefinitely, and a proxy can hold a socket open after the upstream dies — which is
   exactly what happened during development: the UI kept showing `connected` after the
   server was killed. The server now emits a `ping` event every 5s and the client treats
   12s of silence as a lost connection, so connection state is honest.

## Assumptions and limitations

- **Single server process.** Ordering and the hub assume one writer per run. Multiple
  servers would need the fan-out moved out of process (Redis or Postgres notifications);
  the store's sequence assignment would still be the ordering authority.
- **One in-flight run per conversation** — the challenge places multiple simultaneous runs
  out of scope. Conversations are not listed or persisted across page reloads in the UI;
  the durable history is per run, and the UI follows the run it started.
- **`SetMaxOpenConns(1)`** on SQLite keeps writes serialized and avoids lock errors. It is
  the right trade for a prototype and the wrong one for throughput; WAL plus a per-run lock
  is the next step.
- **History is unbounded.** Nothing expires yet. In production I would keep a run's events
  for a short window (say 24 h), return `409 cursor_unavailable` with the oldest available
  sequence when a client asks for something older, and have the client restart that reply
  from the last durable snapshot rather than from token 0.
- **No authentication, no rate limiting, no multi-tenancy**, per the brief.
- The `failAfter` field on `POST /api/messages` is a deliberate test hook for demonstrating
  the failure path; a real deployment would not expose it.

## Production and scale

What the submitted code does now: one process, one SQLite file, in-memory fan-out, unbounded
history, no auth.

What I would change first, in order:

1. **Retention and cursor expiry.** Events are the biggest table and the only unbounded one.
   Add a TTL plus an `oldestSeq` per run, and make `409` carry it so clients recover
   predictably instead of hanging on a cursor nobody can serve.
2. **Move fan-out out of process** (Redis Streams or Postgres `LISTEN/NOTIFY`) so any
   instance can serve a reconnect, and put the generator behind a work queue so a crashed
   worker's run can be retried or explicitly failed rather than only marked interrupted.
3. **Back-pressure and limits**: cap concurrent runs per conversation, bound event size, and
   surface the lag-drop path (`reset` frames) as a metric rather than only a log line.
4. **Observability**: one trace per run with the terminal state, the number of reconnects
   and replayed events; alert on runs that end `interrupted` at an unusual rate, since that
   is the signal that deploys are killing in-flight replies.
5. **Real provider integration** behind the same `generator` seam, with the decision made
   explicitly about whether an interrupted generation resumes from its prefix or fails.

## AI usage

_Review and edit this section so it matches what you actually did._

I used Claude (Claude Code) as a pair programmer for this submission. It helped scaffold the
Go packages, the React client and the test suite from a design we worked through together. I
reviewed every file, ran the tests and the benchmark locally, and drove the manual scenarios
(drop/reconnect, generator failure, killing and restarting the server) in the browser myself.
One real bug came out of that manual testing rather than the AI's first draft: the client
kept showing `connected` after the server was killed, because the dev proxy held the socket
open and `EventSource` never fired an error. The `ping` event and the client-side silence
watchdog were added in response, and that path is now part of the documented demo.

## Credibility note

_TODO — write this yourself, it is required. Cover:_

- _The problem the product solved_
- _Your personal contribution_
- _Scale or operational complexity (users, traffic, data volume, uptime, cost — approximate
  figures are fine)_
- _One difficult engineering or product decision you made, and why you chose as you did_
- _A public link, repository or case study if you have one_
