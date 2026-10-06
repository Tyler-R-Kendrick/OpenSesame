import Foundation

public enum NativeSession: Equatable {
    case locked
    case real(UInt64)
    case synthetic(UInt64)
}

@MainActor
public final class NativeRealmState {
    public private(set) var session: NativeSession = .locked
    private var generation: UInt64 = 0
    public init() {}
    @discardableResult public func lock() -> UInt64 {
        generation &+= 1
        session = .locked
        return generation
    }
    public func admitReal(_ epoch: UInt64) throws {
        guard epoch == generation, session == .locked else { throw NativeRealmError.denied }
        session = .real(epoch)
    }
    public func admitSynthetic(_ epoch: UInt64) throws {
        guard epoch == generation, session == .locked else { throw NativeRealmError.denied }
        session = .synthetic(epoch)
    }
    public func requireReal() throws -> UInt64 {
        guard case let .real(epoch) = session else { throw NativeRealmError.denied }
        return epoch
    }
    public func requireSame(_ epoch: UInt64) throws {
        guard session == .real(epoch) else { throw NativeRealmError.denied }
    }
}

public enum NativeRealmError: Error { case denied }
