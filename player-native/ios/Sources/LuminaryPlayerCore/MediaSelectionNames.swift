import AVFoundation

extension AVMediaSelectionOption {
    /// The name the playlist gives the option (`NAME` in `#EXT-X-MEDIA`). AVFoundation keeps it as the option's
    /// title, and builds `displayName` from the language instead, in the device's language: the page, the web and
    /// Android all show the playlist's own name, so this does too. An option the playlist does not name falls back
    /// to `displayName`.
    public var playlistName: String {
        let title = AVMetadataItem.metadataItems(from: commonMetadata, filteredByIdentifier: .commonIdentifierTitle)
            .first?.stringValue
        if let title, !title.isEmpty { return title }
        return displayName
    }
}
