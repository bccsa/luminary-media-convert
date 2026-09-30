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
        .library(name: "LuminaryPlayerUI", targets: ["LuminaryPlayerUI"]),
    ],
    targets: [
        .target(
            name: "LuminaryPlayerCore",
            path: "ios/Sources/LuminaryPlayerCore",
            // AVFoundation's actor annotations differ between SDKs (Xcode 16 marks
            // AVPlayerItem.currentMediaSelection main-actor, later SDKs do not), and Swift 6
            // mode turns each difference into an error. The engine is main-thread only by
            // contract, so Swift 5 mode keeps those differences as warnings.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The iOS views over the core: UIKit and AVKit, so its sources compile to nothing on
        // macOS and `swift test` is unaffected.
        .target(
            name: "LuminaryPlayerUI",
            dependencies: ["LuminaryPlayerCore"],
            path: "ios/Sources/LuminaryPlayerUI",
            swiftSettings: [.swiftLanguageMode(.v5)]
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
