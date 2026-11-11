import CryptoKit
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
    private var savingsBlocksState: [SavingsBlock]
    private var loansState: [LoanItem] = []
    private var promissoryNotesState: [String: PromissoryNoteDetail] = [:]
    private var hasPasswordState = true
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
        let now = Date()
        let fixtures = MockFixtures(now: now)
        self.user = startsVerified ? fixtures.user : fixtures.user.with(kycStatus: .notStarted, tier: .basic)
        self.walletsState = fixtures.wallets
        self.brebKeyState = nil
        self.cardsState = []
        self.beneficiariesState = fixtures.beneficiaries
        self.transactionsState = fixtures.transactions
        self.limitsState = fixtures.limits
        self.devicesState = fixtures.devices
        self.savingsBlocksState = [
            SavingsBlock(
                id: "sbk_demo_30d",
                termDays: 30,
                principalMinor: "50000000",
                lockedRate: 3.0,
                expectedYieldMinor: "123287",
                totalPayoutMinor: "50123287",
                currency: .cop,
                status: .active,
                escrowStatus: "unfunded",
                startedAt: now.addingTimeInterval(-10 * 24 * 3600),
                maturesAt: now.addingTimeInterval(20 * 24 * 3600),
                completedAt: nil
            ),
        ]
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
        return OTPRequestResponse(otpId: Self.newId("otp"), expiresAt: Date().addingTimeInterval(600), channel: "whatsapp")
    }

    func verifyOTP(otpId: String, phone: String, otpCode: String) async throws -> OTPVerifyResponse {
        await simulateLatency(0.4)
        guard otpCode == "123456" else {
            throw APIError.server(status: 400, code: .otpInvalid, message: "Código de verificación inválido o vencido", limit: nil)
        }
        return OTPVerifyResponse(verified: true, otpId: otpId, phone: phone)
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
            phoneVerified: true,
            emailVerified: false,
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

    func loginWithPassword(phone: String, password: String, deviceName: String?, devicePublicKey: String?) async throws -> AuthSession {
        await simulateLatency()
        let session = AuthSession(accessToken: "mock.jwt", refreshToken: "mock-refresh", expiresIn: 900, deviceId: devicePublicKey ?? "mock-dev-id", user: user)
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

    func updateProfile(_ request: UpdateProfileRequest) async throws -> User {
        await simulateLatency(0.5)
        if let firstName = request.firstName?.trimmingCharacters(in: .whitespacesAndNewlines), !firstName.isEmpty {
            user.firstName = firstName
        }
        if let lastName = request.lastName?.trimmingCharacters(in: .whitespacesAndNewlines), !lastName.isEmpty {
            user.lastName = lastName
        }
        if let email = request.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !email.isEmpty {
            if email == "usuario@cuypay.com" || email.hasSuffix("@pendiente.cuypay.com") {
                throw APIError.server(status: 422, code: .validationError, message: "Ingresa tu correo electrónico real.", limit: nil)
            }
            user.email = email
        }
        if let phone = request.phone?.trimmingCharacters(in: .whitespacesAndNewlines), !phone.isEmpty {
            user.phone = phone
            user.phoneVerified = true
        }
        return user
    }

    func requestContactOTP(_ request: ContactOTPRequest) async throws -> ContactOTPResponse {
        await simulateLatency(0.5)
        if let email = request.email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !email.isEmpty {
            if email == "usuario@cuypay.com" || email.hasSuffix("@pendiente.cuypay.com") {
                throw APIError.server(status: 422, code: .validationError, message: "Ingresa tu correo electrónico real.", limit: nil)
            }
        }
        let targetPhone = request.phone?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isPhoneChange = targetPhone != nil && targetPhone != user.phone
        let useEmail = !isPhoneChange && request.channel == "email"
        let channel: ContactOTPChannel = useEmail ? .email : .whatsapp
        let destination: String = {
            if useEmail, let email = request.email {
                return email
            }
            let p = isPhoneChange ? (targetPhone ?? user.phone) : user.phone
            return p.count >= 8 ? "\(p.prefix(6)) ••• \(p.suffix(4))" : p
        }()
        return ContactOTPResponse(
            otpId: Self.newId("otp"),
            channel: channel,
            maskedDestination: destination,
            expiresAt: Date().addingTimeInterval(600),
            emailOtpAvailable: true
        )
    }

    func confirmContactUpdate(_ request: ConfirmContactUpdateRequest) async throws -> User {
        await simulateLatency(0.5)
        guard request.otpCode == "123456" else {
            throw APIError.server(status: 400, code: .otpInvalid, message: "Código de verificación inválido o vencido", limit: nil)
        }
        let updated = try await updateProfile(
            UpdateProfileRequest(
                firstName: request.firstName,
                lastName: request.lastName,
                email: request.email,
                phone: request.phone,
                otpId: request.otpId,
                otpCode: request.otpCode
            )
        )
        user = updated
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

    private var cardPocketMinor: Int64 = 0
    private var usedCardPocketKeys: [String: CardPocketTransferResponse] = [:]

    private func hydratedCard(_ card: CardItem) -> CardItem {
        var copy = card
        let amount = card.status == .canceled ? 0 : cardPocketMinor
        copy.balanceMinor = amount
        copy.availableMinor = amount
        return copy
    }

    func cards() async throws -> [CardItem] {
        await simulateLatency(0.5)
        return cardsState.map(hydratedCard)
    }

    func card(id: String) async throws -> CardItem {
        await simulateLatency(0.5)
        guard let card = cardsState.first(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        return hydratedCard(card)
    }

    func cardPocket() async throws -> CardPocketSummary {
        await simulateLatency(0.3)
        let copAvailable = walletsState[walletIndex(.cop)].availableMinor
        return CardPocketSummary(
            currency: .cop,
            balanceMinor: cardPocketMinor,
            availableMinor: cardPocketMinor,
            mainAvailableMinor: copAvailable
        )
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
            brand: "Visa",
            currency: .cop,
            createdAt: Date(),
            updatedAt: Date(),
            holderName: user.fullName,
            balanceMinor: cardPocketMinor,
            availableMinor: cardPocketMinor
        )
        cardsState.append(newCard)
        return hydratedCard(newCard)
    }

    func cardLookUrl(id: String) async throws -> String {
        await simulateLatency(1)
        guard cardsState.contains(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        return "https://cards.coinsenda.com/look/demo?card=\(id)"
    }

    func updateCardStatus(id: String, state: String, preservePocket: Bool?) async throws -> CardItem {
        try await requireSignature(SignReason.updateCardStatus)
        await simulateLatency(1)
        guard let index = cardsState.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        let status = CardItemStatus(rawValue: state) ?? .unknown
        cardsState[index].status = status
        cardsState[index].updatedAt = Date()

        if status == .canceled, preservePocket != true {
            let remainingActive = cardsState.filter { $0.status != .canceled }
            if remainingActive.isEmpty, cardPocketMinor > 0 {
                let refund = cardPocketMinor
                cardPocketMinor = 0
                let copIdx = walletIndex(.cop)
                walletsState[copIdx].availableMinor += refund
                walletsState[copIdx].balanceMinor += refund
                let txn = WalletTransaction(
                    id: Self.newId("txn"),
                    type: .cardPocket,
                    direction: .in,
                    currency: .cop,
                    amountMinor: refund,
                    feeMinor: 0,
                    status: .completed,
                    title: "Devolución de Tarjeta CuyPay",
                    subtitle: "Saldo devuelto a tu cuenta principal Bre-B",
                    conversion: nil,
                    createdAt: Date()
                )
                transactionsState.insert(txn, at: 0)
            }
        }

        return hydratedCard(cardsState[index])
    }

    func updateCardLabel(id: String, label: String) async throws -> CardItem {
        await simulateLatency(0.8)
        guard let index = cardsState.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        cardsState[index].label = label
        cardsState[index].updatedAt = Date()
        return hydratedCard(cardsState[index])
    }

    func fundCard(id: String, amountMinor: Int64, idempotencyKey: String) async throws -> CardPocketTransferResponse {
        if let prev = usedCardPocketKeys["fund:\(idempotencyKey)"] { return prev }
        try requireKYC()
        guard let index = cardsState.firstIndex(where: { $0.id == id }), cardsState[index].status != .canceled else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        guard amountMinor >= 10_000 else {
            throw APIError.server(status: 400, code: .validationError, message: "El monto mínimo para recargar tu tarjeta es de $ 100 COP", limit: nil)
        }
        let copIdx = walletIndex(.cop)
        guard walletsState[copIdx].availableMinor >= amountMinor else {
            throw APIError.server(status: 422, code: .insufficientFunds, message: "Saldo insuficiente en tu cuenta principal Bre-B", limit: nil)
        }
        try await requireSignature(SignReason.fundCard)
        await simulateLatency(1.0)

        walletsState[copIdx].availableMinor -= amountMinor
        walletsState[copIdx].balanceMinor -= amountMinor
        cardPocketMinor += amountMinor

        let card = hydratedCard(cardsState[index])
        let txn = WalletTransaction(
            id: Self.newId("txn"),
            type: .cardPocket,
            direction: .out,
            currency: .cop,
            amountMinor: amountMinor,
            feeMinor: 0,
            status: .completed,
            title: "Recarga a Tarjeta CuyPay",
            subtitle: "Bolsillo \(card.label) \(card.maskedPan)",
            conversion: nil,
            createdAt: Date()
        )
        transactionsState.insert(txn, at: 0)
        let response = CardPocketTransferResponse(
            card: card,
            pocketBalanceMinor: cardPocketMinor,
            mainAvailableMinor: walletsState[copIdx].availableMinor,
            transaction: txn
        )
        usedCardPocketKeys["fund:\(idempotencyKey)"] = response
        return response
    }

    func withdrawCard(id: String, amountMinor: Int64, idempotencyKey: String) async throws -> CardPocketTransferResponse {
        if let prev = usedCardPocketKeys["withdraw:\(idempotencyKey)"] { return prev }
        try requireKYC()
        guard let index = cardsState.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: nil, limit: nil)
        }
        guard amountMinor >= 10_000 else {
            throw APIError.server(status: 400, code: .validationError, message: "El monto mínimo para retirar de tu tarjeta es de $ 100 COP", limit: nil)
        }
        guard cardPocketMinor >= amountMinor else {
            throw APIError.server(status: 422, code: .insufficientFunds, message: "Saldo insuficiente en el bolsillo de tu tarjeta", limit: nil)
        }
        try await requireSignature(SignReason.withdrawCard)
        await simulateLatency(1.0)

        let copIdx = walletIndex(.cop)
        cardPocketMinor -= amountMinor
        walletsState[copIdx].availableMinor += amountMinor
        walletsState[copIdx].balanceMinor += amountMinor

        let card = hydratedCard(cardsState[index])
        let txn = WalletTransaction(
            id: Self.newId("txn"),
            type: .cardPocket,
            direction: .in,
            currency: .cop,
            amountMinor: amountMinor,
            feeMinor: 0,
            status: .completed,
            title: "Retiro desde Tarjeta CuyPay",
            subtitle: "Hacia tu saldo principal Bre-B \(card.maskedPan)",
            conversion: nil,
            createdAt: Date()
        )
        transactionsState.insert(txn, at: 0)
        let response = CardPocketTransferResponse(
            card: card,
            pocketBalanceMinor: cardPocketMinor,
            mainAvailableMinor: walletsState[copIdx].availableMinor,
            transaction: txn
        )
        usedCardPocketKeys["withdraw:\(idempotencyKey)"] = response
        return response
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
            hasPassword: hasPasswordState,
            allowedIdleOptions: [0, 60, 300, 900]
        )
    }

    func changePassword(currentPassword: String?, newPassword: String) async throws {
        await simulateLatency(0.5)
        guard newPassword.count >= 4 else {
            throw APIError.server(status: 422, code: .validationError, message: "La nueva contraseña debe tener al menos 4 caracteres.", limit: nil)
        }
        hasPasswordState = true
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

    // MARK: - Bolsillo de Ahorro

    private static let mockSavingsContract = """
TÉRMINOS Y CONDICIONES DEL BOLSILLO DE AHORRO A TÉRMINO FIJO CUYPAY

1. OBJETO: El titular autoriza el bloqueo voluntario de fondos en pesos colombianos (COP) desde su billetera principal CuyPay por el plazo seleccionado (30, 60, 90, 180 o 360 días), bajo administración de XATECH SERVICES S.A.S. (NIT 901.799.579).
2. TASA INMUTABLE GARANTIZADA: La tasa efectiva anual (E.A.) pactada al momento de constituir el bolsillo permanece fija durante todo el plazo.
3. REINTEGRO AUTOMÁTICO A LA HORA EXACTA: Cumplido el plazo y la hora exacta de vencimiento, el capital más los intereses generados se reintegran de forma automática al saldo disponible de la billetera del titular, con respaldo en reserva bloqueada 72 horas antes del vencimiento.
4. DISPONIBILIDAD: Durante la vigencia del bloqueo, el saldo no podrá ser retirado anticipadamente salvo liquidación extraordinaria autorizada por soporte.
"""

    func savingsConfig() async throws -> SavingsConfig {
        await simulateLatency(0.3)
        return SavingsConfig(
            rates: [
                SavingsRateTier(termDays: 30, ratePercent: 3.0, enabled: true),
                SavingsRateTier(termDays: 60, ratePercent: 4.5, enabled: true),
                SavingsRateTier(termDays: 90, ratePercent: 6.0, enabled: true),
                SavingsRateTier(termDays: 180, ratePercent: 8.5, enabled: true),
                SavingsRateTier(termDays: 360, ratePercent: 12.0, enabled: true),
            ],
            minAmountMinor: "1000000",
            maxAmountMinor: "5000000000",
            contractTerms: Self.mockSavingsContract,
            updatedAt: Date()
        )
    }

    func userSavings() async throws -> UserSavingsResponse {
        await simulateLatency(0.4)
        var activePrincipal: Int64 = 0
        var activeYield: Int64 = 0
        var earnedYield: Int64 = 0
        var activeCount = 0
        for block in savingsBlocksState {
            let p = Int64(block.principalMinor) ?? 0
            let y = Int64(block.expectedYieldMinor) ?? 0
            if block.status == .active || block.status == .maturingSoon {
                activePrincipal += p
                activeYield += y
                activeCount += 1
            } else if block.status == .completed {
                earnedYield += y
            }
        }
        return UserSavingsResponse(
            blocks: savingsBlocksState,
            summary: SavingsSummary(
                totalPrincipalMinor: String(activePrincipal),
                totalExpectedYieldMinor: String(activeYield),
                totalYieldEarnedMinor: String(earnedYield),
                activeCount: activeCount
            )
        )
    }

    func savingsCertificate(id: String) async throws -> SavingsCertificate {
        await simulateLatency(0.3)
        guard let block = savingsBlocksState.first(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: "Bolsillo de ahorro no encontrado", limit: nil)
        }
        return SavingsCertificate(
            id: block.id,
            holderName: user.fullName,
            holderEmail: user.email,
            holderPhone: user.phone,
            termDays: block.termDays,
            principalMinor: block.principalMinor,
            lockedRate: block.lockedRate,
            expectedYieldMinor: block.expectedYieldMinor,
            totalPayoutMinor: block.totalPayoutMinor,
            currency: block.currency,
            status: block.status,
            escrowStatus: block.escrowStatus,
            startedAt: block.startedAt,
            maturesAt: block.maturesAt,
            completedAt: block.completedAt,
            contractAcceptedAt: block.startedAt,
            contractTerms: Self.mockSavingsContract
        )
    }

    func createSavingsBlock(termDays: Int, amountMinor: Int64) async throws -> SavingsBlock {
        try requireKYC()
        let copIdx = walletIndex(.cop)
        guard walletsState[copIdx].availableMinor >= amountMinor else {
            throw APIError.server(status: 422, code: .insufficientFunds, message: "Saldo insuficiente en tu billetera COP", limit: nil)
        }
        try await requireSignature(SignReason.createSavingsBlock)
        await simulateLatency(0.8)
        let now = Date()
        let rate: Double = switch termDays {
        case 30: 3.0
        case 60: 4.5
        case 90: 6.0
        case 180: 8.5
        case 360: 12.0
        default: 3.0
        }
        let expectedYieldNum = max(1, Int64((Double(amountMinor) * (rate / 100.0) * (Double(termDays) / 365.0)).rounded()))
        walletsState[copIdx].availableMinor -= amountMinor
        walletsState[copIdx].balanceMinor -= amountMinor

        let block = SavingsBlock(
            id: "sbk_\(UUID().uuidString.prefix(8).lowercased())",
            termDays: termDays,
            principalMinor: String(amountMinor),
            lockedRate: rate,
            expectedYieldMinor: String(expectedYieldNum),
            totalPayoutMinor: String(amountMinor + expectedYieldNum),
            currency: .cop,
            status: .active,
            escrowStatus: "unfunded",
            startedAt: now,
            maturesAt: now.addingTimeInterval(Double(termDays) * 24 * 3600),
            completedAt: nil
        )
        savingsBlocksState.insert(block, at: 0)

        let txn = WalletTransaction(
            id: Self.newId("txn"),
            type: .savings,
            direction: .out,
            currency: .cop,
            amountMinor: amountMinor,
            feeMinor: 0,
            status: .completed,
            title: "Bloqueo en Bolsillo de Ahorro (\(termDays) días)",
            subtitle: "Tasa garantizada \(String(format: "%.2f", rate))% E.A.",
            conversion: nil,
            createdAt: now
        )
        transactionsState.insert(txn, at: 0)
        return block
    }

    // MARK: - Créditos y Pagarés Electrónicos

    func loansConfig() async throws -> LoanConfig {
        await simulateLatency(0.3)
        return LoanConfig(
            enabled: true,
            rates: [
                LoanRateTier(termDays: 30, rateEaPercent: 21.5, enabled: true),
                LoanRateTier(termDays: 60, rateEaPercent: 22.0, enabled: true),
                LoanRateTier(termDays: 90, rateEaPercent: 22.5, enabled: true),
                LoanRateTier(termDays: 180, rateEaPercent: 23.0, enabled: true),
                LoanRateTier(termDays: 360, rateEaPercent: 23.5, enabled: true),
            ],
            usuryCeilingEaPercent: 24.99,
            moratoryRateEaPercent: 24.5,
            minAmountMinor: "10000000",
            maxAmountMinor: "1000000000",
            creditorLegalName: "XATECH SERVICES S.A.S.",
            creditorNit: "901.799.579",
            creditorDomicile: "Bogotá D.C., República de Colombia",
            updatedAt: Date()
        )
    }

    func previewLoan(_ request: LoanPreviewRequest) async throws -> LoanPreviewResponse {
        try requireKYC()
        await simulateLatency(0.4)
        let config = try await loansConfig()
        let principalVal = Int64(request.principalMinor) ?? 0
        guard let tier = config.rates.first(where: { $0.termDays == request.termDays && $0.enabled }) else {
            throw APIError.server(status: 422, code: .validationError, message: "Plazo no disponible", limit: nil)
        }
        let factor = pow(1.0 + tier.rateEaPercent / 100.0, Double(request.termDays) / 365.0) - 1.0
        let interestVal = max(1, Int64((Double(principalVal) * factor).rounded()))
        let totalDueVal = principalVal + interestVal
        let monthly = ((pow(1.0 + tier.rateEaPercent / 100.0, 1.0 / 12.0) - 1.0) * 10000.0).rounded() / 100.0
        let docNumber = request.documentNumber?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? request.documentNumber!
            : "1020789456"
        let docType = request.documentType ?? "CC"
        let city = request.city ?? "Bogotá D.C."
        let principalText = Money(minorUnits: principalVal, currency: .cop).formatted()
        let interestText = Money(minorUnits: interestVal, currency: .cop).formatted()
        let totalText = Money(minorUnits: totalDueVal, currency: .cop).formatted()

        let markdown = """
# PAGARÉ ELECTRÓNICO A LA ORDEN Y CARTA DE INSTRUCCIONES
## TÍTULO VALOR CON MÉRITO EJECUTIVO — ARTS. 621, 622 Y 709 C.CO. · LEY 527 DE 1999

- **ACREEDOR BENEFICIARIO:** \(config.creditorLegalName) — NIT \(config.creditorNit)
- **DEUDOR OTORGANTE:** \(user.fullName) (\(docType) \(docNumber))
- **CAPITAL MUTUADO:** \(principalText)
- **PLAZO PACTADO:** \(request.termDays) días calendario
- **INTERÉS REMUNERATORIO:** \(String(format: "%.2f", tier.rateEaPercent))% E.A. (\(String(format: "%.2f", monthly))% N.M.V.) = \(interestText)
- **TOTAL A PAGAR AL VENCIMIENTO:** \(totalText)

---

## I. PROMESA INCONDICIONAL DE PAGO (ART. 709 CÓDIGO DE COMERCIO)
Yo, **\(user.fullName)**, mayor de edad, identificado(a) con **\(docType) Nº \(docNumber)**, pagaré incondicionalmente, a la orden de **\(config.creditorLegalName)** (NIT \(config.creditorNit)), en Bogotá D.C. o a través de la plataforma CuyPay, la suma de **\(principalText)** por concepto de capital más **\(interestText)** de intereses remuneratorios.

## II. CARTA DE INSTRUCCIONES (ART. 622 CÓDIGO DE COMERCIO)
Autorizo de manera expresa e irrevocable a **\(config.creditorLegalName)** para llenar los espacios relativos a la fecha de vencimiento y cuantía exigible en caso de incumplimiento, sin previo aviso, conforme a los libros contables de doble partida de la plataforma.

## III. AUTORIZACIÓN DE HABEAS DATA FINANCIERO (LEY 1266 DE 2008 Y LEY 2157 DE 2021)
Autorizo la consulta y reporte de mi comportamiento crediticio ante operadores de información financiera (DataCrédito Experian y TransUnion CIFIN), con comunicación previa mínima de veinte (20) días calendario antes de cualquier reporte negativo.
"""
        let digest = SHA256.hash(data: Data(markdown.utf8)).map { String(format: "%02x", $0) }.joined()
        return LoanPreviewResponse(
            principalMinor: String(principalVal),
            interestMinor: String(interestVal),
            totalDueMinor: String(totalDueVal),
            termDays: request.termDays,
            interestRateEa: tier.rateEaPercent,
            nominalMonthlyPercent: monthly,
            moratoryRateEa: config.moratoryRateEaPercent,
            usuryCeilingEaPercent: config.usuryCeilingEaPercent,
            currency: .cop,
            estimatedDueAt: Date().addingTimeInterval(Double(request.termDays) * 24 * 3600),
            debtor: LoanDebtorInfo(
                fullName: user.fullName,
                documentType: docType,
                documentNumber: docNumber,
                email: user.email,
                phone: user.phone,
                city: city
            ),
            creditor: LoanCreditorInfo(
                legalName: config.creditorLegalName,
                nit: config.creditorNit,
                domicile: config.creditorDomicile
            ),
            documentMarkdown: markdown,
            documentSha256: digest
        )
    }

    func applyLoan(_ request: LoanApplyRequest) async throws -> LoanItem {
        try requireKYC()
        try await requireSignature(SignReason.applyLoan)
        let preview = try await previewLoan(
            LoanPreviewRequest(
                principalMinor: request.principalMinor,
                termDays: request.termDays,
                purpose: request.purpose,
                documentType: request.documentType,
                documentNumber: request.documentNumber,
                city: request.city
            )
        )
        let now = Date()
        let loanId = Self.newId("loan")
        let noteId = Self.newId("pag")
        let noteNumber = "PAG-2026-000\(101 + loansState.count)"

        let item = LoanItem(
            id: loanId,
            userId: user.id,
            promissoryNoteId: noteId,
            promissoryNoteNumber: noteNumber,
            principalMinor: preview.principalMinor,
            termDays: preview.termDays,
            interestRateEa: preview.interestRateEa,
            nominalMonthlyPercent: preview.nominalMonthlyPercent,
            moratoryRateEa: preview.moratoryRateEa,
            interestMinor: preview.interestMinor,
            totalDueMinor: preview.totalDueMinor,
            paidMinor: "0",
            principalPaidMinor: "0",
            interestPaidMinor: "0",
            remainingMinor: preview.totalDueMinor,
            currency: .cop,
            status: .pendingReview,
            purpose: request.purpose,
            debtorFullName: preview.debtor.fullName,
            debtorDocumentType: preview.debtor.documentType,
            debtorDocumentNumber: preview.debtor.documentNumber,
            debtorEmail: preview.debtor.email,
            debtorPhone: preview.debtor.phone,
            debtorCity: preview.debtor.city,
            requestedAt: now,
            approvedAt: nil,
            approvedBy: nil,
            disbursedAt: nil,
            dueAt: nil,
            paidAt: nil,
            rejectedAt: nil,
            rejectedReason: nil,
            daysRemaining: nil
        )
        loansState.insert(item, at: 0)

        let sig = ElectronicSignatureEvidence(
            method: "ECDSA_P256_SHA256_SECURE_ENCLAVE",
            deviceId: "dev_mock",
            deviceName: "iPhone Demo",
            devicePublicKey: "BElockMockKey==",
            ecdsaSignatureBase64: "MEYCIQDMockSignatureBase64==",
            canonicalSha256: preview.documentSha256,
            nonce: UUID().uuidString.lowercased(),
            timestampSec: Int64(now.timeIntervalSince1970),
            signedAt: now,
            signerIp: "127.0.0.1",
            signerUserAgent: "CuyPay-iOS/2.0",
            acceptedPagare: true,
            acceptedInstructionLetter: true,
            acceptedCreditBureauAuth: true
        )
        promissoryNotesState[loanId] = PromissoryNoteDetail(
            id: noteId,
            number: noteNumber,
            loanId: loanId,
            userId: user.id,
            status: .signedCustody,
            integrityVerified: true,
            principalMinor: preview.principalMinor,
            interestMinor: preview.interestMinor,
            totalDueMinor: preview.totalDueMinor,
            paidMinor: "0",
            remainingMinor: preview.totalDueMinor,
            termDays: preview.termDays,
            interestRateEa: preview.interestRateEa,
            nominalMonthlyPercent: preview.nominalMonthlyPercent,
            moratoryRateEa: preview.moratoryRateEa,
            currency: .cop,
            creditorLegalName: preview.creditor.legalName,
            creditorNit: preview.creditor.nit,
            creditorDomicile: preview.creditor.domicile,
            debtorFullName: preview.debtor.fullName,
            debtorDocumentType: preview.debtor.documentType,
            debtorDocumentNumber: preview.debtor.documentNumber,
            debtorEmail: preview.debtor.email,
            debtorPhone: preview.debtor.phone,
            debtorCity: preview.debtor.city,
            sumsubApplicantId: "sbx_verified_demo",
            documentMarkdown: preview.documentMarkdown,
            documentSha256: preview.documentSha256,
            signature: sig,
            disbursedAt: nil,
            dueAt: nil,
            cancelledAt: nil,
            createdAt: now,
            printableHtml: "<html><body><h1>Pagaré \(noteNumber)</h1></body></html>"
        )
        return item
    }

    func userLoans() async throws -> UserLoansResponse {
        await simulateLatency(0.4)
        var activeRemaining: Int64 = 0
        var activeCount = 0
        var pendingCount = 0
        for l in loansState {
            if l.status == .approvedActive || l.status == .overdue {
                activeRemaining += Int64(l.remainingMinor) ?? 0
                activeCount += 1
            } else if l.status == .pendingReview {
                pendingCount += 1
            }
        }
        return UserLoansResponse(
            loans: loansState,
            summary: UserLoansSummary(
                activeRemainingMinor: String(activeRemaining),
                activeCount: activeCount,
                pendingCount: pendingCount
            )
        )
    }

    func loanPromissoryNote(id: String) async throws -> PromissoryNoteDetail {
        await simulateLatency(0.3)
        guard let note = promissoryNotesState[id] else {
            throw APIError.server(status: 404, code: .notFound, message: "Pagaré no encontrado", limit: nil)
        }
        return note
    }

    func payLoan(id: String, amountMinor: Int64) async throws -> PayLoanResponse {
        try await requireSignature(SignReason.payLoan)
        await simulateLatency(0.7)
        guard let idx = loansState.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404, code: .notFound, message: "Crédito no encontrado", limit: nil)
        }
        let rem = Int64(loansState[idx].remainingMinor) ?? 0
        let payVal = min(rem, amountMinor)
        let copIdx = walletIndex(.cop)
        guard walletsState[copIdx].availableMinor >= payVal else {
            throw APIError.server(status: 422, code: .insufficientFunds, message: "Saldo insuficiente en tu billetera COP", limit: nil)
        }
        walletsState[copIdx].availableMinor -= payVal
        walletsState[copIdx].balanceMinor -= payVal

        let prevPaid = Int64(loansState[idx].paidMinor) ?? 0
        let newPaid = prevPaid + payVal
        let newRem = rem - payVal
        loansState[idx].paidMinor = String(newPaid)
        loansState[idx].remainingMinor = String(newRem)
        let isPaid = newRem == 0
        if isPaid {
            loansState[idx].status = .paid
            loansState[idx].paidAt = Date()
            if var note = promissoryNotesState[id] {
                note.status = .cancelledPaid
                note.paidMinor = String(newPaid)
                note.remainingMinor = "0"
                note.cancelledAt = Date()
                promissoryNotesState[id] = note
            }
        }
        let txn = WalletTransaction(
            id: Self.newId("txn"),
            type: .loan,
            direction: .out,
            currency: .cop,
            amountMinor: payVal,
            feeMinor: 0,
            status: .completed,
            title: isPaid ? "Pago Total de Crédito CuyPay" : "Abono a Crédito CuyPay",
            subtitle: "Pagaré \(loansState[idx].promissoryNoteNumber)",
            conversion: nil,
            createdAt: Date()
        )
        transactionsState.insert(txn, at: 0)
        return PayLoanResponse(
            loan: loansState[idx],
            paidAmountMinor: String(payVal),
            pazYSalvoIssued: isPaid
        )
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
