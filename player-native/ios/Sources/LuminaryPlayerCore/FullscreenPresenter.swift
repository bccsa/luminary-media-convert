import AVFoundation

/// Where a presented player is shown: the bridge's `presentationchange` states.
public enum Presentation: String {
    case inline, fullscreen, pip
}

/// What full-screen controls ask of the engine. The viewer's actions go through it rather than
/// to the player, so the engine keeps the viewer's intent and JavaScript hears each choice.
public struct FullscreenCommands {
    public var play: () -> Void
    public var pause: () -> Void
    public var seek: (_ position: Double) -> Void
    public var setRate: (_ rate: Double) -> Void
    /// The speed playback has, which holds while paused when the player's own rate reads 0.
    public var rate: () -> Double
    public var setAudioTrack: (_ id: String) -> Void
    /// The tracks the audio menu lists, and the one playing.
    public var audioTracks: () -> (tracks: [AudioTrack], activeId: String?)
    /// The viewer asked for playback, whether or not data is flowing.
    public var playbackWanted: () -> Bool
    /// The skip intervals.
    public var skin: SkinOptions

    public init(
        play: @escaping () -> Void,
        pause: @escaping () -> Void,
        seek: @escaping (Double) -> Void,
        setRate: @escaping (Double) -> Void,
        rate: @escaping () -> Double,
        setAudioTrack: @escaping (String) -> Void,
        audioTracks: @escaping () -> (tracks: [AudioTrack], activeId: String?),
        playbackWanted: @escaping () -> Bool,
        skin: SkinOptions
    ) {
        self.play = play
        self.pause = pause
        self.seek = seek
        self.setRate = setRate
        self.rate = rate
        self.setAudioTrack = setAudioTrack
        self.audioTracks = audioTracks
        self.playbackWanted = playbackWanted
        self.skin = skin
    }
}

/// Shows an engine's player full-screen. The view only borrows the player; dismissing hands it
/// back. The iOS implementation, with controls drawn to `player-web`'s skin (plan 05), sits in
/// `LuminaryPlayerUI`, beside UIKit.
public protocol FullscreenPresenter: AnyObject {
    /// False when already presented, or there is nowhere to present. `commands` are what the
    /// controls drive. `onLeave` is the viewer asking to leave; the engine decides what that means
    /// and dismisses. `onPresentation` is the viewer moving the player between full-screen and
    /// picture in picture.
    func present(
        _ player: AVPlayer,
        commands: FullscreenCommands,
        texts: FullscreenTexts,
        onLeave: @escaping () -> Void,
        onPresentation: @escaping (Presentation) -> Void
    ) -> Bool

    /// Starts picture in picture from the full-screen view. False when none is presented.
    func startPictureInPicture() -> Bool

    /// False when nothing was presented.
    func dismiss() -> Bool
}
