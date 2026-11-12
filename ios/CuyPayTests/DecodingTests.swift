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

    @Test("CardItem decodifica holderName opcional y WalletStore.activeCard ignora canceladas")
    @MainActor
    func cardHolderAndCanceledFiltering() throws {
        let response = try decode(ItemsResponse<CardItem>.self, """
        { "items": [
          { "id": "crd_old", "cardType": "virtual", "status": "canceled", "label": "CuyPay Virtual",
            "holderName": null, "lastFour": "1234", "brand": "Visa", "currency": "COP",
            "createdAt": "2026-11-10T10:00:00Z", "updatedAt": "2026-11-11T10:00:00Z" },
          { "id": "crd_new", "cardType": "virtual", "status": "active", "label": "CuyPay Virtual",
            "holderName": "Bryan Ortiz", "lastFour": "9876", "brand": "Visa", "currency": "COP",
            "createdAt": "2026-11-11T10:05:00Z", "updatedAt": "2026-11-11T10:05:00Z" }
        ] }
        """)
        #expect(response.items.count == 2)
        #expect(response.items[0].holderName == nil)
        #expect(response.items[1].holderName == "Bryan Ortiz")

        let store = WalletStore(api: MockAPIClient())
        store.cards = [response.items[0]]
        #expect(store.activeCard == nil)

        store.cards = response.items
        #expect(store.activeCard?.id == "crd_new")
        #expect(store.activeCard?.holderName == "Bryan Ortiz")
    }

    @Test("User detecta correos placeholder y OnboardingModel exige nombre y correo reales")
    @MainActor
    func placeholderContactAndOnboardingValidation() async throws {
        let legacyUser = User(
            id: "usr_legacy",
            firstName: "Usuario",
            lastName: "CuyPay",
            email: "usuario@cuypay.com",
            phone: "+573005182067",
            country: "CO",
            kycStatus: .approved,
            tier: .full,
            createdAt: Date()
        )
        #expect(legacyUser.hasPlaceholderEmail == true)
        #expect(legacyUser.hasPlaceholderName == true)
        #expect(legacyUser.hasPlaceholderContact == true)

        let realUser = User(
            id: "usr_real",
            firstName: "Bryan",
            lastName: "Ortiz",
            email: "bryan@gmail.com",
            phone: "+573154103795",
            country: "CO",
            kycStatus: .approved,
            tier: .full,
            createdAt: Date()
        )
        #expect(realUser.hasPlaceholderContact == false)

        let mockApi = MockAPIClient(latency: .zero)
        let onboarding = OnboardingModel()
        onboarding.phoneDigits = "3154103792"
        await onboarding.requestOTP(api: mockApi)
        #expect(onboarding.path == [.otp])
        onboarding.otpCode = "000000"
        await onboarding.confirmOTP(api: mockApi)
        #expect(onboarding.path == [.otp])
        #expect(onboarding.otpCode.isEmpty)
        onboarding.otpCode = "123456"
        await onboarding.confirmOTP(api: mockApi)
        #expect(onboarding.path == [.otp, .profile])

        onboarding.firstName = "Usuario"
        onboarding.lastName = "CuyPay"
        onboarding.email = "usuario@cuypay.com"
        #expect(onboarding.isEmailValid == false)
        #expect(onboarding.isProfileValid == false)

        onboarding.firstName = "Bryan"
        onboarding.lastName = "Ortiz"
        onboarding.email = "bryan@gmail.com"
        #expect(onboarding.isEmailValid == true)
        #expect(onboarding.isProfileValid == true)
        onboarding.confirmProfileStep()
        #expect(onboarding.path == [.otp, .profile, .password])

        let updateReq = UpdateProfileRequest(firstName: "Bryan", lastName: "Ortiz", email: "bryan@gmail.com", phone: "+573154103795")
        let encoded = String(decoding: try JSONCoding.makeEncoder().encode(updateReq), as: UTF8.self)
        #expect(encoded.contains(#""email":"bryan@gmail.com""#))
        #expect(encoded.contains(#""phone":"+573154103795""#))
    }

    @Test("Bolsillo de tarjeta decodifica saldos y opera recarga/retiro sin costo en MockAPIClient")
    @MainActor
    func cardPocketDecodingAndMockFlow() async throws {
        let summary = try decode(CardPocketSummary.self, """
        { "currency": "COP", "balanceMinor": 4500000, "availableMinor": 4500000, "mainAvailableMinor": 5500000 }
        """)
        #expect(summary.available.formatted() == "$ 45.000")
        #expect(summary.mainAvailable.formatted() == "$ 55.000")

        let purchase = try decode(WalletTransaction.self, """
        { "id": "txn_cp1", "type": "card_purchase", "direction": "out", "currency": "COP",
          "amountMinor": 1200000, "feeMinor": 0, "status": "completed",
          "title": "Spotify Colombia", "subtitle": "Tarjeta CuyPay •••• 4242",
          "createdAt": "2026-11-11T15:00:00Z" }
        """)
        #expect(purchase.type == .cardPurchase)

        let api = MockAPIClient(latency: .zero)
        let store = WalletStore(api: api)
        await store.refreshAll()
        let initialCop = store.copMainAvailable.minorUnits
        #expect(initialCop > 5_000_000)

        let card = try await api.issueVirtualCard(label: "CuyPay Virtual")
        await store.refreshCards()
        #expect(store.cardPocketBalance.minorUnits == 0)

        let funded = try await api.fundCard(id: card.id, amountMinor: 3_500_000, idempotencyKey: "idem_fund_test_1")
        await store.applyCardPocketTransfer(funded)
        #expect(store.cardPocketBalance.minorUnits == 3_500_000)
        #expect(store.copMainAvailable.minorUnits == initialCop - 3_500_000)
        #expect(store.cardTransactions.first?.type == .cardPocket)

        let withdrawn = try await api.withdrawCard(id: card.id, amountMinor: 1_500_000, idempotencyKey: "idem_withdraw_test_1")
        await store.applyCardPocketTransfer(withdrawn)
        #expect(store.cardPocketBalance.minorUnits == 2_000_000)
        #expect(store.copMainAvailable.minorUnits == initialCop - 2_000_000)
    }

    @Test("Cambio de celular y correo en perfil requiere confirmación OTP por WhatsApp o correo")
    @MainActor
    func whatsappOtpAndProfileContactChangeFlow() async throws {
        let contactOtp = try decode(ContactOTPResponse.self, """
        { "otpId": "otp_wa_1", "channel": "whatsapp", "maskedDestination": "+57315 ••• 3792",
          "expiresAt": "2026-11-11T21:00:00Z", "emailOtpAvailable": true }
        """)
        #expect(contactOtp.channel == .whatsapp)
        #expect(contactOtp.emailOtpAvailable == true)

        let api = MockAPIClient(latency: .zero)
        let phoneOtp = try await api.requestContactOTP(
            ContactOTPRequest(phone: "+573154103792", email: "cliente@cuypay.co", channel: "whatsapp")
        )
        #expect(phoneOtp.channel == .whatsapp)
        #expect(phoneOtp.maskedDestination.contains("3792"))

        let updated = try await api.confirmContactUpdate(
            ConfirmContactUpdateRequest(
                otpId: phoneOtp.otpId,
                otpCode: "123456",
                firstName: "Bryan",
                lastName: "Ortiz",
                email: "cliente@cuypay.co",
                phone: "+573154103792"
            )
        )
        #expect(updated.phone == "+573154103792")
        #expect(updated.email == "cliente@cuypay.co")
        #expect(updated.phoneVerified == true)
    }

    @Test("Bolsillo de Ahorro soporta plazos 30/60/90/180/360d, reserva 72h y certificado")
    @MainActor
    func savingsPocketAndCertificateFlow() async throws {
        let canceledBlock = try decode(SavingsBlock.self, """
        { "id": "sav_1", "termDays": 90, "principalMinor": "50000000", "lockedRate": 11.5,
          "expectedYieldMinor": "1417808", "totalPayoutMinor": "51417808", "currency": "COP",
          "status": "canceled", "escrowStatus": "funded_locked",
          "startedAt": "2026-11-11T12:00:00Z", "maturesAt": "2027-02-09T12:00:00Z" }
        """)
        #expect(canceledBlock.status == .cancelled)
        #expect(canceledBlock.escrowStatus == "funded_locked")

        let api = MockAPIClient(latency: .zero)
        let cfg = try await api.savingsConfig()
        #expect(cfg.rates.map(\.termDays) == [30, 60, 90, 180, 360])

        let beforeWallets = try await api.wallets()
        let beforeCop = beforeWallets.first(where: { $0.currency == .cop })?.availableMinor ?? 0

        let created = try await api.createSavingsBlock(termDays: 60, amountMinor: 10_000_000)
        #expect(created.termDays == 60)
        #expect(created.principal.minorUnits == 10_000_000)

        let afterWallets = try await api.wallets()
        let afterCop = afterWallets.first(where: { $0.currency == .cop })?.availableMinor ?? 0
        #expect(afterCop == beforeCop - 10_000_000)

        let cert = try await api.savingsCertificate(id: created.id)
        #expect(cert.id == created.id)
        #expect(cert.termDays == 60)
    }

    @Test("Créditos CuyPay genera Pagaré Electrónico con SHA-256 y permite pago anticipado sin penalidad")
    @MainActor
    func loansAndPromissoryNoteFlow() async throws {
        let api = MockAPIClient(latency: .zero)
        let cfg = try await api.loansConfig()
        #expect(cfg.rates.map(\.termDays) == [30, 60, 90, 180, 360])
        #expect(cfg.creditorNit == "901.799.579")

        let preview = try await api.previewLoan(
            LoanPreviewRequest(
                principalMinor: "20000000",
                termDays: 90,
                purpose: "Capital de trabajo",
                documentType: "CC",
                documentNumber: "1020304050",
                city: "Bogotá D.C."
            )
        )
        #expect(preview.termDays == 90)
        #expect(preview.documentSha256.count == 64)
        #expect(preview.documentMarkdown.contains("XATECH SERVICES S.A.S."))

        let applied = try await api.applyLoan(
            LoanApplyRequest(
                principalMinor: preview.principalMinor,
                termDays: preview.termDays,
                purpose: "Capital de trabajo",
                documentType: "CC",
                documentNumber: "1020304050",
                city: "Bogotá D.C.",
                documentSha256: preview.documentSha256,
                acceptedPagare: true,
                acceptedInstructionLetter: true,
                acceptedCreditBureauAuth: true
            )
        )
        #expect(applied.status == .pendingReview)

        let note = try await api.loanPromissoryNote(id: applied.id)
        #expect(note.documentSha256 == preview.documentSha256)
        #expect(note.integrityVerified == true)

        // El crédito activo semilla de MockAPIClient permite pago parcial o total sin penalidad
        let list = try await api.userLoans()
        if let activeLoan = list.loans.first(where: { $0.status == .approvedActive }) {
            let paid = try await api.payLoan(id: activeLoan.id, amountMinor: 5_000_000)
            #expect(paid.loan.paid.minorUnits >= 5_000_000)
        }
    }

    @Test("WalletStore sincroniza Bolsillo de Ahorro y Créditos para los cuadrados de Inicio")
    @MainActor
    func homeSquareCardsStoreSync() async throws {
        let api = MockAPIClient(latency: .zero)
        let store = WalletStore(api: api)
        await store.refreshAll()
        #expect(store.savingsLoaded == true)
        #expect(store.savingsConfig != nil)
        #expect(store.userSavings != nil)
        #expect(store.loansLoaded == true)
        #expect(store.loansConfig != nil)
        #expect(store.userLoans != nil)
    }

    @Test("Comprobante CuyPay genera imagen PNG @3x real para compartir en lugar de texto plano")
    @MainActor
    func voucherImageRendering() throws {
        let sample = WalletTransaction(
            id: "txn_01m76jnbch00161zt4jrm0",
            type: .transfer,
            direction: .out,
            currency: .cop,
            amountMinor: 14_300_000,
            feeMinor: 0,
            status: .pending,
            title: "DINA CAMPAA",
            subtitle: "Bre-B · 3167315972",
            conversion: nil,
            createdAt: Date()
        )
        let image = VoucherSharePresenter.renderVoucherImage(
            for: sample,
            pocket: .cop,
            senderName: "Bryan Ortiz"
        )
        #expect(image != nil)
        if let image {
            #expect(image.size.width > 300)
            #expect(image.size.height > 400)
            #expect(image.pngData() != nil)
        }
    }

    @Test("Bre-B respeta @xatechservic para bryan039 y 1019, limpia inmediatamente al eliminar y mapea errores de biometría/gateway")
    @MainActor
    func brebCorporateFormatDeleteAndErrorMapping() async throws {
        #expect(ReceiveView.formatCorporateAlias(suffix: "bryan039") == "@xatechservicbryan039")
        #expect(ReceiveView.formatCorporateAlias(suffix: "1019") == "@xatechservic1019")
        #expect(ReceiveView.formatCorporateAlias(suffix: "@xatechservicbryan039") == "@xatechservicbryan039")
        #expect(ReceiveView.formatCorporateAlias(suffix: "@xatechseric1019") == "@xatechservic1019")
        #expect(ReceiveView.formatCorporateAlias(suffix: "   ") == nil)

        let api = MockAPIClient(latency: .zero)
        let store = WalletStore(api: api)
        await store.refreshAll()
        #expect(store.brebKey != nil)

        try await api.deleteBrebKey()
        store.clearBrebKey()
        #expect(store.brebKey == nil)
        #expect(store.brebKeyLoaded == true)

        let createdNumeric = try await api.createBrebKey(preferredAlias: ReceiveView.formatCorporateAlias(suffix: "1019"))
        #expect(createdNumeric.alias == "@xatechservic1019")

        let changedAlnum = try await api.changeBrebKey(preferredAlias: ReceiveView.formatCorporateAlias(suffix: "bryan039")!)
        #expect(changedAlnum.alias == "@xatechservicbryan039")

        #expect(APIError.biometricFailed.userMessage.contains("Face ID"))
        let gatewayErr = APIClient.parseError(status: 504, data: Data("<html>Gateway time-out</html>".utf8), decoder: decoder)
        #expect(gatewayErr.code == .providerError)
    }
}

