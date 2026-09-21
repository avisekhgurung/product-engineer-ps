// Package generator produces the reply text.
//
// It is a deterministic stand-in for a model provider: the same prompt always
// yields the same chunks in the same order. That is what lets the tests and the
// benchmark assert "zero missing, zero duplicate" without a paid API.
package generator

import (
	"fmt"
	"strings"
)

// body is padding that guarantees a reply long enough to interrupt in the
// middle. The benchmark needs at least 30 events; this always produces more.
var body = []string{
	"I stream this answer one chunk at a time, exactly the way a model would.",
	"Every chunk is written to the database before it is sent to you.",
	"Each one carries a sequence number, so your client always knows its position.",
	"If the connection drops, the server keeps generating without you.",
	"When you come back you ask for everything after the last number you saw.",
	"That is why nothing is repeated and nothing is skipped.",
	"The database is the truth; the connection is only a delivery pipe.",
}

// Chunks returns the deterministic reply for a prompt.
func Chunks(prompt string) []string {
	// Trim trailing punctuation so the echoed prompt does not end in "..".
	echo := strings.TrimRight(strings.TrimSpace(prompt), " .!?,")
	text := fmt.Sprintf("You said: %s.", echo) + " " + strings.Join(body, " ")

	words := strings.Fields(text)
	chunks := make([]string, len(words))
	for i, w := range words {
		// Keep the spaces in the chunks so joining them rebuilds the reply
		// exactly. The benchmark compares that join against this function.
		if i == len(words)-1 {
			chunks[i] = w
		} else {
			chunks[i] = w + " "
		}
	}
	return chunks
}

// Reply is the full expected text for a prompt, used by tests and the
// benchmark to check what the client reconstructed.
func Reply(prompt string) string { return strings.Join(Chunks(prompt), "") }
