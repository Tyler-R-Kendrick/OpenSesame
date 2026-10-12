//! Production binary must not honor the legacy app-integration seam env var.

use std::io::{Read, Write};
use std::os::unix::io::FromRawFd;
use std::process::{Command, Stdio};

#[test]
fn seam_env_without_daemon_is_refused() {
    let mut master_fd: libc::c_int = -1;
    let mut slave_fd: libc::c_int = -1;
    let opened = unsafe {
        libc::openpty(
            &raw mut master_fd,
            &raw mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(opened, 0, "openpty");
    let master = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave_fd) };
    let slave_in = slave.try_clone().expect("dup slave for stdin");
    let slave_out = slave.try_clone().expect("dup slave for stdout");
    drop(slave);

    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    let init = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass", "init", "--path"])
        .arg(&store)
        .env("OPENSESAME_STORE_PASSWORD", "correct horse battery staple")
        .output()
        .expect("init");
    assert!(init.status.success());
    let mut insert = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass", "insert", "Dev/token", "--path"])
        .arg(&store)
        .env("OPENSESAME_STORE_PASSWORD", "correct horse battery staple")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("insert");
    insert
        .stdin
        .take()
        .unwrap()
        .write_all(b"hunter2\n")
        .unwrap();
    assert!(insert.wait().expect("insert wait").success());

    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["pass", "show", "Dev/token", "--reveal", "--path"])
        .arg(&store)
        .env("OPENSESAME_STORE_PASSWORD", "correct horse battery staple")
        .env("OPENSESAME_CLI_APP_INTEGRATION_SEAM", "approve")
        .env("OPENSESAME_DAEMON_API", "http://127.0.0.1:1")
        .env_remove("OPENSESAME_DAEMON_LISTEN")
        .stdin(Stdio::from(slave_in))
        .stdout(Stdio::from(slave_out))
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout_thread = std::thread::spawn(move || {
        let mut master = master;
        let mut buf = Vec::new();
        let _ = master.read_to_end(&mut buf);
        buf
    });
    let mut stderr = child.stderr.take().expect("stderr");
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let status = child.wait().expect("wait");
    let stdout_bytes = stdout_thread.join().unwrap();
    let stderr_bytes = stderr_thread.join().unwrap();
    let out = String::from_utf8_lossy(&stdout_bytes);
    let err = String::from_utf8_lossy(&stderr_bytes);
    let combined = format!("{out}{err}");
    assert!(!status.success(), "combined output:\n{combined}");
    assert!(
        combined.contains("OpenSesame is not running")
            || combined.contains("Unlock OpenSesame"),
        "expected app-unavailable copy, got:\n{combined}"
    );
}
