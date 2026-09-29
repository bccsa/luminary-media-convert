package org.bccsa.luminary.player.conformance

/**
 * The harness the scenarios run against, fresh for each one. Plan 02's phase 1a makes it
 * return a `PlayerRegistry` on a `FakeEngine`; until then every scenario fails.
 */
fun makeConformanceHarness(): ConformanceHarness? = null
