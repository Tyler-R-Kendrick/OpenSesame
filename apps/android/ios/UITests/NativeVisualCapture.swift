import XCTest
import CryptoKit

/// Retains full genuine screenshots only after the calling journey has asserted its visible state.
enum NativeVisualCapture {
    @MainActor static func capture(_ checkpoint: String, app: XCUIApplication, target: XCUIElement, test: XCTestCase) throws {
        let expected = ["security-empty", "enrollment-default", "reject-enrolled", "synthetic-enrolled",
            "reject-result", "synthetic-realm", "fresh-owner", "revoked", "revoked-rejected", "canary-created", "canary-revoked"]
        let source = Bundle(for: type(of: test)).object(forInfoDictionaryKey: "OpenSesameVisualSourceSHA") as? String
        guard expected.contains(checkpoint), let source, source.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              target.exists && target.isHittable else { throw CaptureError.invalidCheckpoint }
        let screenshot = app.screenshot()
        let png = screenshot.pngRepresentation
        guard png.count > 24 else { throw CaptureError.invalidImage }
        let width = png[16..<20].reduce(0) { ($0 << 8) | Int($1) }
        let height = png[20..<24].reduce(0) { ($0 << 8) | Int($1) }
        guard app.frame.width > 0, width > 0, height > 0 else { throw CaptureError.invalidImage }
        let density = Double(width) / app.frame.width
        let bounds = target.frame
        let metadata: [String: Any] = ["v": 1, "platform": "apple", "checkpoint": checkpoint, "sourceSha": source,
            "imageSha256": SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined(),
            "viewport": ["width": width, "height": height], "density": density,
            "bounds": [["name": "asserted-state", "x": (bounds.minX - app.frame.minX) * density,
                        "y": (bounds.minY - app.frame.minY) * density, "width": bounds.width * density,
                        "height": bounds.height * density]]]
        let json = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("native-visual", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (suffix, data, type) in [("png", png, "public.png"), ("json", json, "public.json")] {
            let filename = checkpoint + "." + suffix
            let path = directory.appendingPathComponent(filename)
            guard !FileManager.default.fileExists(atPath: path.path) else { throw CaptureError.duplicateCheckpoint }
            try data.write(to: path, options: [.atomic])
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: type)
            attachment.name = filename; attachment.lifetime = .keepAlways
            test.add(attachment)
        }
    }
    private enum CaptureError: Error { case invalidCheckpoint, invalidImage, duplicateCheckpoint }
}
