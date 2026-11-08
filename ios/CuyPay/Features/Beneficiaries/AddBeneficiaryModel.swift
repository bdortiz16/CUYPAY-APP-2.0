import Foundation
import Observation

/// Tipo de llave Bre-B detectado mientras el usuario escribe (solo para ayudar en la UI;
/// la validación real la hace el directorio Bre-B en el backend).
enum BrebKeyKind: Equatable, Sendable {
    case phone
    case nationalId
    case email
    case alias
    case alphanumeric
    case invalid

    static func detect(_ raw: String) -> BrebKeyKind {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count >= 3 else { return .invalid }
        let digitsOnly = value.allSatisfy(\.isASCIIDigit)
        if digitsOnly {
            if value.count == 10 && value.hasPrefix("3") { return .phone }
            if (5...10).contains(value.count) { return .nationalId }
            return .invalid
        }
        if value.hasPrefix("@") {
            let body = value.dropFirst()
            let valid = !body.isEmpty && body.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" }
            return valid ? .alias : .invalid
        }
        if value.contains("@") {
            let parts = value.split(separator: "@")
            if parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasSuffix(".") { return .email }
            return .invalid
        }
        if value.allSatisfy({ $0.isLetter || $0.isNumber }) && value.count <= 20 { return .alphanumeric }
        return .invalid
    }

    var title: String {
        switch self {
        case .phone: String(localized: "Celular")
        case .nationalId: String(localized: "Cédula")
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
        case .email: "envelope"
        case .alias: "at"
        case .alphanumeric: "textformat.abc"
        case .invalid: "exclamationmark.circle"
        }
    }
}

/// Inscripción: llave → resolución Bre-B (titular) → confirmación + apodo → Face ID → AML → resultado.
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
    var errorMessage: String?

    init(api: any CuyPayAPI) {
        self.api = api
    }

    var keyKind: BrebKeyKind { BrebKeyKind.detect(alias) }

    func resolve() async {
        guard keyKind != .invalid else { return }
        errorMessage = nil
        phase = .resolving
        do {
            let resolution = try await api.resolveAlias(alias.trimmingCharacters(in: .whitespacesAndNewlines))
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
        errorMessage = nil
        phase = .enterKey
    }
}
