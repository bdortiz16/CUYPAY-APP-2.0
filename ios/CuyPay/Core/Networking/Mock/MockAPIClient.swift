import Foundation

/// Implementación demo de `CuyPayAPI` con datos realistas y latencia simulada.
/// Permite usar toda la app sin backend (previews, simulador, demos al equipo).
///
/// Llaves Bre-B "mágicas" para probar el flujo de beneficiarios:
/// - contiene `noexiste` o termina en `0000` → `BREB_ALIAS_NOT_FOUND`
/// - contiene `revision` o termina en `9999` → AML `pending_review`
/// - contiene `rechazo` o termina en `6666` → AML `rejected`
/// - cualquier otra → beneficiario `active`
actor MockAPIClient: CuyPayAPI {
    private let latency: Duration
    private let signer: (any DeviceSigning)?
    private let tokens: TokenStore

    private var user: User
    private var walletsState: [Wallet]
    private var brebKeyState: BrebKey?
    private var cardsState: [CardItem]
    private var beneficiariesState: [Beneficiary]
    private var transactionsState: [WalletTransaction]
    private var limitsState: LimitsSnapshot
    private var devicesState: [Device]
    private var quotes: [String: Quote] = [:]
    private var resolutions: [String: AliasResolution] = [:]
    private var usedIdempotencyKeys: [String: WalletTransaction] = [:]
    private var kycStartedAt: Date?

    /// - Parameters:
    ///   - latency: demora simulada por petición (0 en previews).
    ///   - signer: si se pasa y existe clave, las operaciones 🔐 piden Face ID igual que en producción.
    ///   - startsVerified: usuario demo con KYC aprobado y llave Bre-B creada.
    init(latency: Duration = .milliseconds(600), signer: (any DeviceSigning)? = nil, startsVerified: Bool = true) {
        self.latency = latency
        self.signer = signer
        self.tokens = TokenStore(keychain: KeychainStore(service: "com.cuypay.app.mock"))
        let fixtures = MockFixtures(now: Date())
        self.user = startsVerified ? fixtures.user : fixtures.user.with(kycStatus: .notStarted, tier: .basic)
        self.walletsState = fixtures.wallets
        self.brebKeyState = nil
        self.cardsState = []
        self.beneficiariesState = fixtures.beneficiaries
        self.transactionsState = fixtures.transactions
        self.limitsState = fixtures.limits
        self.devicesState = fixtures.devices
    }

    // MARK: - Helpers

    private func simulateLatency(_ factor: Double = 1) async {
        guard latency > .zero else { return }
        try? await Task.sleep(for: latency * factor)
    }

    private func requireSignature(_ reason: String) async throws {
        guard let signer, signer.hasKey() else { return }
        do {
            _ = try await signer.sign(Data("mock".utf8), reason: reason)
        } catch DeviceKeyError.biometryCancelled {
            throw APIError.biometricCancelled
        } catch {
            throw APIError.deviceKeyUnavailable
        }
    }

    private func requireKYC() throws {
        guard user.kycStatus == .approved else {
            throw APIError.server(status: 403, code: user.kycStatus == .pending ? .kycPending : .kycRequired, message: nil, limit: nil)
        }
    }

    private func walletIndex(_ currency: Currency) -> Int {
        walletsState.firstIndex { $0.currency == currency } ?? 0
    }

    private func addUsage(_ amountMinor: Int64, operation: LimitOperation) {
        for index in limitsState.items.indices where limitsState.items[index].operation == operation {
            limitsState.items[index].usedMinor += amountMinor
        }
    }

    private func checkLimits(_ amountMinor: Int64, operation: LimitOperation) throws {
        for item in limitsState.items(for: operation) where amountMinor > item.remainingMinor {
            throw APIError.server(
                status: 422,
                code: .limitExceeded,
                message: nil,
                limit: LimitExceededDetails(
                    operation: operation,
                    period: item.period,
                    limitMinor: item.limitMinor,
                    usedMinor: item.usedMinor,
                    remainingMinor: item.remainingMinor
                )
            )
        }
    }

    private static func newId(_ prefix: String) -> String {
        prefix + "_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    }

    // MARK: - Sesión local

    func storedDeviceId() async -> String? { await tokens.deviceId }
    func clearLocalSession() async { await tokens.clearSession() }
    func forgetDevice() async { await tokens.clearAll() }

    // MARK: - Auth

    func requestOTP(phone: String) async throws -> OTPRequestResponse {
        await simulateLatency()
        return OTPRequestResponse(otpId: Self.newId("otp"), expiresAt: Date().addingTimeInterval(300))
    }

    func register(_ request: RegisterRequest) async throws -> AuthSession {
        await simulateLatency(1.5)
        guard request.otpCode == "123456" else {
            throw APIError.server(status: 400, code: .otpInvalid, message: nil, limit: nil)
        }
        user = User(
            id: Self.newId("usr"),
            firstName: request.firstName,
            lastName: request.lastName,
            email: request.email,
            phone: request.phone,
            country: request.country,
            kycStatus: .notStarted,
            tier: .basic,
            createdAt: Date()
        )
        brebKeyState = nil
        cardsState = []
        let session = AuthSession(accessToken: "mock.jwt", refreshToken: "mock-refresh", expiresIn: 900, deviceId: Self.newId("dev"), user: user)
        try? await tokens.store(session)
        return session
    }

    func challenge(deviceId: String) async throws -> AuthChallenge {
        await simulateLatency(0.5)
        return AuthChallenge(challengeId: Self.newId("chl"), nonce: UUID().uuidString.lowercased(), expiresAt: Date().addingTimeInterval(60))
    }

    func login(challengeId: String, deviceId: String, signature: String) async throws -> AuthSession {
        await simulateLatency()
        let session = AuthSession(accessToken: "mock.jwt", refreshToken: "mock-refresh", expiresIn: 900, deviceId: deviceId, user: user)
        try? await tokens.store(session)
        return session
    }

    func logout() async throws {
        await simulateLatency(0.5)
        await tokens.clearSession()
    }

    func me() async throws -> User {
        await simulateLatency(0.5)
        return user
    }

    // MARK: - KYC

    func sumsubToken() async throws -> SumsubTokenResponse {
        await simulateLatency()
        if user.kycStatus == .notStarted || user.kycStatus == .retry {
            kycStartedAt = Date()
            user.kycStatus = .pending
        }
        return SumsubTokenResponse(token: "_act-sbx-mock-token", levelName: "basic-kyc-level", expiresAt: Date().addingTimeInterval(600))
    }

    func kycStatus() async throws -> KYCStatusResponse {
        await simulateLatency(0.5)
        // En demo, la verificación se aprueba ~4 s después de enviarla.
        if user.kycStatus == .pending, let kycStartedAt, Date().timeIntervalSince(kycStartedAt) > 4 {
            user.kycStatus = .approved
            user.tier = .full
        }
        return KYCStatusResponse(status: user.kycStatus, tier: user.tier, reviewAnswer: user.kycStatus == .approved ? "GREEN" : nil, rejectLabels: nil)
    }

    // MARK: - Bolsillos

    func wallets() async throws -> [Wallet] {
        await simulateLatency(0.6)
        return walletsState
    }

    // MARK: - Bre-B

    func brebKey() async throws -> BrebKey? {
        await simulateLatency(0.5)
        return brebKeyState
    }

    func createBrebKey(preferredAlias: String?) async throws -> BrebKey {
        try requireKYC()
        if brebKeyState != nil {
            throw APIError.server(status: 409, code: .brebKeyExists, message: nil, limit: nil)
        }
        try await requireSignature(SignReason.createBrebKey)
        await simulateLatency(1.5)
        let generated = "@cuypay\(user.firstName.lowercased().folding(options: .diacriticInsensitive, locale: nil))\(Int.random(in: 100...999))"
        let base: String
        if let preferredAlias, !preferredAlias.isEmpty {
            base = preferredAlias
        } else {
            base = generated
        }
        let alias = base.hasPrefix("@") ? base : "@" + base
        if alias == "@cuypay" {
            throw APIError.server(status: 409, code: .brebAliasTaken, message: nil, limit: nil)
        }
        let key = BrebKey(id: Self.newId("brk"), alias: alias, status: .active, holderName: user.fullName, createdAt: Date())
        brebKeyState = key
        return key
    }

    func changeBrebKey(preferredAlias: String) async throws -> BrebKey {
        try requireKYC()
        try await requireSignature(SignReason.changeBrebKey)
        await simulateLatency(1.5)
        let alias = preferredAlias.hasPrefix("@") ? preferredAlias : "@" + preferredAlias
        let key = BrebKey(id: Self.newId("brk"), alias: alias, status: .active, holderName: user.fullName, createdAt: Date())
        brebKeyState = key
        return key
    }

    func deleteBrebKey() async throws {
        try requireKYC()
        try await requireSignature(SignReason.deleteBrebKey)
        await simulateLatency(1)
        brebKeyState = nil
    }

    // MARK: - Tarjetas (Cards & Apple Pay)

    func cards() async throws -> [CardItem] {
        await simulateLatency(0.5)
        return cardsState
    }

    func card(id: String) async throws -> CardItem {
        await simulateLatency(0.5)
        guard let card = cardsState.first(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        return card
    }

    func issueVirtualCard(label: String?) async throws -> CardItem {
        try requireKYC()
        try await requireSignature(SignReason.issueCard)
        await simulateLatency(2)
        let newCard = CardItem(
            id: Self.newId("crd"),
            cardType: "virtual",
            status: .active,
            label: label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "CuyPay Virtual",
            lastFour: "4242",
            brand: "Mastercard",
            currency: .cop,
            createdAt: Date(),
            updatedAt: Date()
        )
        cardsState.append(newCard)
        return newCard
    }

    func cardLookUrl(id: String) async throws -> String {
        await simulateLatency(1)
        guard cardsState.contains(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        return "https://cards.coinsenda.com/look/demo?card=\(id)"
    }

    func updateCardStatus(id: String, state: String) async throws -> CardItem {
        try await requireSignature(SignReason.updateCardStatus)
        await simulateLatency(1)
        guard let index = cardsState.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        let status = CardItemStatus(rawValue: state) ?? .unknown
        cardsState[index].status = status
        cardsState[index].updatedAt = Date()
        return cardsState[index]
    }

    func updateCardLabel(id: String, label: String) async throws -> CardItem {
        await simulateLatency(0.8)
        guard let index = cardsState.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        cardsState[index].label = label
        cardsState[index].updatedAt = Date()
        return cardsState[index]
    }

    func tokenizeApplePay(id: String, certificates: [String], nonce: String, nonceSignature: String) async throws -> ApplePayTokenizeResponse {
        try await requireSignature(SignReason.tokenizeApplePay)
        await simulateLatency(2)
        return ApplePayTokenizeResponse(
            activationData: "mock_act_data".data(using: .utf8)!.base64EncodedString(),
            encryptedPassData: "mock_pass_data".data(using: .utf8)!.base64EncodedString(),
            ephemeralPublicKey: "mock_pub_key".data(using: .utf8)!.base64EncodedString()
        )
    }

    // MARK: - Seguridad

    func securitySettings() async throws -> SecuritySettingsResponse {
        SecuritySettingsResponse(
            idleTimeoutMinutes: 15,
            autoLockSeconds: 60,
            biometryRequired: true,
            allowedIdleOptions: [60, 300, 900]
        )
    }

    func resolveAlias(_ alias: String) async throws -> AliasResolution {
        await simulateLatency(2)
        let normalized = alias.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.contains("noexiste") || normalized.hasSuffix("0000") || normalized.count < 3 {
            throw APIError.server(status: 404, code: .brebAliasNotFound, message: nil, limit: nil)
        }
        let candidates: [(String, String, String)] = [
            ("Valentina Ríos Mejía", "Bancolombia", "VALENTINA R*** M***A"),
            ("Santiago Herrera López", "Davivienda", "SANTIAGO H***A L***Z"),
            ("Camila Ortiz Pardo", "Nequi", "CAMILA O***Z P***O"),
            ("Mateo Castaño Gil", "Banco de Bogotá", "MATEO C***O G**L"),
        ]
        let seed = normalized.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        let pick = candidates[seed % candidates.count]
        let resolution = AliasResolution(
            resolutionId: Self.newId("res"),
            alias: alias.trimmingCharacters(in: .whitespacesAndNewlines),
            holderName: pick.2,
            holderNameFull: pick.0,
            documentType: "CC",
            documentMasked: "****\(Int.random(in: 1000...9999))",
            bankName: pick.1,
            expiresAt: Date().addingTimeInterval(600)
        )
        resolutions[resolution.resolutionId] = resolution
        return resolution
    }

    func createBeneficiary(resolutionId: String, nickname: String?) async throws -> Beneficiary {
        guard let resolution = resolutions[resolutionId] else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        try await requireSignature(SignReason.createBeneficiary)
        await simulateLatency(3)
        let alias = resolution.alias.lowercased()
        let result: AMLResult
        let status: BeneficiaryStatus
        if alias.contains("rechazo") || alias.hasSuffix("6666") {
            result = .hit
            status = .rejected
        } else if alias.contains("revision") || alias.hasSuffix("9999") {
            result = .review
            status = .pendingReview
        } else {
            result = .clear
            status = .active
        }
        let beneficiary = Beneficiary(
            id: Self.newId("ben"),
            alias: resolution.alias,
            holderName: resolution.holderNameFull,
            nickname: nickname?.isEmpty == true ? nil : nickname,
            bankName: resolution.bankName,
            status: status,
            aml: AMLCheck(provider: "sartblock", result: result, referenceId: Self.newId("aml"), checkedAt: Date()),
            createdAt: Date()
        )
        if status != .rejected {
            beneficiariesState.insert(beneficiary, at: 0)
        }
        return beneficiary
    }

    func beneficiaries() async throws -> [Beneficiary] {
        await simulateLatency(0.6)
        return beneficiariesState
    }

    func deleteBeneficiary(id: String) async throws {
        try await requireSignature(SignReason.deleteBeneficiary)
        await simulateLatency(0.6)
        beneficiariesState.removeAll { $0.id == id }
    }

    // MARK: - Envíos

    private static func transferFee(_ amountMinor: Int64) -> Int64 { 0 }

    func transferPreview(beneficiaryId: String, amountMinor: Int64) async throws -> TransferPreview {
        await simulateLatency(0.8)
        guard amountMinor > 0 else {
            throw APIError.server(status: 400, code: .validationError, message: nil, limit: nil)
        }
        let fee = Self.transferFee(amountMinor)
        return TransferPreview(amountMinor: amountMinor, feeMinor: fee, totalMinor: amountMinor + fee, currency: .cop, limits: limitsState)
    }

    func createTransfer(beneficiaryId: String, amountMinor: Int64, description: String?, idempotencyKey: String) async throws -> WalletTransaction {
        if let previous = usedIdempotencyKeys[idempotencyKey] { return previous }
        try requireKYC()
        guard let beneficiary = beneficiariesState.first(where: { $0.id == beneficiaryId }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        guard beneficiary.status == .active else {
            throw APIError.server(status: 422, code: .beneficiaryNotActive, message: nil, limit: nil)
        }
        let fee = Self.transferFee(amountMinor)
        let total = amountMinor + fee
        try checkLimits(amountMinor, operation: .transferOut)
        let index = walletIndex(.cop)
        guard walletsState[index].availableMinor >= total else {
            throw APIError.server(status: 422, code: .insufficientFunds, message: nil, limit: nil)
        }
        try await requireSignature(SignReason.transfer)
        await simulateLatency(2)

        walletsState[index].availableMinor -= total
        walletsState[index].balanceMinor -= total
        addUsage(amountMinor, operation: .transferOut)

        let transaction = WalletTransaction(
            id: Self.newId("txn"),
            type: .transfer,
            direction: .out,
            currency: .cop,
            amountMinor: amountMinor,
            feeMinor: fee,
            status: .completed,
            title: beneficiary.holderName,
            subtitle: "Bre-B · \(beneficiary.alias)",
            conversion: nil,
            createdAt: Date()
        )
        transactionsState.insert(transaction, at: 0)
        usedIdempotencyKeys[idempotencyKey] = transaction
        return transaction
    }

    // MARK: - FX

    func fxRate(from: Currency, to: Currency) async throws -> FxRate {
        await simulateLatency(0.6)
        return MockFixtures.rate(now: Date())
    }

    func createQuote(from: Currency, to: Currency, amountMinor: Int64) async throws -> Quote {
        await simulateLatency(0.7)
        guard from == .cop, to == .brl, amountMinor > 0 else {
            throw APIError.server(status: 400, code: .validationError, message: nil, limit: nil)
        }
        // Comisión 1 % (mínimo $ 2.000), tasa con spread y pequeña variación para que se note el refresco.
        let fee = max(amountMinor / 100, 200_000)
        guard amountMinor > fee else {
            throw APIError.server(status: 400, code: .validationError, message: "Monto menor a la comisión", limit: nil)
        }
        let jitter = Decimal(Int.random(in: -8...8)) / Decimal(10_000_000)
        let rate = Decimal(string: "0.0013003")! + jitter
        let toAmount = Decimal.floorToInt64(Decimal(amountMinor - fee) * rate)
        let quote = Quote(
            quoteId: Self.newId("qt"),
            fromCurrency: from,
            toCurrency: to,
            fromAmountMinor: amountMinor,
            feeMinor: fee,
            toAmountMinor: toAmount,
            rate: rate,
            expiresAt: Date().addingTimeInterval(30)
        )
        quotes[quote.quoteId] = quote
        return quote
    }

    func createConversion(quoteId: String, idempotencyKey: String) async throws -> WalletTransaction {
        if let previous = usedIdempotencyKeys[idempotencyKey] { return previous }
        try requireKYC()
        guard let quote = quotes[quoteId] else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        try checkLimits(quote.fromAmountMinor, operation: .conversion)
        let copIndex = walletIndex(.cop)
        guard walletsState[copIndex].availableMinor >= quote.fromAmountMinor else {
            throw APIError.server(status: 422, code: .insufficientFunds, message: nil, limit: nil)
        }
        try await requireSignature(SignReason.conversion)
        guard quote.expiresAt > Date() else {
            throw APIError.server(status: 409, code: .quoteExpired, message: nil, limit: nil)
        }
        await simulateLatency(1.5)

        let brlIndex = walletIndex(.brl)
        walletsState[copIndex].availableMinor -= quote.fromAmountMinor
        walletsState[copIndex].balanceMinor -= quote.fromAmountMinor
        walletsState[brlIndex].availableMinor += quote.toAmountMinor
        walletsState[brlIndex].balanceMinor += quote.toAmountMinor
        addUsage(quote.fromAmountMinor, operation: .conversion)

        let transaction = WalletTransaction(
            id: Self.newId("txn"),
            type: .conversion,
            direction: .out,
            currency: .cop,
            amountMinor: quote.fromAmountMinor,
            feeMinor: quote.feeMinor,
            status: .completed,
            title: String(localized: "Conversión a BRL"),
            subtitle: "COP → BRL",
            conversion: ConversionDetail(
                fromCurrency: quote.fromCurrency,
                fromAmountMinor: quote.fromAmountMinor,
                toCurrency: quote.toCurrency,
                toAmountMinor: quote.toAmountMinor,
                rate: quote.rate
            ),
            createdAt: Date()
        )
        transactionsState.insert(transaction, at: 0)
        quotes[quoteId] = nil
        usedIdempotencyKeys[idempotencyKey] = transaction
        return transaction
    }

    // MARK: - Transacciones

    func transactions(currency: Currency?, limit: Int, cursor: String?) async throws -> TransactionPage {
        await simulateLatency(0.7)
        let filtered = transactionsState.filter { transaction in
            guard let currency else { return true }
            if transaction.currency == currency { return true }
            // Una conversión COP→BRL también es relevante en el bolsillo BRL.
            return transaction.conversion?.toCurrency == currency
        }
        let start = cursor.flatMap(Int.init) ?? 0
        let end = min(filtered.count, start + limit)
        guard start < end else { return TransactionPage(items: [], nextCursor: nil) }
        return TransactionPage(items: Array(filtered[start..<end]), nextCursor: end < filtered.count ? String(end) : nil)
    }

    // MARK: - Límites

    func limits() async throws -> LimitsSnapshot {
        await simulateLatency(0.5)
        return limitsState
    }

    // MARK: - Dispositivos

    func devices() async throws -> [Device] {
        await simulateLatency(0.5)
        return devicesState
    }

    func deleteDevice(id: String) async throws {
        try await requireSignature(SignReason.deleteDevice)
        await simulateLatency(0.6)
        devicesState.removeAll { $0.id == id && !$0.current }
    }
}

extension Decimal {
    /// `floor` a entero (Int64) sin pasar por `Double`.
    static func floorToInt64(_ value: Decimal) -> Int64 {
        var input = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &input, 0, .down)
        return NSDecimalNumber(decimal: rounded).int64Value
    }
}

extension User {
    func with(kycStatus: KYCStatus, tier: UserTier) -> User {
        var copy = self
        copy.kycStatus = kycStatus
        copy.tier = tier
        return copy
    }
}
