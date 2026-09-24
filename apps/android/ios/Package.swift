// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OpenSesameAuthenticator",
    platforms: [.iOS(.v26)],
    products: [
        .library(name: "OpenSesameAuthenticator", targets: ["OpenSesameAuthenticator"]),
    ],
    targets: [
        .binaryTarget(
            name: "Multipaz",
            url: "https://github.com/openwallet-foundation/multipaz/releases/download/0.100.0/Multipaz-0.100.0.xcframework.zip",
            checksum: "6098070b02dfe416f27146b9ca43d7867182caf93d5f872aaf560c1af9764452"
        ),
        .binaryTarget(
            name: "opensesame_authenticator_coreFFI",
            path: "Libraries/OpenSesameAuthenticatorCoreFFI.xcframework"
        ),
        .target(
            name: "OpenSesameAuthenticatorCore",
            dependencies: ["opensesame_authenticator_coreFFI"],
            path: "Sources/OpenSesameAuthenticatorCore",
            sources: ["opensesame_authenticator_core.swift"]
        ),
        .target(
            name: "OpenSesameAuthenticator",
            dependencies: ["Multipaz", "OpenSesameAuthenticatorCore"]
        ),
    ]
)
