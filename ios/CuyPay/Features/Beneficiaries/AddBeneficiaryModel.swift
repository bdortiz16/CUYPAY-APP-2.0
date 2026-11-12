import Foundation
import Observation

/// Tipo de llave Bre-B detectado mientras el usuario escribe (solo para ayudar en la UI;
/// la validación real la hace el directorio Bre-B en el backend).
enum BrebKeyKind: Equatable, Sendable {
    case phone
    case nationalId
    case merchantCode
    case email
    case alias
    case alphanumeric
    case invalid

    static func detect(_ raw: String) -> BrebKeyKind {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return .invalid }

        // Si el texto es un payload QR EMVCo o URL con llave, clasificar la llave extraída
        if trimmed.hasPrefix("0002") || trimmed.contains("://") {
            if case .valid(let parsed) = BrebQRParser.parse(trimmed) {
                return detect(parsed.primaryKey)
            }
            return .invalid
        }

        let compactPhone = trimmed
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "(", with: "")
            .replacingOccurrences(of: ")", with: "")
            .replacingOccurrences(of: "-", with: "")
        if compactPhone.hasPrefix("+573") && compactPhone.count == 13 && compactPhone.dropFirst().allSatisfy(\.isASCIIDigit) {
            return .phone
        }
        if compactPhone.hasPrefix("573") && compactPhone.count == 12 && compactPhone.allSatisfy(\.isASCIIDigit) {
            return .phone
        }

        let compactDigits = trimmed
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
        if compactDigits.allSatisfy(\.isASCIIDigit) {
            if compactDigits.count == 10 && compactDigits.hasPrefix("3") { return .phone }
            if compactDigits.count == 10 && compactDigits.hasPrefix("00") { return .merchantCode }
            if (5...15).contains(compactDigits.count) { return .nationalId }
            return .invalid
        }

        if trimmed.hasPrefix("@") {
            let body = trimmed.dropFirst()
            let valid = !body.isEmpty && body.count <= 63 && body.allSatisfy {
                $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-"
            }
            return valid ? .alias : .invalid
        }

        if trimmed.contains("@") {
            let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
            if parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasSuffix(".") {
                return .email
            }
            return .invalid
        }

        if trimmed.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-" }) && trimmed.count <= 40 {
            return .alphanumeric
        }
        return .invalid
    }

    var title: String {
        switch self {
        case .phone: String(localized: "Celular")
        case .nationalId: String(localized: "Documento / NIT")
        case .merchantCode: String(localized: "Código de comercio")
        case .email: String(localized: "Correo")
        case .alias: String(localized: "Alias @")
        case .alphanumeric: String(localized: "Llave alfanumérica")
        case .invalid: String(localized: "Llave no válida")
        }
    }

    var systemImage: String {
        switch self {
        case .phone: "iphone"
        case .nationalId: "person.text.rectangle"
        case .merchantCode: "storefront"
        case .email: "envelope"
        case .alias: "at"
        case .alphanumeric: "textformat.abc"
        case .invalid: "exclamationmark.circle"
        }
    }
}

/// Inscripción: llave → resolución Bre-B (titular o comercio) → confirmación + apodo → Face ID → AML → resultado.
@Observable
@MainActor
final class AddBeneficiaryModel {
    enum Outcome: Equatable {
        case active(Beneficiary)
        case pendingReview(Beneficiary?)
        case rejected
    }

    enum Phase: Equatable {
        case enterKey
        case resolving
        case confirm(AliasResolution)
        case verifying(AliasResolution)
        case done(Outcome)
    }

    private let api: any CuyPayAPI

    var phase: Phase = .enterKey
    var alias = ""
    var nickname = ""
    var pendingQRPayload: String?
    var errorMessage: String?

    init(api: any CuyPayAPI) {
        self.api = api
    }

    var keyKind: BrebKeyKind { BrebKeyKind.detect(alias) }

    func applyScannedQR(_ parsed: ParsedBrebQR) {
        alias = parsed.primaryKey
        pendingQRPayload = parsed.isEmvCo ? parsed.rawPayload : nil
        errorMessage = nil
    }

    func resolve(qrPayload: String? = nil) async {
        let rawTrimmed = alias.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawTrimmed.isEmpty else { return }

        var effectiveKey = rawTrimmed
        var effectiveQRPayload = qrPayload ?? pendingQRPayload

        if case .valid(let parsed) = BrebQRParser.parse(rawTrimmed) {
            effectiveKey = parsed.primaryKey
            if parsed.isEmvCo {
                alias = parsed.primaryKey
                effectiveQRPayload = parsed.rawPayload
                pendingQRPayload = parsed.rawPayload
            }
        }

        guard BrebKeyKind.detect(effectiveKey) != .invalid else { return }
        errorMessage = nil
        phase = .resolving
        do {
            let resolution = try await api.resolveAlias(effectiveKey, qrPayload: effectiveQRPayload)
            alias = resolution.alias
            phase = .confirm(resolution)
        } catch {
            errorMessage = error.userMessage
            phase = .enterKey
        }
    }

    func confirm(_ resolution: AliasResolution, store: WalletStore) async {
        errorMessage = nil
        phase = .verifying(resolution)
        let trimmed = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let beneficiary = try await api.createBeneficiary(resolutionId: resolution.resolutionId, nickname: trimmed.isEmpty ? nil : trimmed)
            switch beneficiary.status {
            case .active: phase = .done(.active(beneficiary))
            case .pendingReview: phase = .done(.pendingReview(beneficiary))
            case .rejected, .unknown: phase = .done(.rejected)
            }
            await store.refreshBeneficiaries()
        } catch let error as APIError {
            switch error.code {
            case .amlRejected:
                phase = .done(.rejected)
            case .amlReview:
                phase = .done(.pendingReview(nil))
                await store.refreshBeneficiaries()
            default:
                errorMessage = error.userMessage
                phase = .confirm(resolution)
            }
        } catch {
            errorMessage = error.userMessage
            phase = .confirm(resolution)
        }
    }

    func restart() {
        alias = ""
        nickname = ""
        pendingQRPayload = nil
        errorMessage = nil
        phase = .enterKey
    }
}
