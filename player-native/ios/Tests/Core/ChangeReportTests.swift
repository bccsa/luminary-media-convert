import XCTest
@testable import LuminaryPlayerCore

final class ChangeReportTests: XCTestCase {
    func testWhatThePageAlreadyAssumesIsNotTold() {
        var report = ChangeReport<String?>(nil)
        XCTAssertFalse(report.tells(nil))
    }

    func testAChangeIsToldOnceAndARepeatOfItNotAtAll() {
        var report = ChangeReport<String?>(nil)
        XCTAssertTrue(report.tells("English"))
        XCTAssertFalse(report.tells("English"))
        XCTAssertTrue(report.tells("Français"))
        XCTAssertTrue(report.tells(nil))
        XCTAssertFalse(report.tells(nil))
    }
}
