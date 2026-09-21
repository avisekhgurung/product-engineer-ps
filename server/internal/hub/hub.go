// Package hub delivers live events to the clients currently connected.
//
// It is deliberately in-memory and disposable. Losing a subscription loses
// nothing, because every event is already in the store and a client can replay
// it from its cursor.
package hub

import (
	"sync"

	"github.com/caygnus-challenge/resumable-chat/internal/store"
)

// buffer is how far a single connection may fall behind before we drop it.
// Dropping is safe and preferable to blocking the generator: the client
// reconnects and replays the gap from the store.
const buffer = 256

// Hub fans out the events of a run to its current subscribers.
type Hub struct {
	mu   sync.Mutex
	subs map[string]map[*Subscription]struct{}
}

// New creates an empty hub.
func New() *Hub {
	return &Hub{subs: make(map[string]map[*Subscription]struct{})}
}

// Subscription is one connected client's live feed.
type Subscription struct {
	hub    *Hub
	runID  string
	events chan store.Event

	mu     sync.Mutex
	closed bool
	lagged bool
}

// Events is closed when the subscription ends, either because the caller closed
// it or because it fell too far behind.
func (s *Subscription) Events() <-chan store.Event { return s.events }

// Lagged reports whether this subscription was dropped for falling behind.
// The caller should reconnect and replay rather than assume it is current.
func (s *Subscription) Lagged() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lagged
}

// Close removes the subscription from the hub. Safe to call twice.
func (s *Subscription) Close() {
	s.hub.mu.Lock()
	if subs, ok := s.hub.subs[s.runID]; ok {
		delete(subs, s)
		if len(subs) == 0 {
			delete(s.hub.subs, s.runID)
		}
	}
	s.hub.mu.Unlock()
	s.close(false)
}

func (s *Subscription) close(lagged bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	s.lagged = lagged
	close(s.events)
}

// Subscribe starts receiving live events for a run.
//
// A reconnecting handler subscribes *before* it reads history from the store.
// Events produced during the replay land in this buffer instead of being lost,
// which is what removes the gap between replay and live delivery.
func (h *Hub) Subscribe(runID string) *Subscription {
	sub := &Subscription{hub: h, runID: runID, events: make(chan store.Event, buffer)}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[runID] == nil {
		h.subs[runID] = make(map[*Subscription]struct{})
	}
	h.subs[runID][sub] = struct{}{}
	return sub
}

// Publish hands an already-stored event to current subscribers. It never
// blocks: a subscriber that cannot keep up is dropped instead.
func (h *Hub) Publish(runID string, ev store.Event) {
	h.mu.Lock()
	subs := make([]*Subscription, 0, len(h.subs[runID]))
	for sub := range h.subs[runID] {
		subs = append(subs, sub)
	}
	h.mu.Unlock()

	for _, sub := range subs {
		sub.mu.Lock()
		closed := sub.closed
		sub.mu.Unlock()
		if closed {
			continue
		}
		select {
		case sub.events <- ev:
		default:
			h.mu.Lock()
			delete(h.subs[runID], sub)
			h.mu.Unlock()
			sub.close(true)
		}
	}
}
