# Compose runtime image

This directory holds the **native CLI runtime** container (`opensesame`), not the
Pages PWA. GitHub Pages and static vault landing content stay file-based; only
deployable server/workload surfaces use this image.

Build:

```bash
docker build -f ops/compose/Dockerfile -t opensesame:local .
```

The default entrypoint is the `opensesame` binary. Host API, daemon, and worker
roles are subcommands (`host run`, `daemon run`, `worker run`). Optional bridge
features are compile-time only:

```bash
docker build -f ops/compose/Dockerfile --build-arg OPENSESAME_FEATURES=bitwarden-compat -t opensesame:bitwarden .
```

CI validates this Dockerfile through `.github/workflows/container-build-pr.yml`
during release promotion.
