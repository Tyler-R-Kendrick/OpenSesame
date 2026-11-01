# Cursor Cloud Agent image for OpenSesame.
# Bookworm userspace comes from the pinned Rust image (aligned with
# rust-toolchain.toml). Node, npm, and Rust on PATH come from the locked mise
# toolchain. Do not COPY the repo — Cursor checks out separately.
FROM rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0

# Login shells reset PATH in /etc/profile. This file puts the mise shims back,
# and vscode bash sources it for interactive shells. BASH_ENV covers
# non-interactive non-login bash (set below).
RUN cat > /etc/profile.d/mise.sh <<'EOF'
# Locked mise shims (node, npm, rustc, cargo) and one shared cargo target dir.
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
case ":${PATH}:" in
  *:/opt/mise/shims:*) ;;
  *) PATH="/opt/mise/shims:${PATH}" ;;
esac
export PATH
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  CARGO_TARGET_DIR="${HOME}/.cache/packages/cargo-target"
  export CARGO_TARGET_DIR
fi
. /etc/profile.d/kimi-code.sh
EOF

# This same source is used by repository bootstrap. The mise profile above
# reaches it from BASH_ENV as well as ordinary login/interactive shells.
COPY .cursor/cloud-path.sh /etc/profile.d/kimi-code.sh

ENV MISE_DATA_DIR=/opt/mise
ENV MISE_CACHE_DIR=/opt/mise/cache
# Keep mise's Rust homes off the base image rustup (/usr/local/rustup, /usr/local/cargo).
ENV MISE_CARGO_HOME=/opt/mise/cargo
ENV MISE_RUSTUP_HOME=/opt/mise/rustup
ENV CARGO_HOME=/opt/mise/cargo
ENV RUSTUP_HOME=/opt/mise/rustup
ENV PATH=/opt/mise/shims:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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

# Pinned GitHub release tarball. The digests are checked before extraction.
# Both image architectures are pinned; the build picks the one it is building.
ARG MISE_VERSION=2026.10.18
ARG MISE_SHA256_LINUX_X64=0d41b60745a6273a80089c86f80d8729042d2f57f87fda70aecc7d1c3ffbd3be
ARG MISE_SHA256_LINUX_ARM64=c5a49a47f8184f5649f3d8685b408bd72325a823f41cf618c60f3ffc303090a1

RUN set -eu; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) mise_target="linux-x64"; mise_sha="${MISE_SHA256_LINUX_X64}" ;; \
    arm64) mise_target="linux-arm64"; mise_sha="${MISE_SHA256_LINUX_ARM64}" ;; \
    *) echo "unsupported mise architecture: ${arch}" >&2; exit 1 ;; \
  esac; \
  archive="mise-v${MISE_VERSION}-${mise_target}.tar.gz"; \
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --show-error --silent --location \
    --output "/tmp/${archive}" \
    "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${archive}"; \
  echo "${mise_sha}  /tmp/${archive}" | sha256sum -c --strict; \
  tar -xzf "/tmp/${archive}" -C /tmp mise/bin/mise; \
  install -m 0755 /tmp/mise/bin/mise /usr/local/bin/mise; \
  rm -rf "/tmp/${archive}" /tmp/mise; \
  mise --version

# Tool versions are the committed lock, installed into the shared data dir.
# This directory is not a parent of the agent checkout, so the repo's own
# mise.toml wins after Cursor checks the tree out.
COPY mise.toml mise.lock /opt/opensesame-toolchain/
WORKDIR /opt/opensesame-toolchain
RUN mise trust /opt/opensesame-toolchain/mise.toml \
  && mise install --locked \
  && node -v \
  && npm -v \
  && rustc --version \
  && cargo --version

ENV GROK_BIN_DIR=/usr/local/bin
COPY .cursor/tools/downloads.json /opt/opensesame/.cursor/tools/downloads.json
COPY scripts/dev/install-cloud-cli.mjs /opt/opensesame/scripts/dev/install-cloud-cli.mjs
RUN node /opt/opensesame/scripts/dev/install-cloud-cli.mjs grok /usr/local/bin/grok \
  && /usr/local/bin/grok --version

COPY .cursor/tools/package.json .cursor/tools/package-lock.json /opt/opensesame-cloud-tools/
# npm ci checks every tarball against the committed integrity lock. Native
# optional dependencies retain their build scripts; Kimi's local postinstall is a no-op.
# Headers come from the mise-installed Node, not a second distribution.
RUN node_prefix="$(mise where node)" \
  && test -n "$node_prefix" \
  && test -f "$node_prefix/include/node/node.h" \
  && npm_config_nodedir="$node_prefix" npm ci --prefix /opt/opensesame-cloud-tools --omit=dev --no-audit --no-fund \
  && ln -s /opt/opensesame-cloud-tools/node_modules/.bin/kimi /usr/local/bin/kimi \
  && kimi --version

RUN useradd -m -u 1000 -s /bin/bash vscode \
  && install -d -o vscode -g vscode /etc/sudoers.d \
  && echo 'vscode ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
  && chmod 0440 /etc/sudoers.d/vscode \
  && chown -R vscode:vscode /opt/mise \
  && { printf '%s\n' \
      '# Mise shims and Kimi for non-login bash. Login shells read /etc/profile.d/*.sh.' \
      '. /etc/profile.d/mise.sh' \
      '. /etc/profile.d/kimi-code.sh' \
      ''; cat /home/vscode/.bashrc; } > /home/vscode/.bashrc.new \
  && mv /home/vscode/.bashrc.new /home/vscode/.bashrc \
  && chown vscode:vscode /home/vscode/.bashrc

# Non-interactive non-login bash does not read .bashrc. BASH_ENV covers it.
ENV BASH_ENV=/etc/profile.d/mise.sh

USER vscode
RUN mise trust /opt/opensesame-toolchain/mise.toml \
  && mise install --locked
WORKDIR /home/vscode
