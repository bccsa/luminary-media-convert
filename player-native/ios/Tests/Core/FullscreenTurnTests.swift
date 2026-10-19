import XCTest
@testable import LuminaryPlayerCore

final class PoseReadingTests: XCTestCase {
    func testAChangeOfPoseIsReported() {
        var reading = PoseReading()
        XCTAssertTrue(reading.read(.upright))
        XCTAssertTrue(reading.read(.sideways))
        XCTAssertEqual(reading.pose, .sideways)
    }

    func testTheSamePoseAgainIsNoChange() {
        var reading = PoseReading(.sideways)
        XCTAssertFalse(reading.read(.sideways))
    }

    func testFlatOrUnknownKeepsThePoseTheTurnIsOnItsWayIn() {
        // Held sideways and tilted back towards the sky: still sideways.
        var reading = PoseReading(.sideways)
        XCTAssertFalse(reading.read(nil))
        XCTAssertEqual(reading.pose, .sideways)
    }
}

final class UprightExitTests: XCTestCase {
    func testAPhoneStillHeldUprightDoesNotLeaveTheTurnFullScreenMadeItself() {
        var exit = UprightExit()
        XCTAssertFalse(exit.saw(.upright))
        XCTAssertFalse(exit.saw(nil))
        XCTAssertFalse(exit.beenSideways)
    }

    func testOnceThePhoneHasBeenOnItsSideTurningItUprightLeaves() {
        var exit = UprightExit()
        XCTAssertFalse(exit.saw(.sideways))
        XCTAssertFalse(exit.saw(nil))
        XCTAssertTrue(exit.saw(.upright))
    }

    func testBackOnItsSideCallsTheLeavingOff() {
        var exit = UprightExit()
        _ = exit.saw(.sideways)
        XCTAssertTrue(exit.saw(.upright))
        XCTAssertFalse(exit.saw(.sideways))
        XCTAssertTrue(exit.saw(.upright))
    }
}
