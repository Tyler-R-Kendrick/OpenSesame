//! Metadata-only native constant capture, linked to the baseline-resolved libc artifact.
//! The runner must retain the exact compiler argv, artifact SHA and lock provenance.

fn target_env() -> &'static str {
    if cfg!(target_env = "gnu") {
        "gnu"
    } else if cfg!(target_env = "msvc") {
        "msvc"
    } else {
        ""
    }
}

#[cfg(unix)]
fn flags() -> String {
    format!(
        "{{\"O_RDONLY\":{},\"O_WRONLY\":{},\"O_CREAT\":{},\"O_EXCL\":{},\"O_NONBLOCK\":{},\"O_DIRECTORY\":{},\"O_NOFOLLOW\":{},\"O_CLOEXEC\":{}}}",
        libc::O_RDONLY,
        libc::O_WRONLY,
        libc::O_CREAT,
        libc::O_EXCL,
        libc::O_NONBLOCK,
        libc::O_DIRECTORY,
        libc::O_NOFOLLOW,
        libc::O_CLOEXEC,
    )
}

#[cfg(not(unix))]
fn flags() -> String {
    "null".into()
}

fn main() {
    println!(
        "{{\"v\":1,\"os\":\"{}\",\"arch\":\"{}\",\"env\":\"{}\",\"flags\":{}}}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        target_env(),
        flags(),
    );
}
