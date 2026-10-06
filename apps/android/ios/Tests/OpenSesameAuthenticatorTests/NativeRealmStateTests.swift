import Testing
@testable import OpenSesameAuthenticator

@Suite("Native authority realm")
@MainActor
struct NativeRealmStateTests {
    @Test func coldStartAndSyntheticDenyRealAuthority() throws {
        let state = NativeRealmState()
        #expect(throws: NativeRealmError.self) { try state.requireReal() }
        try state.admitSynthetic(state.lock())
        #expect(throws: NativeRealmError.self) { try state.requireReal() }
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
        state.lock()
        #expect(throws: NativeRealmError.self) { try state.requireSame(old) }
        try state.admitReal(state.lock())
        #expect(throws: NativeRealmError.self) { try state.requireSame(old) }
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
