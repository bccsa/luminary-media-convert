import XCTest
@testable import LuminaryPlayerCore

/// Full-screen opened from a phone held upright: held sideways through its own turn and until the
/// phone is on its side, then left by turning the phone upright.
final class FullscreenTurnTests: XCTestCase {
    func testHoldsLandscapeWhileItsOwnTurnIsOnItsWay() {
        var turn = FullscreenTurn()
        XCTAssertFalse(turn.holdingLandscape)
        turn.began()
        XCTAssertTrue(turn.turning)
        XCTAssertTrue(turn.holdingLandscape)
    }

    func testLetsGoAsTheTurnEndsWhenThePhoneIsAlreadyOnItsSide() {
        var turn = FullscreenTurn()
        turn.began()
        XCTAssertTrue(turn.ended(deviceSideways: true))
        XCTAssertFalse(turn.turning)
        XCTAssertFalse(turn.holdingLandscape)
    }

    func testKeepsHoldingAPhoneStillHeldUprightUntilItIsTurned() {
        var turn = FullscreenTurn()
        turn.began()
        XCTAssertFalse(turn.ended(deviceSideways: false))
        XCTAssertTrue(turn.holdingLandscape)
        // Wobbles and lying flat are not a turn.
        XCTAssertFalse(turn.deviceTurned(sideways: false))
        XCTAssertTrue(turn.holdingLandscape)

        XCTAssertTrue(turn.deviceTurned(sideways: true))
        XCTAssertFalse(turn.holdingLandscape)
    }

    func testIgnoresThePhoneWhileItsOwnTurnIsOnItsWay() {
        var turn = FullscreenTurn()
        turn.began()
        XCTAssertFalse(turn.deviceTurned(sideways: true))
        XCTAssertTrue(turn.holdingLandscape)
        // The end of the turn reads the phone afresh.
        XCTAssertTrue(turn.ended(deviceSideways: true))
    }

    func testEndsOnceWhetherByTheTransitionTheErrorOrTheTimer() {
        var turn = FullscreenTurn()
        turn.began()
        XCTAssertFalse(turn.ended(deviceSideways: false))
        XCTAssertFalse(turn.ended(deviceSideways: true))
        XCTAssertTrue(turn.holdingLandscape)
    }

    func testTurningUprightLeavesALandscapePictureButNotItsOwnTurn() {
        var turn = FullscreenTurn()
        XCTAssertTrue(turn.leaves(toWidth: 390, height: 844, videoIsLandscape: true))
        XCTAssertFalse(turn.leaves(toWidth: 844, height: 390, videoIsLandscape: true))
        XCTAssertFalse(turn.leaves(toWidth: 390, height: 844, videoIsLandscape: false))

        turn.began()
        XCTAssertFalse(turn.leaves(toWidth: 390, height: 844, videoIsLandscape: true))
    }

    func testOpenedSidewaysByTurningThePhoneItFollowsThePhoneAtOnce() {
        // No turn of its own: nothing is held, and turning upright leaves.
        let turn = FullscreenTurn()
        XCTAssertFalse(turn.holdingLandscape)
        XCTAssertTrue(turn.leaves(toWidth: 390, height: 844, videoIsLandscape: true))
    }
}
