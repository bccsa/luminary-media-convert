import Foundation

/// A JSON value as the conformance runner sees it: `null` is a value, a missing key is `nil`.
public enum JSON: Equatable, Sendable, CustomStringConvertible {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public subscript(key: String) -> JSON? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var objectValue: [String: JSON]? {
        if case .object(let object) = self { return object }
        return nil
    }

    public var stringValue: String? {
        if case .string(let string) = self { return string }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let number) = self { return number }
        return nil
    }

    public var description: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            return value == value.rounded() && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        case .string(let value):
            let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
            return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\(value)\""
        case .array(let items): return "[" + items.map(\.description).joined(separator: ",") + "]"
        case .object(let object):
            return "{" + object.keys.sorted().map { "\(JSON.string($0)):\(object[$0]!)" }.joined(separator: ",") + "}"
        }
    }

    public static func parse(_ data: Data) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: data)
    }
}

extension JSON: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSON].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSON].self))
        }
    }
}
