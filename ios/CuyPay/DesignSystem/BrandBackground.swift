import SwiftUI

/// Fondo esmerilado claro (blanco → #E1E3EA) con manchas Blue Spruce / Dark Slate Grey y un toque de coral,
/// para que el Liquid Glass se lea bien. En modo oscuro usa Onyx → Jet Black.
struct BrandBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            LinearGradient(
                colors: colorScheme == .dark
                    ? [Theme.jetBlack, Theme.onyx]
                    : [Color.white, Theme.mist],
                startPoint: .top,
                endPoint: .bottom
            )

            GeometryReader { proxy in
                let size = proxy.size
                ZStack {
                    Circle()
                        .fill(Theme.spruceSolid.opacity(colorScheme == .dark ? 0.35 : 0.22))
                        .frame(width: size.width * 0.9)
                        .offset(x: -size.width * 0.35, y: -size.height * 0.30)
                    Circle()
                        .fill(Theme.slate.opacity(colorScheme == .dark ? 0.12 : 0.45))
                        .frame(width: size.width * 0.8)
                        .offset(x: size.width * 0.40, y: -size.height * 0.05)
                    Circle()
                        .fill(Theme.coral.opacity(colorScheme == .dark ? 0.08 : 0.10))
                        .frame(width: size.width * 1.0)
                        .offset(x: -size.width * 0.1, y: size.height * 0.42)
                }
                .frame(width: size.width, height: size.height)
                .blur(radius: 70)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

#Preview {
    BrandBackground()
}
