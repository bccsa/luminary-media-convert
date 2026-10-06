import Foundation

/// What `make-payload.mjs` wrote: the `load` arguments the TypeScript half
/// sends, one visit per angle.
struct Payload: Decodable {
    struct Asset: Decodable {
        let uri: String
        let contentType: String
        let text: String
    }

    struct Angle: Decodable {
        let id: String
        let name: String
    }

    struct Visit: Decodable {
        let angleId: String
        let masterUri: String
        let generation: Int
        let assets: [Asset]
    }

    let masterUrl: String
    let keyHex: String?
    let angles: [Angle]
    let visits: [Visit]

    static func bundled() throws -> Payload {
        guard let url = Bundle.main.url(forResource: "payload", withExtension: "json") else {
            throw NSError(domain: "spike", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "payload.json is not bundled; run make-payload.mjs first",
            ])
        }
        return try JSONDecoder().decode(Payload.self, from: Data(contentsOf: url))
    }

    func name(of visit: Visit) -> String {
        angles.first { $0.id == visit.angleId }?.name ?? visit.angleId
    }
}
