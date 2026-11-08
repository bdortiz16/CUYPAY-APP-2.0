import SwiftUI

@main
struct CuyPayApp: App {
    @State private var model = AppModel.live()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .appEnvironment(model)
                .tint(Theme.spruce)
                .onChange(of: scenePhase) { _, newPhase in
                    model.handleScenePhase(newPhase)
                }
        }
    }
}

extension View {
    /// Inyecta `AppModel` y su `WalletStore` en el entorno (app y previews).
    @MainActor
    func appEnvironment(_ model: AppModel) -> some View {
        environment(model)
            .environment(model.store)
    }
}

/// Raíz: decide entre onboarding, login y la app; aplica la cubierta de privacidad y el bloqueo.
struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            switch app.route {
            case .launching:
                SplashView()
            case .onboarding:
                OnboardingFlowView()
                    .transition(.opacity)
            case .login:
                LoginView()
                    .transition(.opacity)
            case .main:
                HomeView()
                    .transition(.opacity)
            }

            if app.isLocked && app.route == .main {
                LockView()
                    .transition(.opacity)
                    .zIndex(2)
            }

            if app.isPrivacyCoverVisible {
                PrivacyCoverView()
                    .transition(.opacity)
                    .zIndex(3)
            }
        }
        .task { await app.bootstrap() }
    }
}

struct SplashView: View {
    var body: some View {
        ZStack {
            BrandBackground()
            CuyPayLogo(size: 32)
        }
    }
}

/// Cubierta borrosa cuando la app pasa a segundo plano (oculta saldos en el selector de apps).
struct PrivacyCoverView: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)
            BrandBackground().opacity(0.6)
            VStack(spacing: 12) {
                CuyPayLogo(size: 30)
                Image(systemName: "lock.fill")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// Bloqueo tras más de 2 minutos en segundo plano.
struct LockView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            Rectangle().fill(.regularMaterial).ignoresSafeArea()
            VStack(spacing: 28) {
                Spacer()
                CuyPayLogo(size: 28)
                Image(systemName: "faceid")
                    .font(.system(size: 64, weight: .light))
                    .foregroundStyle(Theme.spruce)
                    .symbolEffect(.pulse, options: .repeating)
                Text("CuyPay está bloqueado")
                    .font(.title3.weight(.semibold))
                Text("Por tu seguridad, confirma que eres tú para continuar.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Spacer()
                VStack(spacing: 12) {
                    PrimaryButton(title: "Desbloquear con Face ID", systemImage: "faceid") {
                        Task { await app.unlock() }
                    }
                    Button("Cerrar sesión") {
                        Task { await app.logout() }
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                }
            }
            .padding(24)
        }
    }
}

#Preview("Bloqueo") {
    LockView()
        .environment(AppModel.preview())
}
