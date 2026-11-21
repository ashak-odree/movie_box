# Multi-stage Dockerfile for deploying MovieBox-Web (Rust + FFmpeg) to Render / Koyeb / Fly.io
FROM rust:1.90-bookworm AS builder
WORKDIR /app

COPY MovieBox-TUI ./MovieBox-TUI
COPY MovieBox-Web ./MovieBox-Web

WORKDIR /app/MovieBox-Web
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/MovieBox-Web/target/release/moviebox-web /usr/local/bin/moviebox-web

ENV PORT=8080
ENV PASSCODE=mamamiakoi
ENV AUTO_UPDATE_ENABLED=false

EXPOSE 8080
CMD ["moviebox-web"]

