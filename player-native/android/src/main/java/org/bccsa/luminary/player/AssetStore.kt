package org.bccsa.luminary.player

/**
 * generation → uri → (bytes, contentType): the munged text JavaScript sent, answered from memory.
 * Read from ExoPlayer's loader threads while the main thread writes it.
 */
class AssetStore {
    class Asset(val bytes: ByteArray, val contentType: String)

    private val generations = HashMap<Int, HashMap<String, Asset>>()
    private val liveSpecs = HashMap<Int, HashMap<String, LiveSpec>>()
    private val released = HashSet<Int>()

    @Synchronized
    fun put(generation: Int, assets: List<BridgeAsset>) {
        val store = generations.getOrPut(generation) { HashMap() }
        for (asset in assets) store[asset.uri] = Asset(asset.text.toByteArray(Charsets.UTF_8), asset.contentType)
    }

    @Synchronized
    fun get(uri: String): Asset? = generations.values.firstNotNullOfOrNull { it[uri] }

    @Synchronized
    fun putLive(generation: Int, uri: String, spec: LiveSpec) {
        liveSpecs.getOrPut(generation) { HashMap() }.put(uri, spec)?.zero()
    }

    @Synchronized
    fun live(uri: String): LiveSpec? = liveSpecs.values.firstNotNullOfOrNull { it[uri] }

    /** Marks a generation for purging; it stays answerable until a newer load has taken over. */
    @Synchronized
    fun release(generation: Int) {
        released += generation
    }

    /** Called once a load of [current] has been handed to the engine. */
    @Synchronized
    fun purgeReleasedBefore(current: Int) {
        val purged = released.filter { it < current }
        purged.forEach {
            generations.remove(it)
            liveSpecs.remove(it)?.values?.forEach(LiveSpec::zero)
        }
        released -= purged.toSet()
    }

    @Synchronized
    fun clear() {
        generations.clear()
        liveSpecs.values.forEach { it.values.forEach(LiveSpec::zero) }
        liveSpecs.clear()
        released.clear()
    }
}
