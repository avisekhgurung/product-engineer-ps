# One image: builds the React app, builds the Go server, and serves both.

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27 AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# The SQLite driver is pure Go, so a static binary needs no cgo.
RUN CGO_ENABLED=0 go build -o /relay ./cmd/server

FROM alpine:3.20
RUN adduser -D -u 10001 relay && mkdir /data && chown relay /data
COPY --from=server /relay /usr/local/bin/relay
COPY --from=web /web/dist /app/public
USER relay
# The database lives in /data. On a free host this disk is not persistent, so
# history resets when the service restarts; the demo is built to tolerate that.
ENV PORT=8080
EXPOSE 8080
CMD ["relay", "-db", "/data/chat.db", "-static", "/app/public"]
