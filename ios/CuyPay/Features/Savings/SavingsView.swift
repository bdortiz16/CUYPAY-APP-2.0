import SwiftUI

/// Vista principal de Bloques de Ahorro (Inversión a Plazo Fijo con Rendimiento Garantizado).
struct SavingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var config: SavingsConfig?
    @State private var userSavings: UserSavingsResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showNewBlockSheet = false

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                if isLoading && userSavings == nil {
                    ProgressView("Cargando tus bloques de ahorro…")
                        .controlSize(.large)
                } else {
                    ScrollView {
                        VStack(spacing: 20) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            // Resumen patrimonial del Bloque de Ahorro
                            summaryHeader

                            // Botón de acción para crear nuevo bloque
                            Button {
                                showNewBlockSheet = true
                            } label: {
                                HStack {
                                    Image(systemName: "plus.circle.fill")
                                        .font(.title3)
                                    Text("Constituir Nuevo Bloque")
                                        .font(.headline)
                                    Spacer()
                                    Text("Hasta 12% E.A.")
                                        .font(.caption.weight(.bold))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 4)
                                        .background(Color.white.opacity(0.2))
                                        .clipShape(Capsule())
                                }
                                .padding(.horizontal, 20)
                                .padding(.vertical, 16)
                                .foregroundStyle(.white)
                                .background(Theme.spruce)
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .shadow(color: Theme.spruce.opacity(0.3), radius: 10, y: 5)
                            }
                            .buttonStyle(.plain)

                            // Lista de bloques
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
            .navigationTitle("Bloque de Ahorro")
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
        }
    }

    // MARK: - Componentes

    private var summaryHeader: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Total en Bloques de Ahorro")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    let total = userSavings?.summary.totalPrincipal ?? Money.zero(.cop)
                    Text(total.formatted())
                        .font(.system(.title, design: .rounded).weight(.bold))
                }
                Spacer()
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 38))
                    .foregroundStyle(Theme.spruce)
            }

            Divider()

            HStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Intereses generados")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    let yield = userSavings?.summary.totalYieldEarned ?? Money.zero(.cop)
                    Text(yield.formatted())
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.spruce)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Bloques activos")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(userSavings?.summary.activeCount ?? 0)")
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
        .padding(20)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }

    private var blocksSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Tus Bloques")
                .font(.headline)

            if let blocks = userSavings?.blocks, !blocks.isEmpty {
                ForEach(blocks) { block in
                    SavingsBlockCard(block: block)
                }
            } else {
                ContentUnavailableView(
                    "Sin bloques activos",
                    systemImage: "lock.rotation",
                    description: Text("Inmoviliza parte de tu saldo COP a 30, 60, 90, 180 o 360 días para generar rendimientos fijos garantizados.")
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
            self.isLoading = false
        } catch {
            self.errorMessage = error.userMessage
            self.isLoading = false
        }
    }
}

// MARK: - Tarjeta de Bloque Individual

private struct SavingsBlockCard: View {
    let block: SavingsBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("\(block.termDays) días")
                            .font(.headline)
                        Text("\(String(format: "%.1f", block.lockedRate))% E.A.")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.spruce)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Theme.spruce.opacity(0.12))
                            .clipShape(Capsule())
                    }
                    Text("Iniciado el \(block.startedAt.formatted(date: .abbreviated, time: .omitted))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                // Anillo de progreso de maduración
                ZStack {
                    Circle()
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 4)
                        .frame(width: 44, height: 44)
                    Circle()
                        .trim(from: 0, to: CGFloat(block.progress))
                        .stroke(Theme.spruce, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 44, height: 44)
                    Text("\(block.daysRemaining)d")
                        .font(.system(size: 11, weight: .bold))
                }
            }

            Divider()

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Capital bloqueado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(block.principal.formatted())
                        .font(.subheadline.weight(.semibold))
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Rendimiento al vencer")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text("+\(block.expectedYield.formatted())")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Theme.spruce)
                }
            }

            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "calendar")
                    Text("Vence: \(block.maturesAt.formatted(date: .abbreviated, time: .omitted))")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                Spacer()

                Text("Total a recibir: \(block.totalPayout.formatted())")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }
}

// MARK: - Hoja de Nuevo Bloque

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

    private var availableMoney: Money {
        store.wallet(for: .cop)?.available ?? Money.zero(.cop)
    }

    private var currentTier: SavingsRateTier? {
        config.rates.first { $0.termDays == selectedTermDays }
    }

    private var amountMinor: Int64 {
        let clean = inputAmountText.filter { "0123456789".contains($0) }
        guard let num = Int64(clean) else { return 0 }
        return num * 100 // Convertir a minor units COP
    }

    private var calculatedYieldMinor: Int64 {
        guard let rate = currentTier?.ratePercent, amountMinor > 0 else { return 0 }
        let yieldDouble = Double(amountMinor) * (rate / 100.0) * (Double(selectedTermDays) / 365.0)
        return Int64(max(0, yieldDouble))
    }

    private var totalPayoutMinor: Int64 {
        amountMinor + calculatedYieldMinor
    }

    private var canSubmit: Bool {
        amountMinor >= (Int64(config.minAmountMinor) ?? 10_000_00) &&
        amountMinor <= (Int64(config.maxAmountMinor) ?? 100_000_000_00) &&
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

                        // Selector de plazo
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Selecciona el plazo")
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
                                                Text("\(String(format: "%.1f", tier.ratePercent))% E.A.")
                                                    .font(.caption2.weight(.semibold))
                                                    .foregroundStyle(isSelected ? .white : Theme.spruce)
                                            }
                                            .padding(.horizontal, 16)
                                            .padding(.vertical, 12)
                                            .background(isSelected ? Theme.spruce : Color.white.opacity(0.08))
                                            .foregroundStyle(isSelected ? .white : .primary)
                                            .clipShape(RoundedRectangle(cornerRadius: 14))
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 14)
                                                    .stroke(isSelected ? Color.clear : Color.secondary.opacity(0.2), lineWidth: 1)
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .padding(.horizontal, 2)
                            }
                        }

                        // Monto a inmovilizar
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Monto a bloquear")
                                .font(.headline)

                            HStack {
                                Text("$")
                                    .font(.title2.weight(.bold))
                                    .foregroundStyle(.secondary)
                                TextField("100.000", text: $inputAmountText)
                                    .font(.system(.title2, design: .rounded).weight(.bold))
                                    .keyboardType(.numberPad)
                                Text("COP")
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

                                Button("Todo") {
                                    let major = availableMoney.minorUnits / 100
                                    inputAmountText = String(major)
                                }
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Theme.spruce)
                            }

                            // Botones rápidos
                            HStack(spacing: 8) {
                                ForEach([50_000, 200_000, 500_000, 1_000_000], id: \.self) { val in
                                    Button("$\(val.formatted())") {
                                        inputAmountText = String(val)
                                    }
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Color.secondary.opacity(0.12))
                                    .clipShape(Capsule())
                                    .foregroundStyle(.primary)
                                }
                            }
                        }

                        // Tarjeta de simulación y rendimiento
                        VStack(spacing: 12) {
                            HStack {
                                Text("Tasa acordada (fija)")
                                Spacer()
                                Text("\(String(format: "%.1f", currentTier?.ratePercent ?? 0))% E.A.")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(Theme.spruce)
                            }
                            HStack {
                                Text("Rendimiento estimado")
                                Spacer()
                                let yieldMoney = Money(minorUnits: calculatedYieldMinor, currency: .cop)
                                Text("+\(yieldMoney.formatted())")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.spruce)
                            }
                            HStack {
                                Text("Fecha de liquidación")
                                Spacer()
                                let matures = Date().addingTimeInterval(Double(selectedTermDays) * 24 * 3600)
                                Text(matures.formatted(date: .abbreviated, time: .omitted))
                                    .font(.subheadline)
                            }
                            Divider()
                            HStack {
                                Text("Total a recibir")
                                    .font(.headline)
                                Spacer()
                                let totalMoney = Money(minorUnits: totalPayoutMinor, currency: .cop)
                                Text(totalMoney.formatted())
                                    .font(.headline.weight(.bold))
                            }
                        }
                        .padding(18)
                        .glassEffect(.regular, in: .rect(cornerRadius: 18))

                        // Regla garantizada
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "checkmark.shield.fill")
                                .foregroundStyle(Theme.spruce)
                            Text("Tu tasa queda congelada al constituir el bloque. Aunque las tasas del mercado cambien mañana, tu rendimiento pactado se mantiene inalterable.")
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
                                Text("He leído y acepto los términos del")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Button("Contrato Virtual de Bloque de Ahorro") {
                                    showContractModal = true
                                }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.spruce)
                            }
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Nuevo Bloque")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancelar") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                PrimaryButton(
                    title: "Autorizar con Face ID",
                    systemImage: "faceid",
                    isLoading: isSubmitting,
                    isEnabled: canSubmit
                ) {
                    Task { await createBlock() }
                }
                .padding(.horizontal, 20)
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
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCreated()
            dismiss()
        } catch {
            errorMessage = error.userMessage
            isSubmitting = false
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
                    Text("Contrato Virtual de Bloque de Ahorro")
                        .font(.title3.weight(.bold))
                    Text("Operado por XATECH SERVICES S.A.S. (NIT 901799579)")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Divider()

                    Text(contractTerms)
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
