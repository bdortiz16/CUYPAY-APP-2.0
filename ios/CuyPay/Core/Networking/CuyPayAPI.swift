import Foundation

/// Contrato de la API de CuyPay. Lo implementan `APIClient` (backend real) y `MockAPIClient` (demo).
/// Las operaciones marcadas 🔐 firman la petición con la clave del dispositivo (Face ID por operación).
protocol CuyPayAPI: Sendable {
    // MARK: Sesión local
    /// `deviceId` guardado (si el dispositivo ya fue registrado).
    func storedDeviceId() async -> String?
    /// Borra tokens locales (mantiene el dispositivo para volver a entrar con Face ID).
    func clearLocalSession() async
    /// Olvida el dispositivo (re-enrolamiento).
    func forgetDevice() async

    // MARK: Auth y onboarding
    func requestOTP(phone: String) async throws -> OTPRequestResponse
    func verifyOTP(otpId: String, phone: String, otpCode: String) async throws -> OTPVerifyResponse
    func register(_ request: RegisterRequest) async throws -> AuthSession
    func challenge(deviceId: String) async throws -> AuthChallenge
    func login(challengeId: String, deviceId: String, signature: String) async throws -> AuthSession
    func loginWithPassword(phone: String, password: String, deviceName: String?, devicePublicKey: String?) async throws -> AuthSession
    func logout() async throws
    func me() async throws -> User
    func updateProfile(_ request: UpdateProfileRequest) async throws -> User
    func requestContactOTP(_ request: ContactOTPRequest) async throws -> ContactOTPResponse
    func confirmContactUpdate(_ request: ConfirmContactUpdateRequest) async throws -> User
    func registerPushToken(_ token: String, environment: String) async throws

    // MARK: KYC
    func sumsubToken() async throws -> SumsubTokenResponse
    func kycStatus() async throws -> KYCStatusResponse

    // MARK: Bolsillos
    func wallets() async throws -> [Wallet]
    func wallets(syncDeposits: Bool) async throws -> [Wallet]

    // MARK: Llave Bre-B propia
    /// `nil` si el usuario aún no tiene llave (404 NOT_FOUND).
    func brebKey() async throws -> BrebKey?
    /// 🔐
    func createBrebKey(preferredAlias: String?) async throws -> BrebKey
    /// 🔐
    func changeBrebKey(preferredAlias: String) async throws -> BrebKey
    /// 🔐
    func deleteBrebKey() async throws

    // MARK: Tarjetas (Coinsenda Farming & Marketplace)
    func cards() async throws -> [CardItem]
    func card(id: String) async throws -> CardItem
    func cardPocket() async throws -> CardPocketSummary
    /// 🔐
    func issueVirtualCard(label: String?) async throws -> CardItem
    func cardLookUrl(id: String) async throws -> String
    /// 🔐
    func updateCardStatus(id: String, state: String, preservePocket: Bool?) async throws -> CardItem
    func updateCardLabel(id: String, label: String) async throws -> CardItem
    /// 🔐
    func fundCard(id: String, amountMinor: Int64, idempotencyKey: String) async throws -> CardPocketTransferResponse
    /// 🔐
    func withdrawCard(id: String, amountMinor: Int64, idempotencyKey: String) async throws -> CardPocketTransferResponse
    /// 🔐
    func tokenizeApplePay(id: String, certificates: [String], nonce: String, nonceSignature: String) async throws -> ApplePayTokenizeResponse

    // MARK: Seguridad y sesión
    func securitySettings() async throws -> SecuritySettingsResponse

    // MARK: Beneficiarios
    func resolveAlias(_ alias: String) async throws -> AliasResolution
    /// 🔐
    func createBeneficiary(resolutionId: String, nickname: String?) async throws -> Beneficiary
    func beneficiaries() async throws -> [Beneficiary]
    /// 🔐
    func deleteBeneficiary(id: String) async throws

    // MARK: Envíos
    func transferPreview(beneficiaryId: String, amountMinor: Int64) async throws -> TransferPreview
    /// 🔐
    func createTransfer(beneficiaryId: String, amountMinor: Int64, description: String?, idempotencyKey: String) async throws -> WalletTransaction

    // MARK: FX
    func fxRate(from: Currency, to: Currency) async throws -> FxRate
    func createQuote(from: Currency, to: Currency, amountMinor: Int64) async throws -> Quote
    /// 🔐
    func createConversion(quoteId: String, idempotencyKey: String) async throws -> WalletTransaction

    // MARK: Transacciones
    func transactions(currency: Currency?, limit: Int, cursor: String?) async throws -> TransactionPage

    // MARK: Límites
    func limits() async throws -> LimitsSnapshot

    // MARK: Dispositivos
    func devices() async throws -> [Device]
    /// 🔐
    func deleteDevice(id: String) async throws

    // MARK: Bloque de Ahorro (Savings Vault)
    func savingsConfig() async throws -> SavingsConfig
    func userSavings() async throws -> UserSavingsResponse
    /// 🔐
    func createSavingsBlock(termDays: Int, amountMinor: Int64) async throws -> SavingsBlock
}

extension CuyPayAPI {
    func updateCardStatus(id: String, state: String) async throws -> CardItem {
        try await updateCardStatus(id: id, state: state, preservePocket: nil)
    }

    func wallets(syncDeposits: Bool) async throws -> [Wallet] {
        _ = syncDeposits
        return try await wallets()
    }

    func registerPushToken(_ token: String, environment: String) async throws {
        _ = token
        _ = environment
    }
}

/// Textos del diálogo de Face ID para cada operación firmada.
enum SignReason {
    static var login: String { String(localized: "Ingresa a CuyPay") }
    static var createBrebKey: String { String(localized: "Confirma la creación de tu llave Bre-B") }
    static var changeBrebKey: String { String(localized: "Confirma el cambio de tu llave Bre-B") }
    static var deleteBrebKey: String { String(localized: "Confirma la eliminación de tu llave Bre-B") }
    static var issueCard: String { String(localized: "Autoriza la emisión de tu tarjeta virtual") }
    static var updateCardStatus: String { String(localized: "Confirma el cambio de estado de tu tarjeta") }
    static var fundCard: String { String(localized: "Autoriza recargar el bolsillo de tu tarjeta") }
    static var withdrawCard: String { String(localized: "Autoriza mover saldo de tu tarjeta a tu cuenta principal") }
    static var tokenizeApplePay: String { String(localized: "Autoriza vincular tu tarjeta a Apple Pay") }
    static var createBeneficiary: String { String(localized: "Confirma la inscripción del beneficiario") }
    static var deleteBeneficiary: String { String(localized: "Confirma la eliminación del beneficiario") }
    static var transfer: String { String(localized: "Autoriza el envío") }
    static var conversion: String { String(localized: "Autoriza la conversión") }
    static var deleteDevice: String { String(localized: "Confirma la eliminación del dispositivo") }
    static var createSavingsBlock: String { String(localized: "Autoriza la constitución de tu Bloque de Ahorro") }
}

