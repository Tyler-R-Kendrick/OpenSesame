//! Actual Unix terminal execution for native CLI journey assertions.

use std::io::Read;
use std::os::unix::io::FromRawFd;
use std::process::{Command, Output, Stdio};

/// A person at a terminal: stdin and stdout are both the slave side of a pty.
/// Piped `Command::output` is the agent shape, and the reveal gate refuses it.
pub fn run(mut command: Command) -> Output {
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

    let mut child = command
        .stdin(Stdio::from(slave_in))
        .stdout(Stdio::from(slave_out))
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to run the opensesame binary");
    // Command retains the PTY slave handles after spawn; release them before EOF.
    drop(command);
    let stdout_thread = std::thread::spawn(move || {
        let mut master = master;
        let mut buf = Vec::new();
        let _ = master.read_to_end(&mut buf);
        buf
    });
    let mut stderr_pipe = child.stderr.take().expect("stderr");
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });
    let status = child.wait().expect("wait for opensesame");
    Output {
        status,
        stdout: stdout_thread.join().expect("stdout thread"),
        stderr: stderr_thread.join().expect("stderr thread"),
    }
}
