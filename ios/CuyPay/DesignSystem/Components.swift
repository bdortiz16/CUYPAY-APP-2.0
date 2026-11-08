import SwiftUI

// MARK: - Logo

/// Wordmark "CUYPAY" con el isotipo (cuadro redondeado con punto), inspirado en cuypay.com.
struct CuyPayLogo: View {
    var size: CGFloat = 20
    var color: Color = .primary

    var body: some View {
        HStack(spacing: size * 0.4) {
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                    .stroke(Theme.spruce, lineWidth: size * 0.14)
                    .frame(width: size, height: size)
                Circle()
                    .fill(Theme.coral)
                    .frame(width: size * 0.26, height: size * 0.26)
            }
            Text(verbatim: "CUYPAY")
                .font(.system(size: size * 0.95, weight: .heavy, design: .rounded))
                .tracking(size * 0.08)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "CuyPay"))
    }
}

// MARK: - Avatar

/// Avatar con iniciales y degradado determinístico por nombre.
struct AvatarView: View {
    let initials: String
    var size: CGFloat = 44
    var seed: String = ""

    private var gradient: LinearGradient {
        // Degradados derivados de la paleta de marca (Zarta Studio).
        let palettes: [[Color]] = [
            [Theme.spruceSolid, Theme.jetBlack],
            [Theme.coral, Color(red: 0.788, green: 0.290, blue: 0.298)],
            [Theme.slate, Theme.spruceSolid],
            [Color(red: 0.165, green: 0.302, blue: 0.333), Theme.onyx],
            [Color(red: 0.992, green: 0.596, blue: 0.565), Theme.coral],
        ]
        let key = seed.isEmpty ? initials : seed
        let index = key.unicodeScalars.reduce(0) { $0 &+ Int($1.value) } % palettes.count
        return LinearGradient(colors: palettes[index], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    var body: some View {
        Text(verbatim: initials.isEmpty ? "?" : initials)
            .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(gradient, in: .circle)
            .overlay(Circle().stroke(.white.opacity(0.6), lineWidth: 1.5))
            .accessibilityHidden(true)
    }
}

// MARK: - Botón circular de vidrio

struct GlassCircleButton: View {
    let systemImage: String
    let accessibilityLabel: LocalizedStringKey
    var size: CGFloat = 44
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: size, height: size)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(Text(accessibilityLabel))
    }
}

// MARK: - Tarjeta de vidrio

struct GlassCard<Content: View>: View {
    var cornerRadius: CGFloat = Theme.cardRadius
    var padding: CGFloat = 16
    var tint: Color? = nil
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(tint), in: .rect(cornerRadius: cornerRadius))
    }
}

// MARK: - Badge de estado

struct StatusBadge: View {
    let text: LocalizedStringKey
    let color: Color
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.bold))
            }
            Text(text)
                .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: .capsule)
    }
}

extension BeneficiaryStatus {
    var badgeText: LocalizedStringKey {
        switch self {
        case .active: "Activo"
        case .pendingReview: "En revisión"
        case .rejected: "Rechazado"
        case .unknown: "Desconocido"
        }
    }

    var badgeColor: Color {
        switch self {
        case .active: Theme.positive
        case .pendingReview: Theme.warning
        case .rejected: Theme.negative
        case .unknown: .secondary
        }
    }

    var badgeIcon: String {
        switch self {
        case .active: "checkmark.seal.fill"
        case .pendingReview: "clock.fill"
        case .rejected: "xmark.octagon.fill"
        case .unknown: "questionmark.circle"
        }
    }
}

extension KYCStatus {
    var badgeText: LocalizedStringKey {
        switch self {
        case .notStarted: "Sin verificar"
        case .pending: "En revisión"
        case .approved: "Verificado"
        case .rejected: "No aprobado"
        case .retry: "Requiere corrección"
        case .unknown: "Desconocido"
        }
    }

    var badgeColor: Color {
        switch self {
        case .approved: Theme.positive
        case .pending, .retry: Theme.warning
        case .rejected: Theme.negative
        case .notStarted, .unknown: .secondary
        }
    }
}

// MARK: - Botón principal

/// Botón principal de marca (vidrio prominente con tinte Blue Spruce y texto blanco).
struct PrimaryButton: View {
    let title: LocalizedStringKey
    var systemImage: String? = nil
    var isLoading: Bool = false
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .tint(.white)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .foregroundStyle(.white)
        }
        .buttonStyle(.glassProminent)
        .tint(Theme.spruceSolid)
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .disabled(!isEnabled || isLoading)
    }
}

/// Botón secundario de vidrio.
struct SecondaryButton: View {
    let title: LocalizedStringKey
    var systemImage: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text(title).fontWeight(.medium)
            } icon: {
                if let systemImage { Image(systemName: systemImage) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
        .buttonBorderShape(.capsule)
    }
}

// MARK: - Fila clave/valor

struct DetailRow: View {
    let title: LocalizedStringKey
    let value: String
    var systemImage: String? = nil
    var emphasized: Bool = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Theme.spruce)
                    .frame(width: 20)
            }
            Text(title)
                .foregroundStyle(emphasized ? .primary : .secondary)
            Spacer(minLength: 12)
            Text(verbatim: value)
                .fontWeight(emphasized ? .bold : .semibold)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Mensaje de error

struct ErrorBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.negative)
            Text(verbatim: message)
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .glassEffect(.regular.tint(Theme.negative.opacity(0.12)), in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Bandera + moneda

struct CurrencyChip: View {
    let currency: Currency

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: currency.flag)
            Text(verbatim: currency.code)
                .font(.subheadline.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
        .accessibilityLabel(Text(verbatim: currency.displayName))
    }
}

#Preview("Componentes") {
    ZStack {
        BrandBackground()
        VStack(spacing: 16) {
            CuyPayLogo(size: 24)
            HStack {
                AvatarView(initials: "AG")
                GlassCircleButton(systemImage: "bell", accessibilityLabel: "Notificaciones") {}
                StatusBadge(text: "Activo", color: Theme.positive, systemImage: "checkmark.seal.fill")
            }
            GlassCard {
                DetailRow(title: "Costo de envío", value: "$ 0", systemImage: "minus")
            }
            PrimaryButton(title: "Enviar dinero ahora") {}
            SecondaryButton(title: "Más tarde") {}
            ErrorBanner(message: "No tienes saldo suficiente para esta operación.")
        }
        .padding()
    }
}

// MARK: - Botón cerrar (toolbar)

struct CloseToolbarButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
        }
        .accessibilityLabel(Text("Cerrar"))
    }
}
