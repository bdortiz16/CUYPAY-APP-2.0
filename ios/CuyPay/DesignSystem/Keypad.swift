import SwiftUI

/// Teclado numérico de vidrio para montos (sin `Double`, ver `AmountInput`).
struct AmountKeypad: View {
    @Binding var input: AmountInput
    @State private var tapCount = 0
    @State private var rejectCount = 0

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)

    private enum Key: Hashable {
        case digit(Int)
        case decimal
        case delete
        case empty
    }

    private var keys: [Key] {
        (1...9).map { Key.digit($0) } + [input.allowsFraction ? .decimal : .empty, .digit(0), .delete]
    }

    var body: some View {
        GlassEffectContainer(spacing: 12) {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(keys, id: \.self) { key in
                    keyView(key)
                }
            }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: tapCount)
        .sensoryFeedback(.error, trigger: rejectCount)
    }

    @ViewBuilder
    private func keyView(_ key: Key) -> some View {
        switch key {
        case .digit(let digit):
            keyButton(label: Text(verbatim: "\(digit)"), accessibility: Text(verbatim: "\(digit)")) {
                if input.append(digit: digit) { tapCount += 1 } else { rejectCount += 1 }
            }
        case .decimal:
            keyButton(label: Text(verbatim: ","), accessibility: Text("Coma decimal")) {
                if input.appendDecimalSeparator() { tapCount += 1 } else { rejectCount += 1 }
            }
        case .delete:
            keyButton(label: Text(Image(systemName: "delete.left")), accessibility: Text("Borrar")) {
                input.deleteBackward()
                tapCount += 1
            }
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                input.clear()
                tapCount += 1
            })
        case .empty:
            Color.clear.frame(height: 56)
        }
    }

    private func keyButton(label: Text, accessibility: Text, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label
                .font(.title2.weight(.medium))
                .monospacedDigit()
                .frame(maxWidth: .infinity, minHeight: 56)
                .contentShape(.rect(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 18))
        .accessibilityLabel(accessibility)
    }
}

/// Muestra el monto grande que se está escribiendo.
struct AmountDisplay: View {
    let input: AmountInput
    var placeholderColor: Color = .secondary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: input.currency.symbol)
                .font(.system(.title, design: .rounded).weight(.semibold))
                .foregroundStyle(.secondary)
            Text(verbatim: input.isEmpty ? "0" : input.displayString)
                .font(.system(size: 52, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(input.isEmpty ? placeholderColor : .primary)
                .contentTransition(.numericText())
                .animation(.snappy, value: input.displayString)
                .minimumScaleFactor(0.4)
                .lineLimit(1)
            Text(verbatim: input.currency.code)
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: input.money.formatted()))
    }
}

/// Anillo de cuenta regresiva (vigencia de la cotización, 30 s).
struct CountdownRing: View {
    let remaining: Int
    let total: Int
    var size: CGFloat = 34

    private var progress: Double {
        guard total > 0 else { return 0 }
        return Double(max(0, remaining)) / Double(total)
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.spruce.opacity(0.2), lineWidth: 4)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(remaining <= 5 ? Theme.warning : Theme.spruce, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 1), value: remaining)
            Text(verbatim: "\(max(0, remaining))")
                .font(.caption2.weight(.bold))
                .monospacedDigit()
                .contentTransition(.numericText(countsDown: true))
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("La cotización vence en \(max(0, remaining)) segundos"))
    }
}

#Preview("Teclado") {
    @Previewable @State var input = AmountInput(currency: .cop)
    ZStack {
        BrandBackground()
        VStack(spacing: 24) {
            AmountDisplay(input: input)
            CountdownRing(remaining: 18, total: 30)
            AmountKeypad(input: $input)
        }
        .padding()
    }
}
