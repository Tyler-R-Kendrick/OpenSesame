package dev.opensesame.authenticator

import io.ktor.client.HttpClient
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.multipaz.crypto.Algorithm
import org.multipaz.document.DocumentStore
import org.multipaz.documenttype.DocumentTypeRepository
import org.multipaz.documenttype.knowntypes.addKnownTypes
import org.multipaz.presentment.PresentmentSource
import org.multipaz.presentment.SimplePresentmentSource
import org.multipaz.provisioning.DocumentProvisioningHandler
import org.multipaz.provisioning.ProvisioningModel
import org.multipaz.provisioning.openid4vci.OpenID4VCIClientPreferences
import org.multipaz.provisioning.openid4vci.OpenID4VCIBackend
import org.multipaz.provisioning.openid4vci.OpenID4VCIBackendStub
import org.multipaz.rpc.client.RpcAuthorizedDeviceClient
import org.multipaz.rpc.handler.RpcExceptionMap
import org.multipaz.securearea.SecureAreaRepository
import org.multipaz.util.Platform

object WalletRuntime {
    private var realPresentmentSource: PresentmentSource? = null
    private var realProvisioningModel: ProvisioningModel? = null
    private var realClientPreferences: OpenID4VCIClientPreferences? = null
    private var realBackend: OpenID4VCIBackend? = null
    val presentmentSource: PresentmentSource get() {
        val permit = NativeGate.requireReal()
        return GatedPresentmentSource(checkNotNull(realPresentmentSource), permit)
    }
    val provisioningModel: ProvisioningModel get() { NativeGate.requireReal(); return checkNotNull(realProvisioningModel) }
    val clientPreferences: OpenID4VCIClientPreferences get() { NativeGate.requireReal(); return checkNotNull(realClientPreferences) }
    val backend: OpenID4VCIBackend get() { NativeGate.requireReal(); return checkNotNull(realBackend) }

    private val initMutex = Mutex()
    private var initialized = false
    private var productionHttp: HttpClient? = null

    fun lock() {
        initialized = false
        realProvisioningModel?.cancel()
        productionHttp?.close()
        productionHttp = null
        realPresentmentSource = null
        realProvisioningModel = null
        realClientPreferences = null
        realBackend = null
    }

    suspend fun initialize() = initMutex.withLock {
        val permit = NativeGate.requireReal()
        if (initialized) return
        val storage = Platform.nonBackedUpStorage
        val secureArea = Platform.getSecureArea(storage)
        NativeGate.requireSame(permit)
        val secureAreas = SecureAreaRepository.Builder().add(secureArea).build()
        val documents = DocumentStore.Builder(storage, secureAreas).build()
        NativeGate.requireSame(permit)
        val documentTypes = DocumentTypeRepository().apply { addKnownTypes() }
        realPresentmentSource = SimplePresentmentSource(
            documentStore = documents,
            documentTypeRepository = documentTypes,
            domainsMdocSignature = listOf("mdoc_user_auth"),
            domainsKeylessSdJwt = emptyList(),
            domainsKeyBoundSdJwt = listOf("sdjwt_user_auth"),
        )
        val http = HttpClient(RealmHttpEngine(permit)) { followRedirects = false }
        productionHttp = http
        realProvisioningModel = ProvisioningModel(
            documentProvisioningHandler = DocumentProvisioningHandler(
                secureArea = secureArea,
                documentStore = documents,
            ),
            httpClient = http,
            promptModel = Platform.promptModel,
            authorizationSecureArea = secureArea,
            eventLogger = null,
        )
        require(BuildConfig.WALLET_BACKEND_URL.startsWith("https://")) {
            "opensesameWalletBackendUrl must be an HTTPS wallet-attestation service"
        }
        val rpc = RpcAuthorizedDeviceClient.connect(
            exceptionMap = RpcExceptionMap.Builder().build(),
            httpClientEngine = RealmHttpEngine(permit),
            url = "${BuildConfig.WALLET_BACKEND_URL.trimEnd('/')}/rpc",
            secureArea = secureArea,
            storage = storage,
        )
        NativeGate.requireSame(permit)
        realBackend = OpenID4VCIBackendStub(
            endpoint = "openid4vci_backend",
            dispatcher = rpc.dispatcher,
            notifier = rpc.notifier,
        )
        realClientPreferences = OpenID4VCIClientPreferences(
            clientId = backend.getClientId(),
            redirectUrl = "https://${BuildConfig.INVOCATION_HOST}/invoke/oid4vci/callback",
            locales = listOf("en-US"),
            signingAlgorithms = listOf(Algorithm.ESP256),
        )
        NativeGate.requireSame(permit)
        initialized = true
    }

}
