
// Deterministically model a child forked by another thread while a writer
// holds the lock. The child performs only async-signal-safe syscalls until exit.
#[cfg(target_os = "linux")]
#[test]
fn inherited_description_cannot_keep_released_store_guard_locked() {
    let root = tempfile::tempdir().unwrap();
    let guard = super::super::StoreLock::shared(root.path()).unwrap();
    let mut pipe = [0; 2];
    // SAFETY: pipe points to two valid file descriptor slots.
    assert_eq!(unsafe { libc::pipe2(pipe.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
    // SAFETY: after fork, the child uses only close/read/_exit until termination.
    let child = unsafe { libc::fork() };
    if child == 0 {
        // SAFETY: these are inherited descriptors and only async-signal-safe
        // calls run in the child of the multithreaded test process.
        unsafe {
            libc::close(pipe[1]);
            let mut byte = 0u8;
            let received = libc::read(pipe[0], (&raw mut byte).cast(), 1);
            libc::close(pipe[0]);
            libc::_exit(if received == 1 { 0 } else { 2 });
        }
    }
    assert!(child > 0, "fork failed");
    // SAFETY: parent owns this inherited pipe descriptor.
    assert_eq!(unsafe { libc::close(pipe[0]) }, 0);
    drop(guard);
    let exclusive = super::super::StoreLock::exclusive(root.path());
    let acquired = exclusive.is_ok();
    drop(exclusive);
    let byte = 1u8;
    // Release and reap the child before asserting, including the expected
    // failing pre-fix case. No sleeps or retries mask lock behavior.
    // SAFETY: live pipe, a valid one-byte buffer, and a child pid from fork.
    let sent = unsafe { libc::write(pipe[1], (&raw const byte).cast(), 1) };
    let closed = unsafe { libc::close(pipe[1]) };
    let mut status = 0;
    let waited = unsafe { libc::waitpid(child, &raw mut status, 0) };
    assert_eq!(sent, 1);
    assert_eq!(closed, 0);
    assert_eq!(waited, child);
    assert!(libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0);
    assert!(acquired, "LOCK_INHERITANCE_REGRESSION: dropped guard remains locked by forked child");
}

// A child dropping its inherited guard must never unlock the parent's guard.
#[cfg(target_os = "linux")]
#[test]
fn forked_child_drop_must_not_unlock_parent_store_guard() {
    let root = tempfile::tempdir().unwrap();
    let guard = super::super::StoreLock::shared(root.path()).unwrap();
    let mut ready = [0; 2];
    let mut release = [0; 2];
    // SAFETY: each pipe points to two writable descriptor slots.
    assert_eq!(unsafe { libc::pipe2(ready.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
    assert_eq!(unsafe { libc::pipe2(release.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
    // SAFETY: the child drops only the inherited File (and, in the proposed
    // fix, invokes getpid/flock), then uses only pipe syscalls and _exit.
    let child = unsafe { libc::fork() };
    if child == 0 {
        drop(guard);
        // SAFETY: these are inherited descriptors and valid byte buffers.
        unsafe {
            libc::close(ready[0]);
            libc::close(release[1]);
            let byte = 1u8;
            let sent = libc::write(ready[1], (&raw const byte).cast(), 1);
            let mut ack = 0u8;
            let received = libc::read(release[0], (&raw mut ack).cast(), 1);
            libc::close(ready[1]);
            libc::close(release[0]);
            libc::_exit(if sent == 1 && received == 1 { 0 } else { 2 });
        }
    }
    assert!(child > 0, "fork failed");
    // SAFETY: parent owns its ends of both inherited pipes.
    unsafe { libc::close(ready[1]); libc::close(release[0]); }
    let mut byte = 0u8;
    // SAFETY: descriptor and one-byte buffer are valid.
    let received = unsafe { libc::read(ready[0], (&raw mut byte).cast(), 1) };
    let busy = super::super::StoreLock::exclusive(root.path()).is_err();
    drop(guard);
    let acquired_after_drop = super::super::StoreLock::exclusive(root.path()).is_ok();
    let sent = unsafe { libc::write(release[1], (&raw const byte).cast(), 1) };
    unsafe { libc::close(ready[0]); libc::close(release[1]); }
    let mut status = 0;
    let waited = unsafe { libc::waitpid(child, &raw mut status, 0) };
    assert_eq!(received, 1);
    assert_eq!(sent, 1);
    assert_eq!(waited, child);
    assert!(libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0);
    assert!(busy, "forked child released its parent's still-held lock");
    assert!(acquired_after_drop, "parent drop did not release its lock");
}
