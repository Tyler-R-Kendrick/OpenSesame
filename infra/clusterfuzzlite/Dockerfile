# ClusterFuzzLite / OSS-Fuzz builder. Not used by GitHub Actions — this
# repository has no .github/ workflows. Local and scheduled agent runs invoke
# the same build.sh via scripts/fuzz-pr-gate.sh and scripts/fuzz-batch.sh.
FROM gcr.io/oss-fuzz-base/base-builder-rust

COPY . $SRC/opensesame
WORKDIR $SRC/opensesame
COPY infra/clusterfuzzlite/build.sh $SRC/
