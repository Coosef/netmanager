# ── Build stage: compile Python packages that need gcc ──────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /venv
ENV PATH=/venv/bin:$PATH

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Production stage: no gcc / no linux-libc-dev ────────────────────────────
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    openssh-client \
    iputils-ping \
    traceroute \
    bind9-dnsutils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /venv /venv
ENV PATH=/venv/bin:$PATH

COPY . .

ENV PYTHONPATH=/app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
