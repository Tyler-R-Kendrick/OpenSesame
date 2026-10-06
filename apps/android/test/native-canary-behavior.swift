import CoreFoundation
import Foundation
import OpenSesameAuthenticatorCore

// Uses the generated Swift bridge and actual Rust engine. This is not Apple OS owner proof.
@main struct NativeCanaryBehavior {
    struct Created: Decodable { let id: String; let presentedId: String }
    final class ProbeIssuer: NativeCanaryIssuerProvider, @unchecked Sendable {
        private(set) var calls = 0
        let effect: @Sendable () -> Void
        init(effect: @escaping @Sendable () -> Void = {}) { self.effect = effect }
        func retireAuthenticated(issuerRecordRef: String, expectedVaultIdentity: String) throws -> String {
            calls += 1; effect(); return "{}"
        }
    }
    final class SharedPolicy: @unchecked Sendable {
        private let mutex = NSLock()
        private var current = true
        func replace() { mutex.lock(); current = false; mutex.unlock() }
        func check() throws {
            mutex.lock(); let allowed = current; mutex.unlock()
            guard allowed else { throw NativeGateError.OwnerRequired }
        }
    }
    static func main() throws {
        let witness = NativeIssuerWitness()
        let delegate = ProbeIssuer()
        let guarded = NativeIssuerGuard(delegate: delegate, witness: witness, policyCheck: {})
        witness.revoke()
        do {
            _ = try guarded.retireAuthenticated(issuerRecordRef: UUID().uuidString,
                expectedVaultIdentity: UUID().uuidString)
            fatalError("Revoked owner witness reached issuer transport")
        } catch NativeGateError.OwnerRequired {}
        precondition(delegate.calls == 0)
        let changedPolicy = NativeIssuerGuard(delegate: delegate, witness: NativeIssuerWitness(),
            policyCheck: { throw NativeGateError.OwnerRequired })
        do {
            _ = try changedPolicy.retireAuthenticated(issuerRecordRef: UUID().uuidString,
                expectedVaultIdentity: UUID().uuidString)
            fatalError("Changed shared owner policy reached issuer transport")
        } catch NativeGateError.OwnerRequired {}
        precondition(delegate.calls == 0)
        let sharedPolicy = SharedPolicy()
        let rotatingDelegate = ProbeIssuer(effect: { sharedPolicy.replace() })
        let rotatingGuard = NativeIssuerGuard(delegate: rotatingDelegate, witness: NativeIssuerWitness(),
            policyCheck: { try sharedPolicy.check() })
        do {
            _ = try rotatingGuard.retireAuthenticated(issuerRecordRef: UUID().uuidString,
                expectedVaultIdentity: UUID().uuidString)
            fatalError("Issuer result survived shared owner policy replacement")
        } catch NativeGateError.OwnerRequired {}
        precondition(rotatingDelegate.calls == 1)
        let now = "2026-10-06T00:00:00.000Z"
        let owner = "Swift canary current owner"
        let gate = try nativeGateCreate(password: owner)
        let created = try nativeCanaryManage(gateRecord: gate, current: owner, stateRecord: nil,
            operation: .create(kind: "mcp_configuration"), now: now)
        let artifact = try JSONDecoder().decode(Created.self, from: Data(created.output.utf8))
        let exported = try nativeCanaryManage(gateRecord: gate, current: owner,
            stateRecord: created.stateRecord,
            operation: .exportValidator(artifactId: artifact.id, presentedId: artifact.presentedId), now: now)
        let configuration = try NativeCanaryExport.configuration(artifact: created.output, binding: exported.output)
        struct McpConfig: Decodable { struct Server: Decodable { let command: String; let args: [String] }; let mcpServers: [String: Server] }
        let mcp = try JSONDecoder().decode(McpConfig.self, from: Data(configuration.utf8))
        precondition(mcp.mcpServers["OpenSesameCanary"]?.command == "opensesame-id")
        precondition(mcp.mcpServers["OpenSesameCanary"]?.args == ["canary", "serve", "--config", "<config-file>"])
        precondition(!configuration.contains("independentKeyMaterialB64"))
        let metadata = try nativeCanaryStatus(gateRecord: gate, stateRecord: exported.stateRecord)
        precondition(metadata.contains("artifact_dispatched"))
        precondition(!metadata.contains(artifact.presentedId) && !metadata.contains("digestB64"))
        precondition(!exported.output.contains(artifact.presentedId))
        let admission = try nativeGateAdmit(record: gate, password: artifact.presentedId, now: now)
        precondition(admission.realm == .rejected)
        let observed = try nativeCanaryObserve(gateRecord: gate, stateRecord: exported.stateRecord,
            artifactId: artifact.id, presentedId: artifact.presentedId, phase: "invoked", now: now)
        precondition(observed.observed && observed.decision.contains("synthetic_readonly"))
        do {
            _ = try nativeCanaryManage(gateRecord: gate, current: artifact.presentedId,
                stateRecord: observed.stateRecord, operation: .clearEvents, now: now)
            fatalError("Canary identifier regained owner authority")
        } catch {}
        let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        guard let vector = vector as? [String: Any],
            var provision = vector["provision"] as? [String: Any],
            let publicBytes = vector["publicIndependentKeyBytes"] as? [NSNumber], publicBytes.count == 64 else {
            fatalError("Missing shared public receiver fixture")
        }
        precondition(provision["independentKeyMaterialB64"] == nil)
        let bytes = publicBytes.enumerated().map { index, number -> UInt8 in
            precondition(CFGetTypeID(number) != CFBooleanGetTypeID())
            precondition(number.doubleValue == Double(index))
            return UInt8(index)
        }
        provision["independentKeyMaterialB64"] = Data(bytes).base64EncodedString()
        let provisionText = String(decoding: try JSONSerialization.data(withJSONObject: provision), as: UTF8.self)
        let configured = try nativeCanaryManage(gateRecord: gate, current: owner, stateRecord: observed.stateRecord,
            operation: .configureReceiver(provision: provisionText), now: now)
        let testing = try nativeCanaryManage(gateRecord: gate, current: owner, stateRecord: configured.stateRecord,
            operation: .testReceiver, now: now)
        guard let reserved = try nativeCanaryReserve(gateRecord: gate, stateRecord: testing.stateRecord,
            packageId: testing.output, testing: true, now: now) else { fatalError("Test was not queued") }
        precondition(reserved.destination == "https://receiver.example/v1/credential-observations")
        let dispatch = try nativeCanaryDispatchCurrent(gateRecord: gate, stateRecord: reserved.stateRecord,
            reserved: reserved.reservation, now: now)
        precondition(dispatch)
        let finished = try nativeCanaryFinish(gateRecord: gate, stateRecord: reserved.stateRecord,
            reserved: reserved.reservation, acknowledgement: "{\"ok\":true}", now: now)
        precondition(!finished.delivered)
        do {
            _ = try nativeCanaryManage(gateRecord: gate, current: owner, stateRecord: finished.stateRecord,
                operation: .enableReceiver(enabled: true), now: now)
            fatalError("Unauthenticated acknowledgement enabled receiver")
        } catch {}
        let removed = try nativeCanaryManage(gateRecord: gate, current: owner, stateRecord: finished.stateRecord,
            operation: .removeReceiver, now: now)
        let staleDispatch = try nativeCanaryDispatchCurrent(gateRecord: gate, stateRecord: removed.stateRecord,
            reserved: reserved.reservation, now: now)
        precondition(!staleDispatch)
        let removedStatus = try nativeCanaryStatus(gateRecord: gate, stateRecord: removed.stateRecord)
        precondition(removedStatus.contains("\"receiver\":null"))
        print("Swift actual FFI canary/export/receiver refusal checks passed")
    }
}
