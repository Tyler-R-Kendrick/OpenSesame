#!/bin/bash -eu
# Copyright 2026 Tyler Kendrick
# SPDX-License-Identifier: Apache-2.0
#
# Builds OpenSesame's enrolled Rust fuzz targets for OSS Verify: each
# cargo-fuzz [[bin]] of tests/fuzz/cargo as a static library linked with the
# OSS Verify driver, through infra/base-builder/release-target.sh and
# infra/base-builder/rust/recipes.sh. The `sources` file lays each target's
# tree, Cargo.lock and vendored crates out where ov_target_begin and
# oft_build_cargo_shim read them. Do not run the produced binaries here:
# they are cross-compiled static riscv64 programs.
#
# The four builds (plain, ubsan, asan, asan-ubsan) each run this script with
# their $FLAV; ov_target_build links the target into $OUT for each.

. /usr/local/lib/oss-verify/release-target.sh

opensesame_target() {
  _t="$1"
  (
    ov_target_begin "$_t"
    CARGO_FUZZ_DIR=tests/fuzz/cargo
    FUZZ_BIN="$_t"
    CARGO_DEBUG_ASSERTIONS=0
    export CARGO_FUZZ_DIR FUZZ_BIN CARGO_DEBUG_ASSERTIONS
    . /usr/local/lib/oss-verify/rust/recipes.sh
    build_lib() { oft_build_cargo_shim; oft_seal_getenv; }
    LIB_ARCHIVE="lib/liboft.a"
    ov_target_build "$_t"
  )
}

# The first wave enrolled in project.yaml (ADR 0211 §3): authority algebra
# and security-boundary parsers, all hermetic (no entropy or clock). The
# seal/envelope targets (vault_envelope, broker_seal) draw OS randomness
# for nonces and keys and join a later wave once the harnesses take a
# deterministic seam. Add a target here, a `tree` + `crates` pair in
# `sources`, and a fuzz_targets row in project.yaml, together.
opensesame_target capability_algebra
opensesame_target grant_attenuation
opensesame_target canonical_json
opensesame_target jwt_jwk
opensesame_target pki_csr_parse
opensesame_target kdbx_parse
opensesame_target vault_item_type
opensesame_target connector_manifest
