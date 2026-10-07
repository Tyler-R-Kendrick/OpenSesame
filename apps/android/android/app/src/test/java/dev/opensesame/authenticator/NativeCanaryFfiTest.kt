package dev.opensesame.authenticator

import org.junit.Assert.*
import org.junit.Test
import uniffi.opensesame_authenticator_core.*
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Actual generated Kotlin/JNA ABI. Public fixture keys never leave this test. */
class NativeCanaryFfiTest {
    private val now = "2026-10-06T00:00:00.000Z"
    private fun text(raw: String, name: String): String {
        val matches = Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").findAll(raw).toList()
        check(matches.size == 1)
        return matches.single().groupValues[1]
    }
    @Test fun actualBindingsCreateExportObserveAndRevokeWithoutRealAdmission() {
        val created = nativeCanaryManage(nativeGateCreate("owner"), "owner", null,
            NativeCanaryMutation.Create("mcp_configuration"), now)
        val id = text(created.output, "id")
        val presented = text(created.output, "presentedId")
        val exported = nativeCanaryManage(created.gateRecord, "owner", created.stateRecord,
            NativeCanaryMutation.ExportValidator(id, presented), now)
        assertTrue(exported.output.contains("validatorId"))
        assertFalse(exported.output.contains(presented))
        val observed = nativeCanaryObserve(exported.gateRecord, exported.stateRecord, id, presented, "connected", now)
        assertTrue(observed.observed)
        assertTrue(observed.decision.contains("synthetic_readonly"))
        assertEquals(NativeRealm.REJECTED, nativeGateAdmit(created.gateRecord, presented, now).realm)
        val status = nativeCanaryStatus(exported.gateRecord, observed.stateRecord)
        assertFalse(status.contains("digestB64"))
        assertFalse(status.contains(presented))
        val removed = nativeCanaryManage(exported.gateRecord, "owner", observed.stateRecord,
            NativeCanaryMutation.Remove(id), now)
        assertThrows(NativeGateException::class.java) {
            nativeCanaryObserve(removed.gateRecord, removed.stateRecord, id, presented, "connected", now)
        }
    }

    @Test fun genuineAuthenticatedAckCannotVerifyReceiverAfterOwnerPolicyRotation() {
        // Same public interoperability provision as protocol-vectors.json, not a production secret.
        val publicKey = Base64.getEncoder().encodeToString(ByteArray(64) { it.toByte() })
        val provision = """{"v":1,"receiverId":"reference-receiver","bindingId":"fixture-binding","origin":"https://receiver.example","independentKeyMaterialB64":"$publicKey","keyEpoch":7,"expiresAt":"2026-10-07T00:00:00.000Z","allowLoopback":false}"""
        val configured = nativeCanaryManage(nativeGateCreate("owner"), "owner", null,
            NativeCanaryMutation.ConfigureReceiver(provision), now)
        val queued = nativeCanaryManage(configured.gateRecord, "owner", configured.stateRecord,
            NativeCanaryMutation.TestReceiver, now)
        val reserved = checkNotNull(nativeCanaryReserve(queued.gateRecord, queued.stateRecord, queued.output, true, now))
        val packageId = text(reserved.packet, "packageId")
        val unsigned = """{"v":1,"packageId":"$packageId","bindingId":"fixture-binding","keyEpoch":7,"acceptedAt":"$now"}"""
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32) { (it + 32).toByte() }, "HmacSHA256"))
        val signature = Base64.getEncoder().encodeToString(mac.doFinal(
            ("opensesame/credential-observation/ack/v1\n" + unsigned).toByteArray(Charsets.UTF_8)))
        val ack = unsigned.dropLast(1) + ",\"macB64\":\"$signature\"}"
        assertTrue(nativeCanaryDispatchCurrent(queued.gateRecord, reserved.stateRecord, reserved.reservation, now))
        // Positive control: this exact genuine HMAC ACK verifies the original binding.
        assertTrue(nativeCanaryFinish(queued.gateRecord, reserved.stateRecord, reserved.reservation, ack, now).delivered)
        val changed = nativeGateChangePassword(queued.gateRecord, "owner", "next owner")
        assertFalse(nativeCanaryDispatchCurrent(changed, reserved.stateRecord, reserved.reservation, now))
        val stale = nativeCanaryFinish(changed, reserved.stateRecord, reserved.reservation, ack, now)
        assertFalse(stale.delivered)
        assertThrows(NativeGateException::class.java) {
            nativeCanaryManage(changed, "next owner", stale.stateRecord, NativeCanaryMutation.EnableReceiver(true), now)
        }
    }
}
