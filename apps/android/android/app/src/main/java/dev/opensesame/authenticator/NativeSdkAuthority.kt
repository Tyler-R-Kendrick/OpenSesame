package dev.opensesame.authenticator

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

/** A retained SDK handle belongs to its original real session, including suspended operations. */
internal class NativeSdkAuthority(
    private val requireCurrent: () -> Unit,
    private val linearize: (() -> Unit) -> Unit,
    private val subscribe: (() -> Unit) -> (() -> Unit),
) {
    init { requireCurrent() }

    fun check() = requireCurrent()

    suspend fun <T> call(operation: suspend () -> T): T = coroutineScope {
        requireCurrent()
        val remove = subscribe { cancel("Wallet session changed") }
        try {
            lateinit var result: kotlinx.coroutines.Deferred<T>
            // Dispatch is synchronous under the permit check; the lock ends at the first suspension.
            linearize {
                coroutineContext.ensureActive()
                result = async(start = CoroutineStart.UNDISPATCHED) {
                    requireCurrent()
                    val value = operation()
                    coroutineContext.ensureActive()
                    requireCurrent()
                    value
                }
            }
            val value = result.await()
            coroutineContext.ensureActive()
            requireCurrent()
            value
        } finally { remove() }
    }
}
