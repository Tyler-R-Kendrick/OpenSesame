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
        let first = state.lock()
        try state.admitSynthetic(first)
        denied { _ = try state.requireReal() }
        denied { try state.admitReal(first) }
        try state.admitReal(state.lock())
        let old = try state.requireReal()
        state.lock()
        denied { try state.requireSame(old) }
        try state.admitReal(state.lock())
        denied { try state.requireSame(old) }
        try state.requireSame(state.requireReal())
        let stalePrompt = state.lock()
        state.lock()
        denied { try state.admitReal(stalePrompt) }
        denied { try state.admitSynthetic(stalePrompt) }
        print("Native realm behavioral checks passed")
    }
}
