import SwiftUI

struct NativeSecurityView: View {
    let admission: WalletAdmission
    @State private var current = ""
    @State private var retired = ""
    @State private var nextPassword = ""
    @State private var synthetic = false
    @State private var consent = false

    var body: some View {
        Form {
            if admission.busy { ProgressView("Verifying owner…") }
            Section("Security · Decoy · Retired passwords") {
                Text("This local application password gates wallet admission. It does not re-encrypt wallet document keys or revoke stolen wallet backups.")
                SecureField(admission.configured ? "Current application password" : "New application password", text: $current)
                if !admission.configured {
                    Text("Use a unique application password. Its salted Argon2id verifier is stored under the device key and can become an offline guessing target if extracted.")
                    Button("Set application password") {
                        let password = current; current = ""
                        Task { await admission.setup(password) }
                    }.disabled(current.isEmpty || admission.busy)
                } else {
                    SecureField("New application password", text: $nextPassword)
                    Button("Change application password") {
                        let password = current; let next = nextPassword
                        current = ""; nextPassword = ""
                        Task { await admission.changePassword(current: password, next: next) }
                    }.disabled(current.isEmpty || nextPassword.isEmpty || admission.busy)
                    Text("Selected traps: \(admission.status.traps.count)/3")
                    SecureField("Selected retired password", text: $retired)
                    Toggle("Synthetic decoy", isOn: $synthetic).disabled(admission.busy)
                    Text("Off means record and reject. Stale autofill can trigger observations; they do not confirm an attacker. No freeze or wipe. Optional sealed observation delivery is configured separately.")
                    Toggle("I accept the offline password-guessing risk of retaining a verifier, including passwords reused elsewhere.", isOn: $consent).disabled(admission.busy)
                    Button("Enroll selected retired password") {
                        let password = current; let selected = retired
                        let response = synthetic
                        current = ""; retired = ""
                        Task { await admission.enroll(current: password, retired: selected, synthetic: response) }
                    }.disabled(!consent || current.isEmpty || retired.isEmpty || admission.busy || admission.status.traps.count >= 3)
                    ForEach(admission.status.traps) { trap in
                        Text(trap.response == "synthetic_decoy" ? "Synthetic decoy trap" : "Record and reject trap")
                        Button("Remove trap") {
                            let password = current; current = ""
                            Task { await admission.remove(current: password, id: trap.id) }
                        }.disabled(current.isEmpty || admission.busy)
                    }
                    Text("Local observations: \(admission.status.events.count)/32")
                    ForEach(Array(admission.status.events.enumerated()), id: \.offset) { _, event in
                        Text("\(event.type == "synthetic_decoy_interaction" ? "External authority denied" : "Retired credential observed") · \(event.at)")
                    }
                    Button("Clear local evidence") {
                        let password = current; current = ""
                        Task { await admission.clear(current: password) }
                    }.disabled(current.isEmpty || admission.busy)
                }
                admission.message.map { Text($0) }
            }
            NativeCanarySettings(admission: admission)
        }.navigationTitle("Security")
    }
}
