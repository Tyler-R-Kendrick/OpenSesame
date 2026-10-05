# Cursor Cloud Agent image for OpenSesame.
# Rust 1.88 bookworm (matches rust-toolchain.toml; .devcontainer names a devcontainers
# tag that is not published on MCR). Do not COPY the repo — Cursor checks out separately.
FROM rust:1.88.0-bookworm

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

RUN rustup component add rustfmt clippy \
  && rustup target add wasm32-unknown-unknown

RUN corepack enable \
  && corepack prepare pnpm@9.15.0 --activate \
  && node -v \
  && pnpm -v \
  && rustc --version

RUN useradd -m -u 1000 -s /bin/bash vscode \
  && install -d -o vscode -g vscode /etc/sudoers.d \
  && echo 'vscode ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
  && chmod 0440 /etc/sudoers.d/vscode

USER vscode
