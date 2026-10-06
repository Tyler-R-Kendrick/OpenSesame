//! Request cancellation owns child handles, including protected-store authentication helpers.
use std::{
    cell::RefCell,
    io::Read,
    process::{Child, ExitStatus},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
type Handle = Arc<Mutex<Child>>;
#[derive(Default)]
pub(super) struct Cancellation {
    cancelled: AtomicBool,
    children: Mutex<Vec<Weak<Mutex<Child>>>>,
}
pub(super) struct CancellationGuard(pub Arc<Cancellation>);
impl Drop for CancellationGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
impl Cancellation {
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let children = lock(&self.children).clone();
        for child in children.into_iter().filter_map(|c| c.upgrade()) {
            let mut handle = lock(&child);
            let _ = handle.kill();
            let _ = handle.wait();
        }
    }
    fn track(&self, child: &Handle) {
        lock(&self.children).push(Arc::downgrade(child));
        if self.cancelled.load(Ordering::SeqCst) {
            let mut handle = lock(child);
            let _ = handle.kill();
            let _ = handle.wait();
        }
    }
}
thread_local! { static CONTEXT:RefCell<Option<(Arc<Cancellation>,Instant)>>=const { RefCell::new(None) }; }
pub(super) fn scoped<T>(
    cancellation: Arc<Cancellation>,
    deadline: Instant,
    operation: impl FnOnce() -> T,
) -> T {
    CONTEXT.with(|context| context.replace(Some((cancellation, deadline))));
    let result = operation();
    CONTEXT.with(|context| context.replace(None));
    result
}
pub(super) struct Captured {
    pub status: ExitStatus,
    pub stdout: zeroize::Zeroizing<Vec<u8>>,
}
pub(super) fn capture(mut child: Child, deadline: Option<Instant>) -> anyhow::Result<Captured> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("Private helper unavailable"))?;
    let child = Arc::new(Mutex::new(child));
    let context = CONTEXT.with(|context| context.borrow().clone());
    let deadline = match (deadline, context.as_ref()) {
        (Some(a), Some((_, b))) => Some(a.min(*b)),
        (None, Some((_, b))) => Some(*b),
        (a, None) => a,
    };
    if let Some((cancellation, _)) = context {
        cancellation.track(&child);
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        let result = stdout.take(65537).read_to_end(&mut bytes).map(|_| bytes);
        let _ = sender.send(result);
    });
    let status = loop {
        if let Some(status) = lock(&child).try_wait()? {
            break status;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            let mut handle = lock(&child);
            let _ = handle.kill();
            let _ = handle.wait();
            anyhow::bail!("Private helper deadline exceeded; any claimed use remains consumed");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let output = if let Some(deadline) = deadline {
        receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| {
                anyhow::anyhow!(
                    "Private helper deadline exceeded; any claimed use remains consumed"
                )
            })?
    } else {
        receiver
            .recv()
            .map_err(|_| anyhow::anyhow!("Private helper read failed"))?
    };
    let stdout = output.map_err(|_| anyhow::anyhow!("Private helper read failed"))?;
    anyhow::ensure!(
        stdout.len() <= 65536,
        "Private helper response exceeds its bound"
    );
    Ok(Captured { status, stdout })
}
