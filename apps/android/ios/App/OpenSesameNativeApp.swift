import OpenSesameAuthenticator
import SwiftUI

@main
struct OpenSesameNativeApp: App {
    var body: some Scene {
        WindowGroup {
            if let address = Bundle.main.object(forInfoDictionaryKey: "OpenSesameWalletBackendURL") as? String,
               let backend = URL(string: address), backend.scheme == "https", backend.host != nil,
               let group = Bundle.main.object(forInfoDictionaryKey: "OpenSesameAppGroup") as? String,
               let host = Bundle.main.object(forInfoDictionaryKey: "OpenSesameInvocationHost") as? String {
                WalletView(appGroup: group, backendURL: backend, invocationOrigin: "https://\(host)")
            } else {
                ContentUnavailableView("Wallet configuration required", systemImage: "lock.shield",
                    description: Text("A production wallet backend and signed application configuration are required."))
            }
        }
    }
}
