// Package store owns the durable history of a conversation.
//
// Everything a client is allowed to see is written here first, inside a
// transaction, and only then handed to live listeners. That ordering is what
// makes a reconnect safe: the database, not a network connection, decides what
// happened and in which order.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver, no cgo needed
)

// RunStatus is the lifecycle of one generated reply.
type RunStatus string

const (
	// StatusRunning means the generator is still producing events.
	StatusRunning RunStatus = "running"
	// StatusCompleted means the generator finished normally.
	StatusCompleted RunStatus = "completed"
	// StatusFailed means the generator reported an error.
	StatusFailed RunStatus = "failed"
	// StatusInterrupted means the process died while the run was in flight.
	StatusInterrupted RunStatus = "interrupted"
)

// Terminal reports whether no further events can ever be appended.
func (s RunStatus) Terminal() bool { return s != StatusRunning }

// Event types. Exactly one terminal event ends a run's event history.
const (
	EventChunk       = "chunk"
	EventCompleted   = "completed"
	EventFailed      = "failed"
	EventInterrupted = "interrupted"
)

// Event is one ordered item of a run's history.
//
// Seq is assigned by the store and is the client's cursor: "I have everything
// up to Seq". It starts at 1 and never has gaps.
type Event struct {
	Seq    int64  `json:"seq"`
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Terminal reports whether this event ends the run.
func (e Event) Terminal() bool { return e.Type != EventChunk }

// Run is one generated reply to one user message.
type Run struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversationId"`
	UserMessageID  string    `json:"userMessageId"`
	Status         RunStatus `json:"status"`
	LastSeq        int64     `json:"lastSeq"`
	// FailAfter is a demo knob: make the generator fail after N chunks.
	FailAfter int `json:"-"`
}

// Errors callers are expected to handle.
var (
	ErrRunNotFound = errors.New("run not found")
	ErrRunTerminal = errors.New("run already reached a terminal state")
)

// Store is the durable event log plus the run state machine.
type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,      -- client generated, makes send idempotent
    conversation_id  TEXT NOT NULL,
    text             TEXT NOT NULL,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL,
    user_message_id  TEXT NOT NULL UNIQUE,  -- one reply per user message
    status           TEXT NOT NULL,
    last_seq         INTEGER NOT NULL DEFAULT 0,
    fail_after       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
    run_id  TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    type    TEXT NOT NULL,
    text    TEXT NOT NULL DEFAULT '',
    reason  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, seq)                -- an event position exists at most once
);
`

// Open creates or reopens the database file. Pass ":memory:" in tests.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// One writer keeps sequence assignment simple and avoids SQLite lock
	// errors. A real deployment would use WAL plus a per-run lock instead.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// StartRun stores the user message and opens a run for its reply.
//
// The message id comes from the client, so a retried send returns the run that
// already exists instead of starting a second reply. The bool reports whether
// this call created the run.
func (s *Store) StartRun(conversationID, messageID, text string, failAfter int) (Run, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Run{}, false, err
	}
	defer tx.Rollback()

	var existingRunID string
	err = tx.QueryRow(`SELECT id FROM runs WHERE user_message_id = ?`, messageID).Scan(&existingRunID)
	if err == nil {
		run, err := scanRun(tx.QueryRow(runColumns+` WHERE id = ?`, existingRunID))
		if err != nil {
			return Run{}, false, err
		}
		return run, false, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Run{}, false, err
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(
		`INSERT INTO messages (id, conversation_id, text, created_at) VALUES (?, ?, ?, ?)`,
		messageID, conversationID, text, now,
	); err != nil {
		return Run{}, false, err
	}

	run := Run{
		ID:             "run_" + messageID,
		ConversationID: conversationID,
		UserMessageID:  messageID,
		Status:         StatusRunning,
		FailAfter:      failAfter,
	}
	if _, err := tx.Exec(
		`INSERT INTO runs (id, conversation_id, user_message_id, status, last_seq, fail_after, created_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		run.ID, run.ConversationID, run.UserMessageID, run.Status, failAfter, now,
	); err != nil {
		return Run{}, false, err
	}
	return run, true, tx.Commit()
}

// AppendChunk stores the next piece of generated text and returns it with the
// sequence number the store assigned. It fails if the run already ended, so a
// late generator can never extend a finished run.
func (s *Store) AppendChunk(runID, text string) (Event, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Event{}, err
	}
	defer tx.Rollback()

	ev, err := appendLocked(tx, runID, Event{Type: EventChunk, Text: text})
	if err != nil {
		return Event{}, err
	}
	return ev, tx.Commit()
}

// Finish moves a running run to a terminal state and writes its final event.
//
// The status change and the terminal event happen in one transaction guarded by
// `WHERE status = 'running'`, so if completion, failure and a restart race each
// other, exactly one of them wins. The losers get ErrRunTerminal and the history
// keeps a single terminal event.
func (s *Store) Finish(runID string, status RunStatus, reason string) (Event, error) {
	if !status.Terminal() {
		return Event{}, fmt.Errorf("%q is not a terminal status", status)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Event{}, err
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		`UPDATE runs SET status = ? WHERE id = ? AND status = ?`,
		status, runID, StatusRunning,
	)
	if err != nil {
		return Event{}, err
	}
	changed, err := res.RowsAffected()
	if err != nil {
		return Event{}, err
	}
	if changed == 0 {
		if _, err := scanRun(tx.QueryRow(runColumns+` WHERE id = ?`, runID)); err != nil {
			return Event{}, err
		}
		return Event{}, ErrRunTerminal
	}

	ev, err := appendLocked(tx, runID, Event{Type: terminalEventType(status), Reason: reason})
	if err != nil {
		return Event{}, err
	}
	return ev, tx.Commit()
}

// RecoverInterruptedRuns is called once at startup. A run still marked running
// belongs to a process that no longer exists, so it is closed honestly as
// interrupted instead of silently looking alive or later claiming success.
func (s *Store) RecoverInterruptedRuns() ([]string, error) {
	rows, err := s.db.Query(`SELECT id FROM runs WHERE status = ?`, StatusRunning)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	recovered := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, err := s.Finish(id, StatusInterrupted, "service restarted while this reply was in progress"); err != nil {
			if errors.Is(err, ErrRunTerminal) {
				continue
			}
			return recovered, err
		}
		recovered = append(recovered, id)
	}
	return recovered, nil
}

// Run returns the current state of one run.
func (s *Store) Run(runID string) (Run, error) {
	return scanRun(s.db.QueryRow(runColumns+` WHERE id = ?`, runID))
}

// EventsAfter returns stored events with seq greater than after, in order.
// It is the replay half of a reconnect.
func (s *Store) EventsAfter(runID string, after int64, limit int) ([]Event, error) {
	rows, err := s.db.Query(
		`SELECT seq, type, text, reason FROM run_events
		 WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
		runID, after, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var ev Event
		if err := rows.Scan(&ev.Seq, &ev.Type, &ev.Text, &ev.Reason); err != nil {
			return nil, err
		}
		events = append(events, ev)
	}
	return events, rows.Err()
}

const runColumns = `SELECT id, conversation_id, user_message_id, status, last_seq, fail_after FROM runs`

func scanRun(row *sql.Row) (Run, error) {
	var r Run
	err := row.Scan(&r.ID, &r.ConversationID, &r.UserMessageID, &r.Status, &r.LastSeq, &r.FailAfter)
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, ErrRunNotFound
	}
	return r, err
}

// appendLocked assigns the next sequence number and stores the event. The
// caller holds the transaction, so the read-modify-write of last_seq cannot
// interleave with another append and produce a duplicate position.
func appendLocked(tx *sql.Tx, runID string, ev Event) (Event, error) {
	var status RunStatus
	var lastSeq int64
	err := tx.QueryRow(`SELECT status, last_seq FROM runs WHERE id = ?`, runID).Scan(&status, &lastSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, ErrRunNotFound
	}
	if err != nil {
		return Event{}, err
	}
	// A terminal event is written by Finish in the same transaction that flips
	// the status, so only chunks have to check it here.
	if status.Terminal() && ev.Type == EventChunk {
		return Event{}, ErrRunTerminal
	}

	ev.Seq = lastSeq + 1
	if _, err := tx.Exec(
		`INSERT INTO run_events (run_id, seq, type, text, reason) VALUES (?, ?, ?, ?, ?)`,
		runID, ev.Seq, ev.Type, ev.Text, ev.Reason,
	); err != nil {
		return Event{}, err
	}
	if _, err := tx.Exec(`UPDATE runs SET last_seq = ? WHERE id = ?`, ev.Seq, runID); err != nil {
		return Event{}, err
	}
	return ev, nil
}

func terminalEventType(status RunStatus) string {
	switch status {
	case StatusCompleted:
		return EventCompleted
	case StatusInterrupted:
		return EventInterrupted
	default:
		return EventFailed
	}
}
