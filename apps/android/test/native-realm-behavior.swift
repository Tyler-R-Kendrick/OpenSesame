import Foundation

// Run against the exact production NativeRealmState.swift with swiftc, including on Linux.
// This checks realm transitions; it is not evidence of iOS provider or UI execution.
@main struct NativeRealmBehavior {
    @MainActor static func denied(_ action: () throws -> Void) {
        do { try action(); fatalError("Real authority escaped") } catch {}
    }
    @MainActor static func main() throws {
        let state = NativeRealmState()
        denied { _ = try state.requireReal() }
        denied { _ = try state.authorityFence(0) }
        let first = state.lock()
        try state.admitSynthetic(first)
        denied { _ = try state.requireReal() }
        denied { _ = try state.authorityFence(first) }
        denied { try state.admitReal(first) }
        try state.admitReal(state.lock())
        let old = try state.requireReal()
        let fence = try state.authorityFence(old)
        var cancelled = 0
        _ = fence.addCancellation { cancelled += 1 }
        var pending: ((String?, Error?) -> Void)?
        var returned: String?
        var refused = false
        fence.perform({ pending = $0 }, completion: { returned = $0; refused = $1 != nil })
        state.lock()
        precondition(cancelled == 1)
        pending?("real saved credential", nil)
        precondition(returned == nil && refused)
        var dispatches = 0
        fence.perform({ dispatches += 1; $0("forbidden", nil) }, completion: { _, error in precondition(error != nil) })
        precondition(dispatches == 0)
        denied { try state.requireSame(old) }
        try state.admitReal(state.lock())
        denied { try state.requireSame(old) }
        denied { try fence.withCurrent {} }
        let fresh = try state.authorityFence(state.requireReal())
        try fresh.withCurrent { dispatches += 1 }
        precondition(dispatches == 1)
        try state.requireSame(state.requireReal())
        let stalePrompt = state.lock()
        state.lock()
        denied { try state.admitReal(stalePrompt) }
        denied { try state.admitSynthetic(stalePrompt) }
        let expired = NativeAuthorityFence(validate: {
            guard Date() < Date(timeIntervalSince1970: 0) else { throw NativeAuthorityError.denied }
        })
        denied { try expired.withCurrent { dispatches += 1 } }
        precondition(dispatches == 1)
        print("Native realm behavioral checks passed")
    }
}
