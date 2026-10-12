use super::*;

#[test]
fn the_first_signal_that_ends_a_run_is_the_one_reported() {
    install().unwrap();
    assert_eq!(pending(), None, "nothing has been signalled");
    // SAFETY: `raise` signals the calling thread; the handler installed above
    // runs before it returns and only stores to an atomic.
    unsafe { libc::raise(libc::SIGHUP) };
    assert_eq!(pending(), Some(libc::SIGHUP));
    // SAFETY: as above.
    unsafe { libc::raise(libc::SIGTERM) };
    assert_eq!(pending(), Some(libc::SIGHUP), "the first one stands");
}

#[test]
fn signals_are_named_the_way_a_shell_names_them() {
    assert_eq!(name(libc::SIGTERM), "SIGTERM");
    assert_eq!(name(libc::SIGHUP), "SIGHUP");
    assert_eq!(name(libc::SIGKILL), "SIGKILL");
    assert_eq!(name(40), "signal 40");
}

#[test]
fn only_termination_and_hangup_end_a_run() {
    // Ctrl-C reaches the child through the terminal's process group, so
    // SIGINT stays with its default action.
    assert_eq!(unix::ENDING, [libc::SIGTERM, libc::SIGHUP]);
}
