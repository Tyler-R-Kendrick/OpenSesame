package dev.opensesame.authenticator

import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
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
    lateinit var presentmentSource: PresentmentSource
        private set
    lateinit var provisioningModel: ProvisioningModel
        private set
    lateinit var clientPreferences: OpenID4VCIClientPreferences
        private set
    lateinit var backend: OpenID4VCIBackend
        private set

    private val initMutex = Mutex()
    private var initialized = false

    suspend fun initialize() = initMutex.withLock {
        if (initialized) return
        val storage = Platform.nonBackedUpStorage
        val secureArea = Platform.getSecureArea(storage)
        val secureAreas = SecureAreaRepository.Builder().add(secureArea).build()
        val documents = DocumentStore.Builder(storage, secureAreas).build()
        val documentTypes = DocumentTypeRepository().apply { addKnownTypes() }
        presentmentSource = SimplePresentmentSource(
            documentStore = documents,
            documentTypeRepository = documentTypes,
            domainsMdocSignature = listOf("mdoc_user_auth", "mdoc_no_user_auth"),
            domainsKeylessSdJwt = listOf("sdjwt_keyless"),
            domainsKeyBoundSdJwt = listOf("sdjwt_user_auth", "sdjwt_no_user_auth"),
        )
        provisioningModel = ProvisioningModel(
            documentProvisioningHandler = DocumentProvisioningHandler(
                secureArea = secureArea,
                documentStore = documents,
            ),
            httpClient = HttpClient(Android) { followRedirects = false },
            promptModel = Platform.promptModel,
            authorizationSecureArea = secureArea,
            eventLogger = null,
        )
        require(BuildConfig.WALLET_BACKEND_URL.startsWith("https://")) {
            "opensesameWalletBackendUrl must be an HTTPS wallet-attestation service"
        }
        val rpc = RpcAuthorizedDeviceClient.connect(
            exceptionMap = RpcExceptionMap.Builder().build(),
            httpClientEngine = Android,
            url = "${BuildConfig.WALLET_BACKEND_URL.trimEnd('/')}/rpc",
            secureArea = secureArea,
            storage = storage,
        )
        backend = OpenID4VCIBackendStub(
            endpoint = "openid4vci_backend",
            dispatcher = rpc.dispatcher,
            notifier = rpc.notifier,
        )
        clientPreferences = OpenID4VCIClientPreferences(
            clientId = backend.getClientId(),
            redirectUrl = "https://${BuildConfig.INVOCATION_HOST}/invoke/oid4vci/callback",
            locales = listOf("en-US"),
            signingAlgorithms = listOf(Algorithm.ESP256),
        )
        initialized = true
    }

}
