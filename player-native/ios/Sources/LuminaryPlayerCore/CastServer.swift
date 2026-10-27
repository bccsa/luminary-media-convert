import Foundation
import Network
import os
import Security

/**
 * A minimal HTTP server on the phone for the length of an AirPlay session. The receiver fetches the
 * stream itself, and the playlists and key it needs live in memory behind `luminary://`: this
 * answers for them, with the playlists' addresses rewritten (see `rewriteForCast`). Segments are
 * not served here.
 *
 * Everything is behind a per-session token, and only what the router already holds for the current
 * load can be asked for. Never log the token or a response: the token is the key's address.
 */
public final class CastServer: @unchecked Sendable {
    private let router: UriRouter
    private let address: String
    private let token: String
    private let queue = DispatchQueue(label: "org.bccsa.luminary.player.CastServer")
    /// Only what follows the token is logged; the token itself never is.
    private let log = Logger(subsystem: "org.bccsa.luminary.player", category: "CastServer")
    private var listener: NWListener?
    private var connections = Set<ObjectIdentifier>()
    private var held: [ObjectIdentifier: NWConnection] = [:]

    /// `http://<address>:<port>/<token>`, once ``start(completion:)`` has reported it.
    public private(set) var base: String?

    /// `address` is the Wi-Fi address to listen on, never a wildcard: see ``lanAddress()``.
    public init(router: UriRouter, address: String, token: String = CastServer.newToken()) {
        self.router = router
        self.address = address
        self.token = token
    }

    /// Reports the base the rewritten playlists name, or nil when the listener could not start.
    public func start(completion: @escaping @Sendable (String?) -> Void) {
        let parameters = NWParameters.tcp
        guard let host = IPv4Address(address) else { return completion(nil) }
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(host), port: .any)
        guard let listener = try? NWListener(using: parameters) else { return completion(nil) }
        self.listener = listener
        let finished = Locked(false)
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard let port = listener?.port, finished.swap(true) == false else { return }
                let base = "http://\(self.address):\(port.rawValue)/\(self.token)"
                self.base = base
                completion(base)
            case .failed, .cancelled:
                if finished.swap(true) == false { completion(nil) }
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
    }

    public func stop() {
        listener?.cancel()
        listener = nil
        queue.async { [weak self] in
            guard let self else { return }
            self.held.values.forEach { $0.cancel() }
            self.held.removeAll()
        }
        base = nil
    }

    // MARK: Connections

    private static let maxConnections = 8
    private static let maxHeadBytes = 8192

    private func accept(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        guard held.count < Self.maxConnections else {
            // Full: say so rather than queue without end.
            connection.start(queue: queue)
            respond(connection, 503, "Service Unavailable")
            return
        }
        held[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state { self?.queue.async { self?.held[id] = nil } }
        }
        connection.start(queue: queue)
        read(connection, Data())
    }

    private func read(_ connection: NWConnection, _ received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var received = received
            if let data { received.append(data) }
            if let end = received.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: received[..<end.lowerBound], as: UTF8.self)
                return self.handle(head, on: connection)
            }
            if received.count > Self.maxHeadBytes {
                return self.respond(connection, 431, "Request Header Fields Too Large")
            }
            if error != nil || isComplete { return connection.cancel() }
            self.read(connection, received)
        }
    }

    // MARK: Requests

    private func handle(_ head: String, on connection: NWConnection) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ").map(String.init)
        guard parts.count == 3 else { return respond(connection, 400, "Bad Request") }
        let method = parts[0]
        let target = parts[1]
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] =
                line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }

        if method == "OPTIONS" { return respond(connection, 204, "No Content", cors: true) }
        guard method == "GET" || method == "HEAD" else {
            return respond(connection, 405, "Method Not Allowed", cors: true)
        }

        // A query or a fragment names nothing here.
        let path = String(target.split(separator: "?", omittingEmptySubsequences: false)[0]
            .split(separator: "#", omittingEmptySubsequences: false)[0])
        let given = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        // Constant time on the token, so a LAN neighbour cannot learn it a character at a time.
        guard path.hasPrefix("/"), Self.sameBytes(given, token) else {
            return respond(connection, 404, "Not Found", cors: true)
        }
        let rest = String(path.dropFirst(1 + token.count))
        guard let uri = bridgeUri(ofCastPath: rest) else {
            log.warning("\(method, privacy: .public) \(rest, privacy: .public) -> 404 (not an address)")
            return respond(connection, 404, "Not Found", cors: true)
        }

        let headOnly = method == "HEAD"
        let range = headers["range"]
        log.debug("\(method, privacy: .public) \(rest, privacy: .public) range=\(range ?? "-", privacy: .public)")
        switch router.route(uri) {
        case .served(let bytes, let contentType):
            send(connection, headOnly, body(bytes, contentType), contentType, range)
        case .live(let spec):
            _ = router.readLive(spec) { [weak self] result in
                guard let self else { return }
                self.queue.async {
                    switch result {
                    case .success(let text):
                        let bytes = Array(self.cast(text).utf8)
                        self.send(connection, headOnly, bytes, UriRouter.playlistContentType, range)
                    case .failure:
                        self.respond(connection, 502, "Bad Gateway", cors: true)
                    }
                }
            }
        case .failed, .unanswered:
            log.warning("\(method, privacy: .public) \(rest, privacy: .public) -> 404 (not held)")
            respond(connection, 404, "Not Found", cors: true)
        }
    }

    /// Playlists get the phone's HTTP addresses; anything else is sent as it is.
    private func body(_ bytes: [UInt8], _ contentType: String) -> [UInt8] {
        guard contentType.contains("mpegurl") || contentType.hasPrefix("text/") else { return bytes }
        return Array(cast(String(decoding: bytes, as: UTF8.self)).utf8)
    }

    private func cast(_ text: String) -> String {
        base.map { rewriteForCast(text, base: $0) } ?? text
    }

    private func send(_ connection: NWConnection, _ headOnly: Bool, _ bytes: [UInt8], _ type: String, _ range: String?) {
        if let range, let match = Self.parseRange(range) {
            let start = match.start
            let end = min(match.end ?? bytes.count - 1, bytes.count - 1)
            guard start < bytes.count, start <= end else {
                return respond(connection, 416, "Range Not Satisfiable", cors: true,
                               extra: "Content-Range: bytes */\(bytes.count)\r\n")
            }
            let slice = Array(bytes[start...end])
            return respond(connection, 206, "Partial Content", cors: true, type: type,
                           body: headOnly ? nil : slice, length: slice.count,
                           extra: "Content-Range: bytes \(start)-\(end)/\(bytes.count)\r\n")
        }
        respond(connection, 200, "OK", cors: true, type: type, body: headOnly ? nil : bytes, length: bytes.count)
    }

    private func respond(
        _ connection: NWConnection,
        _ status: Int,
        _ reason: String,
        cors: Bool = false,
        type: String? = nil,
        body: [UInt8]? = nil,
        length: Int? = nil,
        extra: String = ""
    ) {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        if cors {
            head += "Access-Control-Allow-Origin: *\r\n"
            head += "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
            head += "Access-Control-Allow-Headers: Range\r\n"
            head += "Access-Control-Expose-Headers: Content-Length, Content-Range\r\n"
            head += "Access-Control-Max-Age: 600\r\n"
        }
        // A live playlist must never be cached, and nothing here is worth caching.
        head += "Cache-Control: no-store\r\n"
        if let type { head += "Content-Type: \(type)\r\n" }
        head += extra
        head += "Content-Length: \(length ?? body?.count ?? 0)\r\n"
        head += "Connection: close\r\n\r\n"
        var data = Data(head.utf8)
        if let body { data.append(contentsOf: body) }
        connection.send(content: data, contentContext: .finalMessage, isComplete: true,
                        completion: .contentProcessed { _ in connection.cancel() })
    }

    // MARK: Helpers

    /// `bytes=<start>-<end?>`; a suffix range is not one a player asks for here.
    static func parseRange(_ header: String) -> (start: Int, end: Int?)? {
        guard header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard spec.count == 2, let start = Int(spec[0]) else { return nil }
        return (start, spec[1].isEmpty ? nil : Int(spec[1]))
    }

    private static func sameBytes(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        return zip(x, y).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// 128 random bits, new for every session.
    public static func newToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /**
     * The phone's address on the Wi-Fi (or a hotspot or Ethernet bridge), which is the only one a
     * receiver on the same network can reach and the only one this should listen on. Nil when there
     * is none: AirPlay then stays with the local player.
     */
    public static func lanAddress() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: [(name: String, address: String)] = []
        for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(entry.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
                  let sa = entry.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: entry.pointee.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            else { continue }
            let address = String(cString: host)
            if isPrivate(address) { found.append((name, address)) }
        }
        return (found.first { $0.name == "en0" } ?? found.first)?.address
    }

    private static func isPrivate(_ address: String) -> Bool {
        let octets = address.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
    }
}

/// A value two threads touch, for the one-shot "reported once" flag.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    /// Stores `new` and returns what was there.
    func swap(_ new: Value) -> Value {
        lock.lock()
        defer { lock.unlock() }
        let old = value
        value = new
        return old
    }
}
