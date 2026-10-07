import Foundation
@preconcurrency import Multipaz
import Testing
@testable import OpenSesameAuthenticator

@Suite("Pinned Multipaz authority bridge")
@MainActor
struct NativeAuthorityBridgeTests {
    @Test func realMultipazStorageSigningAndSelectionRejectStaleAdmission() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(Foundation.UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let delegate = IosStorage(storageFileUrl: root.appendingPathComponent("wallet.db"), excludeFromBackup: true)
        let spec = StorageTableSpec(name: "authority_fixture", supportPartitions: false,
                                   supportExpiration: false, schemaVersion: 0)
        let bytes = KotlinByteArray(size: 1)
        bytes.set(index: 0, value: 42)
        let value = ByteString(data: bytes, startIndex: 0, endIndex: 1)
        let state = NativeRealmState()
        #expect(throws: NativeRealmError.self) { try state.authorityFence(0) }
        try state.admitSynthetic(state.lock())
        #expect(throws: NativeRealmError.self) { try state.authorityFence(state.requireReal()) }
        try state.admitReal(state.lock())
        let fence = try state.authorityFence(state.requireReal(), denied: cancellation)
        let storage = NativeGatedStorage(delegate: delegate, fence: fence)
        let table = try await storage.getTable(spec: spec)
        _ = try await table.insert(key: "selected", data: value, partitionId: nil,
                                   expiration: KotlinInstant.companion.DISTANT_FUTURE)
        #expect(try await table.get(key: "selected", partitionId: nil) == value)
        let area = NativeGatedSecureArea(delegate: try await SoftwareSecureArea.companion.create(storage: storage), fence: fence)
        let settings = CreateKeySettings(algorithm: .esp256, nonce: value, userAuthenticationRequired: false,
                                        userAuthenticationTimeout: 0, validFrom: nil, validUntil: nil)
        let key = try await area.createKey(alias: "selected-signing-key", createKeySettings: settings)
        let signature = try await area.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared)
        try await Crypto.shared.checkSignature(publicKey: key.publicKey, message: bytes, algorithm: .esp256, signature: signature)
        let selectedSource = try await source(storage: storage, area: area, fence: fence)
        let document = try await selectedSource.documentStore.createDocument(displayName: "SDK lifecycle fixture",
            typeDisplayName: nil, cardArt: nil, issuerLogo: nil, authorizationData: nil,
            created: KotlinInstant.companion.DISTANT_PAST, metadata: nil)
        #expect(try await selectedSource.selectCredential(document: document, requestedClaims: [], keyAgreementPossible: []) == nil)
        state.lock()
        try state.admitReal(state.lock())
        await expectCancellation { _ = try await table.get(key: "selected", partitionId: nil) }
        await expectCancellation { try await table.deleteAll() }
        await expectCancellation { _ = try await area.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared) }
        await expectCancellation { _ = try await selectedSource.selectCredential(document: document, requestedClaims: [], keyAgreementPossible: []) }
        let fresh = NativeGatedStorage(delegate: delegate,
            fence: try state.authorityFence(state.requireReal(), denied: cancellation))
        #expect(try await fresh.getTable(spec: spec).get(key: "selected", partitionId: nil) == value)
        let freshArea = NativeGatedSecureArea(delegate: try await SoftwareSecureArea.companion.create(storage: fresh),
            fence: fresh.fence)
        let freshSignature = try await freshArea.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared)
        try await Crypto.shared.checkSignature(publicKey: key.publicKey, message: bytes, algorithm: .esp256, signature: freshSignature)
        let expiry = Date(timeIntervalSince1970: 0).timeIntervalSince1970
        let expired = NativeAuthorityFence(denied: cancellation, validate: {
            guard Date().timeIntervalSince1970 <= expiry else { throw NativeAuthorityError.denied }
        })
        await expectCancellation { _ = try await NativeGatedStorage(delegate: delegate, fence: expired).getTable(spec: spec) }
        let expiredArea = NativeGatedSecureArea(delegate: try await SoftwareSecureArea.companion.create(storage: fresh), fence: expired)
        await expectCancellation { _ = try await expiredArea.sign(alias: key.alias, dataToSign: bytes, unlockReason: ReasonUnspecified.shared) }
        let expiredSource = try await source(storage: fresh, area: freshArea, fence: expired)
        await expectCancellation { _ = try await expiredSource.selectCredential(document: document, requestedClaims: [], keyAgreementPossible: []) }
        // This uses the pinned Ktor engine's actual cancellation Job. It does not contact a server.
        let engine = NativeRealmHttpEngine(fence: fresh.fence).create { _ in }
        #expect(engine.coroutineContext.isActive_)
        let preparedSource = try await source(storage: fresh, area: freshArea, fence: fresh.fence)
        preparedSource.endAdmission()
        await expectCancellation { _ = try await preparedSource.selectCredential(document: document, requestedClaims: [], keyAgreementPossible: []) }
        fresh.fence.revoke()
        #expect(!engine.coroutineContext.isActive_)
        engine.close()
        engine.close()
    }

    private func source(storage: NativeGatedStorage, area: NativeGatedSecureArea,
                        fence: NativeAuthorityFence) async throws -> NativeGatedPresentmentSource {
        let repository = SecureAreaRepository.Builder().add(secureArea: area).build()
        let documents = DocumentStore.Builder(storage: storage, secureAreaRepository: repository).build()
        let delegate = SimplePresentmentSource.companion.create(documentStore: documents,
            documentTypeRepository: DocumentTypeRepository(), zkSystemRepository: nil,
            resolveTrustFn: { _ in nil }, showConsentPromptFn: { _, _, _, _, _ in nil },
            preferSignatureToKeyAgreement: true, domainsMdocSignature: ["mdoc_user_auth"],
            domainsMdocKeyAgreement: [], domainsKeylessSdJwt: [], domainsKeyBoundSdJwt: ["sdjwt_user_auth"])
        return NativeGatedPresentmentSource(delegate: delegate, fence: fence)
    }

    private var cancellation: @Sendable () -> Error {
        { CancellationException(message: "Wallet admission ended", cause: nil).asError() }
    }
    private func expectCancellation(_ action: () async throws -> Void) async {
        do { try await action(); Issue.record("Revoked retained table admitted real storage") }
        catch { #expect((error as NSError).kotlinException is KotlinCancellationException) }
    }
}
