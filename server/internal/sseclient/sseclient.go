// Package sseclient is a minimal Server-Sent Events reader.
//
// The browser has EventSource built in; Go does not. Tests and the benchmark
// use this so they exercise the same wire protocol a browser would.
package sseclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Frame is one parsed SSE message.
type Frame struct {
	// Seq is the SSE id field. Control frames have no id and leave it at 0.
	Seq   int64
	Event string
	Data  json.RawMessage
}

// Stream is an open connection to a run's event endpoint.
type Stream struct {
	resp   *http.Response
	reader *bufio.Reader
}

// Conflict is returned when the server refuses the cursor (HTTP 409).
type Conflict struct {
	ErrorCode string `json:"error"`
	Message   string `json:"message"`
	LastSeq   int64  `json:"lastSeq"`
	Status    string `json:"status"`
}

func (c *Conflict) Error() string {
	return fmt.Sprintf("%s: %s (lastSeq=%d)", c.ErrorCode, c.Message, c.LastSeq)
}

// Connect opens the stream for a run, asking for everything after a cursor.
func Connect(ctx context.Context, baseURL, runID string, after int64) (*Stream, error) {
	url := fmt.Sprintf("%s/api/runs/%s/events?after=%d", strings.TrimRight(baseURL, "/"), runID, after)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusConflict {
		defer resp.Body.Close()
		var c Conflict
		if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
			return nil, err
		}
		return nil, &c
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("stream returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return &Stream{resp: resp, reader: bufio.NewReader(resp.Body)}, nil
}

// Next returns the next frame, or io.EOF when the server closed the stream.
func (s *Stream) Next() (Frame, error) {
	var frame Frame
	for {
		line, err := s.reader.ReadString('\n')
		if err != nil {
			return Frame{}, err
		}
		line = strings.TrimRight(line, "\r\n")

		switch {
		case line == "": // blank line ends a frame
			if frame.Event != "" {
				return frame, nil
			}
		case strings.HasPrefix(line, ":"): // keep-alive comment
		case strings.HasPrefix(line, "id: "):
			seq, err := strconv.ParseInt(strings.TrimPrefix(line, "id: "), 10, 64)
			if err != nil {
				return Frame{}, fmt.Errorf("bad id line %q: %w", line, err)
			}
			frame.Seq = seq
		case strings.HasPrefix(line, "event: "):
			frame.Event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			frame.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
		}
	}
}

// Close hangs up. The server sees the disconnect; the run keeps going.
func (s *Stream) Close() error { return s.resp.Body.Close() }
