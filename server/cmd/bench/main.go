// Command bench is the verification benchmark for problem 1.
//
// It runs a real server in-process, streams one reply of more than 30 events,
// drops the connection twice while generation continues, resumes from the
// client's cursor, and then checks the reconstructed reply against the
// generator's own output. It exits non-zero if a single event is missing,
// duplicated or out of order.
//
//	go run ./cmd/bench
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/caygnus-challenge/resumable-chat/internal/api"
	"github.com/caygnus-challenge/resumable-chat/internal/generator"
	"github.com/caygnus-challenge/resumable-chat/internal/hub"
	"github.com/caygnus-challenge/resumable-chat/internal/runner"
	"github.com/caygnus-challenge/resumable-chat/internal/sseclient"
	"github.com/caygnus-challenge/resumable-chat/internal/store"
)

const (
	prompt = "benchmark run"
	// chunkInterval is slow enough that the client can disconnect mid-reply,
	// fast enough that the whole benchmark finishes in a few seconds.
	chunkInterval = 15 * time.Millisecond
	// awayFor is how long the client stays disconnected. The server keeps
	// generating during this window, which is the point of the exercise.
	awayFor = 150 * time.Millisecond
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "\nBENCHMARK FAILED: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	dir, err := os.MkdirTemp("", "bench")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	st, err := store.Open(filepath.Join(dir, "bench.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New()
	r := runner.New(st, h, chunkInterval)
	srv := httptest.NewServer(api.New(ctx, st, h, r))
	defer srv.Close()

	expected := generator.Chunks(prompt)
	fmt.Printf("Resumable realtime conversation — verification benchmark\n")
	fmt.Printf("  expected events : %d chunks + 1 terminal\n", len(expected))
	fmt.Printf("  chunk interval  : %s\n\n", chunkInterval)

	runID, err := send(srv.URL)
	if err != nil {
		return err
	}

	// received[seq] = text, so a duplicate delivery is detectable rather than
	// silently concatenated.
	received := map[int64]string{}
	var deliveries, duplicates, interruptions int
	var cursor int64
	var terminal store.Event

	// Two interruptions: one early, one in the middle of the reply.
	for _, readBefore := range []int{6, 12} {
		stream, err := sseclient.Connect(ctx, srv.URL, runID, cursor)
		if err != nil {
			return err
		}
		read := 0
		for read < readBefore {
			ev, control, err := next(stream)
			if err != nil {
				return err
			}
			if control {
				continue
			}
			if ev.Terminal() {
				terminal = ev
				break
			}
			deliveries++
			if _, seen := received[ev.Seq]; seen {
				duplicates++
			}
			received[ev.Seq] = ev.Text
			cursor = ev.Seq
			read++
		}
		stream.Close()
		interruptions++
		fmt.Printf("  interruption %d : disconnected at seq %d, staying away %s\n", interruptions, cursor, awayFor)
		time.Sleep(awayFor) // the server keeps generating with nobody listening
	}

	// Final reconnect: read the rest of the reply from the cursor.
	stream, err := sseclient.Connect(ctx, srv.URL, runID, cursor)
	if err != nil {
		return err
	}
	defer stream.Close()
	for terminal.Type == "" {
		ev, control, err := next(stream)
		if err != nil {
			return err
		}
		if control {
			continue
		}
		if ev.Terminal() {
			terminal = ev
			break
		}
		deliveries++
		if _, seen := received[ev.Seq]; seen {
			duplicates++
		}
		received[ev.Seq] = ev.Text
		cursor = ev.Seq
	}

	finalRun, err := st.Run(runID)
	if err != nil {
		return err
	}

	// Checks.
	var missing []int64
	var rebuilt strings.Builder
	for i := int64(1); i <= int64(len(expected)); i++ {
		text, ok := received[i]
		if !ok {
			missing = append(missing, i)
			continue
		}
		rebuilt.WriteString(text)
	}

	fmt.Printf("\n  reconnects      : %d\n", interruptions)
	fmt.Printf("  events delivered: %d\n", deliveries)
	fmt.Printf("  unique events   : %d (expected %d)\n", len(received), len(expected))
	fmt.Printf("  missing events  : %d\n", len(missing))
	fmt.Printf("  duplicate events: %d\n", duplicates)
	fmt.Printf("  terminal event  : %s\n", terminal.Type)
	fmt.Printf("  final run state : %s (lastSeq %d)\n", finalRun.Status, finalRun.LastSeq)

	switch {
	case len(expected) < 30:
		return fmt.Errorf("benchmark needs at least 30 events, generator produced %d", len(expected))
	case len(missing) > 0:
		return fmt.Errorf("%d missing event(s): %v", len(missing), missing)
	case duplicates > 0:
		return fmt.Errorf("%d duplicate event(s) delivered", duplicates)
	case rebuilt.String() != generator.Reply(prompt):
		return fmt.Errorf("reconstructed reply does not match the generator output")
	case finalRun.Status != store.StatusCompleted:
		return fmt.Errorf("final run state = %q, want completed", finalRun.Status)
	}

	fmt.Printf("\n  reply matches generator output exactly.\n")
	fmt.Printf("PASS: %d events, 0 missing, 0 duplicates, state=%s\n", len(received), finalRun.Status)
	return nil
}

// next reads one frame and reports whether it was a control frame, which
// carries no sequence number and must not move the cursor.
func next(s *sseclient.Stream) (store.Event, bool, error) {
	frame, err := s.Next()
	if err != nil {
		return store.Event{}, false, err
	}
	if frame.Seq == 0 {
		return store.Event{}, true, nil
	}
	var ev store.Event
	if err := json.Unmarshal(frame.Data, &ev); err != nil {
		return store.Event{}, false, err
	}
	return ev, false, nil
}

func send(baseURL string) (string, error) {
	body, err := json.Marshal(map[string]any{
		"conversationId": "conv_bench",
		"messageId":      fmt.Sprintf("msg_bench_%d", time.Now().UnixNano()),
		"text":           prompt,
	})
	if err != nil {
		return "", err
	}
	resp, err := http.Post(baseURL+"/api/messages", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return "", fmt.Errorf("send message: status %d", resp.StatusCode)
	}
	var out struct {
		RunID string `json:"runId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.RunID, nil
}
