import Testing
@testable import OpenSesameAuthenticator

@Suite("Native authority realm")
@MainActor
struct NativeRealmStateTests {
    @Test func coldStartAndSyntheticDenyRealAuthority() throws {
        let state = NativeRealmState()
        #expect(throws: NativeRealmError.self) { try state.requireReal() }
        #expect(throws: NativeRealmError.self) { try state.authorityFence(0) }
        try state.admitSynthetic(state.lock())
        #expect(throws: NativeRealmError.self) { try state.requireReal() }
        #expect(throws: NativeRealmError.self) { try state.authorityFence(0) }
    }
    @Test func syntheticCannotUpgradeWithoutFreshAdmission() throws {
        let state = NativeRealmState()
        let epoch = state.lock()
        try state.admitSynthetic(epoch)
        #expect(throws: NativeRealmError.self) { try state.admitReal(epoch) }
        try state.admitReal(state.lock())
        _ = try state.requireReal()
    }
    @Test func lockingInvalidatesEveryRetainedPermit() throws {
        let state = NativeRealmState()
        try state.admitReal(state.lock())
        let old = try state.requireReal()
        let fence = try state.authorityFence(old)
        var cancelled = 0
        _ = fence.addCancellation { cancelled += 1 }
        var pending: ((String?, Error?) -> Void)?
        var result: String?
        var refusal: Error?
        fence.perform({ pending = $0 }, completion: { result = $0; refusal = $1 })
        state.lock()
        #expect(cancelled == 1)
        pending?("real saved credential", nil)
        #expect(result == nil && refusal != nil)
        var calls = 0
        fence.perform({ calls += 1; $0("forbidden", nil) }, completion: { _, error in #expect(error != nil) })
        #expect(calls == 0)
        #expect(throws: NativeRealmError.self) { try state.requireSame(old) }
        try state.admitReal(state.lock())
        #expect(throws: NativeRealmError.self) { try state.requireSame(old) }
        #expect(throws: NativeAuthorityError.self) { try fence.withCurrent {} }
        let fresh = try state.authorityFence(state.requireReal())
        try fresh.withCurrent { calls += 1 }
        #expect(calls == 1)
        try state.requireSame(state.requireReal())
    }
    @Test func cancelledOwnerPromptCannotReopenLockedWallet() {
        let state = NativeRealmState()
        let prompt = state.lock()
        state.lock()
        #expect(throws: NativeRealmError.self) { try state.admitReal(prompt) }
        #expect(throws: NativeRealmError.self) { try state.admitSynthetic(prompt) }
    }
}
