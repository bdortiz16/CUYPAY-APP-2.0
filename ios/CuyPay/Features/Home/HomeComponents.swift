import Charts
import SwiftUI

// MARK: - Selector de bolsillo (morphing glass)

/// Pastilla "🇨🇴 COP ▾" que se expande en dos opciones (COP/BRL) con morphing de Liquid Glass.
struct PocketSwitcher: View {
    @Binding var selection: Currency
    @State private var isExpanded = false
    @Namespace private var glassNamespace

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                if isExpanded {
                    ForEach(Currency.allCases) { currency in
                        Button {
                            withAnimation(.bouncy(duration: 0.45)) {
                                selection = currency
                                isExpanded = false
                            }
                        } label: {
                            pill(currency, showsChevron: false)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(
                            currency == selection
                                ? Glass.regular.tint(Theme.spruce.opacity(0.35)).interactive()
                                : Glass.regular.interactive(),
                            in: .capsule
                        )
                        .glassEffectID(currency, in: glassNamespace)
                        .accessibilityAddTraits(currency == selection ? .isSelected : [])
                    }
                } else {
                    Button {
                        withAnimation(.bouncy(duration: 0.45)) { isExpanded = true }
                    } label: {
                        pill(selection, showsChevron: true)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .glassEffectID(selection, in: glassNamespace)
                    .accessibilityLabel(Text("Bolsillo \(selection.code). Toca para cambiar"))
                }
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
        .sensoryFeedback(.impact(weight: .light), trigger: isExpanded)
    }

    private func pill(_ currency: Currency, showsChevron: Bool) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: currency.flag)
            Text(verbatim: currency.code)
                .font(.subheadline.weight(.bold))
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(.capsule)
    }
}

// MARK: - Saldo

struct BalanceHeader: View {
    let wallet: Wallet?
    let currency: Currency
    @Binding var hideAmounts: Bool

    private var available: Money { wallet?.available ?? .zero(currency) }

    var body: some View {
        VStack(spacing: 6) {
            Text("Saldo disponible")
                .font(.system(.title3, design: .serif))
                .foregroundStyle(.secondary)

            HStack(alignment: .firstTextBaseline, spacing: 10) {
                amountText
                Button {
                    withAnimation(.snappy) { hideAmounts.toggle() }
                } label: {
                    Image(systemName: hideAmounts ? "eye.slash" : "eye")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(hideAmounts ? Text("Mostrar saldo") : Text("Ocultar saldo"))
            }

            if let wallet, wallet.heldMinor > 0, !hideAmounts {
                Text("Retenido: \(wallet.held.formatted())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .sensoryFeedback(.selection, trigger: hideAmounts)
    }

    @ViewBuilder
    private var amountText: some View {
        if hideAmounts {
            Text(verbatim: available.maskedString)
                .font(.system(size: 44, weight: .regular, design: .serif))
                .accessibilityLabel(Text("Saldo oculto"))
        } else {
            let showFraction = currency.alwaysShowsFraction || available.fractionMagnitude != 0
            let fraction = available.fractionMagnitude
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(verbatim: available.formatted(includeSymbol: true).components(separatedBy: ",").first ?? "")
                    .foregroundStyle(.primary)
                if showFraction {
                    Text(verbatim: "," + (fraction < 10 ? "0\(fraction)" : "\(fraction)"))
                        .foregroundStyle(.tertiary)
                }
            }
            .font(.system(size: 44, weight: .regular, design: .serif))
            .monospacedDigit()
            .minimumScaleFactor(0.5)
            .lineLimit(1)
            .contentTransition(.numericText())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: available.formatted()))
        }
    }
}

// MARK: - Tarjeta de tasa (gráfica 30 días)

struct RateChartCard: View {
    let rate: FxRate?

    private struct Bar: Identifiable {
        let id: Date
        let value: Double
        let isCurrent: Bool
    }

    private var bars: [Bar] {
        guard let history = rate?.history, !history.isEmpty else { return [] }
        let sorted = history.sorted { $0.date < $1.date }
        return sorted.enumerated().map { index, point in
            let inverse = point.rate > 0 ? RateFormatter.double(1 / point.rate) : 0
            return Bar(id: point.date, value: inverse, isCurrent: index == sorted.count - 1)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tasa COP→BRL")
                .font(.system(.subheadline, design: .serif).weight(.semibold))

            if let rate {
                VStack(alignment: .center, spacing: 2) {
                    Text(verbatim: "$ " + RateFormatter.copPerBRL(rate.inverseRate))
                        .font(.system(.title3, design: .serif).weight(.medium))
                        .monospacedDigit()
                    Text("por 1 BRL")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)

                chart
                    .frame(height: 64)

                HStack {
                    Text("30 días")
                    Spacer()
                    if let first = rate.history.min(by: { $0.date < $1.date }), let change = RateFormatter.change(from: 1 / first.rate, to: rate.inverseRate) {
                        Text(verbatim: change)
                            .fontWeight(.semibold)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 110)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 190, alignment: .top)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Tasa de cambio"))
        .accessibilityValue(Text(verbatim: rate.map { RateFormatter.headline(rate: $0.rate) } ?? ""))
    }

    private var chart: some View {
        let values = bars.map(\.value)
        let minValue = (values.min() ?? 0) * 0.995
        let maxValue = (values.max() ?? 1) * 1.002
        return Chart(bars) { bar in
            BarMark(
                x: .value("Día", bar.id, unit: .day),
                yStart: .value("Mínimo", minValue),
                yEnd: .value("Tasa", bar.value),
                width: .ratio(0.55)
            )
            .foregroundStyle(bar.isCurrent ? AnyShapeStyle(Theme.coral) : AnyShapeStyle(Theme.spruce.opacity(0.28)))
            .cornerRadius(3)
        }
        .chartYScale(domain: minValue...maxValue)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
    }
}

// MARK: - Beneficiarios (acciones rápidas)

struct BeneficiariesQuickCard: View {
    let beneficiaries: [Beneficiary]
    let onSelect: (Beneficiary) -> Void
    let onAdd: () -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 3)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Beneficiarios")
                .font(.system(.subheadline, design: .serif).weight(.semibold))

            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(beneficiaries.prefix(5)) { beneficiary in
                    Button {
                        onSelect(beneficiary)
                    } label: {
                        VStack(spacing: 4) {
                            AvatarView(initials: beneficiary.initials, size: 40, seed: beneficiary.id)
                            Text(verbatim: beneficiary.displayName.components(separatedBy: " ").first ?? beneficiary.displayName)
                                .font(.caption2)
                                .lineLimit(1)
                                .foregroundStyle(.primary)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Enviar a \(beneficiary.displayName)"))
                }

                Button(action: onAdd) {
                    VStack(spacing: 4) {
                        Image(systemName: "plus")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(Theme.onyx, in: .circle)
                        Text("Agregar")
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                            .foregroundStyle(.primary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Agregar beneficiario"))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 190, alignment: .top)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))
    }
}

// MARK: - Fila de transacción

struct TransactionRow: View {
    let transaction: WalletTransaction
    /// Bolsillo desde el que se mira (una conversión COP→BRL es ingreso en BRL).
    let pocket: Currency
    let hideAmounts: Bool

    private var isIncomingConversion: Bool {
        transaction.type == .conversion && transaction.conversion?.toCurrency == pocket && transaction.currency != pocket
    }

    private var displayedAmount: Money {
        if isIncomingConversion, let conversion = transaction.conversion {
            return conversion.toAmount
        }
        return transaction.signedAmount
    }

    private var isIncoming: Bool { isIncomingConversion || transaction.direction == .in }

    private var icon: (name: String, color: Color) {
        switch transaction.type {
        case .deposit: ("arrow.down.left", Theme.positive)
        case .transfer: ("arrow.up.right", Theme.ink)
        case .conversion: ("arrow.left.arrow.right", Theme.spruce)
        case .unknown: ("circle.dashed", Color.secondary)
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon.name)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(icon.color)
                .frame(width: 42, height: 42)
                .background(icon.color.opacity(0.12), in: .circle)

            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: transaction.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if let subtitle = transaction.subtitle {
                        Text(verbatim: subtitle).lineLimit(1)
                        Text(verbatim: "·")
                    }
                    Text(transaction.createdAt, format: .dateTime.hour().minute())
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 3) {
                Text(verbatim: hideAmounts ? "••••" : displayedAmount.formatted(sign: isIncoming ? .always : .automatic))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(isIncoming ? Theme.positive : .primary)
                    .strikethrough(transaction.status == .failed || transaction.status == .reversed)
                statusLabel
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch transaction.status {
        case .completed:
            Text(transactionKind)
                .font(.caption2.weight(.medium))
                .foregroundStyle(isIncoming ? Theme.positive : .secondary)
        case .pending:
            Label("Pendiente", systemImage: "clock")
                .font(.caption2.weight(.medium))
                .foregroundStyle(Theme.warning)
        case .failed:
            Label("Fallido", systemImage: "xmark.circle")
                .font(.caption2.weight(.medium))
                .foregroundStyle(Theme.negative)
        case .reversed:
            Label("Reversado", systemImage: "arrow.uturn.backward")
                .font(.caption2.weight(.medium))
                .foregroundStyle(Theme.negative)
        case .unknown:
            EmptyView()
        }
    }

    private var transactionKind: LocalizedStringKey {
        switch transaction.type {
        case .deposit: "Recibido"
        case .transfer: "Envío Bre-B"
        case .conversion: "Conversión"
        case .unknown: "Movimiento"
        }
    }
}

// MARK: - Barra inferior flotante

struct BottomActionBar: View {
    let onSend: () -> Void
    let onMenu: () -> Void
    let onReceive: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                actionButton(title: "Enviar", systemImage: "arrow.up", action: onSend)

                Button(action: onMenu) {
                    Image(systemName: "square.grid.2x2.fill")
                        .font(.title3)
                        .foregroundStyle(.primary)
                        .frame(width: 58, height: 58)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel(Text("Más opciones"))

                actionButton(title: "Recibir", systemImage: "arrow.down", action: onReceive)
            }
        }
        .padding(.horizontal, Theme.horizontalPadding)
        .padding(.bottom, 4)
    }

    private func actionButton(title: LocalizedStringKey, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.headline)
                    .frame(width: 38, height: 38)
                    .background(.white.opacity(0.55), in: .circle)
                Text(title)
                    .font(.headline)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.primary)
            .padding(.leading, 10)
            .padding(.trailing, 16)
            .frame(height: 58)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
    }
}

// MARK: - Banner KYC

struct KYCBanner: View {
    let status: KYCStatus
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: status == .pending ? "hourglass" : "person.badge.shield.checkmark.fill")
                    .font(.title2)
                    .foregroundStyle(Theme.spruce)
                VStack(alignment: .leading, spacing: 2) {
                    Text(status == .pending ? LocalizedStringKey("Verificación en revisión") : LocalizedStringKey("Verifica tu identidad"))
                        .font(.subheadline.weight(.semibold))
                    Text(status == .pending ? LocalizedStringKey("Te avisaremos cuando esté lista.") : LocalizedStringKey("Actívala para enviar, convertir y crear tu llave Bre-B."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .padding(14)
            .contentShape(.rect(cornerRadius: 22))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(Theme.spruce.opacity(0.18)).interactive(), in: .rect(cornerRadius: 22))
    }
}
