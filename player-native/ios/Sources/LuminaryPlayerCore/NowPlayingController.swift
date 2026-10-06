import Foundation
import MediaPlayer
#if canImport(UIKit)
import UIKit
#endif

/// Control Center and the lock screen: what is playing, and the commands that drive it, whether
/// or not the full-screen view is up. AVKit's view is told not to publish its own, so this is
/// the only source.
///
/// Skips are 5, 10 or 30 s, snapped from ``CreateOptions`` by ``SkinOptions``, as Android's media
/// session does; a direction with no seconds has no button. The command center is the
/// process's, so ``clear()`` removes only the handlers this player added: a player created to
/// replace it keeps its own.
final class NowPlayingController {
    /// What the commands do, on the main thread.
    struct Commands {
        let play: () -> Void
        let pause: () -> Void
        let seek: (Double) -> Void
        /// Moves the playhead by the given seconds, back when negative.
        let skip: (Double) -> Void
    }

    private var registered: [(command: MPRemoteCommand, target: Any)] = []
    private var info: [String: Any] = [:]
    /// Bumped by each item's metadata, so artwork that arrives late for an earlier one is dropped.
    private var metadataGeneration = 0
    private var artworkTask: URLSessionDataTask?

    init(skin: SkinOptions, commands: Commands) {
        let center = MPRemoteCommandCenter.shared()
        register(center.playCommand) { _ in commands.play() }
        register(center.pauseCommand) { _ in commands.pause() }
        register(center.togglePlayPauseCommand) { [weak self] _ in
            // The center's own idea of the state: the rate this controller last published.
            if (self?.info[MPNowPlayingInfoPropertyPlaybackRate] as? Double ?? 0) > 0 {
                commands.pause()
            } else {
                commands.play()
            }
        }
        register(center.changePlaybackPositionCommand) { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return }
            commands.seek(event.positionTime)
        }
        registerSkip(center.skipBackwardCommand, seconds: skin.back) { commands.skip(-$0) }
        registerSkip(center.skipForwardCommand, seconds: skin.forward) { commands.skip($0) }
    }

    /// A new item: its title, subtitle and artwork, with nothing known yet of its playback.
    func setMetadata(_ nowPlaying: NowPlaying?) {
        metadataGeneration += 1
        artworkTask?.cancel()
        artworkTask = nil
        info = [:]
        setHasVideo(true)
        if let nowPlaying {
            info[MPMediaItemPropertyTitle] = nowPlaying.title
            if let subtitle = nowPlaying.subtitle { info[MPMediaItemPropertyArtist] = subtitle }
            let candidates = [nowPlaying.artworkUrl, nowPlaying.fallbackArtworkUrl].compactMap { $0 }.filter { !$0.isEmpty }
            if !candidates.isEmpty { loadArtwork(candidates, generation: metadataGeneration) }
        }
        publish()
    }

    /// Video until the tracks show none.
    func setHasVideo(_ hasVideo: Bool) {
        let type: MPNowPlayingInfoMediaType = hasVideo ? .video : .audio
        info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: type.rawValue)
        publish()
    }

    /// Where playback stands. Control Center runs the clock on from `elapsed` at `rate` until the
    /// next update, so this is needed only when one of them jumps: play, pause, a seek, a new
    /// duration. `duration` is nil while unbounded (live).
    func update(duration: Double?, elapsed: Double, rate: Double) {
        if let duration, duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyIsLiveStream] = false
        } else {
            info.removeValue(forKey: MPMediaItemPropertyPlaybackDuration)
            info[MPNowPlayingInfoPropertyIsLiveStream] = duration == nil
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, elapsed)
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        publish()
    }

    /// The command center outlives this controller: a player freed without ``clear()`` must not
    /// leave its handlers behind.
    deinit {
        removeTargets()
    }

    func clear() {
        removeTargets()
        artworkTask?.cancel()
        artworkTask = nil
        info = [:]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: Internals

    private func removeTargets() {
        for (command, target) in registered { command.removeTarget(target) }
        registered = []
    }

    private func publish() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func register(_ command: MPRemoteCommand, _ handle: @escaping (MPRemoteCommandEvent) -> Void) {
        command.isEnabled = true
        let target = command.addTarget { event in
            handle(event)
            return .success
        }
        registered.append((command, target))
    }

    private func registerSkip(_ command: MPSkipIntervalCommand, seconds: Int?, skip: @escaping (Double) -> Void) {
        guard let seconds else {
            command.isEnabled = false
            return
        }
        command.preferredIntervals = [NSNumber(value: seconds)]
        register(command) { event in
            skip((event as? MPSkipIntervalCommandEvent)?.interval ?? Double(seconds))
        }
    }

    /// The first of `urls` that gives an image: a post's own picture, else the host's stand-in.
    /// One that does not answer, answers with an error page, or is not an image passes to the next.
    private func loadArtwork(_ urls: [String], generation: Int) {
        #if canImport(UIKit)
        guard let first = urls.first else { return }
        let rest = Array(urls.dropFirst())
        guard let url = URL(string: first) else { return loadArtwork(rest, generation: generation) }
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            guard let data, (200..<300).contains(status), let image = UIImage(data: data) else {
                DispatchQueue.main.async {
                    guard let self, self.metadataGeneration == generation else { return }
                    self.loadArtwork(rest, generation: generation)
                }
                return
            }
            DispatchQueue.main.async {
                guard let self, self.metadataGeneration == generation else { return }
                self.info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.publish()
            }
        }
        artworkTask = task
        task.resume()
        #endif
    }
}
