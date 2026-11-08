import Foundation
import Observation

/// Envío Bre-B: beneficiario → monto → resumen (preview) → Face ID → comprobante.
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
    var input = AmountInput(currency: .cop, allowsFraction: false)
    var note = ""
    private(set) var preview: TransferPreview?
    private(set) var transaction: WalletTransaction?
    private(set) var isLoading = false
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

    func select(_ beneficiary: Beneficiary) {
        guard beneficiary.status == .active else { return }
        self.beneficiary = beneficiary
        errorMessage = nil
        path.append(.amount)
    }

    func requestPreview() async {
        guard let beneficiary, input.minorUnits > 0, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            preview = try await api.transferPreview(beneficiaryId: beneficiary.id, amountMinor: input.minorUnits)
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
        guard let beneficiary, let preview, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            transaction = try await api.createTransfer(
                beneficiaryId: beneficiary.id,
                amountMinor: preview.amountMinor,
                description: trimmedNote.isEmpty ? nil : trimmedNote,
                idempotencyKey: idempotencyKey
            )
            path.append(.receipt)
            await store.refreshAfterMovement()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
