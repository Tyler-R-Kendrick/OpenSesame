import Synchronization

/// Completion and cancellation may race, including before a continuation is installed.
/// All state is Sendable, and every resume occurs after releasing the mutex.
final class NativeOneShotResult<Value: Sendable>: Sendable {
    private struct State: Sendable {
        var finished = false
        var value: Value?
        var continuation: CheckedContinuation<Value?, Never>?
    }
    private let state = Mutex(State())

    func install(_ continuation: CheckedContinuation<Value?, Never>) {
        let finished = state.withLock { value -> (Bool, Value?) in
            if value.finished { return (true, value.value) }
            value.continuation = continuation
            return (false, nil)
        }
        if finished.0 { continuation.resume(returning: finished.1) }
    }

    func finish(_ result: Value?) {
        let pending = state.withLock { value -> CheckedContinuation<Value?, Never>? in
            guard !value.finished else { return nil }
            value.finished = true
            value.value = result
            let pending = value.continuation
            value.continuation = nil
            return pending
        }
        pending?.resume(returning: result)
    }
}
