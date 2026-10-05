# Cursor Cloud Agent image for OpenSesame.
# Matches .devcontainer/devcontainer.json (Rust 1.88 bookworm). Do not COPY the repo;
# Cursor checks out the workspace after the image is built.
FROM mcr.microsoft.com/devcontainers/rust:1-1.88-bookworm

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    sudo \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

ENV GROK_BIN_DIR=/usr/local/bin
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
  && /usr/local/bin/grok --version

USER vscode

RUN rustup target add wasm32-unknown-unknown \
  && corepack enable \
  && corepack prepare pnpm@9.15.0 --activate

USER root
