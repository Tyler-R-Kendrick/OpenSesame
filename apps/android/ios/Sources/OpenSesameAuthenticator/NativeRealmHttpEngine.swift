import Foundation
@preconcurrency import Multipaz

/// Inherit Ktor's install implementation so its send pipeline calls this engine's execute.
/// Delegating install to Darwin would bind the pipeline to an unguarded engine instead.
final class NativeRealmHttpEngine: NSObject, HttpClientEngineFactory {
    private let fence: NativeAuthorityFence
    init(fence: NativeAuthorityFence) { self.fence = fence }
    func create(block: @escaping (HttpClientEngineConfig) -> Void) -> any HttpClientEngine {
        NativeRealmEngine(delegate: Darwin().create(block: block), fence: fence)
    }
}

private final class NativeRealmEngine: HttpClientEngineBase {
    private let delegate: any HttpClientEngine
    private let fence: NativeAuthorityFence
    private var cancellation: UUID?
    private let closeMutex = NSLock()
    private var closed = false
    init(delegate: any HttpClientEngine, fence: NativeAuthorityFence) {
        self.delegate = delegate
        self.fence = fence
        super.init(engineName: "OpenSesame admitted wallet")
        cancellation = fence.addCancellation { [weak self] in self?.close() }
    }
    override var config: HttpClientEngineConfig { delegate.config }
    override var supportedCapabilities: Set<AnyHashable> { delegate.supportedCapabilities }
    override func __execute(data: HttpRequestData, completionHandler: @escaping (HttpResponseData?, Error?) -> Void) {
        fence.perform({ done in delegate.__execute(data: data, completionHandler: done) }, completion: completionHandler)
    }
    override func close() {
        closeMutex.lock()
        guard !closed else { closeMutex.unlock(); return }
        closed = true
        closeMutex.unlock()
        fence.removeCancellation(cancellation)
        coroutineContext.cancel_(cause: nil)
        delegate.coroutineContext.cancel_(cause: nil)
        delegate.close()
        super.close()
    }
}
