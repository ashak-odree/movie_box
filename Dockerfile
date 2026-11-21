# Multi-stage Dockerfile for HuggingFace Spaces (2 vCPU, 16GB RAM, port 7860)
FROM rust:1.90-bookworm AS builder
WORKDIR /app

COPY MovieBox-Web ./MovieBox-Web
COPY MovieBox-TUI ./MovieBox-TUI

# Ensure MovieBox-TUI is populated even if submodule was not checked out
RUN if [ ! -f MovieBox-TUI/Cargo.toml ]; then \
      rm -rf MovieBox-TUI && \
      git clone --depth 1 https://github.com/mesamirh/MovieBox-Tui.git MovieBox-TUI; \
    fi

WORKDIR /app/MovieBox-Web
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# HuggingFace Spaces runs containers as uid 1000
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user/app

COPY --from=builder /app/MovieBox-Web/target/release/moviebox-web /usr/local/bin/moviebox-web

ENV PORT=7860
ENV PASSCODE=mamamiakoi
ENV AUTO_UPDATE_ENABLED=false
ENV HOME=/home/user

EXPOSE 7860
CMD ["moviebox-web"]
