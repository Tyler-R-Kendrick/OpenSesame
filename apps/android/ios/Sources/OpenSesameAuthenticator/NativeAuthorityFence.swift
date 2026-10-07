import Foundation

/// One admitted principal's descendants. No operation or returned value survives revocation.
/// The optional validator also enforces the provider's persisted generation and expiry.
final class NativeAuthorityFence: @unchecked Sendable {
    private let mutex = NSRecursiveLock()
    private var revoked = false
    private var cancellers: [UUID: () -> Void] = [:]
    private let validate: @Sendable () throws -> Void
    private let denied: @Sendable () -> Error

    init(denied: @escaping @Sendable () -> Error = { NativeAuthorityError.denied },
         validate: @escaping @Sendable () throws -> Void = {}) {
        self.denied = denied
        self.validate = validate
    }

    func withCurrent<T>(_ operation: () throws -> T) throws -> T {
        mutex.lock()
        defer { mutex.unlock() }
        guard !revoked else { throw denied() }
        do { try validate() } catch { throw denied() }
        return try operation()
    }

    func addCancellation(_ cancel: @escaping () -> Void) -> UUID? {
        do {
            return try withCurrent {
                let id = UUID()
                cancellers[id] = cancel
                return id
            }
        } catch { cancel(); return nil }
    }

    func removeCancellation(_ id: UUID?) {
        guard let id else { return }
        mutex.lock(); cancellers.removeValue(forKey: id); mutex.unlock()
    }

    func revoke() {
        mutex.lock()
        revoked = true
        let pending = Array(cancellers.values)
        cancellers.removeAll()
        mutex.unlock()
        for cancel in pending { cancel() }
    }

    /// Start synchronously under revocation exclusion; check again before handing data back.
    func perform<T>(_ start: (@escaping (T?, Error?) -> Void) -> Void,
                    completion: @escaping (T?, Error?) -> Void) {
        do {
            try withCurrent {
                start { value, error in
                    do { try self.withCurrent { completion(value, error) } }
                    catch { completion(nil, error) }
                }
            }
        } catch { completion(nil, error) }
    }

    func performVoid(_ start: (@escaping (Error?) -> Void) -> Void,
                     completion: @escaping (Error?) -> Void) {
        perform({ done in start { done(true, $0) } }, completion: { (_: Bool?, error) in completion(error) })
    }
}

enum NativeAuthorityError: Error { case denied }
