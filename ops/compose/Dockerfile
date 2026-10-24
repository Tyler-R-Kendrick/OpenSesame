# The one native binary. Every native role is a subcommand of it:
# `opensesame host run` (Host API), `opensesame worker run`, `opensesame daemon run`.
FROM rust:1.88-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# Optional bridges, off unless asked for, e.g.
# `docker build --build-arg OPENSESAME_FEATURES=bitwarden-compat` (ADR 0148).
ARG OPENSESAME_FEATURES=""
RUN cargo build --release -p opensesame-cli --features "${OPENSESAME_FEATURES}"
FROM debian:bookworm-slim
RUN useradd -u 10001 -m app && apt-get update && apt-get install -y ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/opensesame /usr/local/bin/
USER 10001
EXPOSE 8787
ENTRYPOINT ["opensesame"]
