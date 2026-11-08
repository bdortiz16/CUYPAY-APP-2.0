import SwiftUI

/// Límites diarios / mensuales / anuales por operación (en COP equivalente, zona America/Bogota).
struct LimitsView: View {
    @Environment(WalletStore.self) private var store

    var body: some View {
        ZStack {
            BrandBackground()
            ScrollView {
                VStack(spacing: 16) {
                    if let limits = store.limits {
                        HStack {
                            Label {
                                Text(limits.tier == .full ? LocalizedStringKey("Nivel completo") : LocalizedStringKey("Nivel básico"))
                            } icon: {
                                Image(systemName: "rosette")
                            }
                            .font(.subheadline.weight(.semibold))
                            Spacer()
                            Text("Montos en COP")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 4)

                        ForEach(limits.operations, id: \.self) { operation in
                            LimitOperationCard(operation: operation, items: limits.items(for: operation), currency: limits.currency)
                        }

                        Label("Los límites se reinician cada día, mes y año calendario (hora de Colombia).", systemImage: "info.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                    } else {
                        ProgressView()
                            .padding(.top, 80)
                    }
                }
                .padding(Theme.horizontalPadding)
            }
            .refreshable { await store.refreshLimits() }
        }
        .navigationTitle("Límites")
        .task { await store.refreshLimits() }
    }
}

struct LimitOperationCard: View {
    let operation: LimitOperation
    let items: [LimitItem]
    let currency: Currency

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(operation.title, systemImage: operation.systemImage)
                .font(.headline)
                .symbolRenderingMode(.hierarchical)
            ForEach(items) { item in
                LimitProgressRow(item: item, currency: currency)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))
    }
}

struct LimitProgressRow: View {
    let item: LimitItem
    let currency: Currency

    private var barColor: Color {
        if item.isExhausted { return Theme.negative }
        if item.isNearLimit { return Theme.warning }
        return Theme.spruce
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: item.period.title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("Te quedan \(Money(minorUnits: item.remainingMinor, currency: currency).formatted())")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(item.isExhausted ? Theme.negative : .primary)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(.primary.opacity(0.08))
                    Capsule()
                        .fill(barColor.gradient)
                        .frame(width: max(item.usedFraction > 0 ? 8 : 0, proxy.size.width * item.usedFraction))
                }
            }
            .frame(height: 10)
            .animation(.smooth, value: item.usedFraction)
            HStack {
                Text("Usado \(Money(minorUnits: item.usedMinor, currency: currency).formatted())")
                Spacer()
                Text("Límite \(Money(minorUnits: item.limitMinor, currency: currency).formatted())")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: item.period.title))
        .accessibilityValue(Text("Te quedan \(Money(minorUnits: item.remainingMinor, currency: currency).formatted()) de \(Money(minorUnits: item.limitMinor, currency: currency).formatted())"))
    }
}

#Preview {
    NavigationStack {
        LimitsView()
    }
    .appEnvironment(.preview())
}
