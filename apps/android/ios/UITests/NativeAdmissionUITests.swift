import XCTest

final class NativeAdmissionUITests: XCTestCase {
    @MainActor
    func testColdLaunchAndUnavailableOwnerAuthenticationNeverExposeProductionUi() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Unlock OpenSesame"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Security"].exists)
        app.buttons["Unlock"].tap()
        // The CI simulator has no enrolled owner factor. Real authentication
        // must fail, rather than returning a simulated successful callback.
        XCTAssertTrue(app.staticTexts["Wallet could not be unlocked"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Unlock OpenSesame"].exists)
        XCTAssertFalse(app.buttons["Security"].exists)
        XCTAssertFalse(app.staticTexts["Example membership · member@example.invalid"].exists)
    }
}
