package dev.opensesame.authenticator

/** A rendered issuer action belongs to the original real generation, including its callback. */
internal fun invokeNativeExternalAction(permit: NativeSession.Real, requireSame: (NativeSession.Real) -> Unit,
    action: () -> Unit): Boolean {
    try { requireSame(permit) } catch (_: IllegalStateException) { return false }
    action()
    return true
}
