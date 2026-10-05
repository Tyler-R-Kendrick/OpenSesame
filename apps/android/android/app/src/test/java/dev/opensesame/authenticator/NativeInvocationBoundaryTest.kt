package dev.opensesame.authenticator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import uniffi.opensesame_authenticator_core.AuthenticatorException
import uniffi.opensesame_authenticator_core.InvocationKind
import uniffi.opensesame_authenticator_core.validatePlatformInvocation

/** Exercises the generated Kotlin bindings against the real Rust library. */
class NativeInvocationBoundaryTest {
    private val associationA = "https://customer-a.example"
    private val associationB = "https://customer-b.example"
    private val request = "request_uri=https%3A%2F%2Fverifier.example%2Frequest"

    @Test
    fun associatedInvocationRoundTripsThroughNativeBindings() {
        val invocation = validatePlatformInvocation(associationA, "$associationA/invoke/oid4vp?$request")
        assertEquals(InvocationKind.OID4VP, invocation.kind)
        assertEquals("https://verifier.example/request", invocation.payload)
        assertEquals("openid4vp://?$request", invocation.protocolUri)
    }

    @Test
    fun invocationCopiedToAnotherAssociationFailsClosed() {
        assertThrows(AuthenticatorException.UnverifiedInvocationOrigin::class.java) {
            validatePlatformInvocation(associationB, "$associationA/invoke/oid4vp?$request")
        }
    }

    @Test
    fun invocationCannotFetchPrivateNetworkCredentialRequests() {
        assertThrows(AuthenticatorException.PrivateRequestUri::class.java) {
            validatePlatformInvocation(
                associationA,
                "$associationA/invoke/oid4vp?request_uri=https%3A%2F%2F127.0.0.1%2Frequest",
            )
        }
    }
}
