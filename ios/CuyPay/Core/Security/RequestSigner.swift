import CryptoKit
import Foundation

/// Firma de operaciones sensibles (🔐) según `docs/API_CONTRACT.md` §1.4.
///
/// Cadena canónica (separador `\n`, sin salto final):
/// ```
/// <MÉTODO EN MAYÚSCULAS>
/// <path con /v1, sin query>
/// <sha256 hex minúsculas del body crudo; body vacío = sha256("")>
/// <timestamp unix en segundos>
/// <nonce uuid v4>
/// ```
/// Headers: `X-CuyPay-Device`, `X-CuyPay-Timestamp`, `X-CuyPay-Nonce`, `X-CuyPay-Signature`.
struct RequestSigner: Sendable {
    enum Header {
        static let device = "X-CuyPay-Device"
        static let timestamp = "X-CuyPay-Timestamp"
        static let nonce = "X-CuyPay-Nonce"
        static let signature = "X-CuyPay-Signature"
    }

    let signer: any DeviceSigning
    /// Inyectables para tests deterministas.
    var now: @Sendable () -> Date = { Date() }
    var makeNonce: @Sendable () -> String = { UUID().uuidString.lowercased() }

    init(
        signer: any DeviceSigning,
        now: @escaping @Sendable () -> Date = { Date() },
        makeNonce: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.signer = signer
        self.now = now
        self.makeNonce = makeNonce
    }

    /// SHA-256 en hex minúsculas.
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Construye la cadena canónica exacta del contrato.
    /// - Parameter path: path completo **incluyendo** `/v1` y **sin** query (ej. `/v1/transfers`).
    static func canonicalString(method: String, path: String, body: Data, timestamp: Int64, nonce: String) -> String {
        [
            method.uppercased(),
            path,
            sha256Hex(body),
            String(timestamp),
            nonce,
        ].joined(separator: "\n")
    }

    /// Extrae el path canónico de una URL (con `/v1`, sin query, percent-encoded tal como viaja).
    static func canonicalPath(for url: URL) -> String {
        let path = url.path(percentEncoded: true)
        return path.isEmpty ? "/" : path
    }

    /// Firma y devuelve los headers `X-CuyPay-*` para la petición.
    /// Dispara Face ID (Secure Enclave) con `reason` como texto del diálogo.
    func signedHeaders(
        method: String,
        url: URL,
        body: Data,
        deviceId: String,
        reason: String
    ) async throws -> [String: String] {
        let timestamp = Int64(now().timeIntervalSince1970.rounded(.down))
        let nonce = makeNonce()
        let canonical = Self.canonicalString(
            method: method,
            path: Self.canonicalPath(for: url),
            body: body,
            timestamp: timestamp,
            nonce: nonce
        )
        let signature = try await signer.sign(Data(canonical.utf8), reason: reason)
        return [
            Header.device: deviceId,
            Header.timestamp: String(timestamp),
            Header.nonce: nonce,
            Header.signature: signature,
        ]
    }

    /// Aplica los headers firmados a un `URLRequest` ya construido (usa su body crudo exacto).
    func sign(_ request: inout URLRequest, deviceId: String, reason: String) async throws {
        guard let url = request.url else { throw APIError.unknown("URL ausente") }
        let headers = try await signedHeaders(
            method: request.httpMethod ?? "GET",
            url: url,
            body: request.httpBody ?? Data(),
            deviceId: deviceId,
            reason: reason
        )
        for (field, value) in headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
    }
}
