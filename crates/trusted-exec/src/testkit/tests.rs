use std::process::Command;
use std::sync::Barrier;
use std::thread;

use super::Fixture;

const THREADS: usize = 8;
const ROUNDS: usize = 40;

/// Writes a stub and runs it at once, `ROUNDS` times.
fn write_and_run(barrier: &Barrier) {
    barrier.wait();
    for round in 0..ROUNDS {
        let fixture = Fixture::new("stub");
        let stub = fixture.trusted.join("stub");
        fixture.stub_recorder_saying(&stub, "ran");
        let output = Command::new(&stub)
            .output()
            .unwrap_or_else(|why| panic!("round {round}: {why}"));
        assert_eq!(output.stdout, b"ran", "round {round}");
    }
}

/// A stub run the moment it is written starts, while other threads of the
/// same test binary are starting programs of their own.
#[test]
fn a_stub_runs_the_moment_it_is_written_while_other_threads_start_programs() {
    let barrier = Barrier::new(THREADS);
    thread::scope(|scope| {
        for _ in 0..THREADS {
            scope.spawn(|| write_and_run(&barrier));
        }
    });
}
