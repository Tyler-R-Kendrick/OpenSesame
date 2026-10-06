// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "WalletEnvelopeCore",
    platforms: [.iOS(.v17), .macOS(.v10_15)],
    products: [.library(name: "WalletEnvelopeCore", targets: ["WalletEnvelopeCore"])],
    dependencies: [.package(url: "https://github.com/apple/swift-crypto.git", exact: "3.15.1")],
    targets: [
        .target(name: "WalletEnvelopeCore", dependencies: [.product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux]))]),
        .testTarget(name: "WalletEnvelopeCoreTests", dependencies: ["WalletEnvelopeCore"]),
    ]
)
