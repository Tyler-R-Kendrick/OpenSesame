import Multipaz
import OpenSesameAuthenticatorCore
import SwiftUI

public struct WalletView: View {
    @State private var model = WalletModel()
    private let appGroup: String
    private let backendURL: URL
    private let invocationOrigin: String

    public init(
        appGroup: String,
        backendURL: URL,
        invocationOrigin: String = "https://auth.opensesame.dev"
    ) {
        self.appGroup = appGroup
        self.backendURL = backendURL
        self.invocationOrigin = invocationOrigin
    }

    public var body: some View {
        Group {
            if let error = model.error {
                ContentUnavailableView("Wallet unavailable", systemImage: "exclamationmark.shield", description: Text(error.localizedDescription))
            } else if model.ready {
                ProvisioningView(
                    provisioningModel: model.provisioningModel,
                    waitForRedirectLinkInvocation: { state in
                        await model.waitForRedirect(state: state)
                    }
                )
            } else {
                ProgressView("Opening encrypted wallet…")
            }
        }
        .task { await model.initialize(appGroup: appGroup, backendURL: backendURL) }
        .onOpenURL { url in
            if url.scheme == "openid-credential-offer" || url.scheme == "haip-vci" {
                model.launch(offerURI: url.absoluteString)
            } else if url.scheme == "https",
                      let invocation = try? validatePlatformInvocation(
                          authenticatorOrigin: invocationOrigin,
                          raw: url.absoluteString
                      ),
                      invocation.kind == .oid4vci {
                model.launch(offerURI: invocation.protocolUri)
            } else if url.path.hasSuffix("/callback") {
                model.receiveRedirect(url)
            }
        }
    }
}
