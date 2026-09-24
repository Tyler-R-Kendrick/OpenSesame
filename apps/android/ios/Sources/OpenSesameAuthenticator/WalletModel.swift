import Foundation
import Multipaz
import Observation

@MainActor
@Observable
public final class WalletModel {
    public private(set) var ready = false
    public private(set) var error: Error?
    public private(set) var provisioningModel: ProvisioningModel!
    public private(set) var clientPreferences: OpenID4VCIClientPreferences!
    public private(set) var backend: OpenID4VCIBackend!
    public let promptModel = Platform.shared.promptModel

    private var callbacks: [String: CheckedContinuation<String, Never>] = [:]

    public init() {}

    public func initialize(appGroup: String, backendURL: URL) async {
        guard backendURL.scheme == "https" else {
            error = WalletError.insecureBackend
            return
        }
        do {
            PromptModel.Companion.shared.setGlobal(promptModel: promptModel)
            guard let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
            ) else { throw WalletError.missingAppGroup }
            let storage = IosStorage(
                storageFileUrl: container.appendingPathComponent("wallet.db"),
                excludeFromBackup: true
            )
            let secureArea = try await Platform.shared.getSecureArea(storage: storage)
            let secureAreas = SecureAreaRepository.Builder()
                .add(secureArea: secureArea)
                .build()
            let documents = DocumentStore.Builder(
                storage: storage,
                secureAreaRepository: secureAreas
            ).build()
            let rpc = try await RpcAuthorizedDeviceClient.companion.connect(
                exceptionMap: RpcExceptionMap.Builder().build(),
                httpClientEngine: Darwin(),
                url: backendURL.appendingPathComponent("rpc").absoluteString,
                secureArea: secureArea,
                storage: storage,
                secret: nil
            )
            backend = OpenID4VCIBackendStub(
                endpoint: "openid4vci_backend",
                dispatcher: rpc.dispatcher,
                notifier: rpc.notifier,
                state: Bstr(value: KotlinByteArray(size: 0))
            )
            clientPreferences = OpenID4VCIClientPreferences(
                clientId: try await backend.getClientId(),
                redirectUrl: "https://auth.opensesame.dev/invoke/oid4vci/callback",
                locales: ["en-US"],
                signingAlgorithms: [.esp256]
            )
            provisioningModel = ProvisioningModel(
                documentProvisioningHandler: DocumentProvisioningHandler(
                    secureArea: secureArea,
                    documentStore: documents,
                    metadataHandler: nil,
                    defaultDocumentProvisioningSettings: DocumentProvisioningSettings()
                ),
                httpClient: HttpClient(engineFactory: Darwin()) { $0.followRedirects = false },
                promptModel: promptModel,
                authorizationSecureArea: secureArea,
                eventLogger: nil
            )
            ready = true
        } catch {
            self.error = error
        }
    }

    public func launch(offerURI: String) {
        guard ready else { return }
        provisioningModel.launchOpenID4VCIProvisioning(
            offerUri: offerURI,
            clientPreferences: clientPreferences,
            backend: backend
        )
    }

    public func receiveRedirect(_ url: URL) {
        guard let state = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "state" })?.value else { return }
        callbacks.removeValue(forKey: state)?.resume(returning: url.absoluteString)
    }

    public func waitForRedirect(state: String) async -> String {
        await withCheckedContinuation { callbacks[state] = $0 }
    }
}

public enum WalletError: Error {
    case insecureBackend
    case missingAppGroup
}
