import SwiftUI
import UIKit

enum CardPocketTransferMode: String, CaseIterable, Identifiable, Sendable {
    case fund
    case withdraw

    var id: String { rawValue }

    var segmentTitle: LocalizedStringKey {
        switch self {
        case .fund: "Recargar tarjeta"
        case .withdraw: "Pasar a principal"
        }
    }

    var navigationTitle: LocalizedStringKey {
        switch self {
        case .fund: "Recargar bolsillo"
        case .withdraw: "Pasar a saldo principal"
        }
    }

    var ctaTitle: LocalizedStringKey {
        switch self {
        case .fund: "Recargar tarjeta"
        case .withdraw: "Pasar a saldo principal"
        }
    }
}

/// Hoja interactiva para recargar el bolsillo de la tarjeta desde el saldo principal Bre-B
/// o devolver fondos del bolsillo de la tarjeta al saldo principal sin costo.
struct CardPocketTransferSheet: View {
    let card: CardItem
    let initialMode: CardPocketTransferMode
    var onCompleted: ((CardPocketTransferResponse) -> Void)? = nil

    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var mode: CardPocketTransferMode
    @State private var input = AmountInput(currency: .cop)
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private static let minAmountMinor: Int64 = 10_000 // $ 100 COP
    private static let quickPresetsMinor: [Int64] = [
        1_000_000,   // $ 10.000
        2_000_000,   // $ 20.000
        5_000_000,   // $ 50.000
        10_000_000,  // $ 100.000
    ]

    init(
        card: CardItem,
        initialMode: CardPocketTransferMode = .fund,
        onCompleted: ((CardPocketTransferResponse) -> Void)? = nil
    ) {
        self.card = card
        self.initialMode = initialMode
        self.onCompleted = onCompleted
        _mode = State(initialValue: initialMode)
    }

    private var mainAvailable: Money {
        store.copMainAvailable
    }

    private var pocketAvailable: Money {
        store.cardPocketBalance
    }

    private var sourceAvailable: Money {
        mode == .fund ? mainAvailable : pocketAvailable
    }

    private var amountMinor: Int64 {
        input.minorUnits
    }

    private var exceedsBalance: Bool {
        amountMinor > sourceAvailable.minorUnits
    }

    private var belowMinimum: Bool {
        amountMinor > 0 && amountMinor < Self.minAmountMinor
    }

    private var canSubmit: Bool {
        !isSubmitting &&
            amountMinor >= Self.minAmountMinor &&
            !exceedsBalance &&
            (mode == .withdraw || card.status != .canceled)
    }

    private var projectedCardBalance: Money {
        let next = mode == .fund
            ? pocketAvailable.minorUnits + amountMinor
            : max(0, pocketAvailable.minorUnits - amountMinor)
        return Money(minorUnits: next, currency: .cop)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()

                VStack(spacing: 14) {
                    modeSelector

                    routeSummaryCard

                    Spacer(minLength: 2)

                    VStack(spacing: 8) {
                        AmountDisplay(input: input)
                        helperLabel
                    }

                    quickAmountChips

                    if let errorMessage {
                        ErrorBanner(message: errorMessage)
                    }

                    Spacer(minLength: 2)

                    AmountKeypad(input: $input)

                    PrimaryButton(
                        title: mode.ctaTitle,
                        systemImage: "faceid",
                        isLoading: isSubmitting,
                        isEnabled: canSubmit
                    ) {
                        Task { await submit() }
                    }
                    .padding(.top, 2)
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .navigationTitle(mode.navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .onChange(of: mode) { _, _ in
                errorMessage = nil
                if input.minorUnits > sourceAvailable.minorUnits {
                    input.clear()
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Selector de dirección

    private var modeSelector: some View {
        HStack(spacing: 6) {
            ForEach(CardPocketTransferMode.allCases) { option in
                let selected = mode == option
                Button {
                    withAnimation(.snappy(duration: 0.25)) {
                        mode = option
                    }
                } label: {
                    Text(option.segmentTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(selected ? Color.white : Color.primary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 38)
                        .background {
                            if selected {
                                Capsule().fill(Theme.spruceSolid)
                            }
                        }
                        .contentShape(.capsule)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .glassEffect(.regular, in: .capsule)
        .sensoryFeedback(.selection, trigger: mode)
    }

    // MARK: - Resumen visual Origen → Destino

    private var routeSummaryCard: some View {
        let cardSuffix = (card.lastFour.count == 4 && card.lastFour != "0000") ? " •••• \(card.lastFour)" : ""

        return VStack(spacing: 10) {
            HStack(spacing: 12) {
                routeEndpointIcon(
                    systemImage: mode == .fund ? "building.columns.fill" : "creditcard.fill",
                    tint: mode == .fund ? Theme.spruce : Theme.onyx
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Desde")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(verbatim: mode == .fund ? "Saldo principal Bre-B" : "Bolsillo Tarjeta\(cardSuffix)")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Disponible")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: sourceAvailable.formatted())
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.spruce)
                }
            }

            HStack(spacing: 8) {
                Rectangle()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 1)

                HStack(spacing: 5) {
                    Image(systemName: "arrow.down")
                        .font(.caption2.weight(.bold))
                    Text("$ 0 costo · Inmediato")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(Theme.spruce)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Theme.spruce.opacity(colorScheme == .dark ? 0.20 : 0.12), in: .capsule)

                Rectangle()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 1)
            }

            HStack(spacing: 12) {
                routeEndpointIcon(
                    systemImage: mode == .fund ? "creditcard.fill" : "building.columns.fill",
                    tint: mode == .fund ? Theme.onyx : Theme.spruce
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Hacia")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(verbatim: mode == .fund ? "Bolsillo Tarjeta\(cardSuffix)" : "Saldo principal Bre-B")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("Actual")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: (mode == .fund ? pocketAvailable : mainAvailable).formatted())
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }

    private func routeEndpointIcon(systemImage: String, tint: Color) -> some View {
        ZStack {
            Circle()
                .fill(tint == Theme.onyx ? Theme.spruceSolid.opacity(0.16) : tint.opacity(0.14))
                .frame(width: 36, height: 36)
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.spruce)
        }
    }

    // MARK: - Mensaje dinámico de validación

    @ViewBuilder
    private var helperLabel: some View {
        if exceedsBalance {
            Text("Supera tu saldo disponible (\(sourceAvailable.formatted()))")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.negative)
        } else if belowMinimum {
            Text("El monto mínimo es de $ 100 COP")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.warning)
        } else if amountMinor > 0 {
            Text("Saldo en tu tarjeta después: \(projectedCardBalance.formatted())")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.spruce)
        } else {
            Text(mode == .fund
                 ? "Ingresa cuánto quieres pasar de Bre-B a tu tarjeta"
                 : "Ingresa cuánto quieres devolver a tu saldo principal")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Atajos rápidos de monto

    private var quickAmountChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Self.quickPresetsMinor, id: \.self) { preset in
                    let money = Money(minorUnits: preset, currency: .cop)
                    let isSelected = input.minorUnits == preset
                    let disabled = preset > sourceAvailable.minorUnits
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        input.set(minorUnits: preset)
                    } label: {
                        Text(verbatim: money.formatted())
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(isSelected ? Color.white : Color.primary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background {
                                if isSelected {
                                    Capsule().fill(Theme.spruceSolid)
                                } else {
                                    Capsule().fill(Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06))
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                    .opacity(disabled ? 0.38 : 1)
                }

                if sourceAvailable.minorUnits >= Self.minAmountMinor {
                    let isMax = input.minorUnits == sourceAvailable.minorUnits
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        input.set(minorUnits: sourceAvailable.minorUnits)
                    } label: {
                        Text("Todo")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(isMax ? Color.white : Theme.spruce)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background {
                                if isMax {
                                    Capsule().fill(Theme.spruceSolid)
                                } else {
                                    Capsule().fill(Theme.spruce.opacity(0.14))
                                }
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // MARK: - Ejecución

    private func submit() async {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let idemKey = "cpk_\(mode.rawValue)_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        do {
            let response: CardPocketTransferResponse
            switch mode {
            case .fund:
                response = try await app.api.fundCard(
                    id: card.id,
                    amountMinor: amountMinor,
                    idempotencyKey: idemKey
                )
            case .withdraw:
                response = try await app.api.withdrawCard(
                    id: card.id,
                    amountMinor: amountMinor,
                    idempotencyKey: idemKey
                )
            }
            await store.applyCardPocketTransfer(response)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onCompleted?(response)
            dismiss()
        } catch {
            if case APIError.biometricCancelled = error {
                return
            }
            errorMessage = error.userMessage
        }
    }
}
