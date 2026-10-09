# Cursor Cloud Agent image for OpenSesame.
# Rust 1.88 bookworm (matches rust-toolchain.toml; .devcontainer names a devcontainers
# tag that is not published on MCR). Do not COPY the repo — Cursor checks out separately.
FROM rust:1.88.0-bookworm

ENV PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Login shells reset PATH in /etc/profile. This file puts cargo back, and
# vscode bash sources it for non-login shells (see the bashrc prepend below).
RUN cat > /etc/profile.d/cargo.sh <<'EOF'
# Cargo on PATH, and one shared target dir (AGENTS.md §9).
case ":${PATH}:" in
  *:/usr/local/cargo/bin:*) ;;
  *) PATH="/usr/local/cargo/bin:${PATH}" ;;
esac
export PATH
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  CARGO_TARGET_DIR="${HOME}/.cache/packages/cargo-target"
  export CARGO_TARGET_DIR
fi
EOF

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

ENV KIMI_INSTALL_DIR=/usr/local
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh \
  | env KIMI_INSTALL_DIR=/usr/local KIMI_NO_MODIFY_PATH=1 bash \
  && /usr/local/bin/kimi --version

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
  && chmod 0440 /etc/sudoers.d/vscode \
  && { printf '%s\n' \
      '# Cargo for non-login bash. Login shells read /etc/profile.d/cargo.sh.' \
      '. /etc/profile.d/cargo.sh' \
      ''; cat /home/vscode/.bashrc; } > /home/vscode/.bashrc.new \
  && mv /home/vscode/.bashrc.new /home/vscode/.bashrc \
  && chown vscode:vscode /home/vscode/.bashrc

# Non-interactive non-login bash does not read .bashrc. BASH_ENV covers it.
ENV BASH_ENV=/etc/profile.d/cargo.sh

USER vscode
