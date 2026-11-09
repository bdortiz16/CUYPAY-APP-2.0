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
        case .menu: "menu"
        case .addBeneficiary: "addBeneficiary"
        case .kyc: "kyc"
        case .notifications: "notifications"
        }
    }
}

/// Inicio: replica el layout de la referencia Liquid Glass.
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
                            RateChartCard(rate: store.fxRate)
                            CardQuickCard(
                                card: store.cards.first { $0.status != .canceled } ?? store.cards.first,
                                isLoading: !store.cardsLoaded,
                                onTap: { openGated(.card) }
                            )
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
                    onReceive: { sheet = .receive }
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
                    CardView()
                }
            }
            .sheet(item: $sheet, onDismiss: runPendingAction) { sheet in
                sheetContent(sheet)
            }
            .task {
                if !store.hasLoadedOnce { await store.refreshAll() }
            }
        }
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

            GlassCircleButton(systemImage: "bell", accessibilityLabel: "Notificaciones", size: 52) {
                sheet = .notifications
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
            CardView()
                .presentationDragIndicator(.visible)
        case .savingsVault:
            SavingsView()
                .presentationDragIndicator(.visible)
        case .menu:
            MainMenuSheet(canConvert: store.wallets.count > 1 || store.fxRate != nil) { action in
                pendingAction = action
                self.sheet = nil
            }
            .presentationDetents([.height(440)])
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
        case .convert: openGated(.convert)
        case .brebKey: sheet = .receive
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
                        TransactionRow(transaction: transaction, pocket: pocket, hideAmounts: hideAmounts)
                    }
                }
            }
        }
        .padding(18)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.sheetRadius))
    }
}

enum TransactionFilter: String, CaseIterable, Identifiable, Hashable {
    case all, incoming, outgoing, conversions

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .all: "Todos"
        case .incoming: "Recibidos"
        case .outgoing: "Enviados"
        case .conversions: "Conversiones"
        }
    }

    var systemImage: String {
        switch self {
        case .all: "list.bullet"
        case .incoming: "arrow.down.left"
        case .outgoing: "arrow.up.right"
        case .conversions: "arrow.left.arrow.right"
        }
    }

    func matches(_ transaction: WalletTransaction, pocket: Currency) -> Bool {
        switch self {
        case .all: true
        case .incoming: transaction.type == .deposit
        case .outgoing: transaction.type == .transfer
        case .conversions: transaction.type == .conversion
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
    case card, convert, brebKey, beneficiaries, savingsVault, limits, profile
}

struct MainMenuSheet: View {
    var canConvert: Bool = true
    let onSelect: (MenuAction) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("¿Qué quieres hacer?")
                .font(.system(.title3, design: .serif).weight(.semibold))
                .padding(.top, 24)
            GlassEffectContainer(spacing: 12) {
                LazyVGrid(columns: columns, spacing: 12) {
                    tile("Mi Tarjeta", "creditcard.fill", .card)
                    tile("Bloque de Ahorro", "lock.rotation", .savingsVault)
                    if canConvert {
                        tile("Convertir", "arrow.left.arrow.right", .convert)
                    }
                    tile("Mi llave Bre-B", "key.fill", .brebKey)
                    tile("Beneficiarios", "person.2.fill", .beneficiaries)
                    tile("Límites", "gauge.with.dots.needle.67percent", .limits)
                    tile("Perfil y seguridad", "lock.shield.fill", .profile)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
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

// MARK: - Notificaciones (placeholder: el contrato v1 no define endpoint)

struct NotificationsSheet: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "Estás al día",
                systemImage: "bell.badge",
                description: Text("Aquí verás avisos de depósitos, envíos y tu verificación.")
            )
            .navigationTitle("Notificaciones")
            .navigationBarTitleDisplayMode(.inline)
        }
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
