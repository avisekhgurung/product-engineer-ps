// Command server runs the resumable chat API.
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/caygnus-challenge/resumable-chat/internal/api"
	"github.com/caygnus-challenge/resumable-chat/internal/hub"
	"github.com/caygnus-challenge/resumable-chat/internal/runner"
	"github.com/caygnus-challenge/resumable-chat/internal/store"
)

func main() {
	addr := flag.String("addr", ":8080", "address to listen on")
	dbPath := flag.String("db", "chat.db", "SQLite file holding the durable event history")
	interval := flag.Duration("chunk-interval", 120*time.Millisecond, "pause between generated chunks")
	flag.Parse()

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	// Any run still marked running belongs to a process that is gone. Close it
	// honestly before serving traffic.
	recovered, err := st.RecoverInterruptedRuns()
	if err != nil {
		log.Fatalf("recover runs: %v", err)
	}
	if len(recovered) > 0 {
		log.Printf("startup: marked %d in-flight run(s) as interrupted: %v", len(recovered), recovered)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	h := hub.New()
	run := runner.New(st, h, *interval)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           api.New(ctx, st, h, run),
		ReadHeaderTimeout: 5 * time.Second,
		// No WriteTimeout: SSE responses are intentionally long-lived.
	}

	go func() {
		log.Printf("listening on %s (db=%s, chunk interval=%s)", *addr, *dbPath, *interval)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down; in-flight runs will be marked interrupted on next start")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	run.Wait()
}
