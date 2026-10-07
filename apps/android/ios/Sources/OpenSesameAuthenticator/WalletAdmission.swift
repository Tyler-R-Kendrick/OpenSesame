import Foundation
@preconcurrency import Multipaz
import Observation
import OpenSesameAuthenticatorCore

@MainActor
@Observable
public final class WalletAdmission {
    public private(set) var session: NativeSession = .locked
    public private(set) var configured = false
    public private(set) var busy = false
    public private(set) var status = NativeGateStatus()
    public private(set) var message: String?
    var canaryStatus = NativeCanaryStatus()
    var canaryExport: String?
    var issuerWitness: NativeIssuerWitness?
    private let realms = NativeRealmState()
    private var activeTrap: String?
    // A trusted operator-installed adapter authenticates the Host separately. No UI can inject JSON.
    let issuerProvider: (any NativeCanaryIssuerProvider)?

    public init(issuerProvider: (any NativeCanaryIssuerProvider)? = nil) {
        self.issuerProvider = issuerProvider
    }
    public func start() {
        lock()
        do { configured = try NativeGateStorage.read("record") != nil; NativeObservationSender.pump() }
        catch { message = "Wallet gate unavailable" }
    }
    public func lock() {
        issuerWitness?.revoke(); issuerWitness = nil
        NativeObservationSender.cancelAll()
        canaryExport = nil
        activeTrap = nil
        realms.lock()
        session = .locked
        do { try NativeGateStorage.clearPresentationGrant() }
        catch { message = "Wallet gate unavailable" }
    }
    public func requireReal() throws -> UInt64 { try realms.requireReal() }
    public func requireSame(_ epoch: UInt64) throws { try realms.requireSame(epoch) }
    func authorityFence(_ epoch: UInt64) throws -> NativeAuthorityFence {
        try realms.authorityFence(epoch, denied: {
            CancellationException(message: "Wallet admission ended", cause: nil).asError()
        })
    }

    public func unlock(_ password: String) async {
        guard !busy else { return }
        busy = true
        message = nil
        defer { busy = false }
        lock()
        let epoch = realms.lock()
        do {
            if let record = try NativeGateStorage.read("record") {
                let admission = try await Task.detached {
                    try nativeGateAdmit(record: record, password: password, now: ISO8601DateFormatter().string(from: Date()))
                }.value
                try NativeGateStorage.replaceRecord(expected: record, next: admission.record)
                if admission.trapId != nil { queuePasswordObservation() }
                if admission.realm == .synthetic {
                    try realms.admitSynthetic(epoch)
                    activeTrap = admission.trapId
                    session = realms.session
                    return
                }
                guard admission.realm == .real else { throw NativeRealmError.denied }
            }
            try await NativeGateStorage.ownerProof()
            try realms.admitReal(epoch)
            try NativeGateStorage.authorizePresentation()
            session = realms.session
            try refresh()
        } catch {
            lock()
            message = "Wallet could not be unlocked"
        }
    }
    public func observeDenied() {
        guard case .synthetic = session, let id = activeTrap else { return }
        do {
            guard let record = try NativeGateStorage.read("record") else { return }
            let next = try nativeGateAuthorityDenied(record: record, trapId: id, now: ISO8601DateFormatter().string(from: Date()))
            try NativeGateStorage.replaceRecord(expected: record, next: next)
            queuePasswordObservation()
        } catch { /* Evidence is best effort and never grants authority. */ }
    }
    public func refresh() throws {
        _ = try requireReal()
        configured = try NativeGateStorage.read("record") != nil
        if let record = try NativeGateStorage.read("record") {
            let text = try nativeGateStatus(record: record)
            status = try JSONDecoder().decode(NativeGateStatus.self, from: Data(text.utf8))
            let state = try NativeGateStorage.read(NativeGateStorage.observationAccount)
            let canaries = try nativeCanaryStatus(gateRecord: record, stateRecord: state)
            canaryStatus = try JSONDecoder().decode(NativeCanaryStatus.self, from: Data(canaries.utf8))
        } else { status = NativeGateStatus() }
    }
    public func setup(_ password: String) async {
        await operation { epoch in
            guard try NativeGateStorage.read("record") == nil else { throw NativeRealmError.denied }
            let next = try await Task.detached { try nativeGateCreate(password: password) }.value
            try self.requireSame(epoch)
            try NativeGateStorage.replaceRecord(expected: nil, next: next)
        }
    }
    public func enroll(current: String, retired: String, synthetic: Bool) async {
        await manage(current: current) { record in
            try nativeGateEnroll(record: record, current: current, retired: retired, synthetic: synthetic, now: ISO8601DateFormatter().string(from: Date()))
        }
    }
    public func remove(current: String, id: String) async {
        await manage(current: current) { try nativeGateRemove(record: $0, current: current, id: id) }
    }
    public func clear(current: String) async {
        await manage(current: current) { try nativeGateClearEvents(record: $0, current: current) }
    }
    public func changePassword(current: String, next: String) async {
        await manage(current: current) { try nativeGateChangePassword(record: $0, current: current, next: next) }
    }
    private func manage(current: String, change: @escaping @Sendable (String) throws -> String) async {
        await operation { epoch in
            guard let record = try NativeGateStorage.read("record") else { throw NativeRealmError.denied }
            let next = try await Task.detached { try change(record) }.value
            try self.requireSame(epoch)
            try NativeGateStorage.replaceRecord(expected: record, next: next)
        }
    }
    func operation(_ change: (UInt64) async throws -> Void) async {
        guard !busy else { return }
        busy = true
        message = nil
        defer { busy = false }
        do {
            let epoch = try requireReal()
            try await NativeGateStorage.ownerProof()
            try requireSame(epoch)
            try await change(epoch)
            try requireSame(epoch)
            try refresh()
        } catch { message = "Owner verification or operation failed" }
    }
}

public struct NativeGateStatus: Decodable {
    public struct Trap: Decodable, Identifiable { public let id: String; public let response: String }
    public struct Event: Decodable { public let type: String; public let at: String }
    public var traps: [Trap] = []
    public var events: [Event] = []
}
