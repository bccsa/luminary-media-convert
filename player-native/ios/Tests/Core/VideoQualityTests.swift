import XCTest
@testable import LuminaryPlayerCore

final class VideoQualityTests: XCTestCase {
    func testOffersEachHeightOnceTallestFirst() {
        XCTAssertEqual(VideoQuality.choices(heights: [480, 1080, 720, 720.4, 1080]), [1080, 720, 480])
    }

    func testOffersNothingForOneHeightOrNone() {
        XCTAssertEqual(VideoQuality.choices(heights: [720, 720]), [])
        XCTAssertEqual(VideoQuality.choices(heights: [0, .nan, -1]), [])
    }

    func testNamesAHeightAsTheOtherMenusDo() {
        XCTAssertEqual(VideoQuality.label(720), "720p")
    }
}
