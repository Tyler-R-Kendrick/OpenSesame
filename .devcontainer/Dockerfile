# Devcontainer image for OpenSesame.
# The Rust base matches the previous pinned devcontainer image. Node, npm,
# Go, Java, and the locked Rust toolchain are not baked from a Node feature.
# updateContentCommand runs `mise install --locked`, which installs the tools
# pinned in the workspace mise.toml and mise.lock.
#
# ghcr.io/devcontainers-extra/features/mise is not used. Its gh-release asset
# filter matches both the glibc and musl tarballs for one mise version.
FROM mcr.microsoft.com/devcontainers/rust:1-1-bookworm@sha256:fc57fb865035c5395e85246c8842b071ced6e7cde727b3c98abbcc794eaf4759

USER root

# Login shells reset PATH. This puts the mise shims and the user bin back.
# BASH_ENV covers non-interactive bash. Docker ENV PATH covers other shells.
RUN cat > /etc/profile.d/mise.sh <<'EOF'
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
case ":${PATH}:" in
  *:/opt/mise/shims:*) ;;
  *) PATH="/opt/mise/shims:${PATH}" ;;
esac
if [ -n "${HOME:-}" ]; then
  case ":${PATH}:" in
    *:"${HOME}/.local/bin":*) ;;
    *) PATH="${HOME}/.local/bin:${PATH}" ;;
  esac
fi
export PATH
if [ -z "${CARGO_TARGET_DIR:-}" ]; then
  CARGO_TARGET_DIR="${HOME}/.cache/packages/cargo-target"
  export CARGO_TARGET_DIR
fi
EOF

ENV MISE_DATA_DIR=/opt/mise
ENV MISE_CACHE_DIR=/opt/mise/cache
ENV MISE_CARGO_HOME=/opt/mise/cargo
ENV MISE_RUSTUP_HOME=/opt/mise/rustup
ENV CARGO_HOME=/opt/mise/cargo
ENV RUSTUP_HOME=/opt/mise/rustup
ENV BASH_ENV=/etc/profile.d/mise.sh
ENV PATH=/opt/mise/shims:/home/vscode/.local/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*

# Pinned GitHub release tarball. Same version and linux digests as the
# Cursor Cloud image. The digest is checked before extraction.
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
  mkdir -p /opt/mise; \
  chown vscode:vscode /opt/mise; \
  mise --version

USER vscode
