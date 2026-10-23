# Copyright 2026 Tyler Kendrick
# SPDX-License-Identifier: Apache-2.0
#
# OpenSesame on the OSS Verify builder. tools/check passes REPO, COMMIT and
# BASE_BUILDER; fetch-commit checks out exactly COMMIT, and lay-out-sources
# reads the `sources` file beside this Dockerfile to lay the per-target trees
# and vendored crates out under $WORK the way the release build had them.
ARG BASE_BUILDER=oss-verify-base-builder
FROM ${BASE_BUILDER}
ARG REPO
ARG COMMIT
RUN fetch-commit $SRC/opensesame
COPY . $SRC/project/
RUN lay-out-sources $SRC/project/sources $WORK && cp $SRC/project/build.sh $SRC/build.sh
WORKDIR $SRC
