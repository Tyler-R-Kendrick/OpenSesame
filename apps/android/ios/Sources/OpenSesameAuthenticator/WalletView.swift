import Multipaz
import OpenSesameAuthenticatorCore
import SwiftUI

public struct WalletView: View {
    @State private var admission = WalletAdmission()
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: WalletModel?
    @State private var password = ""
    private let appGroup: String
    private let backendURL: URL
    private let invocationOrigin: String

    public init(appGroup: String, backendURL: URL, invocationOrigin: String = "https://auth.opensesame.dev", issuerProvider: (any NativeCanaryIssuerProvider)? = nil) {
        _admission = State(initialValue: WalletAdmission(issuerProvider: issuerProvider))
        self.appGroup = appGroup
        self.backendURL = backendURL
        self.invocationOrigin = invocationOrigin
    }
    public var body: some View {
        NavigationStack {
            Group {
                switch admission.session {
                case .locked:
                    Form {
                        Text("Unlock OpenSesame")
                        if admission.busy { ProgressView("Verifying owner…") }
                        if admission.configured { SecureField("Application password", text: $password) }
                        Text("Real wallet access also requires device owner verification.")
                        Button("Unlock") {
                            let submitted = password; password = ""
                            Task {
                                await admission.unlock(submitted)
                                if case .real = admission.session {
                                    let opened = WalletModel()
                                    model = opened
                                    await opened.initialize(appGroup: appGroup, backendURL: backendURL, admission: admission)
                                }
                            }
                        }.disabled(admission.busy || (admission.configured && password.isEmpty))
                        admission.message.map { Text($0) }
                    }
                case .synthetic:
                    List {
                        Text("Example membership · member@example.invalid")
                        Text("Example credential · issued by Example organization")
                    }.navigationTitle("OpenSesame wallet")
                case .real:
                    if let model, let error = model.error {
                        ContentUnavailableView("Wallet unavailable", systemImage: "exclamationmark.shield", description: Text(error.localizedDescription))
                    } else if let model, model.ready {
                        ProvisioningView(provisioningModel: model.provisioningModel, waitForRedirectLinkInvocation: { state in
                            await model.waitForRedirect(state: state)
                        })
                    } else { ProgressView("Opening encrypted wallet…") }
                }
            }
            .toolbar {
                if case .real = admission.session {
                    NavigationLink("Security") { NativeSecurityView(admission: admission) }
                }
                if admission.session != .locked { Button("Lock") { lock() } }
            }
        }
        .task { admission.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { NativeObservationSender.pump() }
        }
        .onDisappear { lock() }
        .onOpenURL { url in
            guard case .real = admission.session, let model else { admission.observeDenied(); return }
            if url.path.hasSuffix("/callback") {
                model.receiveRedirect(url)
            } else if url.scheme == "openid-credential-offer" || url.scheme == "haip-vci" {
                model.launch(offerURI: url.absoluteString)
            } else if url.scheme == "https", let invocation = try? validatePlatformInvocation(authenticatorOrigin: invocationOrigin, raw: url.absoluteString), invocation.kind == .oid4vci {
                model.launch(offerURI: invocation.protocolUri)
            }
        }
    }
    private func lock() { admission.lock(); model?.lock(); model = nil; password = "" }
}
