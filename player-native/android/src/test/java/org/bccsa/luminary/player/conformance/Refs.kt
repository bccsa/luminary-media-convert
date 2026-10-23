package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Refs and matchers for conformance scenarios: a port of
 * `src/test-support/conformance/match.ts`, held to `conformance/selftest/match-cases.json`.
 * The rules are in `conformance/README.md`.
 */
class MatchError(message: String) : AssertionError(message)

private val REF = Regex("^\\$[A-Za-z][A-Za-z0-9_]*$")
private val MATCHERS = setOf("\$absent", "\$any", "\$prefix", "\$length", "\$each", "\$contains", "\$not")
private val ABSENT = JsonObject(mapOf("\$absent" to JsonPrimitive(true)))

/** A string primitive is a string; an unquoted `true` / `false` is a boolean; any other primitive is a number. */
internal val JsonPrimitive.isBoolean get() = !isString && (content == "true" || content == "false")
internal val JsonPrimitive.isNumber get() = !isString && this !is JsonNull && !isBoolean

internal fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonElement?.numberOrNull(): Double? = (this as? JsonPrimitive)?.takeIf { it.isNumber }?.content?.toDouble()

/** JSON equality; numbers compare by value, so 1 and 1.0 are equal, as on every runner. */
internal fun jsonEquals(a: JsonElement?, b: JsonElement?): Boolean = when {
    a == null || b == null -> a == null && b == null
    a is JsonNull || b is JsonNull -> a is JsonNull && b is JsonNull
    a is JsonArray -> b is JsonArray && a.size == b.size && a.indices.all { jsonEquals(a[it], b[it]) }
    a is JsonObject -> b is JsonObject && a.keys == b.keys && a.keys.all { jsonEquals(a[it], b[it]) }
    a is JsonPrimitive && b is JsonPrimitive -> when {
        a.isString || b.isString -> a.isString && b.isString && a.content == b.content
        a.isBoolean || b.isBoolean -> a.isBoolean && b.isBoolean && a.content == b.content
        else -> a.content.toDouble() == b.content.toDouble()
    }
    else -> false
}

internal fun isRef(value: JsonElement?): Boolean = value.stringOrNull()?.let { REF.matches(it) } ?: false

private fun isMatcher(value: JsonElement?): Boolean =
    value is JsonObject && value.isNotEmpty() && value.keys.all { it.startsWith("$") }

private fun show(value: JsonElement?) = value?.toString() ?: "missing"

class Refs {
    private val bound = LinkedHashMap<String, JsonElement>()

    private fun bind(name: String, value: JsonElement, path: String) {
        bound.entries.firstOrNull { jsonEquals(it.value, value) }?.let {
            throw MatchError("$path: $name would bind $value, already held by ${it.key}")
        }
        bound[name] = value
    }

    /** A value to send: bound refs substituted, an unbound ref minted as its own name, `$absent` keys dropped. */
    fun issue(value: JsonElement, path: String = "$"): JsonElement {
        if (isRef(value)) {
            val name = value.stringOrNull()!!
            bound[name]?.let { return it }
            val minted = JsonPrimitive(name.drop(1))
            bind(name, minted, path)
            return minted
        }
        if (isMatcher(value)) throw MatchError("$path: a matcher cannot be sent ($value)")
        return when (value) {
            is JsonArray -> JsonArray(value.mapIndexed { i, item -> issue(item, "$path[$i]") })
            is JsonObject -> JsonObject(
                value.filterValues { !jsonEquals(it, ABSENT) }.mapValues { (key, item) -> issue(item, "$path.$key") },
            )
            else -> value
        }
    }

    /** Throws a [MatchError] naming the first path that does not match. */
    fun assert(actual: JsonElement?, expected: JsonElement, path: String = "$") {
        if (isRef(expected)) {
            val name = expected.stringOrNull()!!
            val held = bound[name]
            if (held == null) {
                if (actual == null) throw MatchError("$path: missing, expected $name")
                bind(name, actual, path)
            } else if (!jsonEquals(actual, held)) {
                throw MatchError("$path: expected $name = $held, got ${show(actual)}")
            }
            return
        }
        if (isMatcher(expected)) return assertMatcher(actual, expected as JsonObject, path)
        if (actual == null) throw MatchError("$path: missing, expected $expected")
        when (expected) {
            is JsonArray -> {
                if (actual !is JsonArray) throw MatchError("$path: expected an array, got $actual")
                if (actual.size != expected.size) {
                    throw MatchError("$path: expected ${expected.size} items, got ${actual.size}")
                }
                expected.forEachIndexed { i, item -> assert(actual[i], item, "$path[$i]") }
            }
            is JsonObject -> {
                if (actual !is JsonObject) throw MatchError("$path: expected an object, got $actual")
                expected.forEach { (key, item) -> assert(actual[key], item, "$path.$key") }
            }
            else -> if (!jsonEquals(actual, expected)) throw MatchError("$path: expected $expected, got $actual")
        }
    }

    private fun assertMatcher(actual: JsonElement?, matcher: JsonObject, path: String) {
        for ((key, operand) in matcher) {
            if (key !in MATCHERS) throw MatchError("$path: unknown matcher $key")
            when (key) {
                "\$absent" -> {
                    if (!jsonEquals(operand, JsonPrimitive(true))) throw MatchError("$path: \$absent takes true")
                    if (actual != null) throw MatchError("$path: expected absent, got $actual")
                }
                "\$any" -> if (actual == null) throw MatchError("$path: missing")
                "\$prefix" -> {
                    val prefix = operand.stringOrNull()
                    val string = actual.stringOrNull()
                    if (prefix == null || string == null || !string.startsWith(prefix)) {
                        throw MatchError("$path: expected a string starting $operand, got ${show(actual)}")
                    }
                }
                "\$length" -> {
                    // String.length counts UTF-16 code units, as JavaScript does.
                    val length = when (actual) {
                        is JsonArray -> actual.size
                        else -> actual.stringOrNull()?.length
                    }
                    if (length == null || length.toDouble() != operand.numberOrNull()) {
                        throw MatchError("$path: expected length $operand, got ${show(actual)}")
                    }
                }
                "\$each" -> {
                    if (actual !is JsonArray) throw MatchError("$path: expected an array")
                    actual.forEachIndexed { i, item -> assert(item, operand, "$path[$i]") }
                }
                "\$contains" -> if (actual !is JsonArray || actual.none { tries(it, operand) }) {
                    throw MatchError("$path: no item matches $operand in ${show(actual)}")
                }
                "\$not" -> if (tries(actual, operand)) throw MatchError("$path: expected not to match $operand")
            }
        }
    }

    /** Whether [actual] matches, without keeping bindings; refs inside must already be bound. */
    private fun tries(actual: JsonElement?, expected: JsonElement): Boolean {
        val probe = Refs()
        probe.bound.putAll(bound)
        return try {
            probe.assert(actual, expected)
            probe.bound.size == bound.size
        } catch (_: MatchError) {
            false
        }
    }
}
