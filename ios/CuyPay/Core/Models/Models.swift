import Foundation

// Modelos del contrato `docs/API_CONTRACT.md` (v1). Todos los montos en unidades menores (`Int64`).
// Los enums de estado decodifican valores desconocidos como `.unknown` para no romper la app
// si el backend agrega estados nuevos.

// MARK: - Auth

struct User: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var firstName: String
    var lastName: String
    var email: String
    var phone: String
    var phoneVerified: Bool? = nil
    var emailVerified: Bool? = nil
    var country: String
    var kycStatus: KYCStatus
    var tier: UserTier
    var createdAt: Date

    var fullName: String { "\(firstName) \(lastName)" }
    var initials: String {
        let first = firstName.first.map(String.init) ?? ""
        let last = lastName.first.map(String.init) ?? ""
        return (first + last).uppercased()
    }

    var hasPlaceholderEmail: Bool {
        let clean = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return clean.isEmpty || clean == "usuario@cuypay.com" || clean.hasSuffix("@pendiente.cuypay.com")
    }

    var hasPlaceholderName: Bool {
        firstName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "usuario" &&
            lastName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "cuypay"
    }

    var hasPlaceholderContact: Bool {
        hasPlaceholderEmail || hasPlaceholderName
    }
}

enum KYCStatus: String, Codable, Hashable, Sendable {
    case notStarted = "not_started"
    case pending
    case approved
    case rejected
    case retry
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = KYCStatus(rawValue: raw) ?? .unknown
    }
}

enum UserTier: String, Codable, Hashable, Sendable {
    case basic
    case full
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = UserTier(rawValue: raw) ?? .unknown
    }
}

struct AuthSession: Codable, Hashable, Sendable {
    var accessToken: String
    var refreshToken: String
    var expiresIn: Int
    var deviceId: String
    var user: User
}

struct OTPRequestResponse: Codable, Hashable, Sendable {
    var otpId: String
    var expiresAt: Date
    var channel: String? = nil
}

struct OTPVerifyRequest: Codable, Hashable, Sendable {
    var otpId: String
    var phone: String
    var otpCode: String
}

struct OTPVerifyResponse: Codable, Hashable, Sendable {
    var verified: Bool
    var otpId: String
    var phone: String
}

struct RegisterRequest: Codable, Hashable, Sendable {
    var otpId: String
    var otpCode: String
    var phone: String
    var email: String
    var firstName: String
    var lastName: String
    var country: String = "CO"
    var deviceName: String
    var devicePublicKey: String
    var password: String? = nil
}

struct UpdateProfileRequest: Codable, Hashable, Sendable {
    var firstName: String? = nil
    var lastName: String? = nil
    var email: String? = nil
    var phone: String? = nil
    var otpId: String? = nil
    var otpCode: String? = nil
}

enum ContactOTPChannel: String, Codable, Hashable, Sendable {
    case whatsapp
    case sms
    case email
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ContactOTPChannel(rawValue: raw) ?? .unknown
    }
}

struct ContactOTPRequest: Codable, Hashable, Sendable {
    var phone: String? = nil
    var email: String? = nil
    var channel: String? = nil
}

struct ContactOTPResponse: Codable, Hashable, Sendable {
    var otpId: String
    var channel: ContactOTPChannel
    var maskedDestination: String
    var expiresAt: Date
    var emailOtpAvailable: Bool? = nil
}

struct ConfirmContactUpdateRequest: Codable, Hashable, Sendable {
    var otpId: String
    var otpCode: String
    var firstName: String? = nil
    var lastName: String? = nil
    var email: String? = nil
    var phone: String? = nil
}

struct LoginPasswordRequest: Codable, Hashable, Sendable {
    var phone: String
    var password: String
    var deviceName: String?
    var devicePublicKey: String?
}

struct AuthChallenge: Codable, Hashable, Sendable {
    var challengeId: String
    var nonce: String
    var expiresAt: Date
}

// MARK: - KYC

struct SumsubTokenResponse: Codable, Hashable, Sendable {
    var token: String
    var levelName: String
    var expiresAt: Date
}

struct KYCStatusResponse: Codable, Hashable, Sendable {
    var status: KYCStatus
    var tier: UserTier
    var reviewAnswer: String?
    var rejectLabels: [String]?
}

// MARK: - Wallets

struct Wallet: Codable, Hashable, Sendable, Identifiable {
    var currency: Currency
    var balanceMinor: Int64
    var availableMinor: Int64
    var heldMinor: Int64

    var id: Currency { currency }
    var balance: Money { Money(minorUnits: balanceMinor, currency: currency) }
    var available: Money { Money(minorUnits: availableMinor, currency: currency) }
    var held: Money { Money(minorUnits: heldMinor, currency: currency) }
}

struct ItemsResponse<Item: Codable & Sendable>: Codable, Sendable {
    var items: [Item]
}

// MARK: - Bre-B

struct BrebKey: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var type: String? = "alias"
    var alias: String
    var status: BrebKeyStatus
    var holderName: String
    var createdAt: Date
}

enum BrebKeyStatus: String, Codable, Hashable, Sendable {
    case active
    case blocked
    case pending
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BrebKeyStatus(rawValue: raw) ?? .unknown
    }
}

struct CreateBrebKeyRequest: Codable, Hashable, Sendable {
    var preferredAlias: String?
}

// MARK: - Tarjetas (Cards & Apple Pay)

struct CardItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var cardType: String
    var status: CardItemStatus
    var label: String
    var lastFour: String
    var brand: String
    var currency: Currency
    var createdAt: Date
    var updatedAt: Date
    var holderName: String? = nil
    var balanceMinor: Int64? = nil
    var availableMinor: Int64? = nil

    var maskedPan: String {
        "•••• " + lastFour
    }

    var pocketBalance: Money {
        Money(minorUnits: availableMinor ?? balanceMinor ?? 0, currency: currency)
    }
}

enum CardItemStatus: String, Codable, Hashable, Sendable {
    case active
    case frozen
    case canceled
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CardItemStatus(rawValue: raw) ?? .unknown
    }
}

struct IssueCardRequest: Codable, Hashable, Sendable {
    var label: String?
}

struct UpdateCardStatusRequest: Codable, Hashable, Sendable {
    var state: String
    var preservePocket: Bool? = nil
}

struct UpdateCardLabelRequest: Codable, Hashable, Sendable {
    var label: String
}

struct CardPocketSummary: Codable, Hashable, Sendable {
    var currency: Currency
    var balanceMinor: Int64
    var availableMinor: Int64
    var mainAvailableMinor: Int64

    var available: Money { Money(minorUnits: availableMinor, currency: currency) }
    var mainAvailable: Money { Money(minorUnits: mainAvailableMinor, currency: currency) }
}

struct CardPocketTransferRequest: Codable, Hashable, Sendable {
    var amountMinor: Int64
    var idempotencyKey: String
}

struct CardPocketTransferResponse: Codable, Hashable, Sendable {
    var card: CardItem
    var pocketBalanceMinor: Int64
    var mainAvailableMinor: Int64
    var transaction: WalletTransaction
}

struct CardLookUrlResponse: Codable, Hashable, Sendable {
    var url: String
}

struct ApplePayTokenizeRequest: Codable, Hashable, Sendable {
    var certificates: [String]
    var nonce: String
    var nonceSignature: String
}

struct ApplePayTokenizeResponse: Codable, Hashable, Sendable {
    var activationData: String
    var encryptedPassData: String
    var ephemeralPublicKey: String
}

struct SecuritySettingsResponse: Codable, Hashable, Sendable {
    var idleTimeoutMinutes: Int
    var autoLockSeconds: Int
    var biometryRequired: Bool
    var allowedIdleOptions: [Int]
}

// MARK: - Beneficiarios

struct AliasResolution: Codable, Hashable, Sendable {
    var resolutionId: String
    var alias: String
    var holderName: String
    var holderNameFull: String
    var documentType: String
    var documentMasked: String
    var bankName: String
    var expiresAt: Date
}

struct Beneficiary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var alias: String
    var holderName: String
    var nickname: String?
    var bankName: String
    var status: BeneficiaryStatus
    var aml: AMLCheck?
    var createdAt: Date

    /// Nombre para mostrar (apodo si existe).
    var displayName: String {
        if let nickname, !nickname.trimmingCharacters(in: .whitespaces).isEmpty { return nickname }
        return holderName
    }

    var initials: String {
        let parts = holderName.split(separator: " ")
        let letters = parts.prefix(2).compactMap(\.first).map(String.init)
        return letters.joined().uppercased()
    }
}

enum BeneficiaryStatus: String, Codable, Hashable, Sendable {
    case active
    case pendingReview = "pending_review"
    case rejected
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BeneficiaryStatus(rawValue: raw) ?? .unknown
    }
}

struct AMLCheck: Codable, Hashable, Sendable {
    var provider: String
    var result: AMLResult
    var referenceId: String?
    var checkedAt: Date?
}

enum AMLResult: String, Codable, Hashable, Sendable {
    case clear
    case hit
    case review
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AMLResult(rawValue: raw) ?? .unknown
    }
}

struct ResolveAliasRequest: Codable, Hashable, Sendable {
    var alias: String
}

struct CreateBeneficiaryRequest: Codable, Hashable, Sendable {
    var resolutionId: String
    var nickname: String?
}

// MARK: - Envíos

struct TransferPreviewRequest: Codable, Hashable, Sendable {
    var beneficiaryId: String
    var amountMinor: Int64
}

struct TransferPreview: Codable, Hashable, Sendable {
    var amountMinor: Int64
    var feeMinor: Int64
    var totalMinor: Int64
    var currency: Currency
    var limits: LimitsSnapshot

    var amount: Money { Money(minorUnits: amountMinor, currency: currency) }
    var fee: Money { Money(minorUnits: feeMinor, currency: currency) }
    var total: Money { Money(minorUnits: totalMinor, currency: currency) }
}

struct CreateTransferRequest: Codable, Hashable, Sendable {
    var beneficiaryId: String
    var amountMinor: Int64
    var description: String?
    var idempotencyKey: String
}

// MARK: - FX

struct FxRate: Codable, Hashable, Sendable {
    var from: Currency
    var to: Currency
    /// No es dinero: es una razón. Usamos `Decimal` para no perder precisión al mostrarla.
    var rate: Decimal
    var inverseRate: Decimal
    var updatedAt: Date
    var history: [FxRatePoint]
}

struct FxRatePoint: Codable, Hashable, Sendable, Identifiable {
    var date: Date
    var rate: Decimal

    var id: Date { date }
}

struct QuoteRequest: Codable, Hashable, Sendable {
    var fromCurrency: Currency
    var toCurrency: Currency
    var amountMinor: Int64
}

struct Quote: Codable, Hashable, Sendable, Identifiable {
    var quoteId: String
    var fromCurrency: Currency
    var toCurrency: Currency
    var fromAmountMinor: Int64
    var feeMinor: Int64
    var toAmountMinor: Int64
    var rate: Decimal
    var expiresAt: Date

    var id: String { quoteId }
    var fromAmount: Money { Money(minorUnits: fromAmountMinor, currency: fromCurrency) }
    var fee: Money { Money(minorUnits: feeMinor, currency: fromCurrency) }
    var amountToConvert: Money { Money(minorUnits: fromAmountMinor - feeMinor, currency: fromCurrency) }
    var toAmount: Money { Money(minorUnits: toAmountMinor, currency: toCurrency) }
}

struct CreateConversionRequest: Codable, Hashable, Sendable {
    var quoteId: String
    var idempotencyKey: String
}

// MARK: - Transacciones

struct WalletTransaction: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var type: TransactionType
    var direction: TransactionDirection
    var currency: Currency
    var amountMinor: Int64
    var feeMinor: Int64
    var status: TransactionStatus
    var title: String
    var subtitle: String?
    var conversion: ConversionDetail?
    var createdAt: Date

    var amount: Money { Money(minorUnits: amountMinor, currency: currency) }
    var fee: Money { Money(minorUnits: feeMinor, currency: currency) }
    /// Monto con signo según la dirección (para listas).
    var signedAmount: Money {
        Money(minorUnits: direction == .out ? -amountMinor : amountMinor, currency: currency)
    }
}

enum TransactionType: String, Codable, Hashable, Sendable {
    case deposit
    case transfer
    case conversion
    case cardPocket = "card_pocket"
    case cardPurchase = "card_purchase"
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TransactionType(rawValue: raw) ?? .unknown
    }
}

enum TransactionDirection: String, Codable, Hashable, Sendable {
    case `in`
    case out
}

enum TransactionStatus: String, Codable, Hashable, Sendable {
    case pending
    case completed
    case failed
    case reversed
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TransactionStatus(rawValue: raw) ?? .unknown
    }
}

struct ConversionDetail: Codable, Hashable, Sendable {
    var fromCurrency: Currency
    var fromAmountMinor: Int64
    var toCurrency: Currency
    var toAmountMinor: Int64
    var rate: Decimal

    var fromAmount: Money { Money(minorUnits: fromAmountMinor, currency: fromCurrency) }
    var toAmount: Money { Money(minorUnits: toAmountMinor, currency: toCurrency) }
}

struct TransactionPage: Codable, Hashable, Sendable {
    var items: [WalletTransaction]
    var nextCursor: String?
}

// MARK: - Dispositivos

struct Device: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var createdAt: Date
    var lastUsedAt: Date?
    var current: Bool
}

// MARK: - Requests auxiliares

struct PhoneRequest: Codable, Hashable, Sendable { var phone: String }
struct DeviceIdRequest: Codable, Hashable, Sendable { var deviceId: String }
struct LoginRequest: Codable, Hashable, Sendable {
    var challengeId: String
    var deviceId: String
    var signature: String
}
struct RefreshRequest: Codable, Hashable, Sendable { var refreshToken: String }
struct RegisterPushTokenRequest: Codable, Hashable, Sendable {
    var token: String
    var environment: String
}
struct RegisterPushTokenResponse: Codable, Hashable, Sendable {
    var registered: Bool
}
struct EmptyResponse: Codable, Hashable, Sendable {}

// MARK: - Bloque de Ahorro (Savings Vault)

struct SavingsRateTier: Codable, Hashable, Sendable, Identifiable {
    var id: Int { termDays }
    var termDays: Int
    var ratePercent: Double
    var enabled: Bool
}

struct SavingsConfig: Codable, Hashable, Sendable {
    var rates: [SavingsRateTier]
    var minAmountMinor: String
    var maxAmountMinor: String
    var contractTerms: String
    var updatedAt: Date

    var minAmount: Money {
        Money(minorUnits: Int64(minAmountMinor) ?? 10_000_00, currency: .cop)
    }
    var maxAmount: Money {
        Money(minorUnits: Int64(maxAmountMinor) ?? 100_000_000_00, currency: .cop)
    }
}

enum SavingsBlockStatus: String, Codable, Hashable, Sendable {
    case active
    case maturingSoon = "maturing_soon"
    case completed
    case cancelled
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SavingsBlockStatus(rawValue: raw) ?? .unknown
    }

    var title: String {
        switch self {
        case .active: return "Activo"
        case .maturingSoon: return "Por vencer (<72h)"
        case .completed: return "Finalizado"
        case .cancelled: return "Cancelado"
        case .unknown: return "Desconocido"
        }
    }
}

struct SavingsBlock: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var termDays: Int
    var principalMinor: String
    var lockedRate: Double
    var expectedYieldMinor: String
    var totalPayoutMinor: String
    var currency: Currency
    var status: SavingsBlockStatus
    var startedAt: Date
    var maturesAt: Date
    var completedAt: Date?

    var principal: Money {
        Money(minorUnits: Int64(principalMinor) ?? 0, currency: currency)
    }
    var expectedYield: Money {
        Money(minorUnits: Int64(expectedYieldMinor) ?? 0, currency: currency)
    }
    var totalPayout: Money {
        Money(minorUnits: Int64(totalPayoutMinor) ?? 0, currency: currency)
    }

    var daysRemaining: Int {
        let diff = Calendar.current.dateComponents([.day], from: Date(), to: maturesAt)
        return max(0, diff.day ?? 0)
    }

    var progress: Double {
        let total = maturesAt.timeIntervalSince(startedAt)
        guard total > 0 else { return 1.0 }
        let elapsed = Date().timeIntervalSince(startedAt)
        return min(1.0, max(0.0, elapsed / total))
    }
}

struct SavingsSummary: Codable, Hashable, Sendable {
    var totalPrincipalMinor: String
    var totalYieldEarnedMinor: String
    var activeCount: Int

    var totalPrincipal: Money {
        Money(minorUnits: Int64(totalPrincipalMinor) ?? 0, currency: .cop)
    }
    var totalYieldEarned: Money {
        Money(minorUnits: Int64(totalYieldEarnedMinor) ?? 0, currency: .cop)
    }
}

struct UserSavingsResponse: Codable, Hashable, Sendable {
    var blocks: [SavingsBlock]
    var summary: SavingsSummary
}

struct CreateSavingsBlockRequest: Codable, Hashable, Sendable {
    var termDays: Int
    var amountMinor: String
}
