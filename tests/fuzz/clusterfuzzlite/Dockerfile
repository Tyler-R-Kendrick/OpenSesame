# ClusterFuzzLite / OSS-Fuzz builder. Not used by GitHub Actions — this
# repository runs no ClusterFuzzLite workflow. Local and scheduled agent runs
# use scripts/fuzz-pr-gate.sh and scripts/fuzz-batch.sh instead.
FROM gcr.io/oss-fuzz-base/base-builder-rust

COPY . $SRC/opensesame
WORKDIR $SRC/opensesame
COPY tests/fuzz/clusterfuzzlite/build.sh $SRC/
