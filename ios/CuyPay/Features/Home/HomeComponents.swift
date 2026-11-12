import Charts
import SwiftUI

// MARK: - Selector de bolsillo (morphing glass)

/// Pastilla "🇨🇴 COP ▾" que se expande en opciones con morphing de Liquid Glass.
struct PocketSwitcher: View {
    @Binding var selection: Currency
    var availableCurrencies: [Currency] = Currency.allCases
    @State private var isExpanded = false
    @Namespace private var glassNamespace

    var body: some View {
        if availableCurrencies.count <= 1 {
            pill(selection, showsChevron: false)
                .glassEffect(.regular, in: .capsule)
        } else {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    if isExpanded {
                        ForEach(availableCurrencies) { currency in
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
    var isLoading: Bool = false
    var onTap: (() -> Void)? = nil

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
        Group {
            if let onTap, rate != nil {
                Button(action: onTap) {
                    cardContent
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Theme.cardRadius))
            } else {
                cardContent
                    .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Tasa de cambio"))
        .accessibilityValue(Text(verbatim: rate.map { RateFormatter.headline(rate: $0.rate) } ?? ""))
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Tasa COP→BRL")
                    .font(.system(.subheadline, design: .serif).weight(.semibold))
                Spacer()
                if onTap != nil && rate != nil {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
            }

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
            } else if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 110)
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "globe.americas.fill")
                        .font(.title2)
                        .foregroundStyle(Theme.spruce.opacity(0.75))
                    Text("Corredor COP")
                        .font(.caption.weight(.semibold))
                    Text("Conversión BRL no activa")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, minHeight: 110)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 190, alignment: .top)
        .contentShape(.rect(cornerRadius: Theme.cardRadius))
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

// MARK: - Tarjeta CuyPay (acceso rápido en Inicio)

struct CardQuickCard: View {
    let card: CardItem?
    var hideAmounts: Bool = false
    let isLoading: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Tarjeta")
                        .font(.system(.subheadline, design: .serif).weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer()
                    if let card {
                        Circle()
                            .fill(card.status == .active ? Theme.positive : Theme.coral)
                            .frame(width: 7, height: 7)
                    }
                }

                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 110)
                } else if let card {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            CuyPayLogo(size: 10, color: .white, markColor: Theme.slate)
                            Spacer()
                            Image(systemName: "wave.3.forward")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.8))
                        }

                        Spacer(minLength: 0)

                        VStack(alignment: .leading, spacing: 1) {
                            Text("Bolsillo disponible")
                                .font(.system(size: 8.5, weight: .medium))
                                .foregroundStyle(.white.opacity(0.72))
                            Text(verbatim: hideAmounts ? card.pocketBalance.maskedString : card.pocketBalance.formatted())
                                .font(.system(size: 13.5, weight: .bold, design: .rounded))
                                .monospacedDigit()
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }

                        HStack(alignment: .center) {
                            Text(card.maskedPan)
                                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            VisaLogoView(height: 9.5, color: .white.opacity(0.95))
                        }
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, minHeight: 98)
                    .background(
                        LinearGradient(
                            colors: card.status == .active
                                ? [Color(red: 0.035, green: 0.075, blue: 0.090), Theme.onyx, Theme.spruceSolid]
                                : [Theme.onyx.opacity(0.85), Color.gray.opacity(0.55)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: 14)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.white.opacity(0.20), lineWidth: 0.8)
                    )

                    HStack(spacing: 4) {
                        Text(card.pocketBalance.minorUnits > 0 ? "Administrar bolsillo" : "Recargar bolsillo")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(card.pocketBalance.minorUnits > 0 ? .primary : Theme.spruce)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 2)
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "creditcard.and.123")
                            .font(.system(size: 26))
                            .foregroundStyle(Theme.spruce)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 6)

                        Text("Pide tu tarjeta virtual gratis")
                            .font(.caption2)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)

                        Text("Solicitar")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Theme.onyx, in: Capsule())
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 190, alignment: .top)
            .contentShape(.rect(cornerRadius: Theme.cardRadius))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Theme.cardRadius))
        .accessibilityLabel(card != nil ? Text("Tarjeta CuyPay \(card!.maskedPan)") : Text("Solicitar Tarjeta CuyPay"))
    }
}

// MARK: - Bolsillo de Ahorro (cuadrado rápido en Inicio)

struct SavingsQuickCard: View {
    let userSavings: UserSavingsResponse?
    let config: SavingsConfig?
    var hideAmounts: Bool = false
    let isLoading: Bool
    let onTap: () -> Void

    private var activeCount: Int {
        userSavings?.summary.activeCount ?? 0
    }

    private var totalPrincipal: Money {
        userSavings?.summary.totalPrincipal ?? .zero(.cop)
    }

    private var expectedYield: Money {
        userSavings?.summary.totalExpectedYield ?? .zero(.cop)
    }

    private var maxRateBadge: String {
        let maxRate = config?.rates.filter(\.enabled).map(\.ratePercent).max() ?? 12.0
        return String(format: "%.0f%% E.A.", maxRate)
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("Bolsillo de Ahorro")
                        .font(.system(.subheadline, design: .serif).weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.80)
                    Spacer(minLength: 2)
                    Circle()
                        .fill(activeCount > 0 ? Theme.positive : Theme.spruce.opacity(0.75))
                        .frame(width: 7, height: 7)
                }

                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 110)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 4) {
                            HStack(spacing: 4) {
                                Image(systemName: "lock.rotation")
                                    .font(.system(size: 10, weight: .bold))
                                Text("30–360d")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .foregroundStyle(.white.opacity(0.88))

                            Spacer(minLength: 4)

                            Text(verbatim: maxRateBadge)
                                .font(.system(size: 8.5, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2.5)
                                .background(.white.opacity(0.18), in: Capsule())
                        }

                        Spacer(minLength: 0)

                        VStack(alignment: .leading, spacing: 1) {
                            Text(activeCount > 0 ? "Ahorro bloqueado" : "Saldo en ahorro")
                                .font(.system(size: 8.5, weight: .medium))
                                .foregroundStyle(.white.opacity(0.75))
                            Text(verbatim: hideAmounts ? totalPrincipal.maskedString : totalPrincipal.formatted())
                                .font(.system(size: 13.5, weight: .bold, design: .rounded))
                                .monospacedDigit()
                                .foregroundStyle(.white)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }

                        HStack(alignment: .center) {
                            if activeCount > 0 {
                                Text(verbatim: "\(activeCount) activo\(activeCount == 1 ? "" : "s")")
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.86))
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                Text(verbatim: hideAmounts ? "+••••" : "+" + expectedYield.formatted())
                                    .font(.system(size: 9.5, weight: .bold, design: .rounded))
                                    .monospacedDigit()
                                    .foregroundStyle(Color(red: 0.58, green: 0.96, blue: 0.80))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
                            } else {
                                Text("Plazos 30·60·90·180·360d")
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.84))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.80)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, minHeight: 98)
                    .background(
                        LinearGradient(
                            colors: [
                                Color(red: 0.04, green: 0.19, blue: 0.17),
                                Theme.spruceSolid,
                                Color(red: 0.11, green: 0.46, blue: 0.40)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: 14)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.white.opacity(0.20), lineWidth: 0.8)
                    )

                    HStack(spacing: 4) {
                        Text(activeCount > 0 ? "Ver bolsillo" : "Ahorrar y ganar")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(activeCount > 0 ? .primary : Theme.spruce)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 190, alignment: .top)
            .contentShape(.rect(cornerRadius: Theme.cardRadius))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Theme.cardRadius))
        .accessibilityLabel(Text("Bolsillo de Ahorro"))
    }
}

// MARK: - Créditos (cuadrado rápido en Inicio)

struct LoansQuickCard: View {
    let userLoans: UserLoansResponse?
    let config: LoanConfig?
    var hideAmounts: Bool = false
    let isLoading: Bool
    let onTap: () -> Void

    private var activeCount: Int {
        userLoans?.summary.activeCount ?? 0
    }

    private var pendingCount: Int {
        userLoans?.summary.pendingCount ?? 0
    }

    private var activeRemaining: Money {
        userLoans?.summary.activeRemaining ?? .zero(.cop)
    }

    private var maxLoanAmount: Money {
        config?.maxAmount ?? Money(minorUnits: 10_000_000_00, currency: .cop)
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("Créditos")
                        .font(.system(.subheadline, design: .serif).weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    Circle()
                        .fill(pendingCount > 0 ? Theme.warning : (activeCount > 0 ? Theme.positive : Theme.ink.opacity(0.45)))
                        .frame(width: 7, height: 7)
                }

                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 110)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 4) {
                            HStack(spacing: 4) {
                                Image(systemName: "banknote.fill")
                                    .font(.system(size: 10, weight: .bold))
                                Text("30–360d")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .foregroundStyle(.white.opacity(0.88))

                            Spacer(minLength: 4)

                            Text("Pagaré")
                                .font(.system(size: 8.5, weight: .bold))
                                .foregroundStyle(.white.opacity(0.95))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2.5)
                                .background(.white.opacity(0.16), in: Capsule())
                        }

                        Spacer(minLength: 0)

                        VStack(alignment: .leading, spacing: 1) {
                            if activeCount > 0 {
                                Text("Saldo por pagar")
                                    .font(.system(size: 8.5, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.75))
                                Text(verbatim: hideAmounts ? activeRemaining.maskedString : activeRemaining.formatted())
                                    .font(.system(size: 13.5, weight: .bold, design: .rounded))
                                    .monospacedDigit()
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
                            } else if pendingCount > 0 {
                                Text("Solicitud enviada")
                                    .font(.system(size: 8.5, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.75))
                                Text("En estudio")
                                    .font(.system(size: 13.5, weight: .bold, design: .rounded))
                                    .foregroundStyle(Color(red: 0.98, green: 0.82, blue: 0.44))
                                    .lineLimit(1)
                            } else {
                                Text("Cupo hasta")
                                    .font(.system(size: 8.5, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.75))
                                Text(verbatim: hideAmounts ? maxLoanAmount.maskedString : maxLoanAmount.formatted())
                                    .font(.system(size: 13.5, weight: .bold, design: .rounded))
                                    .monospacedDigit()
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.70)
                            }
                        }

                        HStack(alignment: .center) {
                            if activeCount > 0 {
                                Text(verbatim: "\(activeCount) activo\(activeCount == 1 ? "" : "s")")
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.86))
                            } else if pendingCount > 0 {
                                Text(verbatim: "\(pendingCount) pendiente\(pendingCount == 1 ? "" : "s")")
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.86))
                            } else {
                                Text("Desembolso inmediato")
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.84))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.80)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                    .padding(11)
                    .frame(maxWidth: .infinity, minHeight: 98)
                    .background(
                        LinearGradient(
                            colors: [
                                Color(red: 0.07, green: 0.10, blue: 0.13),
                                Color(red: 0.11, green: 0.18, blue: 0.22),
                                Color(red: 0.08, green: 0.27, blue: 0.26)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: 14)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(.white.opacity(0.18), lineWidth: 0.8)
                    )

                    HStack(spacing: 4) {
                        Text(activeCount > 0 ? "Ver mi crédito" : (pendingCount > 0 ? "Ver solicitud" : "Solicitar crédito"))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(activeCount > 0 ? .primary : Theme.spruce)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 2)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 190, alignment: .top)
            .contentShape(.rect(cornerRadius: Theme.cardRadius))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Theme.cardRadius))
        .accessibilityLabel(Text("Créditos CuyPay"))
    }
}

// MARK: - Beneficiarios (acciones rápidas)

struct BeneficiariesQuickCard: View {
    let beneficiaries: [Beneficiary]
    let onSelect: (Beneficiary) -> Void
    let onAdd: () -> Void
    var onSeeAll: (() -> Void)? = nil

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 3)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Beneficiarios")
                    .font(.system(.subheadline, design: .serif).weight(.semibold))
                Spacer()
                if let onSeeAll {
                    Button(action: onSeeAll) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Ver todos los beneficiarios"))
                }
            }

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
        case .cardPocket: (isIncoming ? "arrow.uturn.backward" : "creditcard.fill", Theme.spruce)
        case .cardPurchase: ("bag.fill", Theme.ink)
        case .savings: (isIncoming ? "arrow.down.left" : "lock.rotation", isIncoming ? Theme.positive : Theme.spruce)
        case .loan: (isIncoming ? "banknote.fill" : "checkmark.seal.fill", isIncoming ? Theme.positive : Theme.spruce)
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
        case .cardPocket: isIncoming ? "Desde tarjeta" : "Recarga tarjeta"
        case .cardPurchase: "Compra tarjeta"
        case .savings: isIncoming ? "Reintegro ahorro" : "Bolsillo de ahorro"
        case .loan: isIncoming ? "Desembolso crédito" : "Pago crédito"
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
