import Foundation

/// generation → uri → (bytes, contentType): the munged text JavaScript sent, answered from
/// memory. Read from the resource loader's queue while the main thread writes it.
public final class AssetStore: @unchecked Sendable {
    public struct Asset: Sendable {
        public let bytes: [UInt8]
        public let contentType: String
    }

    private let lock = NSLock()
    private var generations: [Int: [String: Asset]] = [:]
    private var released: Set<Int> = []

    public init() {}

    public func put(_ generation: Int, _ assets: [BridgeAsset]) {
        lock.lock()
        defer { lock.unlock() }
        var store = generations[generation] ?? [:]
        for asset in assets {
            store[asset.uri] = Asset(bytes: Array(asset.text.utf8), contentType: asset.contentType)
        }
        generations[generation] = store
    }

    public func get(_ uri: String) -> Asset? {
        lock.lock()
        defer { lock.unlock() }
        for store in generations.values {
            if let asset = store[uri] { return asset }
        }
        return nil
    }

    /// Marks a generation for purging; it stays answerable until a newer load has taken over.
    public func release(_ generation: Int) {
        lock.lock()
        defer { lock.unlock() }
        released.insert(generation)
    }

    /// Called once a load of `current` has been handed to the engine.
    public func purgeReleased(before current: Int) {
        lock.lock()
        defer { lock.unlock() }
        let purged = released.filter { $0 < current }
        for generation in purged { generations[generation] = nil }
        released.subtract(purged)
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        generations.removeAll()
        released.removeAll()
    }
}
