import Foundation

/// Códigos de error del contrato (sección "Códigos de error").
enum APIErrorCode: String, Codable, Hashable, Sendable {
    case validationError = "VALIDATION_ERROR"
    case unauthorized = "UNAUTHORIZED"
    case invalidSignature = "INVALID_SIGNATURE"
    case signatureRequired = "SIGNATURE_REQUIRED"
    case replayedNonce = "REPLAYED_NONCE"
    case otpInvalid = "OTP_INVALID"
    case kycRequired = "KYC_REQUIRED"
    case kycPending = "KYC_PENDING"
    case brebKeyExists = "BREB_KEY_EXISTS"
    case brebAliasNotFound = "BREB_ALIAS_NOT_FOUND"
    case brebAliasTaken = "BREB_ALIAS_TAKEN"
    case amlRejected = "AML_REJECTED"
    case amlReview = "AML_REVIEW"
    case beneficiaryNotActive = "BENEFICIARY_NOT_ACTIVE"
    case limitExceeded = "LIMIT_EXCEEDED"
    case insufficientFunds = "INSUFFICIENT_FUNDS"
    case quoteExpired = "QUOTE_EXPIRED"
    case idempotencyConflict = "IDEMPOTENCY_CONFLICT"
    case providerError = "PROVIDER_ERROR"
    case notFound = "NOT_FOUND"
    case rateLimited = "RATE_LIMITED"
    case internalError = "INTERNAL_ERROR"
    case unknown

    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = APIErrorCode(rawValue: raw) ?? .unknown
    }
}

/// Cuerpo de error: `{ "error": { "code", "message", "details" } }`.
struct APIErrorEnvelope: Decodable, Sendable {
    struct Body: Decodable, Sendable {
        var code: APIErrorCode
        var message: String?
        var details: LimitExceededDetails?

        enum CodingKeys: String, CodingKey { case code, message, details }

        init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decode(APIErrorCode.self, forKey: .code)
            message = try container.decodeIfPresent(String.self, forKey: .message)
            // `details` es libre; solo intentamos el formato de LIMIT_EXCEEDED y si no, lo ignoramos.
            details = try? container.decodeIfPresent(LimitExceededDetails.self, forKey: .details)
        }
    }
    var error: Body
}

/// `details` de `422 LIMIT_EXCEEDED`.
struct LimitExceededDetails: Codable, Hashable, Sendable {
    var operation: LimitOperation
    var period: LimitPeriod
    var limitMinor: Int64
    var usedMinor: Int64
    var remainingMinor: Int64
}

/// Error unificado de la capa de red, con mensajes amigables en español.
enum APIError: Error, Hashable, Sendable, LocalizedError {
    /// Error de negocio devuelto por el backend.
    case server(status: Int, code: APIErrorCode, message: String?, limit: LimitExceededDetails?)
    /// Sin conexión / timeout. Guarda el `rawValue` de `URLError.Code` (Int es Sendable/Hashable).
    case network(urlErrorCode: Int)
    /// Respuesta inesperada (JSON inválido, etc.).
    case decoding(String)
    /// No hay sesión (refresh falló o no existe).
    case notAuthenticated
    /// El usuario canceló Face ID.
    case biometricCancelled
    /// Face ID no disponible o la clave del dispositivo es inválida (biometría cambió).
    case deviceKeyUnavailable
    case unknown(String)

    var code: APIErrorCode? {
        if case .server(_, let code, _, _) = self { return code }
        return nil
    }

    var errorDescription: String? { userMessage }

    /// Mensaje claro y neutral para el usuario final.
    var userMessage: String {
        switch self {
        case .server(_, let code, _, let limit):
            return Self.message(for: code, limit: limit)
        case .network(let rawCode):
            switch URLError.Code(rawValue: rawCode) {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return String(localized: "No tienes conexión a internet. Revisa tu red e inténtalo de nuevo.")
            case .timedOut:
                return String(localized: "La conexión tardó demasiado. Inténtalo de nuevo.")
            default:
                return String(localized: "No pudimos conectarnos con CuyPay. Inténtalo de nuevo.")
            }
        case .decoding:
            return String(localized: "Recibimos una respuesta inesperada. Inténtalo de nuevo en unos minutos.")
        case .notAuthenticated:
            return String(localized: "Tu sesión expiró. Ingresa de nuevo con Face ID.")
        case .biometricCancelled:
            return String(localized: "Cancelaste la autenticación. La operación no se realizó.")
        case .deviceKeyUnavailable:
            return String(localized: "No pudimos usar la llave segura de este dispositivo. Si cambiaste tu Face ID, debes registrar el dispositivo de nuevo.")
        case .unknown:
            return String(localized: "Ocurrió un error inesperado. Inténtalo de nuevo.")
        }
    }

    static func message(for code: APIErrorCode, limit: LimitExceededDetails?) -> String {
        switch code {
        case .validationError:
            return String(localized: "Revisa los datos ingresados e inténtalo de nuevo.")
        case .unauthorized:
            return String(localized: "Tu sesión expiró. Ingresa de nuevo con Face ID.")
        case .invalidSignature, .signatureRequired:
            return String(localized: "No pudimos verificar la firma de este dispositivo. Inténtalo de nuevo.")
        case .replayedNonce:
            return String(localized: "Esta solicitud ya fue procesada. Inténtalo de nuevo.")
        case .otpInvalid:
            return String(localized: "El código no es válido o expiró. Solicita uno nuevo.")
        case .kycRequired:
            return String(localized: "Necesitas verificar tu identidad para hacer esta operación.")
        case .kycPending:
            return String(localized: "Tu verificación de identidad está en revisión. Te avisaremos cuando termine.")
        case .brebKeyExists:
            return String(localized: "Ya tienes una llave Bre-B registrada.")
        case .brebAliasNotFound:
            return String(localized: "No encontramos esa llave Bre-B. Verifica que esté bien escrita.")
        case .brebAliasTaken:
            return String(localized: "Esa llave ya está en uso. Prueba con otra.")
        case .amlRejected:
            return String(localized: "No es posible inscribir este beneficiario en este momento.")
        case .amlReview:
            return String(localized: "Este beneficiario quedó en revisión. Te avisaremos cuando esté listo.")
        case .beneficiaryNotActive:
            return String(localized: "Este beneficiario aún no está activo para recibir envíos.")
        case .limitExceeded:
            if let limit {
                let remaining = Money(minorUnits: limit.remainingMinor, currency: .cop).formatted()
                return String(localized: "Superas tu límite \(limit.period.title.lowercased()) de \(limit.operation.title.lowercased()). Te quedan \(remaining).")
            }
            return String(localized: "Esta operación supera tus límites disponibles.")
        case .insufficientFunds:
            return String(localized: "No tienes saldo suficiente para esta operación.")
        case .quoteExpired:
            return String(localized: "La cotización expiró. Generamos una nueva para ti.")
        case .idempotencyConflict:
            return String(localized: "Esta operación ya está en proceso. Revisa tus movimientos.")
        case .providerError:
            return String(localized: "Nuestro aliado no está respondiendo. Inténtalo de nuevo en unos minutos.")
        case .notFound:
            return String(localized: "No encontramos lo que buscabas.")
        case .rateLimited:
            return String(localized: "Hiciste demasiados intentos. Espera un momento e inténtalo de nuevo.")
        case .internalError, .unknown:
            return String(localized: "Ocurrió un error inesperado. Inténtalo de nuevo.")
        }
    }
}

extension Error {
    /// Mensaje amigable para cualquier error.
    var userMessage: String {
        if let apiError = self as? APIError { return apiError.userMessage }
        if let urlError = self as? URLError { return APIError.network(urlErrorCode: urlError.code.rawValue).userMessage }
        return APIError.unknown(String(describing: self)).userMessage
    }
}
