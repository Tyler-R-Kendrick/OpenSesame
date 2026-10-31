# Cursor Cloud Agent image for OpenSesame.
# Rust 1.88 bookworm (matches rust-toolchain.toml; .devcontainer names a devcontainers
# tag that is not published on MCR). Do not COPY the repo — Cursor checks out separately.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS node
FROM rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0

# Both images use Bookworm. Copy the integrity-pinned Node distribution rather
# than running a mutable repository-setup script as root.
COPY --from=node /usr/local/ /usr/local/

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
. /etc/profile.d/kimi-code.sh
EOF

# This same source is used by repository bootstrap. The cargo profile above
# reaches it from BASH_ENV as well as ordinary login/interactive shells.
COPY .cursor/cloud-path.sh /etc/profile.d/kimi-code.sh

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    sudo \
    build-essential \
    python3 \
    libdbus-1-dev \
    pkg-config \
    dbus-daemon \
  && rm -rf /var/lib/apt/lists/*

ENV GROK_BIN_DIR=/usr/local/bin
COPY .cursor/tools/downloads.json /opt/opensesame/.cursor/tools/downloads.json
COPY scripts/dev/install-cloud-cli.mjs /opt/opensesame/scripts/dev/install-cloud-cli.mjs
RUN node /opt/opensesame/scripts/dev/install-cloud-cli.mjs grok /usr/local/bin/grok \
  && /usr/local/bin/grok --version

COPY .cursor/tools/package.json .cursor/tools/package-lock.json /opt/opensesame-cloud-tools/
# npm ci checks every tarball against the committed integrity lock. Native
# optional dependencies retain their build scripts; Kimi's local postinstall is a no-op.
RUN npm_config_nodedir=/usr/local npm ci --prefix /opt/opensesame-cloud-tools --omit=dev --no-audit --no-fund \
  && ln -s /opt/opensesame-cloud-tools/node_modules/.bin/kimi /usr/local/bin/kimi \
  && kimi --version

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
      '# Cargo and Kimi for non-login bash. Login shells read /etc/profile.d/*.sh.' \
      '. /etc/profile.d/cargo.sh' \
      '. /etc/profile.d/kimi-code.sh' \
      ''; cat /home/vscode/.bashrc; } > /home/vscode/.bashrc.new \
  && mv /home/vscode/.bashrc.new /home/vscode/.bashrc \
  && chown vscode:vscode /home/vscode/.bashrc

# Non-interactive non-login bash does not read .bashrc. BASH_ENV covers it.
ENV BASH_ENV=/etc/profile.d/cargo.sh

USER vscode
