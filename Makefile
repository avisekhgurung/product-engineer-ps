# Convenience wrapper. Everything here also works as a plain go/npm command.

.PHONY: server web test bench install

install:          ## install web dependencies
	cd web && npm install

server:           ## run the API on :8080
	cd server && go run ./cmd/server

web:              ## run the UI on :5173 (proxies /api to :8080)
	cd web && npm run dev

test:             ## run the Go tests with the race detector
	cd server && go test -race ./...

bench:            ## run the verification benchmark
	cd server && go run ./cmd/bench
