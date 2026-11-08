import SwiftUI

/// Fondo esmerilado claro con "blobs" mint/teal suaves para que el Liquid Glass se lea bien.
/// En modo oscuro usa el navy de marca.
struct BrandBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            LinearGradient(
                colors: colorScheme == .dark
                    ? [Color(red: 0.05, green: 0.11, blue: 0.14), Color(red: 0.03, green: 0.07, blue: 0.10)]
                    : [Color(red: 0.96, green: 0.97, blue: 0.97), Color(red: 0.91, green: 0.94, blue: 0.94)],
                startPoint: .top,
                endPoint: .bottom
            )

            GeometryReader { proxy in
                let size = proxy.size
                ZStack {
                    Circle()
                        .fill(Theme.mint.opacity(colorScheme == .dark ? 0.22 : 0.28))
                        .frame(width: size.width * 0.9)
                        .offset(x: -size.width * 0.35, y: -size.height * 0.30)
                    Circle()
                        .fill(Color(red: 0.36, green: 0.80, blue: 0.86).opacity(colorScheme == .dark ? 0.16 : 0.22))
                        .frame(width: size.width * 0.8)
                        .offset(x: size.width * 0.40, y: -size.height * 0.05)
                    Circle()
                        .fill(Theme.mint.opacity(colorScheme == .dark ? 0.12 : 0.18))
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
