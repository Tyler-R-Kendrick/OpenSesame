@preconcurrency import Multipaz

/// The SDK's async adapter is nonisolated; use its synchronous completion entry
/// so the non-Sendable trust identity stays on the admitted main actor.
@MainActor
func nativeRequestConsent(
    requester: Requester,
    identity: TrustedRequesterIdentity?,
    consent: ConsentData,
    selected: [Document],
    focused: @escaping @MainActor @Sendable ([Document]) -> Void,
    fence: NativeAuthorityFence
) async -> CredentialSelection? {
    let result = NativeOneShotResult<CredentialSelection>()
    let cancellation = fence.addCancellation { result.finish(nil) }
    defer { fence.removeCancellation(cancellation) }
    let selection = await withTaskCancellationHandler {
        await withCheckedContinuation { continuation in
            result.install(continuation)
            guard !Task.isCancelled else { result.finish(nil); return }
            do {
                try fence.withCurrent {
                    __promptModelRequestConsent(
                        requester: requester,
                        trustedRequesterIdentity: identity,
                        consentData: consent,
                        preselectedDocuments: selected,
                        onDocumentsInFocus: { documents in
                            Task { @MainActor in
                                try? fence.withCurrent { focused(documents) }
                            }
                        },
                        completionHandler: { value, error in
                            do {
                                try fence.withCurrent { result.finish(error == nil ? value : nil) }
                            } catch { result.finish(nil) }
                        }
                    )
                }
            } catch { result.finish(nil) }
        }
    } onCancel: {
        // The SDK exposes no coroutine cancel handle. Revoke this request's
        // authority and resolve nil; late SDK focus/results never regain it.
        fence.revoke()
        result.finish(nil)
    }
    guard !Task.isCancelled else { return nil }
    return (try? fence.withCurrent { selection }) ?? nil
}
