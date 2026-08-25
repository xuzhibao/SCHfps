# Build stage
FROM golang:1.25-alpine AS builder
ARG GOPROXY=https://goproxy.cn,direct
ARG GOSUMDB=sum.golang.org
ENV GOPROXY=${GOPROXY}
ENV GOSUMDB=${GOSUMDB}
WORKDIR /app

# Copy module definitions and pre-download dependencies
COPY server/go.mod server/go.sum ./server/
WORKDIR /app/server
RUN go mod download

# Copy source and map definition
WORKDIR /app
COPY map.json ./map.json
COPY server ./server
WORKDIR /app/server
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/pixelstrike .

# Final minimal runtime container
FROM alpine:3.20
# Do not require a second apk mirror during deployment; the Go builder already
# carries the CA bundle and the server uses UTC when tzdata is unavailable.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app

COPY --from=builder /app/pixelstrike ./pixelstrike
COPY --from=builder /app/map.json ./map.json

ENV PORT=8080
ENV DB_PATH=/data/stats.db
ENV MAP_PATH=/app/map.json

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/app/pixelstrike"]
