import SwiftUI
import UIKit

/// Centro de Créditos CuyPay (30, 60, 90, 180 y 360 días máx.) con Pagaré Electrónico a la Orden y Carta de Instrucciones (Normativa Colombiana).
struct LoansView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var config: LoanConfig?
    @State private var userLoans: UserLoansResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showApplySheet = false
    @State private var selectedLoanForPagare: LoanItem?
    @State private var selectedLoanForPayment: LoanItem?

    private var hasPendingApplication: Bool {
        (userLoans?.summary.pendingCount ?? 0) > 0
    }

    private var hasOverdueLoan: Bool {
        userLoans?.loans.contains(where: { $0.status == .overdue }) == true
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                if isLoading && userLoans == nil {
                    ProgressView("Cargando tus créditos…")
                        .controlSize(.large)
                } else {
                    ScrollView {
                        VStack(spacing: 20) {
                            if let errorMessage {
                                ErrorBanner(message: errorMessage)
                            }

                            portfolioHeader

                            applyActionCard

                            legalTransparencyCard

                            loansListSection
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
            .navigationTitle("Créditos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                await loadData()
            }
            .sheet(isPresented: $showApplySheet) {
                if let config {
                    ApplyLoanSheet(config: config) {
                        Task { await loadData() }
                    }
                }
            }
            .sheet(item: $selectedLoanForPagare) { loan in
                PromissoryNoteViewerSheet(loan: loan)
            }
            .sheet(item: $selectedLoanForPayment) { loan in
                PayLoanSheet(loan: loan) {
                    Task { await loadData() }
                }
            }
        }
    }

    // MARK: - Secciones

    private var portfolioHeader: some View {
        VStack(spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Saldo por pagar en créditos")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    let activeDebt = userLoans?.summary.activeRemaining ?? Money.zero(.cop)
                    Text(verbatim: activeDebt.formatted())
                        .font(.system(.title, design: .rounded).weight(.bold))
                        .monospacedDigit()
                    if let cfg = config {
                        Text("Cupos desde \(cfg.minAmount.formatted()) hasta \(cfg.maxAmount.formatted())")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Image(systemName: "banknote.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(Theme.spruce)
            }

            Divider()

            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Créditos activos")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(verbatim: "\(userLoans?.summary.activeCount ?? 0)")
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                }

                Spacer()

                VStack(alignment: .center, spacing: 2) {
                    Text("En estudio")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(verbatim: "\(userLoans?.summary.pendingCount ?? 0)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(hasPendingApplication ? Theme.warning : .primary)
                        .monospacedDigit()
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Plazo máximo")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("360 días")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.spruce)
                }
            }
        }
        .padding(20)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }

    @ViewBuilder
    private var applyActionCard: some View {
        if config?.enabled == false {
            GlassCard {
                Label("Las nuevas solicitudes de crédito están temporalmente cerradas.", systemImage: "pause.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else if hasOverdueLoan {
            GlassCard(tint: Theme.negative.opacity(0.1)) {
                Label("Tienes un crédito vencido pendiente de pago. Ponlo al día para solicitar uno nuevo.", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.negative)
            }
        } else if hasPendingApplication {
            GlassCard(tint: Theme.warning.opacity(0.1)) {
                HStack(spacing: 12) {
                    Image(systemName: "clock.badge.exclamationmark.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.warning)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Solicitud en estudio")
                            .font(.subheadline.weight(.semibold))
                        Text("Nuestro equipo está revisando tu solicitud y Pagaré firmado. Apenas sea aprobada, el dinero se acreditará automáticamente en tu billetera.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } else {
            Button {
                if config != nil {
                    showApplySheet = true
                } else {
                    Task {
                        await loadData()
                        if config != nil { showApplySheet = true }
                    }
                }
            } label: {
                HStack {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Solicitar Crédito CuyPay")
                            .font(.headline)
                        Text("30 · 60 · 90 · 180 · 360 días · Desembolso a tu billetera")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.subheadline.weight(.bold))
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .foregroundStyle(.white)
                .background(Theme.spruceSolid)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: Theme.spruceSolid.opacity(0.28), radius: 10, y: 5)
            }
            .buttonStyle(.plain)
        }
    }

    private var legalTransparencyCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "signature")
                .font(.title3)
                .foregroundStyle(Theme.spruce)
            VStack(alignment: .leading, spacing: 4) {
                Text("Crédito transparente con Pagaré Electrónico")
                    .font(.subheadline.weight(.semibold))
                Text("Sin cobro de estudio, sin seguros obligatorios, sin 4x1000 y con derecho legal a pago anticipado total o parcial sin penalidad (Ley 1480 de 2011 · Ley 527 de 1999).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }

    private var loansListSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Mis Créditos y Pagarés")
                .font(.headline)

            if let loans = userLoans?.loans, !loans.isEmpty {
                ForEach(loans) { loan in
                    LoanCardView(
                        loan: loan,
                        onOpenPagare: { selectedLoanForPagare = loan },
                        onPay: { selectedLoanForPayment = loan }
                    )
                }
            } else {
                ContentUnavailableView(
                    "Aún no tienes créditos",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text("Simula cuánto necesitas y elige entre 30, 60, 90, 180 o 360 días. Al aprobarse tu solicitud, recibes el desembolso directo en tu saldo COP.")
                )
                .padding(.vertical, 20)
            }
        }
    }

    private func loadData() async {
        errorMessage = nil
        do {
            async let cfgTask = app.api.loansConfig()
            async let loansTask = app.api.userLoans()
            let (cfg, list) = try await (cfgTask, loansTask)
            self.config = cfg
            self.userLoans = list
            self.isLoading = false
        } catch {
            self.errorMessage = error.userMessage
            self.isLoading = false
        }
    }
}

// MARK: - Tarjeta de Crédito Individual

private struct LoanCardView: View {
    let loan: LoanItem
    let onOpenPagare: () -> Void
    let onPay: () -> Void

    private var badgeColor: Color {
        switch loan.status {
        case .approvedActive: Theme.spruce
        case .pendingReview: Theme.warning
        case .paid: Theme.positive
        case .overdue, .rejected: Theme.negative
        case .cancelled, .unknown: .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(verbatim: loan.principal.formatted())
                            .font(.headline.weight(.bold))
                            .monospacedDigit()
                        Text("\(loan.termDays) días")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Color.secondary.opacity(0.14))
                            .clipShape(Capsule())
                    }
                    Text(verbatim: "Pagaré \(loan.promissoryNoteNumber) · \(String(format: "%.2f", loan.interestRateEa))% E.A.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusBadge(
                    text: LocalizedStringKey(loan.status.title),
                    color: badgeColor
                )
            }

            if loan.status == .approvedActive || loan.status == .overdue || loan.status == .paid {
                ProgressView(value: loan.paymentProgress)
                    .tint(loan.status == .paid ? Theme.positive : Theme.spruce)
            }

            Divider()

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Total pactado")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: loan.totalDue.formatted())
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(loan.status == .paid ? "Pagado" : "Saldo pendiente")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: loan.status == .paid ? loan.paid.formatted() : loan.remaining.formatted())
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(loan.status == .paid ? Theme.positive : (loan.status == .overdue ? Theme.negative : .primary))
                        .monospacedDigit()
                }
            }

            if let dueAt = loan.dueAt, loan.status == .approvedActive || loan.status == .overdue {
                HStack(spacing: 6) {
                    Image(systemName: "calendar.badge.clock")
                    Text("Vencimiento: \(dueAt.formatted(date: .abbreviated, time: .shortened))")
                    if let days = loan.daysRemaining {
                        Spacer()
                        Text("\(days) días restantes")
                            .fontWeight(.semibold)
                    }
                }
                .font(.caption2)
                .foregroundStyle(loan.status == .overdue ? Theme.negative : .secondary)
            } else if let rejectedReason = loan.rejectedReason, loan.status == .rejected {
                Text("Motivo: \(rejectedReason)")
                    .font(.caption)
                    .foregroundStyle(Theme.negative)
            }

            HStack(spacing: 10) {
                Button(action: onOpenPagare) {
                    Label(
                        loan.status == .paid ? "Pagaré · Paz y Salvo" : "Ver Pagaré",
                        systemImage: "doc.badge.gearshape"
                    )
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)

                if loan.status == .approvedActive || loan.status == .overdue {
                    Button(action: onPay) {
                        Label("Pagar / Abonar", systemImage: "arrow.up.right.circle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Theme.spruceSolid)
                    .buttonBorderShape(.capsule)
                }
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }
}

// MARK: - Flujo de Solicitud + Firma de Pagaré Electrónico

private struct ApplyLoanSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let config: LoanConfig
    let onSubmitted: () -> Void

    enum Step {
        case simulate
        case reviewAndSign(LoanPreviewResponse)
    }

    @State private var step: Step = .simulate
    @State private var selectedTermDays: Int = 30
    @State private var inputAmountText = ""
    @State private var purposeText = ""
    @State private var docType = "CC"
    @State private var docNumber = ""
    @State private var cityText = "Bogotá D.C."
    @State private var needsManualDoc = false

    @State private var acceptedPagare = false
    @State private var acceptedInstructionLetter = false
    @State private var acceptedCreditBureauAuth = false
    @State private var showFullContractSheet = false

    @State private var isLoadingPreview = false
    @State private var isSigning = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Bool

    private var currentTier: LoanRateTier? {
        config.rates.first(where: { $0.termDays == selectedTermDays && $0.enabled })
            ?? config.rates.first(where: \.enabled)
    }

    private var amountMinor: Int64 {
        let clean = inputAmountText.filter { "0123456789".contains($0) }
        guard let major = Int64(clean), major > 0 else { return 0 }
        return min(major, 9_000_000_000) * 100
    }

    private var minMinor: Int64 { Int64(config.minAmountMinor) ?? 100_000_00 }
    private var maxMinor: Int64 { Int64(config.maxAmountMinor) ?? 10_000_000_00 }

    private var estimatedInterestMinor: Int64 {
        guard let rate = currentTier?.rateEaPercent, amountMinor > 0 else { return 0 }
        let factor = pow(1.0 + rate / 100.0, Double(selectedTermDays) / 365.0) - 1.0
        return max(1, Int64((Double(amountMinor) * factor).rounded()))
    }

    private var validationHint: String? {
        guard amountMinor > 0 else { return nil }
        if amountMinor < minMinor {
            return "El monto mínimo de solicitud es \(config.minAmount.formatted())."
        }
        if amountMinor > maxMinor {
            return "El monto máximo permitido es \(config.maxAmount.formatted())."
        }
        return nil
    }

    private var canPreview: Bool {
        currentTier != nil && amountMinor >= minMinor && amountMinor <= maxMinor && !isLoadingPreview
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                switch step {
                case .simulate:
                    simulatorBody
                case .reviewAndSign(let preview):
                    reviewSignBody(preview)
                }
            }
            .navigationTitle(
                {
                    if case .reviewAndSign = step { return "Firmar Pagaré Electrónico" }
                    return "Solicitar Crédito"
                }()
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if case .reviewAndSign = step {
                        Button("Atrás") {
                            errorMessage = nil
                            step = .simulate
                        }
                    } else {
                        Button("Cancelar") { dismiss() }
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Listo") { focusedField = false }
                        .fontWeight(.semibold)
                }
            }
            .onAppear {
                if !config.rates.contains(where: { $0.termDays == selectedTermDays && $0.enabled }),
                   let first = config.rates.first(where: \.enabled) {
                    selectedTermDays = first.termDays
                }
            }
        }
    }

    // MARK: Paso 1: Simulador Precontractual

    private var simulatorBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }

                // Monto solicitado
                VStack(alignment: .leading, spacing: 10) {
                    Text("¿Cuánto dinero necesitas?")
                        .font(.headline)

                    HStack {
                        Text(verbatim: "$")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(.secondary)
                        TextField("500.000", text: $inputAmountText)
                            .font(.system(.title2, design: .rounded).weight(.bold))
                            .keyboardType(.numberPad)
                            .focused($focusedField)
                        Text(verbatim: "COP")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(16)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))

                    if let validationHint {
                        Label(validationHint, systemImage: "info.circle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach([200_000, 500_000, 1_000_000, 2_000_000, 5_000_000], id: \.self) { val in
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

                // Selector de plazo (30 / 60 / 90 / 180 / 360 días máx.)
                VStack(alignment: .leading, spacing: 10) {
                    Text("¿Por cuánto tiempo? (máximo 360 días)")
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
                                        Text(verbatim: "\(String(format: "%.1f", tier.rateEaPercent))% E.A.")
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
                    }
                }

                // Datos complementarios opcionales / requeridos si Sumsub no retornó cédula
                VStack(alignment: .leading, spacing: 10) {
                    Text("Destino y ciudad de otorgamiento")
                        .font(.subheadline.weight(.semibold))

                    TextField("Destino del crédito (ej. Capital de trabajo, Educación…)", text: $purposeText)
                        .font(.subheadline)
                        .focused($focusedField)
                        .padding(14)
                        .glassEffect(.regular, in: .rect(cornerRadius: 14))

                    TextField("Ciudad de domicilio (ej. Bogotá D.C.)", text: $cityText)
                        .font(.subheadline)
                        .focused($focusedField)
                        .padding(14)
                        .glassEffect(.regular, in: .rect(cornerRadius: 14))

                    if needsManualDoc {
                        HStack(spacing: 10) {
                            Picker("Tipo", selection: $docType) {
                                Text("CC").tag("CC")
                                Text("CE").tag("CE")
                                Text("PPT").tag("PPT")
                            }
                            .pickerStyle(.menu)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .glassEffect(.regular, in: .rect(cornerRadius: 12))

                            TextField("Número de documento", text: $docNumber)
                                .keyboardType(.asciiCapableNumberPad)
                                .focused($focusedField)
                                .padding(14)
                                .glassEffect(.regular, in: .rect(cornerRadius: 14))
                        }
                    }
                }

                // Resumen precontractual Ley 1480 de 2011 Art. 45
                VStack(spacing: 10) {
                    HStack {
                        Text("Resumen legal precontractual")
                            .font(.subheadline.weight(.bold))
                        Spacer()
                        Text("Ley 1480 · Art. 45")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Theme.spruce)
                    }
                    Divider()
                    DetailRow(
                        title: "Capital a desembolsar",
                        value: Money(minorUnits: amountMinor, currency: .cop).formatted()
                    )
                    DetailRow(
                        title: "Tasa efectiva anual",
                        value: "\(String(format: "%.2f", currentTier?.rateEaPercent ?? 0))% E.A."
                    )
                    DetailRow(
                        title: "Intereses remuneratorios (\(selectedTermDays)d)",
                        value: Money(minorUnits: estimatedInterestMinor, currency: .cop).formatted()
                    )
                    DetailRow(title: "Estudio, seguros y 4x1000", value: "$ 0 COP")
                    Divider()
                    DetailRow(
                        title: "Total estimado a pagar",
                        value: Money(minorUnits: amountMinor + estimatedInterestMinor, currency: .cop).formatted(),
                        emphasized: true
                    )
                }
                .padding(18)
                .glassEffect(.regular, in: .rect(cornerRadius: 18))
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(
                title: "Continuar y generar Pagaré",
                systemImage: "doc.text.fill",
                isLoading: isLoadingPreview,
                isEnabled: canPreview
            ) {
                focusedField = false
                Task { await loadPreview() }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
        }
    }

    // MARK: Paso 2: Revisión Jurídica + Firma Electrónica Face ID

    private func reviewSignBody(_ preview: LoanPreviewResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            StatusBadge(text: "Título Valor Art. 709 C.Co.", color: Theme.spruce, systemImage: "checkmark.shield.fill")
                            Spacer()
                            Text("\(preview.termDays) días")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.secondary)
                        }
                        DetailRow(title: "Deudor otorgante", value: "\(preview.debtor.fullName) (\(preview.debtor.documentType) \(preview.debtor.documentNumber))")
                        DetailRow(title: "Acreedor beneficiario", value: "\(preview.creditor.legalName) · NIT \(preview.creditor.nit)")
                        DetailRow(title: "Capital solicitado", value: preview.principal.formatted())
                        DetailRow(title: "Tasa remuneratoria", value: "\(String(format: "%.2f", preview.interestRateEa))% E.A. (\(String(format: "%.2f", preview.nominalMonthlyPercent))% N.M.V.)")
                        DetailRow(title: "Intereses del plazo", value: preview.interest.formatted())
                        DetailRow(title: "Total obligación", value: preview.totalDue.formatted(), emphasized: true)
                    }
                }

                // Extracto y botón de lectura completa del Pagaré + Carta de Instrucciones
                GlassCard {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Label("Pagaré a la Orden y Carta de Instrucciones", systemImage: "doc.richtext")
                                .font(.subheadline.weight(.bold))
                            Spacer()
                            Button("Pantalla completa") {
                                showFullContractSheet = true
                            }
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.spruce)
                        }

                        ScrollView {
                            Text(verbatim: preview.documentMarkdown)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(height: 210)
                        .padding(10)
                        .background(Color.secondary.opacity(0.08), in: .rect(cornerRadius: 12))

                        Text(verbatim: "SHA-256: \(preview.documentSha256)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }

                // 3 Aceptaciones expresas exigidas por la normativa colombiana
                VStack(alignment: .leading, spacing: 14) {
                    LegalCheckRow(
                        isChecked: $acceptedPagare,
                        text: "Otorgo y suscribo incondicionalmente el Pagaré Electrónico a la Orden (Arts. 621 y 709 del Código de Comercio y Ley 527 de 1999) a favor de XATECH SERVICES S.A.S."
                    )
                    LegalCheckRow(
                        isChecked: $acceptedInstructionLetter,
                        text: "Autorizo expresamente la Carta de Instrucciones para el diligenciamiento del Pagaré en caso de mora conforme al Artículo 622 del Código de Comercio."
                    )
                    LegalCheckRow(
                        isChecked: $acceptedCreditBureauAuth,
                        text: "Autorizo la consulta y reporte de información crediticia ante centrales de riesgo bajo la Ley 1266 de 2008 y Ley 2157 de 2021 (Habeas Data)."
                    )
                }
                .padding(16)
                .glassEffect(.regular, in: .rect(cornerRadius: 18))
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(
                title: "Firmar Pagaré con Face ID y Solicitar",
                systemImage: "faceid",
                isLoading: isSigning,
                isEnabled: acceptedPagare && acceptedInstructionLetter && acceptedCreditBureauAuth && !isSigning
            ) {
                Task { await submitSignedApplication(preview) }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
        }
        .sheet(isPresented: $showFullContractSheet) {
            FullMarkdownSheet(
                title: "Pagaré y Carta de Instrucciones",
                markdown: preview.documentMarkdown,
                sha256: preview.documentSha256
            )
        }
    }

    private func loadPreview() async {
        isLoadingPreview = true
        errorMessage = nil
        do {
            let req = LoanPreviewRequest(
                principalMinor: String(amountMinor),
                termDays: selectedTermDays,
                purpose: purposeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : purposeText.trimmingCharacters(in: .whitespacesAndNewlines),
                documentType: docNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : docType,
                documentNumber: docNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : docNumber.trimmingCharacters(in: .whitespacesAndNewlines),
                city: cityText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : cityText.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            let p = try await app.api.previewLoan(req)
            acceptedPagare = false
            acceptedInstructionLetter = false
            acceptedCreditBureauAuth = false
            step = .reviewAndSign(p)
        } catch {
            let msg = error.userMessage
            if msg.localizedCaseInsensitiveContains("documento") || msg.localizedCaseInsensitiveContains("cédula") {
                needsManualDoc = true
            }
            errorMessage = msg
        }
        isLoadingPreview = false
    }

    private func submitSignedApplication(_ preview: LoanPreviewResponse) async {
        isSigning = true
        errorMessage = nil
        do {
            let req = LoanApplyRequest(
                principalMinor: preview.principalMinor,
                termDays: preview.termDays,
                purpose: purposeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : purposeText.trimmingCharacters(in: .whitespacesAndNewlines),
                documentType: preview.debtor.documentType,
                documentNumber: preview.debtor.documentNumber,
                city: preview.debtor.city,
                documentSha256: preview.documentSha256,
                acceptedPagare: acceptedPagare,
                acceptedInstructionLetter: acceptedInstructionLetter,
                acceptedCreditBureauAuth: acceptedCreditBureauAuth
            )
            _ = try await app.api.applyLoan(req)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onSubmitted()
            dismiss()
        } catch {
            errorMessage = error.userMessage
            isSigning = false
        }
    }
}

private struct LegalCheckRow: View {
    @Binding var isChecked: Bool
    let text: String

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            isChecked.toggle()
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isChecked ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(isChecked ? Theme.spruce : .secondary)
                Text(verbatim: text)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
            }
        }
        .buttonStyle(.plain)
    }
}

private struct FullMarkdownSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let markdown: String
    let sha256: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(verbatim: markdown)
                        .font(.footnote)
                        .lineSpacing(4)
                    Divider()
                    Text(verbatim: "Huella SHA-256 del documento:\n\(sha256)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cerrar") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Visor del Pagaré Electrónico Firmado / Paz y Salvo

struct PromissoryNoteViewerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let loan: LoanItem
    @State private var note: PromissoryNoteDetail?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                if isLoading {
                    ProgressView("Verificando integridad SHA-256 del Pagaré…")
                } else if let note {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            GlassCard {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        StatusBadge(
                                            text: LocalizedStringKey(note.status.title),
                                            color: note.status == .cancelledPaid ? Theme.positive : Theme.spruce,
                                            systemImage: note.integrityVerified ? "checkmark.seal.fill" : "exclamationmark.shield"
                                        )
                                        Spacer()
                                        Text(verbatim: note.number)
                                            .font(.caption.monospaced().weight(.bold))
                                    }

                                    DetailRow(title: "Deudor", value: "\(note.debtorFullName) (\(note.debtorDocumentType) \(note.debtorDocumentNumber))")
                                    DetailRow(title: "Acreedor", value: "\(note.creditorLegalName) · NIT \(note.creditorNit)")
                                    DetailRow(title: "Capital", value: note.principal.formatted())
                                    DetailRow(title: "Intereses (\(note.termDays)d)", value: note.interest.formatted())
                                    DetailRow(title: "Abonos aplicados", value: note.paid.formatted())
                                    DetailRow(title: "Saldo insoluto actual", value: note.remaining.formatted(), emphasized: true)
                                }
                            }

                            GlassCard {
                                VStack(alignment: .leading, spacing: 8) {
                                    Label("Evidencia Criptográfica (Ley 527 de 1999)", systemImage: "lock.doc.fill")
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(Theme.spruce)
                                    Text("Firmado con \(note.signature.deviceName) el \(note.signature.signedAt.formatted(date: .abbreviated, time: .standard))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(verbatim: "SHA-256 Documento: \(note.documentSha256)")
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                    Text(verbatim: "Firma ECDSA P-256: \(note.signature.ecdsaSignatureBase64.prefix(44))…")
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                            }

                            GlassCard {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("Texto íntegro del Título Valor y Carta de Instrucciones")
                                        .font(.subheadline.weight(.bold))
                                    Divider()
                                    Text(verbatim: note.documentMarkdown)
                                        .font(.caption)
                                        .lineSpacing(3)
                                }
                            }

                            ShareLink(
                                item: "\(note.number) — \(note.status.title)\n\n\(note.documentMarkdown)\n\nSHA-256: \(note.documentSha256)"
                            ) {
                                Label("Compartir / Guardar copia del Pagaré", systemImage: "square.and.arrow.up")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                            }
                            .buttonStyle(.glass)
                            .buttonBorderShape(.capsule)
                        }
                        .padding(20)
                    }
                } else if let errorMessage {
                    VStack(spacing: 14) {
                        ErrorBanner(message: errorMessage)
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Pagaré Electrónico")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .task {
                do {
                    note = try await app.api.loanPromissoryNote(id: loan.id)
                } catch {
                    errorMessage = error.userMessage
                }
                isLoading = false
            }
        }
    }
}

// MARK: - Hoja de Pago Total o Abono sin Penalidad

private struct PayLoanSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let loan: LoanItem
    let onPaid: () -> Void

    @State private var payFull = true
    @State private var customAmountText = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @FocusState private var isFocused: Bool

    private var availableBalance: Money {
        store.copMainAvailable
    }

    private var remainingMinor: Int64 {
        Int64(loan.remainingMinor) ?? 0
    }

    private var selectedPayMinor: Int64 {
        if payFull { return remainingMinor }
        let clean = customAmountText.filter { "0123456789".contains($0) }
        guard let val = Int64(clean), val > 0 else { return 0 }
        return min(remainingMinor, val * 100)
    }

    private var canPay: Bool {
        selectedPayMinor > 0 && selectedPayMinor <= availableBalance.minorUnits && !isSubmitting
    }

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
                            VStack(alignment: .leading, spacing: 10) {
                                Text(verbatim: "Pagaré \(loan.promissoryNoteNumber)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                DetailRow(title: "Saldo pendiente total", value: loan.remaining.formatted(), emphasized: true)
                                DetailRow(title: "Disponible en tu billetera COP", value: availableBalance.formatted())
                                DetailRow(title: "Penalidad por pago anticipado", value: "$ 0 COP")
                            }
                        }

                        Picker("Modalidad de pago", selection: $payFull) {
                            Text("Pago total (Paz y Salvo)").tag(true)
                            Text("Abono parcial").tag(false)
                        }
                        .pickerStyle(.segmented)

                        if !payFull {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Valor del abono")
                                    .font(.subheadline.weight(.semibold))
                                HStack {
                                    Text(verbatim: "$")
                                        .font(.title3.weight(.bold))
                                        .foregroundStyle(.secondary)
                                    TextField("100.000", text: $customAmountText)
                                        .font(.system(.title3, design: .rounded).weight(.bold))
                                        .keyboardType(.numberPad)
                                        .focused($isFocused)
                                    Text(verbatim: "COP")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                                .padding(14)
                                .glassEffect(.regular, in: .rect(cornerRadius: 14))
                            }
                        }

                        if selectedPayMinor > availableBalance.minorUnits {
                            Label("Saldo insuficiente en tu billetera COP para cubrir este pago.", systemImage: "exclamationmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(Theme.negative)
                        }
                    }
                    .padding(20)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Pagar Crédito")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Listo") { isFocused = false }
                }
            }
            .safeAreaInset(edge: .bottom) {
                PrimaryButton(
                    title: payFull ? "Liquidar crédito con Face ID" : "Autorizar abono con Face ID",
                    systemImage: "faceid",
                    isLoading: isSubmitting,
                    isEnabled: canPay
                ) {
                    isFocused = false
                    Task { await performPayment() }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
        }
    }

    private func performPayment() async {
        isSubmitting = true
        errorMessage = nil
        do {
            _ = try await app.api.payLoan(id: loan.id, amountMinor: selectedPayMinor)
            await store.refreshAfterMovement()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onPaid()
            dismiss()
        } catch {
            errorMessage = error.userMessage
            isSubmitting = false
        }
    }
}
