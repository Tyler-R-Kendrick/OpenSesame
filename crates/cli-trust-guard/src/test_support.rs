//! In-process mock guard for daemon tests (no root).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use std::os::unix::net::UnixListener;

pub struct MockGuard {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl MockGuard {
    pub fn start(state_root: &Path) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("guard.sock");
        let listener = UnixListener::bind(&socket).expect("bind mock guard");
        listener
            .set_nonblocking(true)
            .expect("nonblocking mock guard");
        let stop = Arc::new(AtomicBool::new(false));
        let state = state_root.to_path_buf();
        let stop_flag = stop.clone();
        let handle = thread::spawn(move || {
            while !stop_flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = server::handle_connection(&mut stream, &state);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            _dir: dir,
            socket,
            stop,
            handle: Some(handle),
        }
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket
    }
}

impl Drop for MockGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

use crate::server;
