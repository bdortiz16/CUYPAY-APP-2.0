import Foundation
import Observation

/// Conversión COP → BRL con cotización de 30 s que se renueva automáticamente.
@Observable
@MainActor
final class ConvertViewModel {
    private let api: any CuyPayAPI

    var input = AmountInput(currency: .cop, allowsFraction: false)
    private(set) var quote: Quote?
    private(set) var isQuoting = false
    private(set) var secondsRemaining = 0
    private(set) var isConverting = false
    private(set) var result: WalletTransaction?
    var errorMessage: String?

    /// Clave de idempotencia por cotización: reintentos de la misma cotización no duplican la conversión.
    private var idempotencyKey = UUID().uuidString.lowercased()
    private var debounceTask: Task<Void, Never>?
    private var countdownTask: Task<Void, Never>?

    nonisolated static let quoteValidity = 30

    init(api: any CuyPayAPI) {
        self.api = api
    }

    var hasAmount: Bool { input.minorUnits > 0 }

    func canConvert(available: Money?, limits: LimitsSnapshot?) -> Bool {
        guard let quote, !isConverting, !isQuoting, secondsRemaining > 0 else { return false }
        if let available, quote.fromAmountMinor > available.minorUnits { return false }
        if let limits, !limits.allows(quote.fromAmountMinor, for: .conversion) { return false }
        return true
    }

    // MARK: Cotización

    /// Llamar cuando cambia el monto: espera 450 ms y pide cotización nueva.
    func amountChanged() {
        debounceTask?.cancel()
        countdownTask?.cancel()
        quote = nil
        secondsRemaining = 0
        errorMessage = nil
        guard hasAmount else { return }
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            await self?.fetchQuote()
        }
    }

    func fetchQuote() async {
        guard hasAmount else { return }
        isQuoting = true
        defer { isQuoting = false }
        let amount = input.minorUnits
        do {
            let newQuote = try await api.createQuote(from: .cop, to: .brl, amountMinor: amount)
            // Si el usuario cambió el monto mientras tanto, descartamos.
            guard amount == input.minorUnits else { return }
            quote = newQuote
            idempotencyKey = UUID().uuidString.lowercased()
            errorMessage = nil
            startCountdown(serverExpiry: newQuote.expiresAt)
        } catch {
            if !(error is CancellationError) {
                errorMessage = error.userMessage
            }
        }
    }

    private func startCountdown(serverExpiry: Date) {
        countdownTask?.cancel()
        // Usamos la vigencia del servidor pero acotada a 30 s (tolerante a relojes desfasados).
        let serverSeconds = Int(serverExpiry.timeIntervalSinceNow.rounded(.down))
        let validity = (1...Self.quoteValidity).contains(serverSeconds) ? serverSeconds : Self.quoteValidity
        let localExpiry = Date().addingTimeInterval(TimeInterval(validity))
        secondsRemaining = validity

        countdownTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                let remaining = max(0, Int(localExpiry.timeIntervalSinceNow.rounded(.up)))
                self.secondsRemaining = remaining
                if remaining == 0 {
                    // Tarea no estructurada: no hereda la cancelación de este contador.
                    Task { await self.fetchQuote() }
                    return
                }
            }
        }
    }

    func stop() {
        debounceTask?.cancel()
        countdownTask?.cancel()
    }

    // MARK: Conversión (🔐 Face ID)

    func convert(store: WalletStore) async {
        guard let quote, !isConverting else { return }
        isConverting = true
        errorMessage = nil
        defer { isConverting = false }
        do {
            let transaction = try await api.createConversion(quoteId: quote.quoteId, idempotencyKey: idempotencyKey)
            stop()
            result = transaction
            await store.refreshAfterMovement()
        } catch let error as APIError where error.code == .quoteExpired {
            errorMessage = error.userMessage
            await fetchQuote()
        } catch {
            errorMessage = error.userMessage
        }
    }
}
