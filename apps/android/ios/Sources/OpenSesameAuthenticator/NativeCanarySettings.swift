import SwiftUI
import OpenSesameAuthenticatorCore

struct NativeCanarySettings: View {
    let admission: WalletAdmission
    @State private var current = ""
    @State private var provisioning = ""
    @State private var approvedOrigin = ""
    @State private var selectedId = ""
    @State private var presentedId = ""
    @State private var issuerRecordRef = ""
    private struct Preview: Decodable { let receiverId: String; let origin: String }
    private var preview: Preview? { try? JSONDecoder().decode(Preview.self, from: Data(provisioning.utf8)) }
    private var ownerReady: Bool { admission.configured && !admission.busy && !current.isEmpty }

    var body: some View {
        Section("Security · Decoy · Controlled canaries") {
            Text("Local detection only. These identifiers grant no real wallet or production account access. Exported MCP bindings require explicit installation in the human CLI validator.")
            SecureField("Current application password for canaries", text: $current)
            Button("Create controlled MCP canary") { run(.create(kind: "mcp_configuration")) }
                .disabled(!ownerReady || admission.canaryStatus.artifacts.count >= 16)
            if admission.issuerProvider == nil {
                Text("Issued generation detection is unavailable until an authenticated Host provider is installed. Device and application passwords do not authorize the Host.")
            } else {
                TextField("Issued Host record UUID", text: $issuerRecordRef).textInputAutocapitalization(.never)
                Button("Revoke issued authority and enroll detection") {
                    let password = current; let reference = issuerRecordRef
                    current = ""; issuerRecordRef = ""
                    Task { await admission.retireIssued(current: password, issuerRecordRef: reference) }
                }.disabled(!ownerReady || UUID(uuidString: issuerRecordRef) == nil)
            }
            Text("Controlled canaries: \(admission.canaryStatus.artifacts.count)/16")
            ForEach(admission.canaryStatus.artifacts) { artifact in
                Text("\(artifact.context.kind) · generation \(artifact.context.generation)")
                Text(artifact.id)
                Button("Remove controlled canary") { run(.remove(artifactId: artifact.id)) }.disabled(!ownerReady)
            }
            Text("Observations: \(admission.canaryStatus.events.count)/64")
            ForEach(Array(admission.canaryStatus.events.enumerated()), id: \.offset) { _, event in
                Text("\(event.phase) · \(event.at)")
            }
            Button("Clear canary evidence") { run(.clearEvents) }.disabled(!ownerReady)
            TextField("Selected canary artifact ID", text: $selectedId).textInputAutocapitalization(.never)
            SecureField("Once-issued controlled identifier", text: $presentedId)
            Button("Export validator binding") {
                let id = selectedId; let token = presentedId
                selectedId = ""; presentedId = ""
                run(.exportValidator(artifactId: id, presentedId: token))
            }.disabled(!ownerReady || selectedId.isEmpty || presentedId.isEmpty)
            if let export = admission.canaryExport {
                Text("One-time controlled artifact export. Save it before leaving; retained detector state contains no presented identifier.")
                ShareLink("Share controlled artifact", item: export)
                Text("For an MCP configuration, save an owner-private file (chmod 600 FILE on Unix), then run opensesame-id canary install --config FILE --trust-configuration. The installed offline detector is revoked separately with opensesame-id canary uninstall --config FILE.")
            }
        }
        Section("Optional sealed observation receiver") {
            Text("Detection keys use device-only Keychain protection and cannot unlock real wallet documents. Independent delivery requires a supplied reachable receiver and its pairing material.")
            SecureField("Receiver pairing JSON", text: $provisioning)
            if let preview { Text("\(preview.receiverId) · \(preview.origin)") }
            TextField("Approved receiver origin", text: $approvedOrigin).textInputAutocapitalization(.never)
            Button("Import approved receiver") {
                let raw = provisioning; provisioning = ""; approvedOrigin = ""
                run(.configureReceiver(provision: raw))
            }.disabled(!ownerReady || preview == nil || preview?.origin != approvedOrigin || provisioning.utf8.count > 8_192)
            if let receiver = admission.canaryStatus.receiver {
                Text("\(receiver.receiverId) · \(receiver.origin)")
                Text("\(receiver.verified ? "Verified" : "Unverified") · \(receiver.enabled ? "Enabled" : "Disabled")")
                Text("Queued: \(admission.canaryStatus.queued) · Failed attempts: \(admission.canaryStatus.failed)")
                Button("Test sealed delivery") { run(.testReceiver) }.disabled(!ownerReady)
                Button(receiver.enabled ? "Disable sealed delivery" : "Enable sealed delivery") {
                    run(.enableReceiver(enabled: !receiver.enabled))
                }.disabled(!ownerReady || (!receiver.enabled && !receiver.verified))
                Button("Remove receiver and unsent packages") { run(.removeReceiver) }.disabled(!ownerReady)
            }
            Text("Authenticated acknowledgements prove delivery. Offline attempts remain queued. Removing or disabling drops unsent packages; requests already emitted cannot be recalled.")
        }
    }
    private func run(_ mutation: NativeCanaryMutation) {
        let password = current; current = ""
        Task { await admission.manageCanary(current: password, mutation: mutation) }
    }
}
