import Foundation

/// Ephemeral sealed-only transport. No cookies, credentials, redirects, cache or TLS exceptions.
final class NativeObservationTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var body = Data()
    private var result: Result<String, Error>?
    private var waiter: CheckedContinuation<String, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var approvedResponse = false

    func start(destination: String, packet: String) throws {
        guard let url = URL(string: destination), packet.utf8.count <= 8_192 else { throw NativeStorageError.unavailable }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 4
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(packet.utf8)
        let task = session.dataTask(with: request)
        self.session = session
        self.task = task
        task.resume()
    }
    func acknowledgement() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result) }
            else { waiter = continuation; lock.unlock() }
        }
    }
    func cancel() { task?.cancel(); complete(.failure(NativeStorageError.unavailable)) }
    private func complete(_ value: Result<String, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let continuation = waiter
        waiter = nil
        lock.unlock()
        continuation?.resume(with: value)
        session?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let allowed = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
        lock.lock(); approvedResponse = allowed; lock.unlock()
        completionHandler(allowed ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let allowed = body.count + data.count <= 2_048
        if allowed { body.append(data) }
        lock.unlock()
        if !allowed { dataTask.cancel(); complete(.failure(NativeStorageError.unavailable)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let value = approvedResponse ? String(data: body, encoding: .utf8) : nil
        body.removeAll(keepingCapacity: false)
        lock.unlock()
        guard error == nil, let value else { complete(.failure(NativeStorageError.unavailable)); return }
        complete(.success(value))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
}
