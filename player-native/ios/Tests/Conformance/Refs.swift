/// Refs and matchers for conformance scenarios: a port of
/// `src/test-support/conformance/match.ts`, held to `conformance/selftest/match-cases.json`.
/// The rules are in `conformance/README.md`.

public struct MatchError: Error, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

private let matchers: Set<String> = ["$absent", "$any", "$prefix", "$length", "$each", "$contains", "$not"]

func isRef(_ value: JSON?) -> Bool {
    guard case .string(let string)? = value, string.count > 1, string.first == "$" else { return false }
    let rest = string.dropFirst()
    guard let head = rest.first, head.isASCII, head.isLetter else { return false }
    return rest.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
}

private func isMatcher(_ value: JSON?) -> Bool {
    guard let object = value?.objectValue, !object.isEmpty else { return false }
    return object.keys.allSatisfy { $0.hasPrefix("$") }
}

private func show(_ value: JSON?) -> String { value?.description ?? "missing" }

public final class Refs {
    private var bound: [String: JSON] = [:]

    public init() {}

    private func bind(_ name: String, _ value: JSON, _ path: String) throws {
        if let other = bound.first(where: { $0.value == value }) {
            throw MatchError("\(path): \(name) would bind \(value), already held by \(other.key)")
        }
        bound[name] = value
    }

    /// A value to send: bound refs substituted, an unbound ref minted as its own name, `$absent` keys dropped.
    public func issue(_ value: JSON, _ path: String = "$") throws -> JSON {
        if isRef(value), case .string(let name) = value {
            if let held = bound[name] { return held }
            let minted = JSON.string(String(name.dropFirst()))
            try bind(name, minted, path)
            return minted
        }
        if isMatcher(value) { throw MatchError("\(path): a matcher cannot be sent (\(value))") }
        switch value {
        case .array(let items):
            return .array(try items.enumerated().map { try issue($0.element, "\(path)[\($0.offset)]") })
        case .object(let object):
            var out: [String: JSON] = [:]
            for (key, item) in object {
                if item == .object(["$absent": .bool(true)]) { continue }
                out[key] = try issue(item, "\(path).\(key)")
            }
            return .object(out)
        default:
            return value
        }
    }

    /// Throws a ``MatchError`` naming the first path that does not match.
    public func assert(_ actual: JSON?, _ expected: JSON, _ path: String = "$") throws {
        if isRef(expected), case .string(let name) = expected {
            guard let held = bound[name] else {
                guard let actual else { throw MatchError("\(path): missing, expected \(name)") }
                try bind(name, actual, path)
                return
            }
            if actual != held { throw MatchError("\(path): expected \(name) = \(held), got \(show(actual))") }
            return
        }
        if isMatcher(expected), let matcher = expected.objectValue {
            try assertMatcher(actual, matcher, path)
            return
        }
        guard let actual else { throw MatchError("\(path): missing, expected \(expected)") }
        switch expected {
        case .array(let items):
            guard case .array(let actualItems) = actual else { throw MatchError("\(path): expected an array, got \(actual)") }
            guard actualItems.count == items.count else {
                throw MatchError("\(path): expected \(items.count) items, got \(actualItems.count)")
            }
            for (index, item) in items.enumerated() { try assert(actualItems[index], item, "\(path)[\(index)]") }
        case .object(let object):
            guard case .object(let actualObject) = actual else { throw MatchError("\(path): expected an object, got \(actual)") }
            for (key, item) in object { try assert(actualObject[key], item, "\(path).\(key)") }
        default:
            if actual != expected { throw MatchError("\(path): expected \(expected), got \(actual)") }
        }
    }

    private func assertMatcher(_ actual: JSON?, _ matcher: [String: JSON], _ path: String) throws {
        for (key, operand) in matcher {
            guard matchers.contains(key) else { throw MatchError("\(path): unknown matcher \(key)") }
            switch key {
            case "$absent":
                guard operand == .bool(true) else { throw MatchError("\(path): $absent takes true") }
                if let actual { throw MatchError("\(path): expected absent, got \(actual)") }
            case "$any":
                if actual == nil { throw MatchError("\(path): missing") }
            case "$prefix":
                guard case .string(let string)? = actual, let prefix = operand.stringValue, string.hasPrefix(prefix) else {
                    throw MatchError("\(path): expected a string starting \(operand), got \(show(actual))")
                }
            case "$length":
                let length: Int?
                switch actual {
                case .array(let items)?: length = items.count
                // Counted in UTF-16 code units, as JavaScript counts a string's length.
                case .string(let string)?: length = string.utf16.count
                default: length = nil
                }
                guard let length, let expected = operand.numberValue, Double(length) == expected else {
                    throw MatchError("\(path): expected length \(operand), got \(show(actual))")
                }
            case "$each":
                guard case .array(let items)? = actual else { throw MatchError("\(path): expected an array") }
                for (index, item) in items.enumerated() { try assert(item, operand, "\(path)[\(index)]") }
            case "$contains":
                guard case .array(let items)? = actual, items.contains(where: { tries($0, operand) }) else {
                    throw MatchError("\(path): no item matches \(operand) in \(show(actual))")
                }
            case "$not":
                if tries(actual, operand) { throw MatchError("\(path): expected not to match \(operand)") }
            default:
                break
            }
        }
    }

    /// Whether `actual` matches, without keeping bindings; refs inside must already be bound.
    private func tries(_ actual: JSON?, _ expected: JSON) -> Bool {
        let probe = Refs()
        probe.bound = bound
        do {
            try probe.assert(actual, expected)
        } catch {
            return false
        }
        return probe.bound.count == bound.count
    }
}
