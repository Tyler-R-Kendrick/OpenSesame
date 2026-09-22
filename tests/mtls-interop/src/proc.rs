//! Bounded child processes and ephemeral loopback ports.
//!
//! Every helper here fails closed: a port is always allocated by the kernel
//! (never a constant), every wait has a deadline, and a [`Child`] kills its
//! process group on drop so a panicking test cannot leave a `nats-server`,
//! `bao`, `spire-agent`, `caddy` or `node` behind.

use std::io::Read as _;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context as _, Result};

/// A loopback port the kernel just handed out. The listener is dropped, so
/// there is a race in principle; in practice the kernel does not hand the
/// same port to two live sockets, and nothing else in this suite binds.
///
/// # Errors
///
/// No loopback port could be bound.
pub fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// A spawned process that is killed when this value drops.
pub struct Child {
    inner: std::process::Child,
    log: PathBuf,
    label: String,
}

impl Child {
    /// Spawn `command`, sending stdout and stderr to `log`.
    ///
    /// # Errors
    ///
    /// The log file could not be created or the program could not be spawned.
    pub fn spawn(label: &str, command: &mut Command, log: &Path) -> Result<Self> {
        let out =
            std::fs::File::create(log).with_context(|| format!("create {}", log.display()))?;
        let err = out.try_clone()?;
        let inner = command
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
            .with_context(|| format!("spawn {label}"))?;
        Ok(Self {
            inner,
            log: log.to_path_buf(),
            label: label.to_string(),
        })
    }

    /// Everything the child has written so far.
    #[must_use]
    pub fn log(&self) -> String {
        let mut buf = String::new();
        if let Ok(mut file) = std::fs::File::open(&self.log) {
            let _ = file.read_to_string(&mut buf);
        }
        buf
    }

    /// Has the child already exited?
    #[must_use]
    pub fn exited(&mut self) -> bool {
        matches!(self.inner.try_wait(), Ok(Some(_)))
    }

    /// Kill it now (the drop guard does the same thing).
    pub fn stop(&mut self) {
        let _ = self.inner.kill();
        let _ = self.inner.wait();
    }

    /// Wait until `port` accepts a TCP connection, or fail with the log.
    ///
    /// # Errors
    ///
    /// The deadline passed, or the child exited first.
    pub fn wait_for_port(&mut self, port: u16, bound: Duration) -> Result<()> {
        let deadline = Instant::now() + bound;
        while Instant::now() < deadline {
            if std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse()?,
                Duration::from_millis(200),
            )
            .is_ok()
            {
                return Ok(());
            }
            if self.exited() {
                bail!("{} exited before listening\n{}", self.label, self.log());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        bail!(
            "{} did not listen on {port} within {bound:?}\n{}",
            self.label,
            self.log()
        )
    }

    /// Wait until the child's log contains `needle`.
    ///
    /// # Errors
    ///
    /// The deadline passed.
    pub fn wait_for_log(&mut self, needle: &str, bound: Duration) -> Result<()> {
        let deadline = Instant::now() + bound;
        while Instant::now() < deadline {
            if self.log().contains(needle) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        bail!(
            "{} never logged {needle:?} within {bound:?}\n{}",
            self.label,
            self.log()
        )
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.inner.kill();
        let _ = self.inner.wait();
    }
}

/// Run a command to completion under a deadline, returning
/// `(exit code or None when killed, stdout, stderr)`.
///
/// # Errors
///
/// The program could not be spawned.
pub fn run_bounded(
    command: &mut Command,
    bound: Duration,
) -> Result<(Option<i32>, String, String)> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("spawn")?;
    let deadline = Instant::now() + bound;
    loop {
        if let Some(status) = child.try_wait()? {
            let out = child.wait_with_output()?;
            return Ok((
                status.code(),
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let out = child.wait_with_output()?;
            return Ok((
                None,
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
