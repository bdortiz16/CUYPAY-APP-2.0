import Foundation
import Testing
@testable import CuyPay

/// Muestras JSON tomadas de `docs/API_CONTRACT.md`.
@Suite("Decodificación de muestras del contrato")
struct DecodingTests {
    private let decoder = JSONCoding.makeDecoder()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder.decode(T.self, from: Data(json.utf8))
    }

    @Test("AuthSession + User")
    func authSession() throws {
        let session = try decode(AuthSession.self, """
        { "accessToken": "jwt", "refreshToken": "opaque", "expiresIn": 900, "deviceId": "dev_1",
          "user": { "id": "usr_1", "firstName": "Ana", "lastName": "Gómez", "email": "ana@cuypay.com",
                    "phone": "+573001234567", "country": "CO", "kycStatus": "not_started", "tier": "basic",
                    "createdAt": "2026-11-07T23:50:10Z" } }
        """)
        #expect(session.expiresIn == 900)
        #expect(session.deviceId == "dev_1")
        #expect(session.user.kycStatus == .notStarted)
        #expect(session.user.tier == .basic)
        #expect(session.user.initials == "AG")
        #expect(session.user.createdAt == Date(timeIntervalSince1970: 1_794_095_410))
    }

    @Test("Wallets")
    func wallets() throws {
        let response = try decode(ItemsResponse<Wallet>.self, """
        { "items": [
          { "currency": "COP", "balanceMinor": 125000000, "availableMinor": 120000000, "heldMinor": 5000000 },
          { "currency": "BRL", "balanceMinor": 182300,    "availableMinor": 182300,    "heldMinor": 0 }
        ] }
        """)
        #expect(response.items.count == 2)
        #expect(response.items[0].available.formatted() == "$ 1.200.000")
        #expect(response.items[1].balance.formatted() == "R$ 1.823,00")
    }

    @Test("BrebKey")
    func brebKey() throws {
        let key = try decode(BrebKey.self, """
        { "id": "brk_1", "alias": "@cuypayana123", "status": "active", "holderName": "Ana Gómez", "createdAt": "2026-11-07T23:50:10.123Z" }
        """)
        #expect(key.alias == "@cuypayana123")
        #expect(key.status == .active)
    }

    @Test("AliasResolution")
    func aliasResolution() throws {
        let resolution = try decode(AliasResolution.self, """
        { "resolutionId": "res_1", "alias": "3001234567", "holderName": "JUAN P***Z", "holderNameFull": "Juan Pérez",
          "documentType": "CC", "documentMasked": "****4321", "bankName": "Bancolombia", "expiresAt": "2026-11-07T23:55:10Z" }
        """)
        #expect(resolution.holderName == "JUAN P***Z")
        #expect(resolution.bankName == "Bancolombia")
    }

    @Test("Beneficiary con AML")
    func beneficiary() throws {
        let beneficiary = try decode(Beneficiary.self, """
        { "id": "ben_1", "alias": "3001234567", "holderName": "Juan Pérez", "nickname": "Juan", "bankName": "Bancolombia",
          "status": "pending_review",
          "aml": { "provider": "sartblock", "result": "review", "referenceId": "ref_1", "checkedAt": "2026-11-07T23:50:10Z" },
          "createdAt": "2026-11-07T23:50:10Z" }
        """)
        #expect(beneficiary.status == .pendingReview)
        #expect(beneficiary.aml?.result == .review)
        #expect(beneficiary.initials == "JP")
    }

    @Test("Quote con rate decimal")
    func quote() throws {
        let quote = try decode(Quote.self, """
        { "quoteId": "qt_1", "fromCurrency": "COP", "toCurrency": "BRL", "fromAmountMinor": 100000000,
          "feeMinor": 1000000, "toAmountMinor": 128729, "rate": 0.0013003, "expiresAt": "2026-11-07T23:50:40Z" }
        """)
        #expect(quote.amountToConvert.minorUnits == 99_000_000)
        #expect(quote.toAmount.formatted() == "R$ 1.287,29")
        #expect(abs(NSDecimalNumber(decimal: quote.rate).doubleValue - 0.0013003) < 1e-12)
    }

    @Test("Transacción de conversión")
    func conversionTransaction() throws {
        let transaction = try decode(WalletTransaction.self, """
        { "id": "txn_1", "type": "conversion", "direction": "out",
          "currency": "COP", "amountMinor": 100000000, "feeMinor": 1000000,
          "status": "completed",
          "title": "Conversión a BRL", "subtitle": null,
          "conversion": { "fromCurrency": "COP", "fromAmountMinor": 100000000, "toCurrency": "BRL", "toAmountMinor": 128729, "rate": 0.0013003 },
          "createdAt": "2026-11-07T23:50:10Z" }
        """)
        #expect(transaction.type == .conversion)
        #expect(transaction.direction == .out)
        #expect(transaction.subtitle == nil)
        #expect(transaction.conversion?.toAmount.minorUnits == 128_729)
    }

    @Test("Página de transacciones con nextCursor nulo")
    func transactionPage() throws {
        let page = try decode(TransactionPage.self, """
        { "items": [ { "id": "txn_2", "type": "deposit", "direction": "in", "currency": "COP", "amountMinor": 5000000,
          "feeMinor": 0, "status": "pending", "title": "Juan Pérez", "subtitle": "Bre-B · @cuypayana123",
          "createdAt": "2026-11-07T23:50:10Z" } ], "nextCursor": null }
        """)
        #expect(page.items.first?.status == .pending)
        #expect(page.items.first?.conversion == nil)
        #expect(page.nextCursor == nil)
    }

    @Test("Estados desconocidos se decodifican como .unknown")
    func unknownEnums() throws {
        let transaction = try decode(WalletTransaction.self, """
        { "id": "txn_3", "type": "cashback", "direction": "in", "currency": "COP", "amountMinor": 1, "feeMinor": 0,
          "status": "on_hold", "title": "x", "createdAt": "2026-11-07T23:50:10Z" }
        """)
        #expect(transaction.type == .unknown)
        #expect(transaction.status == .unknown)
        let user = try decode(KYCStatusResponse.self, #"{ "status": "frozen", "tier": "platinum" }"#)
        #expect(user.status == .unknown)
        #expect(user.tier == .unknown)
    }

    @Test("FxRate con historial")
    func fxRate() throws {
        let rate = try decode(FxRate.self, """
        { "from": "COP", "to": "BRL", "rate": 0.0013003, "inverseRate": 769.05, "updatedAt": "2026-11-07T23:50:10Z",
          "history": [ { "date": "2026-11-06T00:00:00Z", "rate": 0.00129 }, { "date": "2026-11-07T00:00:00Z", "rate": 0.0013003 } ] }
        """)
        #expect(rate.history.count == 2)
        #expect(rate.from == .cop)
    }

    @Test("LimitsSnapshot")
    func limits() throws {
        let snapshot = try decode(LimitsSnapshot.self, LimitsTests.contractSample)
        #expect(snapshot.tier == .full)
        #expect(snapshot.items.count == 5)
        #expect(snapshot.item(.transferOut, .daily)?.remainingMinor == 295_000_000)
    }

    @Test("Error LIMIT_EXCEEDED con details")
    func limitExceededError() throws {
        let envelope = try decode(APIErrorEnvelope.self, """
        { "error": { "code": "LIMIT_EXCEEDED", "message": "Daily limit",
          "details": { "operation": "transfer_out", "period": "daily", "limitMinor": 300000000, "usedMinor": 290000000, "remainingMinor": 10000000 } } }
        """)
        #expect(envelope.error.code == .limitExceeded)
        #expect(envelope.error.details?.remainingMinor == 10_000_000)
        #expect(envelope.error.details?.period == .daily)
        let message = APIError.message(for: envelope.error.code, limit: envelope.error.details)
        #expect(message.contains("$ 100.000"))
    }

    @Test("Error con details libres (AML_REJECTED) no falla")
    func freeformDetails() throws {
        let envelope = try decode(APIErrorEnvelope.self, """
        { "error": { "code": "AML_REJECTED", "message": "x", "details": { "beneficiary": { "id": "ben_1" } } } }
        """)
        #expect(envelope.error.code == .amlRejected)
        #expect(envelope.error.details == nil)
    }

    @Test("Código de error desconocido")
    func unknownErrorCode() throws {
        let envelope = try decode(APIErrorEnvelope.self, #"{ "error": { "code": "SOMETHING_NEW" } }"#)
        #expect(envelope.error.code == .unknown)
    }

    @Test("Fechas ISO-8601 con y sin fracción")
    func dates() {
        let plain = JSONCoding.parseDate("2026-11-07T23:50:10Z")
        let fractional = JSONCoding.parseDate("2026-11-07T23:50:10.500Z")
        #expect(plain != nil)
        #expect(fractional != nil)
        if let plain, let fractional {
            #expect(abs(fractional.timeIntervalSince(plain) - 0.5) < 0.001)
        }
        #expect(JSONCoding.parseDate("ayer") == nil)
    }

    @Test("Los requests se codifican en camelCase")
    func encodeRequest() throws {
        let request = CreateTransferRequest(beneficiaryId: "ben_1", amountMinor: 5_000_000, description: nil, idempotencyKey: "k1")
        let json = String(decoding: try JSONCoding.makeEncoder().encode(request), as: UTF8.self)
        #expect(json == #"{"amountMinor":5000000,"beneficiaryId":"ben_1","idempotencyKey":"k1"}"#)
    }
}
