package dev.opensesame.authenticator

sealed interface NativeSession {
    data object Locked : NativeSession
    data class Real(val generation: Long) : NativeSession
    data class Synthetic(val generation: Long) : NativeSession
}

/** Generation changes invalidate every retained production permit. No realm upgrades in place. */
class NativeRealmState {
    @Volatile var session: NativeSession = NativeSession.Locked
        private set
    private var generation = 0L

    @Synchronized fun lock(): Long {
        generation++
        session = NativeSession.Locked
        return generation
    }
    @Synchronized fun enterReal(expected: Long) {
        check(expected == generation && session == NativeSession.Locked)
        session = NativeSession.Real(generation)
    }
    @Synchronized fun enterSynthetic(expected: Long) {
        check(expected == generation && session == NativeSession.Locked)
        session = NativeSession.Synthetic(generation)
    }
    fun requireReal(): NativeSession.Real = session as? NativeSession.Real
        ?: error("Real wallet authentication is required")
    fun requireSame(permit: NativeSession.Real) { check(session == permit) { "Wallet session changed" } }
    /** Linearize a bounded local owner mutation against lock, after expensive work has finished. */
    @Synchronized fun <T> withSame(permit: NativeSession.Real, operation: () -> T): T {
        requireSame(permit)
        return operation()
    }
}
