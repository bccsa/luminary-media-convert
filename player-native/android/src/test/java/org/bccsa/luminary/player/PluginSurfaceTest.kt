package org.bccsa.luminary.player

import com.getcapacitor.PluginMethod
import java.io.File
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bridge's TypeScript interface is the contract, and Capacitor answers a call only for a method
 * the plugin class declares: a method decoded and handled natively but not declared here is "not
 * implemented" to the page, which no test that bypasses Capacitor can see.
 */
class PluginSurfaceTest {
    private val declared = LuminaryPlayerPlugin::class.java.declaredMethods
        .filter { it.isAnnotationPresent(PluginMethod::class.java) }
        .map { it.name }
        .toSet()

    /** Every method of `LuminaryPlayerPlugin` in `bridge.ts`, which the Gradle test run reaches at `../src`. */
    private val contract = Regex("^    (\\w+)\\(.*\\): Promise<", RegexOption.MULTILINE)
        .findAll(File("../src/bridge.ts").readText())
        .map { it.groupValues[1] }
        .toList()

    @Test
    fun `the contract was found`() {
        assertTrue("found only $contract", contract.size >= 15)
    }

    @Test
    fun `every method the bridge defines is one the plugin declares`() {
        val missing = contract.filter { it !in declared }
        assertTrue("the plugin does not declare: $missing", missing.isEmpty())
    }

    @Test
    fun `every method the plugin declares is one the native side knows how to decode`() {
        val unknown = declared.filter { name ->
            try {
                BridgeCall.decode(name, JsonObject(emptyMap()))
                false
            } catch (rejection: BridgeRejection) {
                false
            } catch (unknown: IllegalArgumentException) {
                true
            }
        }
        assertTrue("declared but not decoded: $unknown", unknown.isEmpty())
    }
}
