import AVFoundation

/// The `error` event's `category` (`AdapterErrorCategory`) for an AVFoundation failure: a URL
/// error anywhere in the chain is `network`, one AVFoundation raised about the media itself is
/// `media`, and anything else is `other`.
func errorCategory(of error: Error) -> String {
    var current: NSError? = error as NSError
    var sawAVFoundation = false
    while let error = current {
        if error.domain == NSURLErrorDomain || error.domain == UriRouter.errorDomain { return "network" }
        if error.domain == AVFoundationErrorDomain { sawAVFoundation = true }
        current = error.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return sawAVFoundation ? "media" : "other"
}

/// A stable code for the `error` event: the outermost domain and code.
func errorCode(of error: Error) -> String {
    let error = error as NSError
    return "\(error.domain):\(error.code)"
}
