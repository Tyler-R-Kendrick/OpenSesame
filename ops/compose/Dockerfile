# The one native binary. Every native role is a subcommand of it:
# `opensesame host run` (Host API), `opensesame worker run`, `opensesame daemon run`.
FROM rust:1.88.0-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS build
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# Optional bridges, off unless asked for, e.g.
# `docker build --build-arg OPENSESAME_FEATURES=bitwarden-compat` (ADR 0148).
ARG OPENSESAME_FEATURES=""
RUN cargo build --release -p opensesame-cli --features "${OPENSESAME_FEATURES}"
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
RUN useradd -u 10001 -m app && apt-get update && apt-get install -y ca-certificates libdbus-1-3 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/opensesame /usr/local/bin/
USER 10001
EXPOSE 8787
ENTRYPOINT ["opensesame"]
