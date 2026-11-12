import SwiftUI

/// Destinos con navegación push desde el inicio.
enum HomeDestination: Hashable {
    case beneficiaries
    case limits
    case profile
    case allTransactions(Currency)
    case card
}

/// Hojas presentadas desde el inicio.
enum HomeSheet: Identifiable, Hashable {
    case send(preselected: Beneficiary?)
    case receive
    case convert
    case card
    case savingsVault
    case loans
    case menu
    case addBeneficiary
    case kyc
    case notifications

    var id: String {
        switch self {
        case .send(let beneficiary): "send-\(beneficiary?.id ?? "none")"
        case .receive: "receive"
        case .convert: "convert"
        case .card: "card"
        case .savingsVault: "savingsVault"
        case .loans: "loans"
        case .menu: "menu"
        case .addBeneficiary: "addBeneficiary"
        case .kyc: "kyc"
        case .notifications: "notifications"
        }
    }
}

/// Inicio: replica el layout de la referencia Liquid Glass con actualización automática en vivo.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @AppStorage(AppModel.hideAmountsKey) private var hideAmounts = false

    @State private var pocket: Currency = .cop
    @State private var path: [HomeDestination] = []
    @State private var sheet: HomeSheet?
    /// Acción a ejecutar cuando se cierre la hoja actual (p. ej. menú → otra hoja).
    @State private var pendingAction: MenuAction?

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(spacing: 20) {
                        header

                        if let user = app.user, user.kycStatus != .approved {
                            KYCBanner(status: user.kycStatus) { sheet = .kyc }
                        }

                        VStack(spacing: 14) {
                            let available = store.wallets.map(\.currency)
                            PocketSwitcher(selection: $pocket, availableCurrencies: available.isEmpty ? [.cop] : available)
                            BalanceHeader(wallet: store.wallet(for: pocket), currency: pocket, hideAmounts: $hideAmounts)
                                .redacted(reason: store.hasLoadedOnce ? [] : .placeholder)
                        }
                        .padding(.vertical, 8)

                        if let error = store.errorMessage, store.wallets.isEmpty {
                            ErrorBanner(message: error)
                        }

                        HStack(alignment: .top, spacing: 12) {
                            CardQuickCard(
                                card: store.activeCard,
                                hideAmounts: hideAmounts,
                                isLoading: !store.cardsLoaded,
                                onTap: { openGated(.card) }
                            )
                            RateChartCard(
                                rate: store.fxRate,
                                isLoading: !store.hasLoadedOnce,
                                onTap: store.fxRate != nil ? { openGated(.convert) } : nil
                            )
                        }

                        // Accesos directos delgados a Bolsillo de Ahorro y Créditos
                        HStack(spacing: 12) {
                            quickFinancePill(
                                title: "Bolsillo de Ahorro",
                                subtitle: savingsPillSubtitle,
                                systemImage: "lock.rotation"
                            ) {
                                openGated(.savingsVault)
                            }
                            quickFinancePill(
                                title: "Créditos",
                                subtitle: loansPillSubtitle,
                                systemImage: "banknote.fill"
                            ) {
                                openGated(.loans)
                            }
                        }

                        TransactionsSection(
                            transactions: store.transactions(for: pocket),
                            pocket: pocket,
                            hideAmounts: hideAmounts,
                            isLoading: !store.hasLoadedOnce,
                            onSeeAll: { path.append(.allTransactions(pocket)) }
                        )
                    }
                    .padding(.horizontal, Theme.horizontalPadding)
                    .padding(.bottom, 90)
                }
                .scrollIndicators(.hidden)
                .refreshable {
                    await store.refreshAll()
                    await app.refreshUser()
                }
            }
            .safeAreaInset(edge: .bottom) {
                BottomActionBar(
                    onSend: { openGated(.send(preselected: nil)) },
                    onMenu: { sheet = .menu },
                    onReceive: { openGated(.receive) }
                )
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: HomeDestination.self) { destination in
                switch destination {
                case .beneficiaries:
                    BeneficiariesView()
                case .limits:
                    LimitsView()
                case .profile:
                    ProfileView()
                case .allTransactions(let currency):
                    AllTransactionsView(pocket: currency)
                case .card:
                    CardView(onOpenProfile: {
                        if !path.isEmpty {
                            path.removeLast()
                        }
                        path.append(.profile)
                    })
                }
            }
            .sheet(item: $sheet, onDismiss: runPendingAction) { sheet in
                sheetContent(sheet)
            }
            .task {
                if !store.hasLoadedOnce {
                    await store.refreshAll()
                }
                // Sincronización silenciosa continua cada 5 s mientras la app está visible:
                // actualiza saldos y dispara notificaciones de depósitos sin necesidad de deslizar hacia abajo.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled else { break }
                    if !app.isPrivacyCoverVisible && !app.isLocked {
                        await store.refreshLiveState()
                    }
                }
            }
        }
    }

    private var savingsPillSubtitle: String {
        if let summary = store.userSavings?.summary, summary.activeCount > 0 {
            return hideAmounts ? "•••• bloqueado" : summary.totalPrincipal.formatted()
        }
        return "30 a 360 días"
    }

    private var loansPillSubtitle: String {
        if let summary = store.userLoans?.summary {
            if summary.activeCount > 0 {
                return hideAmounts ? "•••• activo" : summary.activeRemaining.formatted()
            }
            if summary.pendingCount > 0 {
                return "En estudio"
            }
        }
        return "Solicita hasta 360d"
    }

    private func quickFinancePill(
        title: LocalizedStringKey,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Theme.spruce)
                    .frame(width: 34, height: 34)
                    .background(Theme.spruce.opacity(0.12), in: .circle)

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                    Text(verbatim: subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .contentShape(.rect(cornerRadius: 20))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
    }

    // MARK: Encabezado

    private var header: some View {
        HStack {
            Button {
                path.append(.profile)
            } label: {
                AvatarView(initials: app.user?.initials ?? "", size: 46, seed: app.user?.id ?? "")
                    .padding(3)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Perfil y seguridad"))

            Spacer()
            CuyPayLogo(size: 20)
            Spacer()

            ZStack(alignment: .topTrailing) {
                GlassCircleButton(
                    systemImage: store.unreadNotificationsCount > 0 ? "bell.badge.fill" : "bell",
                    accessibilityLabel: "Notificaciones",
                    size: 52
                ) {
                    sheet = .notifications
                }

                if store.unreadNotificationsCount > 0 {
                    Circle()
                        .fill(Theme.coral)
                        .frame(width: 11, height: 11)
                        .overlay {
                            Circle().strokeBorder(.background, lineWidth: 2)
                        }
                        .offset(x: -4, y: 4)
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(.top, 4)
    }

    // MARK: Hojas

    @ViewBuilder
    private func sheetContent(_ sheet: HomeSheet) -> some View {
        switch sheet {
        case .send(let beneficiary):
            SendFlowView(preselected: beneficiary)
                .presentationDragIndicator(.visible)
        case .receive:
            ReceiveView()
                .presentationDetents([.fraction(0.88), .large])
                .presentationDragIndicator(.visible)
        case .convert:
            ConvertView()
                .presentationDetents([.fraction(0.85), .large])
                .presentationDragIndicator(.visible)
        case .card:
            CardView(onOpenProfile: {
                pendingAction = .profile
                self.sheet = nil
            })
            .presentationDragIndicator(.visible)
        case .savingsVault:
            SavingsView()
                .presentationDragIndicator(.visible)
        case .loans:
            LoansView()
                .presentationDragIndicator(.visible)
        case .menu:
            MainMenuSheet(canConvert: store.wallets.count > 1 || store.fxRate != nil) { action in
                pendingAction = action
                self.sheet = nil
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        case .addBeneficiary:
            AddBeneficiaryFlowView()
                .presentationDragIndicator(.visible)
        case .kyc:
            KYCFlowSheet()
                .presentationDragIndicator(.visible)
        case .notifications:
            NotificationsSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Envío, conversión e inscripción requieren KYC aprobado.
    private func openGated(_ target: HomeSheet) {
        if app.isKYCApproved {
            sheet = target
        } else {
            sheet = .kyc
        }
    }

    private func runPendingAction() {
        guard let action = pendingAction else { return }
        pendingAction = nil
        switch action {
        case .card: openGated(.card)
        case .savingsVault: openGated(.savingsVault)
        case .loans: openGated(.loans)
        case .convert: openGated(.convert)
        case .brebKey: openGated(.receive)
        case .beneficiaries: path.append(.beneficiaries)
        case .limits: path.append(.limits)
        case .profile: path.append(.profile)
        }
    }
}

// MARK: - Sección de movimientos (hoja de vidrio)

struct TransactionsSection: View {
    let transactions: [WalletTransaction]
    let pocket: Currency
    let hideAmounts: Bool
    let isLoading: Bool
    let onSeeAll: () -> Void

    @State private var isSearching = false
    @State private var query = ""
    @State private var filter: TransactionFilter = .all
    @State private var selectedTransaction: WalletTransaction? = nil
    @FocusState private var searchFocused: Bool

    private var filtered: [WalletTransaction] {
        transactions
            .filter { filter.matches($0, pocket: pocket) }
            .filter { query.isEmpty || $0.title.localizedStandardContains(query) || ($0.subtitle?.localizedStandardContains(query) ?? false) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("Movimientos")
                    .font(.system(.title3, design: .serif).weight(.semibold))
                Spacer()
                GlassCircleButton(systemImage: isSearching ? "xmark" : "magnifyingglass", accessibilityLabel: "Buscar", size: 38) {
                    withAnimation(.snappy) {
                        isSearching.toggle()
                        if !isSearching { query = "" }
                        searchFocused = isSearching
                    }
                }
                Menu {
                    Picker("Filtrar", selection: $filter) {
                        ForEach(TransactionFilter.allCases) { option in
                            Label(option.title, systemImage: option.systemImage).tag(option)
                        }
                    }
                } label: {
                    Image(systemName: filter == .all ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 38, height: 38)
                        .glassEffect(.regular.interactive(), in: .circle)
                }
                .accessibilityLabel(Text("Filtrar movimientos"))
                Button("Ver todo", action: onSeeAll)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .glassEffect(.regular.interactive(), in: .capsule)
            }

            if isSearching {
                TextField("Buscar por nombre o llave", text: $query)
                    .focused($searchFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 14))
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            if isLoading {
                ForEach(0..<3, id: \.self) { _ in
                    TransactionRow(transaction: .placeholder, pocket: pocket, hideAmounts: false)
                        .redacted(reason: .placeholder)
                }
            } else if filtered.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? LocalizedStringKey("Sin movimientos") : LocalizedStringKey("Sin resultados"),
                    systemImage: "tray",
                    description: Text("Aquí verás tus depósitos, envíos y conversiones.")
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            } else {
                ForEach(DayGrouping.sections(for: Array(filtered.prefix(12)))) { section in
                    Text(verbatim: section.title)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                    ForEach(section.items) { transaction in
                        Button {
                            selectedTransaction = transaction
                        } label: {
                            TransactionRow(transaction: transaction, pocket: pocket, hideAmounts: hideAmounts)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.sheetRadius))
        .sheet(item: $selectedTransaction) { txn in
            TransactionDetailSheet(transaction: txn, pocket: pocket)
        }
    }
}

enum TransactionFilter: String, CaseIterable, Identifiable, Hashable {
    case all, incoming, outgoing, cards, conversions

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .all: "Todos"
        case .incoming: "Recibidos"
        case .outgoing: "Enviados"
        case .cards: "Tarjeta"
        case .conversions: "Conversiones"
        }
    }

    var systemImage: String {
        switch self {
        case .all: "list.bullet"
        case .incoming: "arrow.down.left"
        case .outgoing: "arrow.up.right"
        case .cards: "creditcard.fill"
        case .conversions: "arrow.left.arrow.right"
        }
    }

    func matches(_ transaction: WalletTransaction, pocket: Currency) -> Bool {
        let isIncomingConversion = transaction.type == .conversion
            && transaction.conversion?.toCurrency == pocket
            && transaction.currency != pocket
        switch self {
        case .all: return true
        case .incoming: return transaction.direction == .in || isIncomingConversion
        case .outgoing: return transaction.direction == .out && !isIncomingConversion
        case .cards: return transaction.type == .cardPocket || transaction.type == .cardPurchase
        case .conversions: return transaction.type == .conversion
        }
    }
}

extension WalletTransaction {
    /// Para estados de carga (`.redacted`).
    static let placeholder = WalletTransaction(
        id: "placeholder", type: .deposit, direction: .in, currency: .cop, amountMinor: 10_000_000, feeMinor: 0,
        status: .completed, title: "Cargando movimiento", subtitle: "Bre-B", conversion: nil, createdAt: Date()
    )
}

// MARK: - Menú (⊞)

enum MenuAction: Hashable {
    case card, convert, brebKey, beneficiaries, savingsVault, loans, limits, profile
}

struct MainMenuSheet: View {
    var canConvert: Bool = true
    let onSelect: (MenuAction) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("¿Qué quieres hacer?")
                    .font(.system(.title3, design: .serif).weight(.semibold))
                    .padding(.top, 24)
                GlassEffectContainer(spacing: 12) {
                    LazyVGrid(columns: columns, spacing: 12) {
                        tile("Mi Tarjeta", "creditcard.fill", .card)
                        tile("Bolsillo de Ahorro", "lock.rotation", .savingsVault)
                        tile("Créditos", "banknote.fill", .loans)
                        if canConvert {
                            tile("Convertir", "arrow.left.arrow.right", .convert)
                        }
                        tile("Mi llave Bre-B", "key.fill", .brebKey)
                        tile("Beneficiarios", "person.2.fill", .beneficiaries)
                        tile("Límites", "gauge.with.dots.needle.67percent", .limits)
                        tile("Perfil y seguridad", "lock.shield.fill", .profile)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .scrollIndicators(.hidden)
    }

    private func tile(_ title: LocalizedStringKey, _ systemImage: String, _ action: MenuAction) -> some View {
        Button {
            onSelect(action)
        } label: {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(Theme.spruce)
                    .symbolRenderingMode(.hierarchical)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, minHeight: 92)
            .contentShape(.rect(cornerRadius: 22))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
    }
}

// MARK: - Centro de notificaciones en tiempo real

struct NotificationsSheet: View {
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppModel.hideAmountsKey) private var hideAmounts = false

    @State private var selectedTransaction: WalletTransaction?

    private var notificationItems: [WalletTransaction] {
        Array(store.transactions.prefix(25))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                if notificationItems.isEmpty {
                    ContentUnavailableView(
                        "Estás al día",
                        systemImage: "bell.badge",
                        description: Text("Aquí recibirás avisos inmediatos cada vez que te envíen dinero o uses tu cuenta.")
                    )
                } else {
                    ScrollView {
                        VStack(spacing: 10) {
                            ForEach(notificationItems) { txn in
                                Button {
                                    selectedTransaction = txn
                                } label: {
                                    notificationCard(for: txn)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .navigationTitle("Notificaciones")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .onAppear {
                store.markNotificationsRead()
            }
            .sheet(item: $selectedTransaction) { txn in
                TransactionDetailSheet(transaction: txn, pocket: txn.currency)
            }
        }
    }

    private func notificationCard(for txn: WalletTransaction) -> some View {
        let isIncomingDeposit = txn.type == .deposit && txn.direction == .in
        let isIncomingCredit = (txn.type == .deposit || txn.type == .loan || txn.type == .savings) && txn.direction == .in
        let amountStr = hideAmounts ? txn.amount.maskedString : txn.amount.formatted()
        let sender = txn.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasNamedSender = !sender.isEmpty && sender.lowercased() != "depósito bre-b" && sender.lowercased() != "deposito bre-b"

        let headline: String = switch txn.type {
        case .deposit:
            "¡Recibiste \(amountStr)!"
        case .transfer:
            "Enviaste \(amountStr)"
        case .cardPurchase:
            "Compra con tarjeta · \(amountStr)"
        case .cardPocket:
            txn.direction == .out ? "Recargaste tu tarjeta · \(amountStr)" : "Retiro de tarjeta · \(amountStr)"
        case .conversion:
            "Conversión realizada · \(amountStr)"
        case .savings:
            txn.direction == .in ? "¡Reintegro de ahorro · \(amountStr)!" : "Ahorro bloqueado · \(amountStr)"
        case .loan:
            txn.direction == .in ? "¡Crédito desembolsado · \(amountStr)!" : "Pago de crédito · \(amountStr)"
        case .unknown:
            "\(txn.title) · \(amountStr)"
        }

        let detail: String = if isIncomingDeposit {
            hasNamedSender
                ? "Recibiste \(amountStr) de \(sender) en tu cuenta CuyPay."
                : "Depósito recibido por Bre-B en tu cuenta CuyPay."
        } else {
            [txn.title, txn.subtitle].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }

        let iconName: String = switch txn.type {
        case .deposit: "arrow.down.left.circle.fill"
        case .transfer: "arrow.up.right.circle.fill"
        case .cardPurchase, .cardPocket: "creditcard.circle.fill"
        case .conversion: "arrow.left.arrow.right.circle.fill"
        case .savings: "lock.circle.fill"
        case .loan: "banknote.fill"
        case .unknown: "bell.circle.fill"
        }

        let iconTint: Color = isIncomingCredit ? Theme.positive : Theme.spruce

        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 26))
                .foregroundStyle(iconTint)
                .symbolRenderingMode(.hierarchical)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: headline)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.primary)
                    Spacer()
                    Text(txn.createdAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Text(verbatim: detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 18))
    }
}

#Preview("Inicio") {
    HomeView()
        .appEnvironment(.preview())
}

#Preview("Inicio · sin KYC") {
    HomeView()
        .appEnvironment(.preview(kycStatus: .notStarted))
}

#Preview("Inicio · oscuro") {
    HomeView()
        .appEnvironment(.preview())
        .preferredColorScheme(.dark)
}
