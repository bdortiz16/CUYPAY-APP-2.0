import SwiftUI

/// Hoja de envío Bre-B.
struct SendFlowView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let preselected: Beneficiary?
    @State private var model: SendFlowModel?

    var body: some View {
        Group {
            if let model {
                SendFlowContent(model: model) { dismiss() }
            } else {
                Color.clear
            }
        }
        .onAppear {
            if model == nil { model = SendFlowModel(api: app.api, preselected: preselected) }
        }
    }
}

private struct SendFlowContent: View {
    @Bindable var model: SendFlowModel
    let onClose: () -> Void

    var body: some View {
        NavigationStack(path: $model.path) {
            BeneficiaryPickerView(model: model)
                .navigationDestination(for: SendFlowModel.Step.self) { step in
                    switch step {
                    case .amount: SendAmountView(model: model)
                    case .review: SendReviewView(model: model)
                    case .receipt: SendReceiptView(model: model, onDone: onClose)
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        CloseToolbarButton(action: onClose)
                    }
                }
        }
    }
}

// MARK: - 1. Beneficiario

private struct BeneficiaryPickerView: View {
    @Environment(WalletStore.self) private var store
    let model: SendFlowModel
    @State private var showAdd = false
    @State private var query = ""

    private var filtered: [Beneficiary] {
        store.beneficiaries.filter {
            query.isEmpty || $0.displayName.localizedStandardContains(query) || $0.alias.localizedStandardContains(query)
        }
    }

    var body: some View {
        ZStack {
            BrandBackground()
            List {
                Section {
                    Button {
                        showAdd = true
                    } label: {
                        Label("Nuevo beneficiario", systemImage: "person.crop.circle.badge.plus")
                            .font(.body.weight(.semibold))
                    }
                }
                .listRowBackground(Color.clear)

                Section("Tus beneficiarios") {
                    ForEach(filtered) { beneficiary in
                        Button {
                            model.select(beneficiary)
                        } label: {
                            BeneficiaryRow(beneficiary: beneficiary)
                        }
                        .buttonStyle(.plain)
                        .disabled(beneficiary.status != .active)
                        .opacity(beneficiary.status == .active ? 1 : 0.55)
                    }
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))
            }
            .scrollContentBackground(.hidden)
            .searchable(text: $query, prompt: Text("Buscar beneficiario"))
            .overlay {
                if store.beneficiaries.isEmpty {
                    ContentUnavailableView("Aún no tienes beneficiarios", systemImage: "person.2", description: Text("Inscribe una llave Bre-B para enviar dinero."))
                }
            }
        }
        .navigationTitle("¿A quién envías?")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showAdd) {
            AddBeneficiaryFlowView { beneficiary in
                if beneficiary.status == .active { model.select(beneficiary) }
            }
        }
        .task {
            if store.beneficiaries.isEmpty { await store.refreshBeneficiaries() }
        }
    }
}

// MARK: - 2. Monto

private struct SendAmountView: View {
    @Environment(WalletStore.self) private var store
    @Bindable var model: SendFlowModel

    private let quickAmounts: [Int64] = [50_000, 100_000, 200_000]

    private var available: Money? { store.wallet(for: .cop)?.available }
    private var insufficient: Bool {
        guard let available else { return false }
        return model.input.minorUnits > available.minorUnits
    }

    var body: some View {
        ZStack {
            BrandBackground()
            ScrollView {
                VStack(spacing: 18) {
                    if let beneficiary = model.beneficiary {
                        HStack(spacing: 12) {
                            AvatarView(initials: beneficiary.initials, size: 48, seed: beneficiary.id)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: beneficiary.displayName).font(.headline)
                                Text(verbatim: "\(beneficiary.bankName) · \(beneficiary.alias)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding(14)
                        .glassEffect(.regular, in: .rect(cornerRadius: 22))
                    }

                    AmountDisplay(input: model.input)
                        .padding(.vertical, 12)

                    if let available {
                        Text("Disponible: \(available.formatted())")
                            .font(.footnote)
                            .foregroundStyle(insufficient ? Theme.negative : .secondary)
                    }

                    GlassEffectContainer(spacing: 8) {
                        HStack(spacing: 8) {
                            ForEach(quickAmounts, id: \.self) { major in
                                let money = Money(major: major, currency: .cop) ?? .zero(.cop)
                                Button(money.formatted()) {
                                    model.input.set(minorUnits: money.minorUnits)
                                }
                                .font(.footnote.weight(.semibold))
                                .buttonStyle(.glass)
                            }
                        }
                    }

                    if let error = model.errorMessage {
                        ErrorBanner(message: error)
                    }

                    AmountKeypad(input: $model.input)
                }
                .padding(.horizontal, 20)
            }
        }
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(
                title: "Continuar",
                isLoading: model.isLoading,
                isEnabled: model.input.minorUnits > 0 && !insufficient
            ) {
                Task { await model.requestPreview() }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .navigationTitle("Monto")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - 3. Resumen

private struct SendReviewView: View {
    @Environment(WalletStore.self) private var store
    @Bindable var model: SendFlowModel

    var body: some View {
        ZStack {
            BrandBackground()
            ScrollView {
                VStack(spacing: 18) {
                    if let preview = model.preview, let beneficiary = model.beneficiary {
                        VStack(spacing: 6) {
                            Text("Vas a enviar")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Text(verbatim: preview.amount.formatted())
                                .font(.system(size: 44, weight: .bold, design: .rounded))
                                .monospacedDigit()
                            Text("a \(beneficiary.holderName)")
                                .font(.headline)
                        }
                        .padding(.top, 12)

                        GlassCard {
                            VStack(spacing: 12) {
                                DetailRow(title: "Llave Bre-B", value: beneficiary.alias)
                                DetailRow(title: "Banco", value: beneficiary.bankName)
                                Divider()
                                DetailRow(title: "Monto", value: preview.amount.formatted())
                                DetailRow(title: "Costo del envío", value: preview.feeMinor == 0 ? String(localized: "Gratis") : preview.fee.formatted())
                                DetailRow(title: "Total a debitar", value: preview.total.formatted(), emphasized: true)
                            }
                        }

                        if let remaining = model.remainingDailyAfter {
                            HStack(spacing: 10) {
                                Image(systemName: "gauge.with.dots.needle.33percent")
                                    .foregroundStyle(model.exceedsDailyLimit ? Theme.negative : Theme.mint)
                                Group {
                                    if model.exceedsDailyLimit {
                                        Text("Este envío supera tu cupo diario.")
                                    } else {
                                        Text("Cupo diario restante después del envío: \(remaining.formatted())")
                                    }
                                }
                                .font(.footnote)
                                Spacer(minLength: 0)
                            }
                            .padding(12)
                            .glassEffect(.regular, in: .rect(cornerRadius: 16))
                        }

                        TextField("Descripción (opcional)", text: $model.note)
                            .formFieldStyle()

                        if let error = model.errorMessage {
                            ErrorBanner(message: error)
                        }

                        Label("Los envíos Bre-B son inmediatos y no se pueden reversar. Verifica los datos.", systemImage: "info.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 12)
            }
        }
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(
                title: "Enviar ahora",
                systemImage: "faceid",
                isLoading: model.isLoading,
                isEnabled: !model.exceedsDailyLimit
            ) {
                Task { await model.send(store: store) }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .navigationTitle("Resumen")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.error, trigger: model.errorMessage) { _, newValue in newValue != nil }
    }
}

// MARK: - 4. Comprobante

private struct SendReceiptView: View {
    let model: SendFlowModel
    let onDone: () -> Void
    @State private var appeared = false

    var body: some View {
        ZStack {
            BrandBackground()
            if let transaction = model.transaction {
                VStack(spacing: 20) {
                    Spacer()
                    Image(systemName: transaction.status == .pending ? "clock.badge.checkmark.fill" : "checkmark.circle.fill")
                        .font(.system(size: 90))
                        .foregroundStyle(transaction.status == .pending ? Theme.warning : Theme.mint)
                        .symbolEffect(.bounce, value: appeared)
                        .scaleEffect(appeared ? 1 : 0.5)
                    Text(transaction.status == .pending ? LocalizedStringKey("Envío en proceso") : LocalizedStringKey("¡Envío exitoso!"))
                        .font(.system(.title, design: .rounded).weight(.bold))
                    Text(verbatim: transaction.amount.formatted())
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .monospacedDigit()

                    GlassCard {
                        VStack(spacing: 10) {
                            DetailRow(title: "Para", value: transaction.title)
                            if let subtitle = transaction.subtitle {
                                DetailRow(title: "Destino", value: subtitle)
                            }
                            DetailRow(title: "Costo", value: transaction.feeMinor == 0 ? String(localized: "Gratis") : transaction.fee.formatted())
                            DetailRow(title: "Fecha", value: transaction.createdAt.formatted(date: .abbreviated, time: .shortened))
                            DetailRow(title: "Referencia", value: transaction.id)
                        }
                    }

                    Spacer()

                    ShareLink(item: receiptText(transaction)) {
                        Label("Compartir comprobante", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.glass)
                    .controlSize(.large)

                    PrimaryButton(title: "Listo", action: onDone)
                }
                .padding(24)
            }
        }
        .navigationBarBackButtonHidden()
        .sensoryFeedback(.success, trigger: appeared) { _, newValue in newValue }
        .onAppear {
            withAnimation(.bouncy(duration: 0.6)) { appeared = true }
        }
    }

    private func receiptText(_ transaction: WalletTransaction) -> String {
        let date = transaction.createdAt.formatted(date: .abbreviated, time: .shortened)
        return String(localized: "Comprobante CuyPay\nEnvío Bre-B de \(transaction.amount.formatted()) a \(transaction.title)\n\(date)\nRef: \(transaction.id)")
    }
}

// MARK: - Fila de beneficiario (compartida)

struct BeneficiaryRow: View {
    let beneficiary: Beneficiary

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(initials: beneficiary.initials, size: 44, seed: beneficiary.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: beneficiary.displayName)
                    .font(.body.weight(.medium))
                Text(verbatim: "\(beneficiary.bankName) · \(beneficiary.alias)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            StatusBadge(text: beneficiary.status.badgeText, color: beneficiary.status.badgeColor, systemImage: beneficiary.status.badgeIcon)
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Enviar") {
    SendFlowView(preselected: nil)
        .appEnvironment(.preview())
}

#Preview("Enviar · monto") {
    SendFlowView(preselected: MockFixtures(now: Date()).beneficiaries[0])
        .appEnvironment(.preview())
}
