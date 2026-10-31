# syntax=docker/dockerfile:1.7

# Base images are pinned by digest; update tag and digest together.
ARG BUN_IMAGE=oven/bun:1.3.13-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349
ARG GO_IMAGE=golang:1.26.10-bookworm@sha256:23ce71337b726608afb1bc00986e630a05034a87a87ea1fc2cd1ae5cf33387eb
ARG RUNTIME_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM --platform=$BUILDPLATFORM ${RUNTIME_IMAGE} AS agent-deps
WORKDIR /app/agent-runtime
COPY agent-runtime/package.json agent-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY agent-runtime/worker.mjs ./

FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS web-deps

WORKDIR /app/web
ENV CI=1

COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,id=bun-install-cache-v2,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile


FROM web-deps AS web-build

COPY web ./
COPY internal/service/canvas_agent_assets /app/internal/service/canvas_agent_assets
ARG BUILD_NODE_OPTIONS=--max-old-space-size=1024
ENV NODE_OPTIONS=${BUILD_NODE_OPTIONS}
RUN bun run build


FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS go-build

WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked go mod download

COPY internal ./internal
COPY --from=web-build /app/internal/web/dist ./internal/web/dist
ARG TARGETOS
ARG TARGETARCH
ARG BUILD_GOMAXPROCS=2
ARG BUILD_GOMEMLIMIT=2GiB
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    GOMAXPROCS=${BUILD_GOMAXPROCS} GOMEMLIMIT=${BUILD_GOMEMLIMIT} \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -p=${BUILD_GOMAXPROCS} -trimpath -tags=embed \
    -ldflags="-s -w" \
    -o /out/chatgpt2api ./internal


FROM --platform=$TARGETPLATFORM ${RUNTIME_IMAGE} AS app

WORKDIR /app
ENV PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=go-build /out/chatgpt2api ./chatgpt2api
COPY --from=agent-deps /app/agent-runtime ./agent-runtime

# /app must be writable: the service persists admin settings to /app/.env.
RUN mkdir -p /app/data && chown node:node /app /app/data && chmod +x /app/chatgpt2api

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT:-8080}/health || exit 1

CMD ["/app/chatgpt2api"]
