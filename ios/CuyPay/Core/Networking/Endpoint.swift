import Foundation

/// Endpoint tipado: método, ruta relativa a la base (`/v1` ya incluido en la base), body crudo y flags.
struct Endpoint<Response: Decodable & Sendable>: Sendable {
    enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case delete = "DELETE"
    }

    struct QueryItem: Sendable, Hashable {
        var name: String
        var value: String
    }

    var method: Method
    /// Ruta relativa, ej. `/transfers`. Se concatena al path de la base URL (`/v1`).
    var path: String
    var query: [QueryItem] = []
    /// Body JSON ya codificado: estos bytes exactos se envían y se hashean para la firma.
    var body: Data?
    /// Requiere `Authorization: Bearer`.
    var requiresAuth: Bool = true
    /// Si no es `nil`, la operación es 🔐 y se firma con Face ID mostrando este texto.
    var signReason: String?
}

extension Endpoint {
    static func get(_ path: String, query: [QueryItem] = [], auth: Bool = true) -> Endpoint {
        Endpoint(method: .get, path: path, query: query, body: nil, requiresAuth: auth, signReason: nil)
    }

    static func post<Body: Encodable>(_ path: String, body: Body, auth: Bool = true, signReason: String? = nil) throws -> Endpoint {
        Endpoint(method: .post, path: path, body: try JSONCoding.makeEncoder().encode(body), requiresAuth: auth, signReason: signReason)
    }

    /// POST sin body (`/auth/logout`, `/kyc/sumsub/token`).
    static func post(_ path: String, auth: Bool = true, signReason: String? = nil) -> Endpoint {
        Endpoint(method: .post, path: path, body: nil, requiresAuth: auth, signReason: signReason)
    }

    static func delete(_ path: String, signReason: String? = nil) -> Endpoint {
        Endpoint(method: .delete, path: path, body: nil, requiresAuth: true, signReason: signReason)
    }
}
