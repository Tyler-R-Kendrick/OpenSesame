//! Actual owner terminal and independent cold process helpers.
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
fn await_hidden_input(terminal: &File) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut settings = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: tcgetattr initializes this valid termios pointer on success.
        assert_eq!(
            unsafe { libc::tcgetattr(terminal.as_raw_fd(), settings.as_mut_ptr()) },
            0
        );
        // SAFETY: the successful tcgetattr call initialized all termios fields.
        let settings = unsafe { settings.assume_init() };
        if settings.c_lflag & (libc::ECHO | libc::ICANON) == 0 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "hidden input mode did not become ready"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
pub fn human(root: &Path, args: &[&str], secrets: &[&str]) -> Output {
    terminal(root, args, secrets, true)
}
pub fn terminal(root: &Path, args: &[&str], secrets: &[&str], store_command: bool) -> Output {
    terminal_with_environment(root, args, secrets, store_command, &[])
}
pub fn terminal_with_environment(
    root: &Path,
    args: &[&str],
    secrets: &[&str],
    store_command: bool,
    environment: &[(&str, &str)],
) -> Output {
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: openpty receives valid output pointers and null optional termios/winsize.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0
    );
    // SAFETY: successful openpty returned two distinct fresh owned descriptors.
    let mut terminal = unsafe { File::from_raw_fd(master) };
    // SAFETY: slave is the other fresh descriptor, now uniquely owned by File.
    let slave = unsafe { File::from_raw_fd(slave) };
    let mut command = Command::new(env!("CARGO_BIN_EXE_opensesame"));
    command
        .env_remove("OPENSESAME_OPERATOR_TOKEN")
        .env("XDG_CONFIG_HOME", root.join("test-client-config"));
    for (name, value) in environment {
        command.env(name, value);
    }
    if store_command {
        command
            .args(["pass", "security"])
            .args(args)
            .arg("--path")
            .arg(root);
    } else {
        command.args(args);
    }
    command
        .stdin(Stdio::from(slave))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: the child hook invokes async-signal-safe syscalls only; descriptor0 is its slave PTY.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut prompts = Vec::new();
    for secret in secrets {
        loop {
            let mut poll = libc::pollfd {
                fd: stderr.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll receives one initialized pollfd owned for this call.
            if unsafe { libc::poll(&mut poll, 1, 10000) } <= 0 {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("human prompt did not arrive");
            }
            let mut byte = [0];
            if stderr.read(&mut byte).unwrap() == 0 {
                let output = child.wait_with_output().unwrap();
                panic!("CLI exited before owner prompt: {:?}", output.status);
            }
            prompts.extend_from_slice(&byte);
            assert!(prompts.len() < 8192);
            if prompts.ends_with(b": ") {
                break;
            }
        }
        await_hidden_input(&terminal);
        terminal.write_all(secret.as_bytes()).unwrap();
        terminal.write_all(b"\r").unwrap();
        terminal.flush().unwrap();
    }
    let mut output = child.wait_with_output().unwrap();
    stderr.read_to_end(&mut prompts).unwrap();
    output.stderr = prompts;
    output
}
pub fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    opensesame_sealed_store::init_store(dir.path(), &[]).unwrap();
    opensesame_sealed_store::init_store_key(dir.path(), b"generated owner").unwrap();
    dir
}
pub fn serve(root: &Path, id: &str, presented: &str, input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_opensesame"))
        .args(["canary", "serve", "--store"])
        .arg(root)
        .args(["--artifact-id", id])
        .env("OPENSESAME_CANARY_TOKEN", presented)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
