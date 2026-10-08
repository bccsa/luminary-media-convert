import Foundation

/// Between ``JSON`` and the Foundation values a Capacitor call carries (`call.options`,
/// `call.resolve`, `notifyListeners`).
extension JSON {
    /// A Foundation value as JSON. A boolean arrives as an `NSNumber`, and is told apart from a
    /// number by its Core Foundation type; anything that is not a JSON value reads as `null`.
    public init(any value: Any?) {
        switch value {
        case nil, is NSNull:
            self = .null
        case let number as NSNumber:
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            self = .array(array.map { JSON(any: $0) })
        case let object as [AnyHashable: Any]:
            var converted: [String: JSON] = [:]
            for (key, element) in object {
                if let key = key.base as? String { converted[key] = JSON(any: element) }
            }
            self = .object(converted)
        default:
            self = .null
        }
    }

    /// The Foundation value for this JSON: what `call.resolve` and `notifyListeners` take.
    public var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let items): return items.map(\.anyValue)
        case .object(let object): return object.mapValues(\.anyValue)
        }
    }
}
