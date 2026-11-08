import Foundation
import Observation

/// Estado compartido de la cuenta (bolsillos, movimientos, beneficiarios, tasa, límites, llave Bre-B).
@Observable
@MainActor
final class WalletStore {
    private let api: any CuyPayAPI

    var wallets: [Wallet] = []
    var transactions: [WalletTransaction] = []
    var transactionsCursor: String?
    var beneficiaries: [Beneficiary] = []
    var fxRate: FxRate?
    var limits: LimitsSnapshot?
    var brebKey: BrebKey?
    var brebKeyLoaded = false
    var cards: [CardItem] = []
    var cardsLoaded = false

    var isLoading = false
    var hasLoadedOnce = false
    var errorMessage: String?

    init(api: any CuyPayAPI) {
        self.api = api
    }

    func wallet(for currency: Currency) -> Wallet? {
        wallets.first { $0.currency == currency }
    }

    var activeBeneficiaries: [Beneficiary] {
        beneficiaries.filter { $0.status == .active }
    }

    /// Movimientos relevantes para un bolsillo.
    /// Una conversión COP→BRL aparece una sola vez (con `currency` = COP) pero también la mostramos en BRL como ingreso.
    func transactions(for currency: Currency) -> [WalletTransaction] {
        transactions.filter { $0.currency == currency || $0.conversion?.toCurrency == currency }
    }

    func refreshAll() async {
        isLoading = true
        defer {
            isLoading = false
            hasLoadedOnce = true
        }
        let api = self.api
        async let walletsTask = api.wallets()
        async let transactionsTask = api.transactions(currency: nil, limit: 30, cursor: nil)
        async let beneficiariesTask = api.beneficiaries()
        async let rateTask = api.fxRate(from: .cop, to: .brl)
        async let limitsTask = api.limits()
        async let keyTask = api.brebKey()
        async let cardsTask = api.cards()

        do {
            wallets = try await walletsTask
            errorMessage = nil
        } catch {
            errorMessage = error.userMessage
        }
        if let page = try? await transactionsTask {
            transactions = page.items
            transactionsCursor = page.nextCursor
        }
        if let items = try? await beneficiariesTask { beneficiaries = items }
        if let rate = try? await rateTask { fxRate = rate }
        if let snapshot = try? await limitsTask { limits = snapshot }
        do {
            brebKey = try await keyTask
            brebKeyLoaded = true
        } catch {
            // Se reintenta al abrir "Recibir".
        }
        if let cardList = try? await cardsTask {
            cards = cardList
            cardsLoaded = true
        }
    }

    func refreshWallets() async {
        if let items = try? await api.wallets() { wallets = items }
    }

    func refreshTransactions() async {
        if let page = try? await api.transactions(currency: nil, limit: 30, cursor: nil) {
            transactions = page.items
            transactionsCursor = page.nextCursor
        }
    }

    func loadMoreTransactions() async {
        guard let cursor = transactionsCursor else { return }
        if let page = try? await api.transactions(currency: nil, limit: 30, cursor: cursor) {
            let known = Set(transactions.map(\.id))
            transactions.append(contentsOf: page.items.filter { !known.contains($0.id) })
            transactionsCursor = page.nextCursor
        }
    }

    func refreshBeneficiaries() async {
        if let items = try? await api.beneficiaries() { beneficiaries = items }
    }

    func refreshLimits() async {
        if let snapshot = try? await api.limits() { limits = snapshot }
    }

    func refreshBrebKey() async {
        do {
            brebKey = try await api.brebKey()
            brebKeyLoaded = true
        } catch {
            brebKeyLoaded = true
        }
    }

    func refreshCards() async {
        do {
            cards = try await api.cards()
            cardsLoaded = true
        } catch {
            cardsLoaded = true
        }
    }

    /// Después de un envío o conversión.
    func refreshAfterMovement() async {
        async let w: Void = refreshWallets()
        async let t: Void = refreshTransactions()
        async let l: Void = refreshLimits()
        _ = await (w, t, l)
    }

    func reset() {
        wallets = []
        transactions = []
        transactionsCursor = nil
        beneficiaries = []
        fxRate = nil
        limits = nil
        brebKey = nil
        brebKeyLoaded = false
        cards = []
        cardsLoaded = false
        hasLoadedOnce = false
        errorMessage = nil
    }
}
