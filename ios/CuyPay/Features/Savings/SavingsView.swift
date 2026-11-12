import SwiftUI
import UIKit

/// Vista principal de Bolsillo de Ahorro (30, 60, 90, 180 y 360 días con rendimiento fijo garantizado).
struct SavingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var config: SavingsConfig?
    @State private var userSavings: UserSavingsResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showNewBlockSheet = false
    @State private var selectedCertificateBlock: SavingsBlock?

    private var maxRateLabel: String {
        let maxRate = config?.rates.filter(\.enabled).map(\.ratePercent).max() ?? 12.0
        return "Hasta \(String(format: "%.1f", maxRate))% E.A."
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                if isLoading && userSavings == nil {
                    ProgressView("Cargando tu Bolsillo de Ahorro…")
                        .controlSize(.large)
                } else {
                    ScrollView {
                        VStack(spacing: 20) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            summaryHeader

                            Button {
                                if config != nil {
                                    showNewBlockSheet = true
                                } else {
                                    Task {
                                        await loadData()
                                        if config != nil { showNewBlockSheet = true }
                                    }
                                }
                            } label: {
                                HStack {
                                    Image(systemName: "plus.circle.fill")
                                        .font(.title3)
                                    Text("Bloquear saldo y ganar interés")
                                        .font(.headline)
                                    Spacer()
                                    Text(verbatim: maxRateLabel)
                                        .font(.caption.weight(.bold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 4)
                                        .background(Color.white.opacity(0.2))
                                        .clipShape(Capsule())
                                }
                                .padding(.horizontal, 20)
                                .padding(.vertical, 16)
                                .foregroundStyle(.white)
                                .background(Theme.spruceSolid)
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .shadow(color: Theme.spruceSolid.opacity(0.28), radius: 10, y: 5)
                            }
                            .buttonStyle(.plain)

                            howItWorksCard

                            blocksSection
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                        .padding(.bottom, 32)
                    }
                    .refreshable {
                        await loadData()
                    }
                }
            }
            .navigationTitle("Bolsillo de Ahorro")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                await loadData()
            }
            .sheet(isPresented: $showNewBlockSheet) {
                if let config {
                    NewSavingsBlockSheet(config: config) {
                        Task { await loadData() }
                    }
                }
            }
            .sheet(item: $selectedCertificateBlock) { block in
                SavingsCertificateSheet(block: block)
            }
        }
    }

    // MARK: - Componentes

    private var summaryHeader: some View {
        VStack(spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Capital bloqueado en ahorro")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    let total = userSavings?.summary.totalPrincipal ?? Money.zero(.cop)
                    Text(verbatim: total.formatted())
                        .font(.system(.title, design: .rounded).weight(.bold))
                        .monospacedDigit()
                    Text("Disponible en billetera: \(store.copMainAvailable.formatted())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(Theme.spruce)
            }

            Divider()

            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Interés en curso")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    let activeYield = userSavings?.summary.totalExpectedYield ?? Money.zero(.cop)
                    Text(verbatim: "+\(activeYield.formatted())")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.positive)
                        .monospacedDigit()
                }

                Spacer()

                VStack(alignment: .center, spacing: 2) {
                    Text("Ya acreditados")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    let earned = userSavings?.summary.totalYieldEarned ?? Money.zero(.cop)
                    Text(verbatim: earned.formatted())
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Activos")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(verbatim: "\(userSavings?.summary.activeCount ?? 0)")
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                }
            }
        }
        .padding(20)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }

    private var howItWorksCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "clock.badge.checkmark.fill")
                .font(.title3)
                .foregroundStyle(Theme.spruce)
            VStack(alignment: .leading, spacing: 4) {
                Text("Plazos fijos 30 · 60 · 90 · 180 · 360 días")
                    .font(.subheadline.weight(.semibold))
                Text("Elige el plazo, bloquea tu saldo con tasa garantizada y recibe automáticamente tu capital + intereses en tu cuenta a la fecha y hora exacta de vencimiento.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }

    private var blocksSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Tus Bolsillos de Ahorro")
                    .font(.headline)
                Spacer()
                if let count = userSavings?.blocks.count, count > 0 {
                    Text("Toca para ver certificado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if let blocks = userSavings?.blocks, !blocks.isEmpty {
                ForEach(blocks) { block in
                    Button {
                        selectedCertificateBlock = block
                    } label: {
                        SavingsBlockCard(block: block)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                ContentUnavailableView(
                    "Sin bolsillos de ahorro activos",
                    systemImage: "lock.rotation",
                    description: Text("Deposita y bloquea parte de tu saldo COP por 30, 60, 90, 180 o 360 días para ganar intereses garantizados sin cobro de 4x1000.")
                )
                .padding(.vertical, 20)
            }
        }
    }

    private func loadData() async {
        errorMessage = nil
        do {
            async let configTask = app.api.savingsConfig()
            async let userSavingsTask = app.api.userSavings()
            let (cfg, savings) = try await (configTask, userSavingsTask)
            self.config = cfg
            self.userSavings = savings
            store.savingsConfig = cfg
            store.userSavings = savings
            store.savingsLoaded = true
            self.isLoading = false
        } catch {
            self.errorMessage = error.userMessage
            self.isLoading = false
        }
    }
}

// MARK: - Tarjeta de Bolsillo Individual

private struct SavingsBlockCard: View {
    let block: SavingsBlock

    private var statusColor: Color {
        switch block.status {
        case .active: Theme.spruce
        case .maturingSoon: Theme.warning
        case .completed: Theme.positive
        case .cancelled, .unknown: .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text("\(block.termDays) días")
                            .font(.headline)
                        Text(verbatim: "\(String(format: "%.1f", block.lockedRate))% E.A.")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.spruce)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Theme.spruce.opacity(0.12))
                            .clipShape(Capsule())
                        Text(verbatim: block.status.title)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(statusColor)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(statusColor.opacity(0.14))
                            .clipShape(Capsule())
                    }
                    Text("Constituido: \(block.startedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if block.isEscrowReserved && block.status != .completed {
                        Label("Reserva de pago 72h bloqueada y lista", systemImage: "checkmark.seal.fill")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.positive)
                    }
                }

                Spacer()

                if block.status == .completed {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(Theme.positive)
                } else {
                    ZStack {
                        Circle()
                            .stroke(Color.secondary.opacity(0.2), lineWidth: 4)
                            .frame(width: 44, height: 44)
                        Circle()
                            .trim(from: 0, to: CGFloat(block.progress))
                            .stroke(Theme.spruce, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .frame(width: 44, height: 44)
                        Text(verbatim: "\(block.daysRemaining)d")
                            .font(.system(size: 11, weight: .bold))
                    }
                }
            }

            Divider()

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Capital bloqueado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: block.principal.formatted())
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Interés garantizado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: "+\(block.expectedYield.formatted())")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Theme.positive)
                        .monospacedDigit()
                }
            }

            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                    Text("Reintegro: \(block.maturesAt.formatted(date: .abbreviated, time: .shortened))")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                Spacer()

                HStack(spacing: 4) {
                    Text(verbatim: block.totalPayout.formatted())
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.primary)
                        .monospacedDigit()
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }
}

// MARK: - Hoja de Constitución de Bolsillo de Ahorro

private struct NewSavingsBlockSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let config: SavingsConfig
    let onCreated: () -> Void

    @State private var selectedTermDays: Int = 30
    @State private var inputAmountText = ""
    @State private var acceptedContract = false
    @State private var showContractModal = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @FocusState private var isAmountFocused: Bool

    private var availableMoney: Money {
        store.wallet(for: .cop)?.available ?? Money.zero(.cop)
    }

    private var currentTier: SavingsRateTier? {
        config.rates.first { $0.termDays == selectedTermDays && $0.enabled }
            ?? config.rates.first(where: \.enabled)
    }

    private var amountMinor: Int64 {
        let clean = inputAmountText.filter { "0123456789".contains($0) }
        guard let num = Int64(clean), num > 0 else { return 0 }
        let capped = min(num, 9_000_000_000)
        return capped * 100
    }

    private var minMinor: Int64 {
        Int64(config.minAmountMinor) ?? 10_000_00
    }

    private var maxMinor: Int64 {
        Int64(config.maxAmountMinor) ?? 100_000_000_00
    }

    private var calculatedYieldMinor: Int64 {
        guard let rate = currentTier?.ratePercent, amountMinor > 0 else { return 0 }
        let yieldDouble = (Double(amountMinor) * (rate / 100.0) * (Double(selectedTermDays) / 365.0)).rounded()
        return max(1, Int64(yieldDouble))
    }

    private var totalPayoutMinor: Int64 {
        amountMinor + calculatedYieldMinor
    }

    private var validationHint: String? {
        guard amountMinor > 0 else { return nil }
        if amountMinor < minMinor {
            return "El monto mínimo para abrir tu Bolsillo de Ahorro es \(config.minAmount.formatted())."
        }
        if amountMinor > maxMinor {
            return "El monto máximo permitido por bolsillo es \(config.maxAmount.formatted())."
        }
        if amountMinor > availableMoney.minorUnits {
            return "Supera tu saldo disponible actual (\(availableMoney.formatted()))."
        }
        return nil
    }

    private var canSubmit: Bool {
        currentTier != nil &&
            amountMinor >= minMinor &&
            amountMinor <= maxMinor &&
            amountMinor <= availableMoney.minorUnits &&
            acceptedContract &&
            !isSubmitting
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }

                        // Selector de plazo 30 / 60 / 90 / 180 / 360 días
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Elige el plazo de bloqueo")
                                .font(.headline)

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(config.rates.filter(\.enabled)) { tier in
                                        let isSelected = tier.termDays == selectedTermDays
                                        Button {
                                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                                selectedTermDays = tier.termDays
                                            }
                                        } label: {
                                            VStack(spacing: 4) {
                                                Text("\(tier.termDays) días")
                                                    .font(.subheadline.weight(isSelected ? .bold : .medium))
                                                Text(verbatim: "\(String(format: "%.1f", tier.ratePercent))% E.A.")
                                                    .font(.caption2.weight(.semibold))
                                                    .foregroundStyle(isSelected ? .white : Theme.spruce)
                                            }
                                            .padding(.horizontal, 16)
                                            .padding(.vertical, 12)
                                            .background(isSelected ? Theme.spruceSolid : Color.secondary.opacity(0.1))
                                            .foregroundStyle(isSelected ? .white : .primary)
                                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                                    .stroke(isSelected ? Color.clear : Color.secondary.opacity(0.2), lineWidth: 1)
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .padding(.horizontal, 2)
                            }
                        }

                        // Monto a bloquear
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Monto a depositar y bloquear")
                                .font(.headline)

                            HStack {
                                Text(verbatim: "$")
                                    .font(.title2.weight(.bold))
                                    .foregroundStyle(.secondary)
                                TextField("100.000", text: $inputAmountText)
                                    .font(.system(.title2, design: .rounded).weight(.bold))
                                    .keyboardType(.numberPad)
                                    .focused($isAmountFocused)
                                Text(verbatim: "COP")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(16)
                            .glassEffect(.regular, in: .rect(cornerRadius: 16))

                            HStack {
                                Text("Disponible: \(availableMoney.formatted())")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                Spacer()

                                Button("Usar todo") {
                                    let major = max(0, availableMoney.minorUnits / 100)
                                    inputAmountText = major > 0 ? String(major) : ""
                                }
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Theme.spruce)
                            }

                            if let validationHint {
                                Label(validationHint, systemImage: "info.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(Theme.warning)
                            }

                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach([50_000, 100_000, 500_000, 1_000_000], id: \.self) { val in
                                        Button("$\(val.formatted())") {
                                            inputAmountText = String(val)
                                        }
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .background(Color.secondary.opacity(0.12))
                                        .clipShape(Capsule())
                                        .foregroundStyle(.primary)
                                    }
                                }
                            }
                        }

                        // Simulación transparente
                        VStack(spacing: 12) {
                            HStack {
                                Text("Tasa fija garantizada")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(verbatim: "\(String(format: "%.2f", currentTier?.ratePercent ?? 0))% E.A.")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(Theme.spruce)
                            }
                            HStack {
                                Text("Intereses a ganar (\(selectedTermDays) días)")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                let yieldMoney = Money(minorUnits: calculatedYieldMinor, currency: .cop)
                                Text(verbatim: "+\(yieldMoney.formatted())")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.positive)
                                    .monospacedDigit()
                            }
                            HStack {
                                Text("Cobro 4x1000 / administración")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(verbatim: "$ 0 COP")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.positive)
                            }
                            HStack {
                                Text("Reintegro automático exacto")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                let matures = Date().addingTimeInterval(Double(selectedTermDays) * 24 * 3600)
                                Text(matures.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption.weight(.semibold))
                            }
                            Divider()
                            HStack {
                                Text("Total a recibir al vencimiento")
                                    .font(.headline)
                                Spacer()
                                let totalMoney = Money(minorUnits: totalPayoutMinor, currency: .cop)
                                Text(verbatim: totalMoney.formatted())
                                    .font(.headline.weight(.bold))
                                    .monospacedDigit()
                            }
                        }
                        .padding(18)
                        .glassEffect(.regular, in: .rect(cornerRadius: 18))

                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "checkmark.shield.fill")
                                .foregroundStyle(Theme.spruce)
                            Text("El saldo se debita al instante de tu billetera principal y queda bloqueado durante \(selectedTermDays) días con tasa congelada. Cumplida la fecha y hora exacta, el capital más los intereses regresan automáticamente a tu cuenta.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        // Aceptación de contrato virtual
                        HStack(alignment: .top, spacing: 12) {
                            Button {
                                acceptedContract.toggle()
                            } label: {
                                Image(systemName: acceptedContract ? "checkmark.square.fill" : "square")
                                    .font(.title3)
                                    .foregroundStyle(acceptedContract ? Theme.spruce : .secondary)
                            }
                            .buttonStyle(.plain)

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Acepto bloquear este saldo por \(selectedTermDays) días según el")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Button("Contrato de Bolsillo de Ahorro a Término") {
                                    showContractModal = true
                                }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.spruce)
                            }
                        }
                    }
                    .padding(20)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Nuevo Bolsillo de Ahorro")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Listo") { isAmountFocused = false }
                        .fontWeight(.semibold)
                }
            }
            .onAppear {
                if !config.rates.contains(where: { $0.termDays == selectedTermDays && $0.enabled }),
                   let first = config.rates.first(where: \.enabled) {
                    selectedTermDays = first.termDays
                }
            }
            .safeAreaInset(edge: .bottom) {
                PrimaryButton(
                    title: "Bloquear saldo con Face ID",
                    systemImage: "faceid",
                    isLoading: isSubmitting,
                    isEnabled: canSubmit
                ) {
                    isAmountFocused = false
                    Task { await createBlock() }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 8)
            }
            .sheet(isPresented: $showContractModal) {
                ContractModalView(contractTerms: config.contractTerms)
            }
        }
    }

    private func createBlock() async {
        isSubmitting = true
        errorMessage = nil
        do {
            _ = try await app.api.createSavingsBlock(termDays: selectedTermDays, amountMinor: amountMinor)
            await store.refreshAfterMovement()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCreated()
            dismiss()
        } catch {
            errorMessage = error.userMessage
            isSubmitting = false
        }
    }
}

// MARK: - Hoja de Certificado y Contrato de Bolsillo de Ahorro

struct SavingsCertificateSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let block: SavingsBlock

    @State private var certificate: SavingsCertificate?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }

                        GlassCard {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    StatusBadge(
                                        text: LocalizedStringKey(block.status.title),
                                        color: block.status == .completed ? Theme.positive : Theme.spruce,
                                        systemImage: "lock.shield.fill"
                                    )
                                    Spacer()
                                    Text(verbatim: block.id)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                }

                                Text("Certificado de Bolsillo de Ahorro")
                                    .font(.title3.weight(.bold))
                                Text("XATECH SERVICES S.A.S. · NIT 901.799.579")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                Divider()

                                if let cert = certificate {
                                    DetailRow(title: "Titular", value: cert.holderName, systemImage: "person.fill")
                                    DetailRow(title: "Celular registrado", value: cert.holderPhone, systemImage: "phone.fill")
                                }
                                DetailRow(title: "Plazo pactado", value: "\(block.termDays) días", systemImage: "calendar")
                                DetailRow(title: "Tasa garantizada", value: "\(String(format: "%.2f", block.lockedRate))% E.A.", systemImage: "percent")
                                DetailRow(title: "Capital bloqueado", value: block.principal.formatted(), systemImage: "lock.fill")
                                DetailRow(title: "Interés garantizado", value: "+\(block.expectedYield.formatted())", systemImage: "chart.line.uptrend.xyaxis")
                                DetailRow(title: "Total a reintegrar", value: block.totalPayout.formatted(), systemImage: "banknote.fill", emphasized: true)
                                DetailRow(
                                    title: "Fecha de inicio",
                                    value: block.startedAt.formatted(date: .abbreviated, time: .shortened),
                                    systemImage: "play.circle"
                                )
                                DetailRow(
                                    title: "Hora exacta de reintegro",
                                    value: block.maturesAt.formatted(date: .abbreviated, time: .shortened),
                                    systemImage: "clock.badge.checkmark"
                                )
                            }
                        }

                        if isLoading {
                            HStack {
                                Spacer()
                                ProgressView()
                                Spacer()
                            }
                        } else if let cert = certificate {
                            GlassCard {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("Términos aceptados electrónicamente")
                                        .font(.subheadline.weight(.bold))
                                    Text("Aceptado el \(cert.contractAcceptedAt.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                    Divider()
                                    Text(verbatim: cert.contractTerms)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineSpacing(3)
                                }
                            }
                        }

                        Button {
                            VoucherSharePresenter.shareSavingsCertificate(
                                block: block,
                                holderName: certificate?.holderName ?? app.user?.fullName
                            )
                        } label: {
                            Label("Compartir certificado", systemImage: "square.and.arrow.up")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.capsule)
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Certificado de Ahorro")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                do {
                    certificate = try await app.api.savingsCertificate(id: block.id)
                } catch {
                    errorMessage = error.userMessage
                }
                isLoading = false
            }
        }
    }
}

// MARK: - Modal de Términos del Contrato Virtual

private struct ContractModalView: View {
    @Environment(\.dismiss) private var dismiss
    let contractTerms: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Contrato de Bolsillo de Ahorro a Término Fijo")
                        .font(.title3.weight(.bold))
                    Text("Operado por XATECH SERVICES S.A.S. — NIT 901.799.579")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Divider()

                    Text(verbatim: contractTerms)
                        .font(.footnote)
                        .lineSpacing(4)
                }
                .padding(20)
            }
            .navigationTitle("Términos Legales")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Entendido") { dismiss() }
                }
            }
        }
    }
}
