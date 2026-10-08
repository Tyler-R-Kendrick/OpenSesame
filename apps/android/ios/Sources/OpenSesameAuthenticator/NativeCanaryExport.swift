import Foundation

/// Matches the shared installed-validator configuration. It contains controlled bait and public
/// binding metadata only, with no receiver material, real vault keys or production credentials.
enum NativeCanaryExport {
    private struct Context: Codable, Equatable { let vaultIdentity: String; let kind: String; let generation: UInt32 }
    private struct Artifact: Codable { let id: String; let context: Context; let presentedId: String }
    private struct Binding: Codable {
        let v: UInt32; let validatorId: String; let artifactId: String
        let context: Context; let digestB64: String
    }
    private struct Server: Codable { let command: String; let args: [String] }
    private enum OutputError: Error { case invalid }
    private struct Configuration: Codable {
        let v: UInt32; let tomb: String; let artifact: Artifact
        let validatorBinding: Binding; let mcpServers: [String: Server]
    }
    static func configuration(artifact: String, binding: String) throws -> String {
        let decoder = JSONDecoder()
        let artifact = try decoder.decode(Artifact.self, from: Data(artifact.utf8))
        let binding = try decoder.decode(Binding.self, from: Data(binding.utf8))
        guard binding.v == 1, artifact.context.kind == "mcp_configuration",
              binding.artifactId == artifact.id, binding.context == artifact.context else { throw OutputError.invalid }
        let value = Configuration(v: 1, tomb: "native-wallet-credential-observations.v1",
            artifact: artifact, validatorBinding: binding,
            mcpServers: ["OpenSesameCanary": Server(command: "opensesame-id",
                args: ["canary", "serve", "--config", "<config-file>"])])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(value)
        guard data.count <= 4096, let text = String(data: data, encoding: .utf8) else { throw OutputError.invalid }
        return text
    }
}
