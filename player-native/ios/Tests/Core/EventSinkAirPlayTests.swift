import Testing
import LuminaryPlayerCore

/// AirPlay is reported on a change; a page that loads afterwards is told the state once more.
@Suite("AirPlay events")
struct EventSinkAirPlayTests {
    private final class Log { var events: [(String, [String: JSON])] = [] }

    private func make() -> (EventSink, Log) {
        let log = Log()
        let sink = EventSink(
            playerId: "p", clock: ManualClock(), variantSwitching: false,
            emit: { name, payload in log.events.append((name, payload)) }, position: { 0 }
        )
        sink.begin(loadId: "l1")
        return (sink, log)
    }

    private func airPlayEvents(_ log: Log) -> [Bool] {
        log.events.filter { $0.0 == "airplaychange" }.compactMap {
            if case .bool(let available)? = $0.1["available"] { return available }
            return nil
        }
    }

    @Test("a repeat of the same state is not an event")
    func changesOnly() {
        let (sink, log) = make()
        sink.airPlayChanged(available: true, active: false)
        sink.airPlayChanged(available: true, active: false)
        #expect(airPlayEvents(log) == [true])
    }

    @Test("a page that loads later is told the state again")
    func resend() {
        let (sink, log) = make()
        sink.airPlayChanged(available: true, active: false)
        sink.airPlayResend(available: true, active: false)
        #expect(airPlayEvents(log) == [true, true])
    }

    @Test("a subtitle chosen in native UI is told once, and turning it off is told as null")
    func subtitleChanges() {
        let (sink, log) = make()
        func labels() -> [String?] {
            log.events.filter { $0.0 == "subtitlechange" }.map {
                if case .string(let label)? = $0.1["label"] { return label }
                return nil
            }
        }
        sink.subtitleChanged(nil)
        #expect(labels().isEmpty)
        sink.subtitleChanged("English")
        sink.subtitleChanged("English")
        sink.subtitleChanged(nil)
        #expect(labels() == ["English", nil])
    }
}
