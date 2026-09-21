package store_test

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/caygnus-challenge/resumable-chat/internal/store"
)

func open(t *testing.T, path string) *store.Store {
	t.Helper()
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestAppendAssignsGaplessSequence(t *testing.T) {
	st := open(t, ":memory:")
	run, created, err := st.StartRun("conv", "msg", "hi", 0)
	if err != nil || !created {
		t.Fatalf("StartRun: %v (created=%v)", err, created)
	}

	for i := int64(1); i <= 5; i++ {
		ev, err := st.AppendChunk(run.ID, "x")
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		if ev.Seq != i {
			t.Fatalf("append %d got seq %d", i, ev.Seq)
		}
	}
	events, err := st.EventsAfter(run.ID, 2, 100)
	if err != nil {
		t.Fatalf("EventsAfter: %v", err)
	}
	if len(events) != 3 || events[0].Seq != 3 {
		t.Fatalf("EventsAfter(2) = %d events starting at %d, want 3 starting at 3", len(events), events[0].Seq)
	}
}

// Only one terminal transition may win, and a finished run stays finished.
func TestFinishHappensOnlyOnce(t *testing.T) {
	st := open(t, ":memory:")
	run, _, err := st.StartRun("conv", "msg", "hi", 0)
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if _, err := st.AppendChunk(run.ID, "partial"); err != nil {
		t.Fatalf("append: %v", err)
	}

	failEvent, err := st.Finish(run.ID, store.StatusFailed, "boom")
	if err != nil {
		t.Fatalf("first Finish: %v", err)
	}
	if failEvent.Type != store.EventFailed || failEvent.Seq != 2 {
		t.Fatalf("terminal event = %+v, want failed at seq 2", failEvent)
	}

	if _, err := st.Finish(run.ID, store.StatusCompleted, ""); !errors.Is(err, store.ErrRunTerminal) {
		t.Fatalf("second Finish = %v, want ErrRunTerminal", err)
	}
	if _, err := st.AppendChunk(run.ID, "late"); !errors.Is(err, store.ErrRunTerminal) {
		t.Fatalf("append after terminal = %v, want ErrRunTerminal", err)
	}

	got, err := st.Run(run.ID)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got.Status != store.StatusFailed || got.LastSeq != 2 {
		t.Fatalf("run = %+v, want failed with lastSeq 2", got)
	}
}

// A run left running by a dead process is closed as interrupted on the next
// startup, and its stored chunks survive.
func TestRecoverInterruptedRunsAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recover.db")

	first, err := store.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	run, _, err := first.StartRun("conv", "msg", "hi", 0)
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := first.AppendChunk(run.ID, "chunk "); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	first.Close() // process dies here

	second := open(t, path)
	recovered, err := second.RecoverInterruptedRuns()
	if err != nil {
		t.Fatalf("RecoverInterruptedRuns: %v", err)
	}
	if len(recovered) != 1 || recovered[0] != run.ID {
		t.Fatalf("recovered = %v, want [%s]", recovered, run.ID)
	}

	got, err := second.Run(run.ID)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got.Status != store.StatusInterrupted {
		t.Fatalf("status = %q, want interrupted", got.Status)
	}
	events, err := second.EventsAfter(run.ID, 0, 100)
	if err != nil {
		t.Fatalf("EventsAfter: %v", err)
	}
	if len(events) != 4 || events[3].Type != store.EventInterrupted {
		t.Fatalf("history = %+v, want 3 chunks plus an interrupted event", events)
	}

	// Running recovery again must not append a second terminal event.
	if again, err := second.RecoverInterruptedRuns(); err != nil || len(again) != 0 {
		t.Fatalf("second recovery = %v, %v; want no work", again, err)
	}
}

func TestStartRunIsIdempotent(t *testing.T) {
	st := open(t, ":memory:")

	first, created, err := st.StartRun("conv", "msg_1", "hi", 0)
	if err != nil || !created {
		t.Fatalf("first StartRun: %v (created=%v)", err, created)
	}
	second, created, err := st.StartRun("conv", "msg_1", "hi", 0)
	if err != nil {
		t.Fatalf("second StartRun: %v", err)
	}
	if created {
		t.Fatal("second StartRun reported a new run for the same message id")
	}
	if second.ID != first.ID {
		t.Fatalf("run ids differ: %q vs %q", first.ID, second.ID)
	}
}
