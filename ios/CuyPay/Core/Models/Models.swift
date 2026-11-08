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
struct EmptyResponse: Codable, Hashable, Sendable {}
