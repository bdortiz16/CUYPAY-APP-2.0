import SwiftUI

/// Historial completo de un bolsillo, agrupado por día, con búsqueda, filtro y paginación por cursor.
struct AllTransactionsView: View {
    let pocket: Currency

    @Environment(WalletStore.self) private var store
    @AppStorage(AppModel.hideAmountsKey) private var hideAmounts = false
    @State private var query = ""
    @State private var filter: TransactionFilter = .all
    @State private var isLoadingMore = false
    @State private var selectedTransaction: WalletTransaction? = nil

    private var filtered: [WalletTransaction] {
        store.transactions(for: pocket)
            .filter { filter.matches($0, pocket: pocket) }
            .filter {
                query.isEmpty
                    || $0.title.localizedStandardContains(query)
                    || ($0.subtitle?.localizedStandardContains(query) ?? false)
            }
    }

    var body: some View {
        let sections = DayGrouping.sections(for: filtered)
        ZStack {
            BrandBackground()
            List {
                Section {
                    Picker("Filtro", selection: $filter) {
                        ForEach(TransactionFilter.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

                if sections.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? LocalizedStringKey("Sin movimientos") : LocalizedStringKey("Sin resultados"),
                        systemImage: "tray",
                        description: Text("Tus movimientos aparecerán aquí.")
                    )
                    .listRowBackground(Color.clear)
                }

                ForEach(sections) { section in
                    Section {
                        ForEach(section.items) { transaction in
                            Button {
                                selectedTransaction = transaction
                            } label: {
                                TransactionRow(transaction: transaction, pocket: pocket, hideAmounts: hideAmounts)
                            }
                            .buttonStyle(.plain)
                            .onAppear {
                                if transaction.id == filtered.last?.id {
                                    Task { await loadMore() }
                                }
                            }
                        }
                    } header: {
                        Text(verbatim: section.title)
                    }
                    .listRowBackground(Rectangle().fill(.thinMaterial))
                }

                if isLoadingMore {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle(pocket == .cop ? LocalizedStringKey("Movimientos COP") : LocalizedStringKey("Movimientos BRL"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: Text("Buscar movimientos"))
        .refreshable {
            await store.refreshTransactions()
        }
        .task {
            if !store.hasLoadedOnce { await store.refreshAll() }
        }
        .sheet(item: $selectedTransaction) { txn in
            TransactionDetailSheet(transaction: txn, pocket: pocket)
        }
    }

    private func loadMore() async {
        guard !isLoadingMore, store.transactionsCursor != nil else { return }
        isLoadingMore = true
        await store.loadMoreTransactions()
        isLoadingMore = false
    }
}

#Preview {
    NavigationStack {
        AllTransactionsView(pocket: .cop)
    }
    .appEnvironment(.preview())
}
