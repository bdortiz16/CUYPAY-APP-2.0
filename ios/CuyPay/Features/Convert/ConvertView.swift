import SwiftUI
import UIKit

/// Convertir COP → BRL. Widget inspirado en cuypay.com ("Tú envías / Tu contacto recibe").
struct ConvertView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var model: ConvertViewModel?

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                if let model {
                    if let result = model.result {
                        ConversionSuccessView(transaction: result) { dismiss() }
                            .transition(.asymmetric(insertion: .scale(scale: 0.9).combined(with: .opacity), removal: .opacity))
                    } else {
                        ConvertContent(model: model)
                    }
                }
            }
            .animation(.smooth, value: model?.result?.id)
            .navigationTitle(model?.result == nil ? Text("Convertir") : Text(verbatim: ""))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
        .onAppear {
            if model == nil { model = ConvertViewModel(api: app.api) }
        }
        .onDisappear { model?.stop() }
    }
}

private struct ConvertContent: View {
    @Environment(WalletStore.self) private var store
    @Bindable var model: ConvertViewModel

    private var available: Money? { store.wallet(for: .cop)?.available }

    private var insufficientFunds: Bool {
        guard let available else { return false }
        return model.input.minorUnits > available.minorUnits
    }

    private var exceedsLimit: Bool {
        guard let limits = store.limits else { return false }
        return !limits.allows(model.input.minorUnits, for: .conversion)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                widget

                HStack {
                    if let available {
                        Text("Disponible: \(available.formatted())")
                            .font(.footnote)
                            .foregroundStyle(insufficientFunds ? Theme.negative : .secondary)
                    }
                    Spacer()
                    if let available, available.minorUnits > 0 {
                        Button("Usar todo") {
                            model.input.set(minorUnits: available.minorUnits - available.minorUnits % 100)
                        }
                        .font(.footnote.weight(.semibold))
                    }
                }
                .padding(.horizontal, 4)

                if insufficientFunds {
                    ErrorBanner(message: APIError.message(for: .insufficientFunds, limit: nil))
                } else if exceedsLimit, let remaining = store.limits?.effectiveRemaining(for: .conversion) {
                    ErrorBanner(message: String(localized: "Superas tu cupo de conversiones. Disponible: \(remaining.formatted())."))
                } else if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }

                AmountKeypad(input: $model.input)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(
                title: "Convertir ahora",
                systemImage: "faceid",
                isLoading: model.isConverting,
                isEnabled: model.canConvert(available: available, limits: store.limits)
            ) {
                Task { await model.convert(store: store) }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .onChange(of: model.input) { model.amountChanged() }
        .sensoryFeedback(.success, trigger: model.result != nil) { _, newValue in newValue }
    }

    // MARK: Widget

    private var widget: some View {
        VStack(spacing: 14) {
            ZStack {
                VStack(spacing: 8) {
                    amountBox(
                        label: "TÚ CONVIERTES",
                        amount: model.input.isEmpty ? "0" : model.input.displayString,
                        currency: .cop,
                        isPlaceholder: model.input.isEmpty
                    )
                    amountBox(
                        label: "RECIBES",
                        amount: model.quote.map { $0.toAmount.formatted(includeSymbol: false) } ?? "0,00",
                        currency: .brl,
                        isPlaceholder: model.quote == nil,
                        isLoading: model.isQuoting
                    )
                }
                Image(systemName: "arrow.down")
                    .font(.footnote.weight(.bold))
                    .frame(width: 32, height: 32)
                    .glassEffect(.regular, in: .circle)
                    .accessibilityHidden(true)
            }

            VStack(spacing: 10) {
                DetailRow(title: "Costo de conversión", value: model.quote?.fee.formatted() ?? "—", systemImage: "minus.circle.fill")
                DetailRow(title: "Monto a convertir", value: model.quote?.amountToConvert.formatted() ?? "—", systemImage: "equal.circle.fill")
                DetailRow(title: "Tipo de cambio", value: model.quote.map { RateFormatter.headline(rate: $0.rate) } ?? "—", systemImage: "multiply.circle.fill")
            }
            .padding(.horizontal, 4)

            HStack(spacing: 10) {
                CountdownRing(remaining: model.secondsRemaining, total: ConvertViewModel.quoteValidity)
                Group {
                    if model.isQuoting {
                        Text("Actualizando cotización…")
                    } else if model.quote != nil {
                        Text("La cotización se actualiza en \(model.secondsRemaining) s")
                    } else {
                        Text("Ingresa un monto para cotizar")
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(12)
            .background(Theme.spruce.opacity(0.08), in: .rect(cornerRadius: 16))
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))
    }

    private func amountBox(label: LocalizedStringKey, amount: String, currency: Currency, isPlaceholder: Bool, isLoading: Bool = false) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    Text(verbatim: amount)
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(isPlaceholder ? .secondary : .primary)
                        .contentTransition(.numericText())
                        .animation(.snappy, value: amount)
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                    if isLoading {
                        ProgressView().controlSize(.small)
                    }
                }
            }
            Spacer()
            CurrencyChip(currency: currency)
        }
        .padding(14)
        .background(.background.opacity(0.55), in: .rect(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(.primary.opacity(0.06)))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Éxito

struct ConversionSuccessView: View {
    let transaction: WalletTransaction
    let onDone: () -> Void
    @Environment(AppModel.self) private var app
    @State private var appeared = false
    @State private var copiedRef = false

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                CuyPayVoucherCard(
                    transaction: transaction,
                    pocket: transaction.conversion?.toCurrency ?? transaction.currency,
                    senderName: app.user?.fullName,
                    copiedReference: copiedRef,
                    onCopyReference: {
                        UIPasteboard.general.string = transaction.id
                        withAnimation(.snappy) { copiedRef = true }
                        Task { @MainActor in
                            try? await Task.sleep(for: .seconds(2))
                            withAnimation { copiedRef = false }
                        }
                    }
                )
                .scaleEffect(appeared ? 1 : 0.95)
                .opacity(appeared ? 1 : 0)
                .padding(.top, 8)

                VStack(spacing: 12) {
                    Button {
                        VoucherSharePresenter.shareTransactionVoucher(
                            transaction,
                            pocket: transaction.conversion?.toCurrency ?? transaction.currency,
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
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 28)
        }
        .scrollIndicators(.hidden)
        .onAppear {
            withAnimation(.spring(duration: 0.48, bounce: 0.16)) { appeared = true }
        }
    }
}

#Preview("Convertir") {
    ConvertView()
        .appEnvironment(.preview())
}

#Preview("Conversión exitosa") {
    ZStack {
        BrandBackground()
        ConversionSuccessView(transaction: MockFixtures(now: Date()).transactions[2]) {}
    }
    .appEnvironment(.preview())
}
