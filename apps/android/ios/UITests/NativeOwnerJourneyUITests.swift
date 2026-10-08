import XCTest

/// Drives production views and LAContext. The host fixture supplies simulated OS sensor input,
/// never application grants, gate records, passwords or Rust return values.
final class NativeOwnerJourneyUITests: XCTestCase {
    @MainActor private var app: XCUIApplication!
    private let current = "Apple visible current application password"
    private let prior = "Apple visible previously retired password"
    private let synthetic = "Apple visible synthetic trap password"
    private let consent = "I accept the offline password-guessing risk of retaining a verifier, including passwords reused elsewhere."

    @MainActor
    func testVisibleOwnerRetiredPasswordLifecycle() async throws {
        app = XCUIApplication()
        app.launch()
        try await setup(password: prior)
        try capture("security-empty", "Selected traps: 0/3")
        fill("Current application password", prior)
        fill("New application password", current)
        try await ownerAction("Change application password")
        returnAndLock()
        try await unlock(current)
        openSecurity()
        fill("Current application password", current)
        fill("Selected retired password", prior)
        try capture("enrollment-default", "Enroll selected retired password", button: true)
        setSwitch(consent, true)
        setSwitch("Synthetic decoy", false)
        try await ownerAction("Enroll selected retired password")
        expect("Record and reject trap")
        try capture("reject-enrolled", "Record and reject trap")
        returnAndLock()
        fill("Application password", prior)
        tap("Unlock")
        waitOwnerOperation()
        expect("Wallet could not be unlocked")
        XCTAssertFalse(app.buttons["Security"].exists)
        try capture("reject-result", "Wallet could not be unlocked")
        try await unlock(current)
        openSecurity()
        fill("Current application password", current)
        fill("Selected retired password", synthetic)
        setSwitch(consent, true)
        setSwitch("Synthetic decoy", true)
        try await ownerAction("Enroll selected retired password")
        expect("Synthetic decoy trap")
        try capture("synthetic-enrolled", "Synthetic decoy trap")
        returnAndLock()
        fill("Application password", synthetic)
        tap("Unlock")
        expect("Example membership · member@example.invalid")
        XCTAssertFalse(app.buttons["Security"].exists)
        try capture("synthetic-realm", "Example membership · member@example.invalid")
        tap("Lock")
        try await unlock(current)
        openSecurity()
        expect("Selected traps: 2/3")
        expect("Local observations: 2/32")
        try capture("fresh-owner", "Local observations: 2/32")
        fill("Current application password", current)
        try await ownerAction("Clear local evidence")
        expect("Local observations: 0/32")
        for remaining in [1, 0] {
            fill("Current application password", current)
            try await ownerAction("Remove trap")
            expect("Selected traps: \(remaining)/3")
        }
        try capture("revoked", "Selected traps: 0/3")
        returnAndLock()
        fill("Application password", synthetic)
        tap("Unlock")
        waitOwnerOperation()
        expect("Wallet could not be unlocked")
        XCTAssertFalse(app.staticTexts["Example membership · member@example.invalid"].exists)
        try capture("revoked-rejected", "Wallet could not be unlocked")
        try await unlock(current)
        openSecurity()
        expect("Selected traps: 0/3")
    }

    @MainActor
    func testVisibleFreshOwnerControlledCanaryLifecycle() async throws {
        app = XCUIApplication()
        app.launch()
        try await setup(password: current)
        fill("Current application password for canaries", current)
        try await ownerAction("Create controlled MCP canary")
        expect("Controlled canaries: 1/16")
        expect("Observations: 1/64")
        try capture("canary-created", "Controlled canaries: 1/16")
        reveal(app.buttons["Share controlled artifact"].firstMatch)
        XCTAssertTrue(app.buttons["Share controlled artifact"].firstMatch.isHittable)
        fill("Current application password for canaries", current)
        try await ownerAction("Clear canary evidence")
        expect("Observations: 0/64")
        fill("Current application password for canaries", current)
        try await ownerAction("Remove controlled canary")
        expect("Controlled canaries: 0/16")
        try capture("canary-revoked", "Controlled canaries: 0/16")
        returnAndLock()
        try await unlock(current)
        openSecurity()
        expect("Controlled canaries: 0/16")
        expect("Observations: 0/64")
        XCTAssertFalse(app.buttons["Share controlled artifact"].exists)
    }

    @MainActor
    private func capture(_ name: String, _ label: String, button: Bool = false) throws {
        let target = button ? app.buttons[label].firstMatch : app.staticTexts[label].firstMatch
        reveal(target)
        try NativeVisualCapture.capture(name, app: app, target: target, test: self)
    }
    @MainActor
    private func setup(password: String) async throws {
        expect("Unlock OpenSesame")
        try await ownerAction("Unlock")
        openSecurity()
        fill("New application password", password)
        try await ownerAction("Set application password")
        expect("Selected traps: 0/3")
    }
    @MainActor
    private func unlock(_ password: String) async throws {
        expect("Unlock OpenSesame")
        fill("Application password", password)
        try await ownerAction("Unlock")
        XCTAssertTrue(app.buttons["Security"].waitForExistence(timeout: 30))
    }
    @MainActor
    private func ownerAction(_ label: String) async throws {
        tap(label)
        // First-use Face ID consent is a real platform alert, not an application auth shortcut.
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for host in [app, system] {
            for label in ["Allow", "OK"] {
                let button = host.alerts.buttons[label].firstMatch
                if button.waitForExistence(timeout: 1), button.isHittable { button.tap() }
            }
        }
        try await matchSensor()
        waitOwnerOperation()
    }
    @MainActor
    private func waitOwnerOperation() {
        let progress = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Verifying owner…")).firstMatch
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: progress)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 30), .completed)
    }
    @MainActor
    private func matchSensor() async throws {
        let bundle = Bundle(for: NativeOwnerJourneyUITests.self)
        guard let address = bundle.object(forInfoDictionaryKey: "OpenSesameBiometricHelperURL") as? String,
              let origin = URL(string: address), origin.scheme == "http", origin.host == "127.0.0.1",
              origin.path.isEmpty, origin.user == nil, origin.password == nil else {
            throw JourneyError.missingHostFixture
        }
        var request = URLRequest(url: origin.appendingPathComponent("match"), timeoutInterval: 15)
        request.httpMethod = "POST"
        request.httpBody = Data("{\"v\":1,\"action\":\"match\"}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await URLSession.shared.data(for: request)
        struct SensorResult: Decodable { let matched: Bool }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              try JSONDecoder().decode(SensorResult.self, from: data).matched else {
            throw JourneyError.sensorRefused
        }
    }
    @MainActor
    private func openSecurity() { tap("Security"); expect("Security · Decoy · Retired passwords") }
    @MainActor
    private func returnAndLock() {
        let back = app.navigationBars["Security"].buttons.element(boundBy: 0)
        XCTAssertTrue(back.exists); back.tap()
        tap("Lock"); expect("Unlock OpenSesame")
    }
    @MainActor
    private func fill(_ label: String, _ value: String) {
        let field = app.secureTextFields[label].firstMatch
        reveal(field); field.tap(); field.typeText(value)
        let keyboard = app.keyboards.firstMatch
        for label in ["Return", "Done"] {
            let button = keyboard.buttons[label]
            if button.exists { button.tap(); break }
        }
    }
    @MainActor
    private func setSwitch(_ label: String, _ enabled: Bool) {
        let control = app.switches[label].firstMatch
        reveal(control)
        if (control.value as? String == "1") != enabled { control.tap() }
        XCTAssertEqual(control.value as? String, enabled ? "1" : "0")
    }
    @MainActor
    private func tap(_ label: String) {
        let button = app.buttons[label].firstMatch
        reveal(button); XCTAssertTrue(button.isEnabled); button.tap()
    }
    @MainActor
    private func expect(_ label: String) {
        let text = app.staticTexts[label].firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 30), "Expected visible journey state")
        reveal(text)
    }
    @MainActor
    private func reveal(_ element: XCUIElement) {
        if element.exists && element.isHittable { return }
        for _ in 0..<14 {
            app.swipeDown()
            if element.exists && element.isHittable { return }
        }
        for _ in 0..<24 {
            app.swipeUp()
            if element.exists && element.isHittable { return }
        }
        XCTAssertTrue(element.exists && element.isHittable, "Required production control is not reachable")
    }
    private enum JourneyError: Error { case missingHostFixture, sensorRefused }
}
