import Foundation
import Observation

/// Envío Bre-B (persona o comercio): destinatario / QR → monto → resumen (preview) → Face ID → comprobante.
@Observable
@MainActor
final class SendFlowModel {
    enum Step: Hashable {
        case amount
        case review
        case receipt
    }

    private let api: any CuyPayAPI

    var path: [Step] = []
    private(set) var beneficiary: Beneficiary?
    private(set) var resolvedRecipient: AliasResolution?
    var input = AmountInput(currency: .cop, allowsFraction: false)
    var note = ""
    private(set) var preview: TransferPreview?
    private(set) var transaction: WalletTransaction?
    private(set) var isLoading = false
    private(set) var isResolvingRecipient = false
    var pickerErrorMessage: String?
    var errorMessage: String?

    /// Una clave por intento de envío (se genera al crear el resumen): si la red falla y el usuario
    /// reintenta, el backend no duplica el envío.
    private var idempotencyKey = UUID().uuidString.lowercased()

    init(api: any CuyPayAPI, preselected: Beneficiary?) {
        self.api = api
        if let preselected, preselected.status == .active {
            beneficiary = preselected
            path = [.amount]
        }
    }

    // MARK: - Destinatario activo (beneficiario guardado o comercio/cliente recién escaneado)

    var hasRecipient: Bool {
        beneficiary != nil || resolvedRecipient != nil
    }

    var recipientDisplayName: String {
        if let beneficiary {
            return beneficiary.displayName
        }
        if let resolved = resolvedRecipient {
            if resolved.isMerchantAccount {
                if let mName = resolved.merchantName, !mName.isEmpty { return mName }
                if !resolved.holderNameFull.isEmpty { return resolved.holderNameFull }
            }
            return resolved.holderName.isEmpty ? resolved.holderNameFull : resolved.holderName
        }
        return ""
    }

    var recipientHolderName: String {
        if let beneficiary {
            return beneficiary.holderName
        }
        if let resolved = resolvedRecipient {
            if resolved.isMerchantAccount, !resolved.holderNameFull.isEmpty {
                return resolved.holderNameFull
            }
            return resolved.holderName.isEmpty ? resolved.holderNameFull : resolved.holderName
        }
        return ""
    }

    var recipientAlias: String {
        beneficiary?.alias ?? resolvedRecipient?.alias ?? ""
    }

    var recipientBankName: String {
        beneficiary?.bankName ?? resolvedRecipient?.bankName ?? "Bre-B"
    }

    var recipientDocumentSummary: String? {
        guard let resolved = resolvedRecipient else { return nil }
        return "\(resolved.documentType) \(resolved.documentMasked)"
    }

    var recipientIsMerchant: Bool {
        if let resolved = resolvedRecipient {
            return resolved.isMerchantAccount
        }
        if let beneficiary {
            return beneficiary.alias.count == 10 && beneficiary.alias.hasPrefix("00") && beneficiary.alias.allSatisfy(\.isASCIIDigit)
        }
        return false
    }

    var recipientInitials: String {
        if let beneficiary {
            return beneficiary.initials
        }
        let source = recipientDisplayName
        let letters = source.split(separator: " ").prefix(2).compactMap(\.first).map(String.init)
        return letters.isEmpty ? "CP" : letters.joined().uppercased()
    }

    var recipientSeed: String {
        beneficiary?.id ?? resolvedRecipient?.alias ?? "cuypay"
    }

    func select(_ beneficiary: Beneficiary, suggestedAmountMinor: Int64? = nil, suggestedReference: String? = nil) {
        guard beneficiary.status == .active else { return }
        self.beneficiary = beneficiary
        self.resolvedRecipient = nil
        applyPaymentSuggestions(amountMinor: suggestedAmountMinor, reference: suggestedReference)
        pickerErrorMessage = nil
        errorMessage = nil
        path = [.amount]
    }

    /// Resuelve un código QR Bre-B / EMVCo o una llave escrita directamente y avanza directo a la pantalla de pago (`Monto`),
    /// tanto para clientes (P2P) como para comercios (P2B), sin pasar por la ventana manual de "Nuevo beneficiario".
    func resolveAndSelect(
        rawInput: String,
        parsedQR: ParsedBrebQR? = nil,
        existingBeneficiaries: [Beneficiary]
    ) async {
        guard !isResolvingRecipient else { return }

        let parsed: ParsedBrebQR
        if let parsedQR {
            parsed = parsedQR
        } else {
            switch BrebQRParser.parse(rawInput) {
            case .valid(let decoded):
                parsed = decoded
            case .unsupportedQR(let reason):
                pickerErrorMessage = reason
                return
            }
        }

        pickerErrorMessage = nil
        errorMessage = nil

        // 1. Si alguna de las llaves candidatas ya está activa en los beneficiarios del usuario, pasar directo.
        if let matched = Self.findMatchingActiveBeneficiary(candidates: parsed.candidateKeys, in: existingBeneficiaries) {
            select(matched, suggestedAmountMinor: parsed.amountMinor, suggestedReference: parsed.reference)
            return
        }

        // 2. Consultar en tiempo real en Bre-B (enviando también el payload QR completo para respaldos Tag 26 → Tag 50 → Tag 62).
        isResolvingRecipient = true
        defer { isResolvingRecipient = false }

        do {
            let resolution = try await api.resolveAlias(
                parsed.primaryKey,
                qrPayload: parsed.isEmvCo ? parsed.rawPayload : nil
            )
            if let matched = Self.findMatchingActiveBeneficiary(candidates: [resolution.alias], in: existingBeneficiaries) {
                select(
                    matched,
                    suggestedAmountMinor: resolution.suggestedAmountMinor ?? parsed.amountMinor,
                    suggestedReference: resolution.suggestedReference ?? parsed.reference
                )
                return
            }

            self.beneficiary = nil
            self.resolvedRecipient = resolution
            applyPaymentSuggestions(
                amountMinor: resolution.suggestedAmountMinor ?? parsed.amountMinor,
                reference: resolution.suggestedReference ?? parsed.reference
            )
            path = [.amount]
        } catch {
            pickerErrorMessage = error.userMessage
        }
    }

    private func applyPaymentSuggestions(amountMinor: Int64?, reference: String?) {
        if let amountMinor, amountMinor > 0 {
            input.set(minorUnits: amountMinor)
        } else {
            input.clear()
        }
        if let reference, !reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            note = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            note = ""
        }
    }

    private static func findMatchingActiveBeneficiary(candidates: [String], in list: [Beneficiary]) -> Beneficiary? {
        for candidate in candidates {
            let normCandidate = canonicalKey(candidate)
            if let found = list.first(where: { $0.status == .active && canonicalKey($0.alias) == normCandidate }) {
                return found
            }
        }
        return nil
    }

    private static func canonicalKey(_ key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasPrefix("+573") && trimmed.count == 13 {
            return String(trimmed.dropFirst(3))
        }
        return trimmed
    }

    func requestPreview() async {
        guard hasRecipient, input.minorUnits > 0, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            preview = try await api.transferPreview(
                beneficiaryId: beneficiary?.id,
                resolutionId: beneficiary == nil ? resolvedRecipient?.resolutionId : nil,
                amountMinor: input.minorUnits
            )
            idempotencyKey = UUID().uuidString.lowercased()
            path.append(.review)
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// Cupo diario de envíos que quedaría después de este envío.
    var remainingDailyAfter: Money? {
        guard let preview, let daily = preview.limits.item(.transferOut, .daily) else { return nil }
        return Money(minorUnits: max(0, daily.remainingMinor - preview.amountMinor), currency: preview.limits.currency)
    }

    var exceedsDailyLimit: Bool {
        guard let preview, let daily = preview.limits.item(.transferOut, .daily) else { return false }
        return preview.amountMinor > daily.remainingMinor
    }

    func send(store: WalletStore) async {
        guard hasRecipient, let preview, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let usedDirectResolution = (beneficiary == nil && resolvedRecipient != nil)
            transaction = try await api.createTransfer(
                beneficiaryId: beneficiary?.id,
                resolutionId: beneficiary == nil ? resolvedRecipient?.resolutionId : nil,
                amountMinor: preview.amountMinor,
                description: trimmedNote.isEmpty ? nil : trimmedNote,
                idempotencyKey: idempotencyKey
            )
            path.append(.receipt)
            await store.refreshAfterMovement()
            if usedDirectResolution {
                await store.refreshBeneficiaries()
            }
        } catch {
            errorMessage = error.userMessage
        }
    }
}
