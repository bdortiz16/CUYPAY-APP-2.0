import CryptoKit
import Foundation
import Testing
@testable import CuyPay

@Suite("RequestSigner — cadena canónica y firma (contrato §1.4)")
struct RequestSignerTests {
    @Test("sha256 de body vacío es sha256(\"\")")
    func emptyBodyHash() {
        #expect(RequestSigner.sha256Hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test("sha256 en hex minúsculas")
    func knownHash() {
        #expect(RequestSigner.sha256Hex(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test("Cadena canónica exacta: 5 líneas, sin salto final")
    func canonicalStringExact() {
        let body = Data(#"{"amountMinor":5000000,"beneficiaryId":"ben_1","idempotencyKey":"k1"}"#.utf8)
        let canonical = RequestSigner.canonicalString(
            method: "post",
            path: "/v1/transfers",
            body: body,
            timestamp: 1_700_000_000,
            nonce: "3f1c2b8e-7d4a-4c1e-9b2f-0a1b2c3d4e5f"
        )
        let expected = "POST\n/v1/transfers\n\(RequestSigner.sha256Hex(body))\n1700000000\n3f1c2b8e-7d4a-4c1e-9b2f-0a1b2c3d4e5f"
        #expect(canonical == expected)
        #expect(!canonical.hasSuffix("\n"))
        #expect(canonical.split(separator: "\n", omittingEmptySubsequences: false).count == 5)
    }

    @Test("Cadena canónica con body vacío (DELETE)")
    func canonicalStringEmptyBody() {
        let canonical = RequestSigner.canonicalString(
            method: "DELETE", path: "/v1/beneficiaries/ben_1", body: Data(), timestamp: 1, nonce: "n"
        )
        #expect(canonical == "DELETE\n/v1/beneficiaries/ben_1\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1\nn")
    }

    @Test("El path canónico incluye /v1 y excluye la query")
    func canonicalPathStripsQuery() throws {
        let url = try #require(URL(string: "http://localhost:8080/v1/transactions?currency=COP&limit=30"))
        #expect(RequestSigner.canonicalPath(for: url) == "/v1/transactions")
    }

    @Test("La clave pública es X9.63 sin comprimir (65 bytes, 0x04)")
    func publicKeyFormat() throws {
        let key = SoftwareSigningKey()
        let data = try #require(Data(base64Encoded: try key.publicKeyBase64()))
        #expect(data.count == 65)
        #expect(data.first == 0x04)
    }

    @Test("Headers firmados y firma DER verificable con la clave pública")
    func signedHeadersVerify() async throws {
        let key = SoftwareSigningKey()
        let fixedNonce = "0b9a5c7e-1111-4222-8333-944455556666"
        let signer = RequestSigner(
            signer: key,
            now: { Date(timeIntervalSince1970: 1_700_000_000.9) },
            makeNonce: { fixedNonce }
        )
        let url = try #require(URL(string: "http://localhost:8080/v1/fx/conversions"))
        let body = Data(#"{"idempotencyKey":"abc","quoteId":"qt_1"}"#.utf8)

        let headers = try await signer.signedHeaders(method: "POST", url: url, body: body, deviceId: "dev_1", reason: "test")

        #expect(headers[RequestSigner.Header.device] == "dev_1")
        #expect(headers[RequestSigner.Header.timestamp] == "1700000000")
        #expect(headers[RequestSigner.Header.nonce] == fixedNonce)

        let signatureB64 = try #require(headers[RequestSigner.Header.signature])
        let der = try #require(Data(base64Encoded: signatureB64))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
        let canonical = RequestSigner.canonicalString(
            method: "POST", path: "/v1/fx/conversions", body: body, timestamp: 1_700_000_000, nonce: fixedNonce
        )
        let publicKeyData = try #require(Data(base64Encoded: try key.publicKeyBase64()))
        let publicKey = try P256.Signing.PublicKey(x963Representation: publicKeyData)
        #expect(publicKey.isValidSignature(signature, for: Data(canonical.utf8)))
        // Una alteración del body invalida la firma.
        #expect(!publicKey.isValidSignature(signature, for: Data((canonical + "x").utf8)))
    }

    @Test("sign(&request) usa el body crudo y el método del URLRequest")
    func signURLRequest() async throws {
        let key = SoftwareSigningKey()
        let signer = RequestSigner(signer: key, now: { Date(timeIntervalSince1970: 42) }, makeNonce: { "nonce-1" })
        var request = URLRequest(url: try #require(URL(string: "https://api.cuypay.com/v1/breb/key")))
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        try await signer.sign(&request, deviceId: "dev_9", reason: "test")
        #expect(request.value(forHTTPHeaderField: "X-CuyPay-Device") == "dev_9")
        #expect(request.value(forHTTPHeaderField: "X-CuyPay-Timestamp") == "42")
        #expect(request.value(forHTTPHeaderField: "X-CuyPay-Nonce") == "nonce-1")
        #expect(request.value(forHTTPHeaderField: "X-CuyPay-Signature") != nil)
    }

    @Test("Firma del nonce de login verificable")
    func loginNonceSignature() async throws {
        let key = SoftwareSigningKey()
        let nonce = "c2VydmVyLW5vbmNl"
        let der = try #require(Data(base64Encoded: try await key.sign(Data(nonce.utf8), reason: "login")))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
        let publicKey = try P256.Signing.PublicKey(x963Representation: try #require(Data(base64Encoded: try key.publicKeyBase64())))
        #expect(publicKey.isValidSignature(signature, for: Data(nonce.utf8)))
    }
}
