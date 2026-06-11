# ── Go stage: compile the Windows agent host (windows-amd64, CGO off) ───────
#
# WIN-INTEGRATE: the Windows installer downloads this binary from the
# backend at agent enrollment time. Building it inside the backend image
# guarantees the binary version is pinned to the same git commit as the
# backend that serves it, so an image rollback also rolls back the host
# binary.
#
# The build context is the repo root (see docker-compose.yml), which is
# why these COPY paths reach into charon-agent-host/.
FROM golang:1.22 AS agent-host-builder

WORKDIR /src/charon-agent-host

# Cache go.mod / go.sum separately so dependency downloads only re-run
# when those files change.
COPY charon-agent-host/go.mod charon-agent-host/go.sum ./
RUN go mod download

COPY charon-agent-host/ ./

# HOST_VERSION format: 2.0.0-mvp0+g<12char-sha>
# Override via:
#   docker compose build --build-arg HOST_VERSION="2.0.0-mvp0+g$(git rev-parse --short=12 HEAD)" backend
# Default "dev" is intentionally NOT a valid production version; the
# integrity check at /opt/netmanager/agent-bins read time rejects it.
ARG HOST_VERSION=dev

# UPX is intentionally NOT applied — EDR and SmartScreen flag UPX-packed
# binaries as suspicious.
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
    go build \
        -trimpath \
        -ldflags="-s -w -X github.com/Coosef/netmanager/charon-agent-host/internal/version.Version=${HOST_VERSION}" \
        -o /out/charon-agent-host-windows-amd64.exe \
        ./cmd/charon-agent-host

RUN sha256sum /out/charon-agent-host-windows-amd64.exe \
        | awk '{print $1}' \
        > /out/charon-agent-host-windows-amd64.exe.sha256


# ── Python builder stage: compile Python packages that need gcc ─────────────
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
        && rm -rf /var/lib/apt/lists/*

RUN python -m venv /venv
ENV PATH=/venv/bin:$PATH

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# ── Production stage: no gcc / no linux-libc-dev ────────────────────────────
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
        && apt-get install -y --no-install-recommends \
        libpq-dev \
        openssh-client \
        iputils-ping \
        traceroute \
        bind9-dnsutils \
        && rm -rf /var/lib/apt/lists/*

COPY --from=builder /venv /venv
ENV PATH=/venv/bin:$PATH

# Backend application code. Context is repo root; COPY only what the
# runtime image needs.
COPY backend/ /app/

# Embedded Windows host binary + integrity sidecar produced by
# agent-host-builder above. Served by the gated
# /api/v1/agents/{id}/download/host/windows-amd64 endpoint.
COPY --from=agent-host-builder /out/charon-agent-host-windows-amd64.exe       /opt/netmanager/agent-bins/
COPY --from=agent-host-builder /out/charon-agent-host-windows-amd64.exe.sha256 /opt/netmanager/agent-bins/

ENV PYTHONPATH=/app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
