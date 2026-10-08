fn main() {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows && msvc {
        // The generated CLI command tree exceeds MSVC's 1 MiB default in
        // debug builds. Reserve the same bounded 8 MiB available to the
        // supported Linux CLI; retain the default 4 KiB initial commitment.
        println!("cargo:rustc-link-arg-bin=opensesame=/STACK:8388608,4096");
    }
}
