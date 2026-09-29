// swift-tools-version: 6.0
import PackageDescription

// The Capacitor plugin's Swift package. Plan 03 adds the plugin target
// (ios/Sources/LuminaryPlayerPlugin, on capacitor-swift-pm) and makes the
// conformance tests depend on it for their harness.
let package = Package(
    name: "LuminaryPlayer",
    platforms: [.iOS(.v15), .macOS(.v14)],
    targets: [
        .testTarget(
            name: "Conformance",
            path: "ios/Tests/Conformance"
        ),
    ]
)
