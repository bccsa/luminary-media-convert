import Foundation

/// The current 16-byte key. Zeroed on destroy or replace, and never logged. Read from the
/// resource loader's queue while the main thread writes it.
public final class KeyHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var key: [UInt8]?

    public init() {}

    /// Replaces the key; the old bytes are zeroed first, and no hex means no key.
    public func set(hex: String?) {
        lock.lock()
        defer { lock.unlock() }
        zeroLocked()
        guard let hex else { return }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0)
            index = next
        }
        key = bytes
    }

    /// A copy, so a reader holding it cannot see the zeroing or keep the original alive.
    public func copy() -> [UInt8]? {
        lock.lock()
        defer { lock.unlock() }
        return key
    }

    public func zero() {
        lock.lock()
        defer { lock.unlock() }
        zeroLocked()
    }

    private func zeroLocked() {
        if key != nil {
            for i in key!.indices { key![i] = 0 }
        }
        key = nil
    }
}
