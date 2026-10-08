import Foundation
import OpenSesameAuthenticatorCore

struct NativeCanaryStatus: Decodable {
    struct Artifact: Decodable, Identifiable {
        struct Context: Decodable { let vaultIdentity: String; let kind: String; let generation: UInt32 }
        let id: String; let context: Context; let state: String
    }
    struct Event: Decodable { let artifactId: String; let phase: String; let at: String }
    struct Receiver: Decodable {
        let receiverId: String; let bindingId: String; let origin: String
        let keyEpoch: UInt32; let expiresAt: String; let enabled: Bool; let verified: Bool
    }
    var artifacts: [Artifact] = []
    var events: [Event] = []
    var receiver: Receiver?
    var queued = 0
    var failed = 0
}

enum NativeObservationClock {
    static func now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

extension WalletAdmission {
    func retireIssued(current: String, issuerRecordRef: String) async {
        guard let provider = issuerProvider else { return }
        await operation { epoch in
            guard let gate = try NativeGateStorage.read("record") else { throw NativeStorageError.ownerRequired }
            let state = try NativeGateStorage.read(NativeGateStorage.observationAccount)
            let witness = NativeIssuerWitness()
            self.issuerWitness = witness
            defer { witness.revoke(); self.issuerWitness = nil }
            let guarded = NativeIssuerGuard(delegate: provider, witness: witness, policyCheck: {
                guard try NativeGateStorage.read("record") == gate else {
                    throw NativeGateError.OwnerRequired
                }
            })
            let result = try await Task.detached {
                try nativeCanaryRetireIssued(gateRecord: gate, current: current, stateRecord: state,
                    issuerRecordRef: issuerRecordRef, provider: guarded, now: NativeObservationClock.now())
            }.value
            try self.requireSame(epoch)
            try NativeGateStorage.replaceDetection(expectedGate: gate, expectedState: state,
                nextGate: result.gateRecord, nextState: result.stateRecord)
            try self.requireSame(epoch)
        }
    }
    func manageCanary(current: String, mutation: NativeCanaryMutation) async {
        canaryExport = nil
        await operation { epoch in
            guard let gate = try NativeGateStorage.read("record") else { throw NativeStorageError.ownerRequired }
            let state = try NativeGateStorage.read(NativeGateStorage.observationAccount)
            let result = try await Task.detached {
                let created = try nativeCanaryManage(gateRecord: gate, current: current, stateRecord: state,
                    operation: mutation, now: NativeObservationClock.now())
                if case .create(let kind) = mutation, kind == "mcp_configuration" {
                    struct Created: Decodable { let id: String; let presentedId: String }
                    let artifact = try JSONDecoder().decode(Created.self, from: Data(created.output.utf8))
                    let exported = try nativeCanaryManage(gateRecord: created.gateRecord, current: current,
                        stateRecord: created.stateRecord,
                        operation: .exportValidator(artifactId: artifact.id, presentedId: artifact.presentedId),
                        now: NativeObservationClock.now())
                    return NativeCanaryOwnerResult(gateRecord: exported.gateRecord, stateRecord: exported.stateRecord,
                        output: try NativeCanaryExport.configuration(artifact: created.output, binding: exported.output))
                }
                return created
            }.value
            try self.requireSame(epoch)
            switch mutation {
            case .configureReceiver, .removeReceiver, .enableReceiver(enabled: false):
                NativeObservationSender.cancelAll()
            default: break
            }
            try NativeGateStorage.replaceDetection(expectedGate: gate, expectedState: state,
                nextGate: result.gateRecord, nextState: result.stateRecord)
            try self.requireSame(epoch)
            if case .testReceiver = mutation {
                guard !result.output.isEmpty else { throw NativeStorageError.unavailable }
                let delivered = try await NativeObservationSender.deliver(packageId: result.output,
                    testing: true, ownerCheck: { try self.requireSame(epoch) })
                try self.requireSame(epoch)
                guard delivered else { throw NativeStorageError.unavailable }
            } else if !result.output.isEmpty { self.canaryExport = result.output }
            NativeObservationSender.pump()
        }
    }
    func queuePasswordObservation() {
        do {
            guard try NativeGateStorage.read(NativeGateStorage.observationAccount) != nil else { return }
            try NativeGateStorage.observationTransaction { gate, state in
                let next = try nativeCanaryQueueLatestPassword(gateRecord: gate, stateRecord: state,
                    now: NativeObservationClock.now())
                return (next, ())
            }
            NativeObservationSender.pump()
        } catch { /* Optional sealed delivery never changes admission or local password evidence. */ }
    }
}
