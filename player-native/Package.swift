// swift-tools-version: 6.0
import PackageDescription

// The iOS side of the plugin. LuminaryPlayerCore is plain Swift — no Capacitor,
// UIKit or AVKit — so the conformance tests build and run with `swift test` on
// macOS against the same code the app runs.
let package = Package(
    name: "LuminaryPlayer",
    platforms: [.iOS(.v15), .macOS(.v14)],
    products: [
        .library(name: "LuminaryPlayerCore", targets: ["LuminaryPlayerCore"]),
    ],
    targets: [
        .target(
            name: "LuminaryPlayerCore",
            path: "ios/Sources/LuminaryPlayerCore"
        ),
        .testTarget(
            name: "CoreTests",
            dependencies: ["LuminaryPlayerCore"],
            path: "ios/Tests/Core"
        ),
        .testTarget(
            name: "Conformance",
            dependencies: ["LuminaryPlayerCore"],
            path: "ios/Tests/Conformance"
        ),
    ]
)
