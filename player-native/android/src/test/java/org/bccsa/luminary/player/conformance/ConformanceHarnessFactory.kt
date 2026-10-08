package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.bccsa.luminary.player.BridgeCapabilities
import org.bccsa.luminary.player.BridgeRejection
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.PlayerRegistry
import org.bccsa.luminary.player.UriRouter

/** The harness the scenarios run against, fresh for each one. */
fun makeConformanceHarness(): ConformanceHarness? = RegistryHarness()

/** The real [PlayerRegistry] on a [FakeEngine] and a [VirtualClock]. */
private class RegistryHarness : ConformanceHarness {
    private val clock = VirtualClock()
    private val events = mutableListOf<JsonObject>()
    private val engineCalls = mutableListOf<JsonObject>()
    private val engines = mutableMapOf<UriRouter, FakeEngine>()
    private var registry: PlayerRegistry? = null

    /** The most recently created player's router, kept here so the registry need not remember destroyed players. */
    private var lastRouter: UriRouter? = null

    override fun start(capabilities: JsonObject) {
        val factory = EngineFactory { router, clock, _ -> FakeEngine(clock, engineCalls).also { engines[router] = it; lastRouter = router } }
        registry = PlayerRegistry(BridgeCapabilities.fromJson(capabilities), clock, upstream = null, factory) { name, payload ->
            events += buildJsonObject {
                put("name", name)
                put("payload", payload)
            }
        }
    }

    override fun call(method: String, args: JsonObject): CallResult = try {
        CallResult.Resolved(started().call(method, args))
    } catch (rejection: BridgeRejection) {
        CallResult.Rejected(rejection.code.wire, rejection.message ?: "")
    }

    override fun engine(signal: String, args: JsonObject) {
        val router = lastRouter ?: throw IllegalStateException("No engine: create a player first")
        engines.getValue(router).signal(signal, args)
    }

    override fun advanceClock(seconds: Double) = clock.advance(seconds)

    override fun drainEvents(): List<JsonObject> = events.toList().also { events.clear() }

    override fun drainEngineCalls(): List<JsonObject> = engineCalls.toList().also { engineCalls.clear() }

    override fun route(uri: String): RouteResult {
        val router = lastRouter ?: return RouteResult.Failed("not-found")
        return when (val route = router.route(uri)) {
            is UriRouter.Route.Served -> RouteResult.Served(route.bytes, route.contentType)
            is UriRouter.Route.Failed -> RouteResult.Failed(route.code)
            // Live reads belong to the live tests; the scenarios route only assets and the key.
            is UriRouter.Route.Live, UriRouter.Route.Unanswered -> RouteResult.Failed("not-found")
        }
    }

    private fun started(): PlayerRegistry = registry ?: throw IllegalStateException("start the harness first")
}
