import SwiftUI
import UIKit

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
    @Bindable var model: SendFlowModel
    @State private var showAdd = false
    @State private var showQRScanner = false
    @State private var directKey = ""
    @State private var query = ""
    @FocusState private var directKeyFocused: Bool

    private var filtered: [Beneficiary] {
        store.beneficiaries.filter {
            query.isEmpty || $0.displayName.localizedStandardContains(query) || $0.alias.localizedStandardContains(query)
        }
    }

    var body: some View {
        ZStack {
            BrandBackground()
            VStack(spacing: 0) {
                // Entrada directa de llave Bre-B y botón de escanear QR contiguo
                HStack(spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "key.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.spruce)
                        TextField("Llave Bre-B (celular, @alias, NIT, comercio)…", text: $directKey)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.emailAddress)
                            .focused($directKeyFocused)
                            .submitLabel(.go)
                            .onSubmit { submitDirectInput(directKey) }
                            .onChange(of: directKey) { _, newValue in
                                model.pickerErrorMessage = nil
                                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                                if trimmed.hasPrefix("0002") && trimmed.count > 30,
                                   case .valid(let parsed) = BrebQRParser.parse(trimmed),
                                   parsed.isEmvCo {
                                    directKeyFocused = false
                                    directKey = ""
                                    Task {
                                        await model.resolveAndSelect(
                                            rawInput: parsed.rawPayload,
                                            parsedQR: parsed,
                                            existingBeneficiaries: store.beneficiaries
                                        )
                                    }
                                }
                            }

                        if !directKey.isEmpty {
                            Button {
                                directKey = ""
                                model.pickerErrorMessage = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))

                    if !directKey.isEmpty {
                        Button {
                            submitDirectInput(directKey)
                        } label: {
                            Image(systemName: "arrow.right.circle.fill")
                                .font(.system(size: 32))
                                .foregroundStyle(Theme.spruce)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.isResolvingRecipient)
                    }

                    Button {
                        directKeyFocused = false
                        model.pickerErrorMessage = nil
                        showQRScanner = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "qrcode.viewfinder")
                                .font(.headline)
                            Text("Escanear")
                                .font(.footnote.weight(.bold))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(Theme.spruce)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isResolvingRecipient)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 8)

                if let pickerError = model.pickerErrorMessage {
                    ErrorBanner(message: pickerError)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                }

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
                    if store.beneficiaries.isEmpty && !model.isResolvingRecipient {
                        ContentUnavailableView("Aún no tienes beneficiarios", systemImage: "person.2", description: Text("Escanea el QR de un cliente o comercio, escribe su llave arriba o inscribe un contacto."))
                    }
                }
            }

            if model.isResolvingRecipient {
                ZStack {
                    Color.black.opacity(0.25).ignoresSafeArea()
                    VStack(spacing: 14) {
                        ProgressView()
                            .controlSize(.large)
                        Text("Verificando destinatario Bre-B…")
                            .font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 24)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
                .transition(.opacity)
            }
        }
        .navigationTitle("¿A quién envías?")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showQRScanner) {
            QRScannerView { parsedQR in
                directKeyFocused = false
                directKey = ""
                Task {
                    await model.resolveAndSelect(
                        rawInput: parsedQR.rawPayload,
                        parsedQR: parsedQR,
                        existingBeneficiaries: store.beneficiaries
                    )
                }
            }
        }
        .sheet(isPresented: $showAdd) {
            AddBeneficiaryFlowView { beneficiary in
                if beneficiary.status == .active { model.select(beneficiary) }
            }
        }
        .task {
            if store.beneficiaries.isEmpty { await store.refreshBeneficiaries() }
        }
    }

    private func submitDirectInput(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        directKeyFocused = false
        Task {
            await model.resolveAndSelect(rawInput: trimmed, existingBeneficiaries: store.beneficiaries)
            if model.hasRecipient {
                directKey = ""
            }
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
                    if model.hasRecipient {
                        HStack(spacing: 12) {
                            AvatarView(initials: model.recipientInitials, size: 48, seed: model.recipientSeed)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(verbatim: model.recipientDisplayName)
                                        .font(.headline)
                                        .lineLimit(1)
                                    if model.recipientIsMerchant {
                                        Label("Comercio", systemImage: "storefront.fill")
                                            .font(.caption2.weight(.semibold))
                                            .padding(.horizontal, 7)
                                            .padding(.vertical, 3)
                                            .background(Theme.spruce.opacity(0.16), in: Capsule())
                                            .foregroundStyle(Theme.spruce)
                                    }
                                }
                                Text(verbatim: "\(model.recipientBankName) · \(model.recipientAlias)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if let docSummary = model.recipientDocumentSummary {
                                    Text(verbatim: docSummary)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
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

                    if !model.note.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "doc.text")
                                .font(.caption)
                                .foregroundStyle(Theme.spruce)
                            Text("Referencia QR: \(model.note)")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
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

                    AmountKeypad(input: $model.input, keyHeight: 50, spacing: 10)

                    PrimaryButton(
                        title: "Continuar",
                        isLoading: model.isLoading,
                        isEnabled: model.input.minorUnits > 0 && !insufficient
                    ) {
                        Task { await model.requestPreview() }
                    }
                    .padding(.top, 4)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
        }
        .navigationTitle(model.recipientIsMerchant ? "Pagar a comercio" : "Monto")
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
                    if let preview = model.preview, model.hasRecipient {
                        VStack(spacing: 6) {
                            Text(model.recipientIsMerchant ? "Vas a pagar" : "Vas a enviar")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Text(verbatim: preview.amount.formatted())
                                .font(.system(size: 44, weight: .bold, design: .rounded))
                                .monospacedDigit()
                            Text("a \(model.recipientHolderName)")
                                .font(.headline)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.top, 12)

                        GlassCard {
                            VStack(spacing: 12) {
                                DetailRow(title: model.recipientIsMerchant ? "Comercio / Llave" : "Llave Bre-B", value: model.recipientAlias)
                                DetailRow(title: "Entidad", value: model.recipientBankName)
                                if let docSummary = model.recipientDocumentSummary {
                                    DetailRow(title: "Identificación", value: docSummary)
                                }
                                Divider()
                                DetailRow(title: "Monto", value: preview.amount.formatted())
                                DetailRow(title: "Costo del envío", value: preview.feeMinor == 0 ? String(localized: "Gratis") : preview.fee.formatted())
                                DetailRow(title: "Total a debitar", value: preview.total.formatted(), emphasized: true)
                            }
                        }

                        if let remaining = model.remainingDailyAfter {
                            HStack(spacing: 10) {
                                Image(systemName: "gauge.with.dots.needle.33percent")
                                    .foregroundStyle(model.exceedsDailyLimit ? Theme.negative : Theme.spruce)
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

                        TextField(model.recipientIsMerchant ? "Referencia o factura (opcional)" : "Descripción (opcional)", text: $model.note)
                            .formFieldStyle()

                        if let error = model.errorMessage {
                            ErrorBanner(message: error)
                        }

                        Label("Los pagos y envíos Bre-B son inmediatos y no se pueden reversar. Verifica los datos.", systemImage: "info.circle")
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
                title: model.recipientIsMerchant ? "Pagar ahora" : "Enviar ahora",
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
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    let model: SendFlowModel
    let onDone: () -> Void

    @State private var appeared = false
    @State private var copiedRef = false

    private var liveTransaction: WalletTransaction? {
        guard let initial = model.transaction else { return nil }
        return store.transactions.first(where: { $0.id == initial.id }) ?? initial
    }

    var body: some View {
        ZStack {
            BrandBackground()
            if let transaction = liveTransaction {
                ScrollView {
                    VStack(spacing: 18) {
                        CuyPayVoucherCard(
                            transaction: transaction,
                            pocket: transaction.currency,
                            senderName: app.user?.fullName,
                            copiedReference: copiedRef,
                            onCopyReference: {
                                UIPasteboard.general.string = transaction.id
                                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                withAnimation(.snappy) { copiedRef = true }
                                Task { @MainActor in
                                    try? await Task.sleep(for: .seconds(2))
                                    withAnimation { copiedRef = false }
                                }
                            }
                        )
                        .scaleEffect(appeared ? 1 : 0.95)
                        .opacity(appeared ? 1 : 0)
                        .animation(.snappy, value: transaction.status)
                        .padding(.top, 8)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 16)
                }
                .scrollIndicators(.hidden)
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: 10) {
                        Button {
                            VoucherSharePresenter.shareTransactionVoucher(
                                transaction,
                                pocket: transaction.currency,
                                senderName: app.user?.fullName
                            )
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "square.and.arrow.up")
                                    .font(.body.weight(.semibold))
                                Text("Compartir comprobante")
                                    .font(.body.weight(.semibold))
                            }
                            .foregroundStyle(.primary)
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .contentShape(.capsule)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(.regular.interactive(), in: .capsule)

                        PrimaryButton(title: "Listo", action: onDone)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 6)
                    .padding(.bottom, 10)
                }
            }
        }
        .navigationTitle("Comprobante")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .sensoryFeedback(.success, trigger: appeared) { _, newValue in newValue }
        .onAppear {
            withAnimation(.spring(duration: 0.48, bounce: 0.16)) { appeared = true }
        }
        .task {
            // Si el envío Bre-B inicia en estado pendiente, consultamos unos segundos por si liquida al instante.
            for _ in 0..<8 {
                guard !Task.isCancelled else { break }
                guard liveTransaction?.status == .pending else { break }
                try? await Task.sleep(for: .milliseconds(2500))
                guard !Task.isCancelled else { break }
                await store.refreshLiveState(allowHaptic: false)
                if liveTransaction?.status == .completed {
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    break
                }
            }
        }
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
