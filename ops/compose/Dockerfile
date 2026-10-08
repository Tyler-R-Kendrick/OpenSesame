# GHCR image: the `opensesame` CLI with relay-only server role (ADR 0181).
# Default CMD: `opensesame relay run` — optional vault-relay peer, not Host/Identity/daemon.
FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY . .
ARG OPENSESAME_FEATURES=""
RUN cargo build --release -p opensesame-cli --features "${OPENSESAME_FEATURES}"
FROM debian:bookworm-slim
RUN useradd -u 10001 -m app && apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/opensesame /usr/local/bin/
USER 10001
EXPOSE 8787
ENTRYPOINT ["opensesame"]
CMD ["relay", "run"]
