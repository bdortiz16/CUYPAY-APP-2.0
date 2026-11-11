import Foundation
import Observation
import SwiftUI
import UIKit

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
    var unreadNotificationsCount = 0
    var onSessionExpired: (@MainActor () -> Void)?

    private var activeUserId: String?
    private var isLiveRefreshing = false

    init(api: any CuyPayAPI) {
        self.api = api
    }

    func configureSession(userId: String) {
        activeUserId = userId
        recalculateUnreadNotifications(from: transactions)
    }

    func wallet(for currency: Currency) -> Wallet? {
        wallets.first { $0.currency == currency }
    }

    var activeBeneficiaries: [Beneficiary] {
        beneficiaries.filter { $0.status == .active }
    }

    /// Tarjeta activa o congelada del usuario (ignora tarjetas canceladas para permitir crear una nueva).
    var activeCard: CardItem? {
        cards.first { $0.status != .canceled }
    }

    /// Saldo disponible en el bolsillo dedicado de la tarjeta virtual COP.
    var cardPocketBalance: Money {
        activeCard?.pocketBalance ?? .zero(.cop)
    }

    /// Saldo disponible en el bolsillo principal COP (Bre-B).
    var copMainAvailable: Money {
        wallet(for: .cop)?.available ?? .zero(.cop)
    }

    /// Movimientos asociados a la tarjeta virtual (recargas/retiros de bolsillo y compras).
    var cardTransactions: [WalletTransaction] {
        transactions.filter { $0.type == .cardPocket || $0.type == .cardPurchase }
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
        async let walletsTask = api.wallets(syncDeposits: true)
        async let transactionsTask = api.transactions(currency: nil, limit: 30, cursor: nil)
        async let beneficiariesTask = api.beneficiaries()
        async let rateTask = api.fxRate(from: .cop, to: .brl)
        async let limitsTask = api.limits()
        async let keyTask = api.brebKey()
        async let cardsTask = api.cards()

        do {
            wallets = try await walletsTask
            errorMessage = nil
        } catch let apiErr as APIError {
            if case .server(let status, _, _, _) = apiErr, status == 401 || status == 403 {
                onSessionExpired?()
            } else if case .notAuthenticated = apiErr {
                onSessionExpired?()
            }
            errorMessage = apiErr.userMessage
        } catch {
            errorMessage = error.userMessage
        }
        if let page = try? await transactionsTask {
            transactions = page.items
            transactionsCursor = page.nextCursor
            processIncomingDeposits(page.items, allowHaptic: true)
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

    /// Sincronización silenciosa en vivo (sin parpadeo ni esqueletos de carga):
    /// actualiza saldo disponible, movimientos entrantes y bolsillo de tarjeta automáticamente.
    func refreshLiveState(allowHaptic: Bool = true) async {
        guard !isLoading, !isLiveRefreshing else { return }
        isLiveRefreshing = true
        defer { isLiveRefreshing = false }

        let api = self.api
        async let walletsTask = api.wallets(syncDeposits: true)
        async let transactionsTask = api.transactions(currency: nil, limit: 30, cursor: nil)
        async let cardsTask = api.cards()

        do {
            let freshWallets = try await walletsTask
            if freshWallets != wallets {
                withAnimation(.snappy) {
                    wallets = freshWallets
                }
            }
            errorMessage = nil
        } catch let apiErr as APIError {
            if case .server(let status, _, _, _) = apiErr, status == 401 || status == 403 {
                onSessionExpired?()
            } else if case .notAuthenticated = apiErr {
                onSessionExpired?()
            }
            return
        } catch {
            return
        }

        if let page = try? await transactionsTask {
            processIncomingDeposits(page.items, allowHaptic: allowHaptic)
            if page.items != transactions {
                withAnimation(.snappy) {
                    transactions = page.items
                    transactionsCursor = page.nextCursor
                }
            }
        }

        if let freshCards = try? await cardsTask {
            if freshCards != cards || !cardsLoaded {
                withAnimation(.snappy) {
                    cards = freshCards
                    cardsLoaded = true
                }
            }
        }
    }

    func refreshWallets() async {
        if let items = try? await api.wallets(syncDeposits: true) {
            if items != wallets {
                withAnimation(.snappy) { wallets = items }
            }
        }
    }

    func refreshTransactions() async {
        if let page = try? await api.transactions(currency: nil, limit: 30, cursor: nil) {
            processIncomingDeposits(page.items, allowHaptic: true)
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

    /// Aplica al instante el resultado de recargar o retirar del bolsillo de la tarjeta y sincroniza con el backend.
    func applyCardPocketTransfer(_ response: CardPocketTransferResponse) async {
        if let idx = cards.firstIndex(where: { $0.id == response.card.id }) {
            cards[idx] = response.card
        }
        for i in cards.indices where cards[i].status != .canceled {
            cards[i].balanceMinor = response.pocketBalanceMinor
            cards[i].availableMinor = response.pocketBalanceMinor
        }
        if let wIdx = wallets.firstIndex(where: { $0.currency == .cop }) {
            wallets[wIdx].availableMinor = response.mainAvailableMinor
            wallets[wIdx].balanceMinor = response.mainAvailableMinor + wallets[wIdx].heldMinor
        }
        if !transactions.contains(where: { $0.id == response.transaction.id }) {
            transactions.insert(response.transaction, at: 0)
        }
        async let w: Void = refreshWallets()
        async let c: Void = refreshCards()
        async let t: Void = refreshTransactions()
        _ = await (w, c, t)
    }

    /// Después de un envío o conversión.
    func refreshAfterMovement() async {
        async let w: Void = refreshWallets()
        async let t: Void = refreshTransactions()
        async let l: Void = refreshLimits()
        _ = await (w, t, l)
    }

    // MARK: - Detección de nuevos depósitos y centro de notificaciones

    private var userScopeKey: String {
        activeUserId ?? "default"
    }

    private var seenDepositsStorageKey: String {
        "cuypay.seenDepositIds.\(userScopeKey)"
    }

    private var lastReadNotificationsKey: String {
        "cuypay.notificationsLastRead.\(userScopeKey)"
    }

    func markNotificationsRead() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastReadNotificationsKey)
        unreadNotificationsCount = 0
    }

    private func recalculateUnreadNotifications(from items: [WalletTransaction]) {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: lastReadNotificationsKey) == nil {
            let baseline = items.first?.createdAt.timeIntervalSince1970 ?? Date().timeIntervalSince1970
            defaults.set(baseline, forKey: lastReadNotificationsKey)
            unreadNotificationsCount = 0
            return
        }
        let lastRead = defaults.double(forKey: lastReadNotificationsKey)
        unreadNotificationsCount = items.filter { $0.createdAt.timeIntervalSince1970 > lastRead + 0.5 }.count
    }

    private func processIncomingDeposits(_ items: [WalletTransaction], allowHaptic: Bool) {
        let defaults = UserDefaults.standard
        let deposits = items.filter {
            ($0.type == .deposit || $0.type == .loan || $0.type == .savings) &&
                $0.direction == .in &&
                $0.status == .completed
        }

        // Primera sincronización en este dispositivo para este usuario: sembramos los IDs actuales
        // sin disparar notificaciones retroactivas del historial pasado.
        guard let stored = defaults.stringArray(forKey: seenDepositsStorageKey) else {
            let seeded = ["__initialized__"] + deposits.map(\.id)
            defaults.set(Array(seeded.prefix(400)), forKey: seenDepositsStorageKey)
            recalculateUnreadNotifications(from: items)
            return
        }

        var seenSet = Set(stored)
        let unseenDeposits = deposits.filter { !seenSet.contains($0.id) }

        if !unseenDeposits.isEmpty {
            var updatedList = stored
            for dep in unseenDeposits {
                seenSet.insert(dep.id)
                updatedList.insert(dep.id, at: min(1, updatedList.count))
            }
            defaults.set(Array(updatedList.prefix(400)), forKey: seenDepositsStorageKey)

            if allowHaptic {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
            for dep in unseenDeposits.reversed() {
                DepositNotificationManager.shared.notifyIncomingDeposit(dep)
            }
        }

        recalculateUnreadNotifications(from: items)
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
        unreadNotificationsCount = 0
        activeUserId = nil
    }
}
