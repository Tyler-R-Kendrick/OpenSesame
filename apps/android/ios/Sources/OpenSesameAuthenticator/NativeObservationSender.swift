import Foundation
import OpenSesameAuthenticatorCore

/// This capability emits only pre-enrolled sealed metadata; it has no real wallet principal.
@MainActor
enum NativeObservationSender {
    private static var active: [UUID: NativeObservationTransport] = [:]
    private static var pumping = false
    static func cancelAll() { for request in active.values { request.cancel() } }
    static func pump() {
        guard !pumping else { return }
        pumping = true
        Task {
            defer { pumping = false }
            for _ in 0..<2 {
                do { if !(try await deliver(packageId: nil, testing: false, ownerCheck: nil)) { break } }
                catch { break }
            }
        }
    }
    static func deliver(packageId: String?, testing: Bool, ownerCheck: (() throws -> Void)?) async throws -> Bool {
        guard active.count < 4 else { return false }
        try ownerCheck?()
        let reserved: NativeCanaryDelivery? = try NativeGateStorage.observationTransaction { gate, state in
            let candidate = try nativeCanaryReserve(gateRecord: gate, stateRecord: state,
                packageId: packageId, testing: testing, now: NativeObservationClock.now())
            return (candidate?.stateRecord, candidate)
        }
        guard let reserved else { return false }
        let request = NativeObservationTransport()
        let id = UUID()
        defer { active.removeValue(forKey: id) }
        let started: Bool = try NativeGateStorage.observationTransaction { gate, state in
            try ownerCheck?()
            guard try nativeCanaryDispatchCurrent(gateRecord: gate, stateRecord: state,
                reserved: reserved.reservation, now: NativeObservationClock.now()) else { return (nil, false) }
            active[id] = request
            // Start synchronously while local revocation is excluded; await after releasing the lock.
            try request.start(destination: reserved.destination, packet: reserved.packet)
            return (nil, true)
        }
        guard started else { return false }
        let acknowledgement: String?
        do { acknowledgement = try await request.acknowledgement() }
        catch { acknowledgement = nil }
        try ownerCheck?()
        return try NativeGateStorage.observationTransaction { gate, state in
            try ownerCheck?()
            let result = try nativeCanaryFinish(gateRecord: gate, stateRecord: state,
                reserved: reserved.reservation, acknowledgement: acknowledgement, now: NativeObservationClock.now())
            return (result.stateRecord, result.delivered)
        }
    }
}
