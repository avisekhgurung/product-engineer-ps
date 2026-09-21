package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/caygnus-challenge/resumable-chat/internal/api"
	"github.com/caygnus-challenge/resumable-chat/internal/generator"
	"github.com/caygnus-challenge/resumable-chat/internal/hub"
	"github.com/caygnus-challenge/resumable-chat/internal/runner"
	"github.com/caygnus-challenge/resumable-chat/internal/sseclient"
	"github.com/caygnus-challenge/resumable-chat/internal/store"
)

// liveInterval is small but non-zero: long enough that a test can disconnect
// while the run is still producing, short enough that no test waits on a
// meaningful amount of wall-clock time.
const liveInterval = 2 * time.Millisecond

// harness is one server instance backed by a SQLite file on disk, so a test can
// stop it and start another one over the same durable state.
type harness struct {
	t      *testing.T
	dbPath string
	store  *store.Store
	runner *runner.Runner
	server *httptest.Server
	cancel context.CancelFunc
}

func newHarness(t *testing.T, dbPath string, interval time.Duration) *harness {
	t.Helper()
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	if _, err := st.RecoverInterruptedRuns(); err != nil {
		t.Fatalf("recover runs: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	h := hub.New()
	r := runner.New(st, h, interval)
	srv := httptest.NewServer(api.New(ctx, st, h, r))

	return &harness{t: t, dbPath: dbPath, store: st, runner: r, server: srv, cancel: cancel}
}

// stop imitates the process going away: generation stops where it is and
// nothing rewrites the durable history on the way out.
func (h *harness) stop() {
	h.cancel()
	h.runner.Wait()
	h.server.Close()
	h.store.Close()
}

func (h *harness) send(text string, failAfter int) string {
	h.t.Helper()
	body, err := json.Marshal(map[string]any{
		"conversationId": "conv_test",
		"messageId":      fmt.Sprintf("msg_%d", time.Now().UnixNano()),
		"text":           text,
		"failAfter":      failAfter,
	})
	if err != nil {
		h.t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(h.server.URL+"/api/messages", "application/json", strings.NewReader(string(body)))
	if err != nil {
		h.t.Fatalf("post message: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		h.t.Fatalf("post message: status %d", resp.StatusCode)
	}
	var out struct {
		RunID string `json:"runId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		h.t.Fatalf("decode: %v", err)
	}
	return out.RunID
}

func (h *harness) connect(runID string, after int64) *sseclient.Stream {
	h.t.Helper()
	s, err := sseclient.Connect(context.Background(), h.server.URL, runID, after)
	if err != nil {
		h.t.Fatalf("connect after=%d: %v", after, err)
	}
	return s
}

func (h *harness) runState(runID string) store.Run {
	h.t.Helper()
	resp, err := http.Get(h.server.URL + "/api/runs/" + runID)
	if err != nil {
		h.t.Fatalf("get run: %v", err)
	}
	defer resp.Body.Close()
	var run store.Run
	if err := json.NewDecoder(resp.Body).Decode(&run); err != nil {
		h.t.Fatalf("decode run: %v", err)
	}
	return run
}

// readAll consumes a stream to its end and returns the events it carried.
// Control frames (state, reset) are reported separately because they carry no
// sequence number and must never affect the client's cursor.
func readAll(t *testing.T, s *sseclient.Stream, maxEvents int) (events []store.Event, control []string) {
	t.Helper()
	for len(events) <= maxEvents {
		frame, err := s.Next()
		if err != nil {
			if errors.Is(err, io.EOF) || strings.Contains(err.Error(), "closed") {
				return events, control
			}
			t.Fatalf("read frame: %v", err)
		}
		if frame.Seq == 0 {
			control = append(control, frame.Event)
			continue
		}
		var ev store.Event
		if err := json.Unmarshal(frame.Data, &ev); err != nil {
			t.Fatalf("decode frame data: %v", err)
		}
		events = append(events, ev)
		if ev.Terminal() {
			return events, control
		}
	}
	t.Fatalf("stream produced more than %d events", maxEvents)
	return nil, nil
}

// readN consumes exactly n chunk events, then leaves the stream open.
func readN(t *testing.T, s *sseclient.Stream, n int) []store.Event {
	t.Helper()
	var events []store.Event
	for len(events) < n {
		frame, err := s.Next()
		if err != nil {
			t.Fatalf("read frame: %v", err)
		}
		if frame.Seq == 0 {
			continue
		}
		var ev store.Event
		if err := json.Unmarshal(frame.Data, &ev); err != nil {
			t.Fatalf("decode frame data: %v", err)
		}
		if ev.Terminal() {
			t.Fatalf("run ended after %d events, wanted %d chunks first", len(events), n)
		}
		events = append(events, ev)
	}
	return events
}

// assertContiguous checks the ordering contract: sequence numbers start just
// after the cursor, increase by exactly one, and never repeat.
func assertContiguous(t *testing.T, events []store.Event, after int64) {
	t.Helper()
	want := after + 1
	for _, ev := range events {
		if ev.Seq != want {
			t.Fatalf("out-of-order or duplicate event: got seq %d, want %d", ev.Seq, want)
		}
		want++
	}
}

func text(events []store.Event) string {
	var b strings.Builder
	for _, ev := range events {
		b.WriteString(ev.Text)
	}
	return b.String()
}

func dbFile(t *testing.T) string { return filepath.Join(t.TempDir(), "test.db") }

// AC1: a live stream arrives in order, exactly once, and reaches completed.
func TestLiveStreamIsOrderedAndCompletes(t *testing.T) {
	h := newHarness(t, dbFile(t), liveInterval)
	defer h.stop()

	const prompt = "hello there"
	runID := h.send(prompt, 0)
	stream := h.connect(runID, 0)
	defer stream.Close()

	events, control := readAll(t, stream, 500)
	assertContiguous(t, events, 0)

	last := events[len(events)-1]
	if last.Type != store.EventCompleted {
		t.Fatalf("last event = %q, want %q", last.Type, store.EventCompleted)
	}
	if got := text(events); got != generator.Reply(prompt) {
		t.Fatalf("reconstructed text does not match generator output:\n got: %q\nwant: %q", got, generator.Reply(prompt))
	}
	if len(control) == 0 || control[0] != "state" {
		t.Fatalf("expected a leading state frame, got %v", control)
	}
	if run := h.runState(runID); run.Status != store.StatusCompleted {
		t.Fatalf("run status = %q, want %q", run.Status, store.StatusCompleted)
	}
}

// AC2 (replay half): a client that arrives late gets everything after its
// cursor and nothing before it.
func TestReplayAfterCursor(t *testing.T) {
	h := newHarness(t, dbFile(t), 0)
	defer h.stop()

	const prompt = "replay please"
	runID := h.send(prompt, 0)
	h.runner.Wait() // the whole reply is now durable

	const cursor = 10
	stream := h.connect(runID, cursor)
	defer stream.Close()

	events, _ := readAll(t, stream, 500)
	assertContiguous(t, events, cursor)

	full := generator.Chunks(prompt)
	if got, want := text(events), strings.Join(full[cursor:], ""); got != want {
		t.Fatalf("replay text mismatch:\n got: %q\nwant: %q", got, want)
	}
}

// AC2 (recovery half): the run keeps producing while the client is away, and
// the reconnect neither loses nor repeats content.
func TestReconnectRecoversMissedEvents(t *testing.T) {
	h := newHarness(t, dbFile(t), liveInterval)
	defer h.stop()

	const prompt = "drop me"
	runID := h.send(prompt, 0)

	first := h.connect(runID, 0)
	seen := readN(t, first, 5)
	first.Close() // the generator carries on without a listener
	assertContiguous(t, seen, 0)

	cursor := seen[len(seen)-1].Seq
	second := h.connect(runID, cursor)
	defer second.Close()

	rest, _ := readAll(t, second, 500)
	assertContiguous(t, rest, cursor)

	if got := text(seen) + text(rest); got != generator.Reply(prompt) {
		t.Fatalf("text after reconnect does not match:\n got: %q\nwant: %q", got, generator.Reply(prompt))
	}
	if last := rest[len(rest)-1]; last.Type != store.EventCompleted {
		t.Fatalf("run ended as %q, want completed", last.Type)
	}
}

// AC3: reconnecting with a deliberately stale cursor makes replay and live
// delivery overlap. Each sequence number must still be delivered once.
func TestReplayAndLiveDoNotOverlap(t *testing.T) {
	h := newHarness(t, dbFile(t), liveInterval)
	defer h.stop()

	const prompt = "overlap check"
	runID := h.send(prompt, 0)

	first := h.connect(runID, 0)
	seen := readN(t, first, 8)
	first.Close()

	// Rewind three events: the server must replay them from the store and
	// then continue live without repeating the handover point.
	cursor := seen[len(seen)-1].Seq - 3
	second := h.connect(runID, cursor)
	defer second.Close()

	rest, _ := readAll(t, second, 500)
	assertContiguous(t, rest, cursor)

	seqs := map[int64]int{}
	for _, ev := range rest {
		seqs[ev.Seq]++
		if seqs[ev.Seq] > 1 {
			t.Fatalf("event %d delivered twice on one connection", ev.Seq)
		}
	}
	if got := text(seen[:cursor]) + text(rest); got != generator.Reply(prompt) {
		t.Fatalf("deduplicated text mismatch:\n got: %q\nwant: %q", got, generator.Reply(prompt))
	}
}

// AC5: a generator failure after partial output is terminal, keeps its
// history, and can never turn into a completed run.
func TestGeneratorFailureIsTerminalAndInspectable(t *testing.T) {
	h := newHarness(t, dbFile(t), 0)
	defer h.stop()

	const failAfter = 5
	runID := h.send("fail midway", failAfter)
	h.runner.Wait()

	stream := h.connect(runID, 0)
	defer stream.Close()
	events, _ := readAll(t, stream, 500)
	assertContiguous(t, events, 0)

	if got := len(events); got != failAfter+1 {
		t.Fatalf("got %d events, want %d chunks plus one failure event", got, failAfter+1)
	}
	last := events[len(events)-1]
	if last.Type != store.EventFailed {
		t.Fatalf("last event = %q, want %q", last.Type, store.EventFailed)
	}
	if last.Reason == "" {
		t.Fatal("failure event carries no reason")
	}
	if run := h.runState(runID); run.Status != store.StatusFailed {
		t.Fatalf("run status = %q, want %q", run.Status, store.StatusFailed)
	}
	// The run cannot be talked into success afterwards.
	if _, err := h.store.Finish(runID, store.StatusCompleted, ""); !errors.Is(err, store.ErrRunTerminal) {
		t.Fatalf("Finish(completed) on a failed run = %v, want ErrRunTerminal", err)
	}
}

// AC4: after a restart the durable history is intact and the abandoned run is
// reported as interrupted instead of silently pending or falsely completed.
func TestRestartRecoversDurableState(t *testing.T) {
	path := dbFile(t)
	first := newHarness(t, path, 20*time.Millisecond)

	const prompt = "restart me"
	runID := first.send(prompt, 0)
	stream := first.connect(runID, 0)
	seen := readN(t, stream, 3)
	stream.Close()
	first.stop() // process dies mid-reply

	second := newHarness(t, path, 20*time.Millisecond)
	defer second.stop()

	run := second.runState(runID)
	if run.Status != store.StatusInterrupted {
		t.Fatalf("run status after restart = %q, want %q", run.Status, store.StatusInterrupted)
	}

	cursor := seen[len(seen)-1].Seq
	resumed := second.connect(runID, cursor)
	defer resumed.Close()
	rest, _ := readAll(t, resumed, 500)
	assertContiguous(t, rest, cursor)

	last := rest[len(rest)-1]
	if last.Type != store.EventInterrupted {
		t.Fatalf("last event = %q, want %q", last.Type, store.EventInterrupted)
	}
	// Whatever survived must be a prefix of the real reply: no invented text.
	if got := text(seen) + text(rest); !strings.HasPrefix(generator.Reply(prompt), got) {
		t.Fatalf("recovered text is not a prefix of the expected reply: %q", got)
	}
}

// AC6: a cursor the server cannot honour produces an explicit, recoverable
// answer rather than a stream with a hole in it.
func TestUnknownOrStaleCursorIsExplicit(t *testing.T) {
	h := newHarness(t, dbFile(t), 0)
	defer h.stop()

	runID := h.send("cursor rules", 0)
	h.runner.Wait()

	_, err := sseclient.Connect(context.Background(), h.server.URL, runID, 9999)
	var conflict *sseclient.Conflict
	if !errors.As(err, &conflict) {
		t.Fatalf("connect with future cursor = %v, want a 409 conflict", err)
	}
	if conflict.LastSeq == 0 || conflict.ErrorCode != "cursor_unavailable" {
		t.Fatalf("conflict body unhelpful: %+v", conflict)
	}

	resp, err := http.Get(h.server.URL + "/api/runs/" + runID + "/events?after=-4")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("negative cursor status = %d, want 400", resp.StatusCode)
	}

	resp2, err := http.Get(h.server.URL + "/api/runs/run_missing/events?after=0")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown run status = %d, want 404", resp2.StatusCode)
	}
}

// Reconnecting at the very end of a finished run has nothing left to replay.
// The server must close the stream instead of holding it open for live events
// that can never arrive.
func TestReconnectAtEndOfFinishedRunClosesStream(t *testing.T) {
	h := newHarness(t, dbFile(t), 0)
	defer h.stop()

	runID := h.send("already done", 0)
	h.runner.Wait()
	last := h.runState(runID).LastSeq

	stream := h.connect(runID, last)
	defer stream.Close()

	done := make(chan error, 1)
	go func() {
		for {
			frame, err := stream.Next()
			if err != nil {
				done <- err
				return
			}
			if frame.Seq != 0 {
				done <- fmt.Errorf("unexpected event %d after the terminal event", frame.Seq)
				return
			}
		}
	}()

	select {
	case err := <-done:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("stream ended with %v, want a clean EOF", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream stayed open after the run's terminal event was already delivered")
	}
}

// A retried send must not start a second reply for the same message.
func TestSendIsIdempotentPerMessageID(t *testing.T) {
	h := newHarness(t, dbFile(t), 0)
	defer h.stop()

	body := `{"conversationId":"conv_test","messageId":"msg_fixed","text":"only once"}`
	var runIDs []string
	for i := 0; i < 2; i++ {
		resp, err := http.Post(h.server.URL+"/api/messages", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		var out struct {
			RunID   string `json:"runId"`
			Created bool   `json:"created"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		resp.Body.Close()
		if i == 1 && out.Created {
			t.Fatal("second send with the same messageId created a new run")
		}
		runIDs = append(runIDs, out.RunID)
	}
	if runIDs[0] != runIDs[1] {
		t.Fatalf("same message produced two runs: %q and %q", runIDs[0], runIDs[1])
	}
}
