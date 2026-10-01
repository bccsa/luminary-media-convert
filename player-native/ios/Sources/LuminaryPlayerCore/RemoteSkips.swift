import MediaPlayer

/// Skip back and forward on the lock screen and in Control Center, by the skin's seconds, as
/// Android's media session does. A direction with no seconds has no button.
///
/// The command center is the process's; a player removes only the handlers it added, so a player
/// created to replace it keeps its own.
final class RemoteSkips {
    private var registered: [(command: MPRemoteCommand, target: Any)] = []

    /// `skip` moves the playhead by the given seconds, back when negative.
    init(skin: SkinOptions, skip: @escaping (Double) -> Void) {
        let center = MPRemoteCommandCenter.shared()
        register(center.skipBackwardCommand, seconds: skin.back) { skip(-$0) }
        register(center.skipForwardCommand, seconds: skin.forward) { skip($0) }
    }

    private func register(_ command: MPSkipIntervalCommand, seconds: Int?, skip: @escaping (Double) -> Void) {
        guard let seconds else {
            command.isEnabled = false
            return
        }
        command.preferredIntervals = [NSNumber(value: seconds)]
        command.isEnabled = true
        let target = command.addTarget { event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? Double(seconds)
            skip(interval)
            return .success
        }
        registered.append((command, target))
    }

    func remove() {
        for (command, target) in registered { command.removeTarget(target) }
        registered = []
    }
}
