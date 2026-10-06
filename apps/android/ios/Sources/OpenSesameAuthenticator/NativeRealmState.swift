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
    private var descendants: [NativeAuthorityFence] = []
    public init() {}
    @discardableResult public func lock() -> UInt64 {
        let pending = descendants
        descendants.removeAll()
        generation &+= 1
        session = .locked
        for fence in pending { fence.revoke() }
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
    func authorityFence(_ epoch: UInt64,
                        denied: @escaping @Sendable () -> Error = { NativeAuthorityError.denied }) throws -> NativeAuthorityFence {
        try requireSame(epoch)
        let fence = NativeAuthorityFence(denied: denied)
        descendants.append(fence)
        return fence
    }
}

public enum NativeRealmError: Error { case denied }
