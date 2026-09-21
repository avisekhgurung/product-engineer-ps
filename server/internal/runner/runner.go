// Package runner drives one generated reply from start to terminal state.
//
// It is the only component that writes a run's events. It stores each chunk
// first and publishes it second, so a live listener can never see an event that
// a reconnecting client would fail to find in history.
package runner

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/caygnus-challenge/resumable-chat/internal/generator"
	"github.com/caygnus-challenge/resumable-chat/internal/hub"
	"github.com/caygnus-challenge/resumable-chat/internal/store"
)

// Runner starts replies and tracks the goroutines producing them.
type Runner struct {
	store *store.Store
	hub   *hub.Hub
	// interval is the pause between chunks. Tests set it to zero so no test
	// depends on wall-clock sleeping.
	interval time.Duration
	wg       sync.WaitGroup
}

// New creates a runner.
func New(st *store.Store, h *hub.Hub, interval time.Duration) *Runner {
	return &Runner{store: st, hub: h, interval: interval}
}

// Start generates the reply for a run in the background.
//
// ctx is the server's lifetime. When the server shuts down, generation stops
// where it is and the run stays `running` in the database; the next startup
// closes it as `interrupted`. Pretending a killed process completed its work
// would be the dishonest alternative.
func (r *Runner) Start(ctx context.Context, run store.Run, prompt string) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		r.generate(ctx, run, prompt)
	}()
}

// Wait blocks until every in-flight generation has stopped. Used by shutdown
// and by tests that need the run to settle.
func (r *Runner) Wait() { r.wg.Wait() }

func (r *Runner) generate(ctx context.Context, run store.Run, prompt string) {
	chunks := generator.Chunks(prompt)

	for i, chunk := range chunks {
		if r.interval > 0 {
			select {
			case <-ctx.Done():
				return // shutdown: leave the run for restart recovery
			case <-time.After(r.interval):
			}
		} else if ctx.Err() != nil {
			return
		}

		// Demo knob: fail after N chunks so the failure path is easy to show.
		if run.FailAfter > 0 && i >= run.FailAfter {
			r.finish(run.ID, store.StatusFailed, "generator failed after partial output")
			return
		}

		ev, err := r.store.AppendChunk(run.ID, chunk)
		if err != nil {
			// The run ended underneath us (restart recovery, for example).
			// Stop instead of forcing more events into a closed history.
			if !errors.Is(err, store.ErrRunTerminal) {
				log.Printf("run %s: append failed: %v", run.ID, err)
			}
			return
		}
		r.hub.Publish(run.ID, ev)
	}

	r.finish(run.ID, store.StatusCompleted, "")
}

// finish applies the terminal state. The store decides who wins if two
// terminal transitions race; a loser simply stops.
func (r *Runner) finish(runID string, status store.RunStatus, reason string) {
	ev, err := r.store.Finish(runID, status, reason)
	if err != nil {
		if !errors.Is(err, store.ErrRunTerminal) {
			log.Printf("run %s: finish failed: %v", runID, err)
		}
		return
	}
	r.hub.Publish(runID, ev)
}
