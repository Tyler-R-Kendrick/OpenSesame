import Foundation

// Compile with the generated Swift binding and link the real host Rust library.
// This verifies the actual FFI conversion and canonical KDF, not an iOS OS-auth prompt.
@main struct NativeFfiBehavior {
    static func main() throws {
        let now = "2026-10-05T12:00:00.000Z"
        let initial = try nativeGateCreate(password: "previous application password")
        let rotated = try nativeGateChangePassword(record: initial, current: "previous application password", next: "current application password")
        let enrolled = try nativeGateEnroll(record: rotated, current: "current application password", retired: "previous application password", synthetic: true, now: now)
        let admission = try nativeGateAdmit(record: enrolled, password: "previous application password", now: now)
        precondition(admission.realm == .synthetic)
        guard let trap = admission.trapId else { fatalError("Synthetic admission lost its trap context") }
        let interacted = try nativeGateAuthorityDenied(record: admission.record, trapId: trap, now: now)
        let text = try nativeGateStatus(record: interacted)
        precondition(!text.contains("verifier") && !text.contains("salt"))
        precondition(!text.contains("previous application password"))
        guard let json = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let events = json["events"] as? [Any] else { fatalError("Malformed FFI metadata") }
        precondition(events.count == 2)
        do {
            _ = try nativeGateRemove(record: interacted, current: "previous application password", id: trap)
            fatalError("Retired credential regained management authority")
        } catch {}
        let real = try nativeGateAdmit(record: interacted, password: "current application password", now: now)
        precondition(real.realm == .real && real.trapId == nil)
        let cleared = try nativeGateClearEvents(record: interacted, current: "current application password")
        let status = try nativeGateStatus(record: cleared)
        precondition(status.contains("\"events\":[]"))
        print("Swift FFI behavioral checks passed")
    }
}
