import SwiftUI

/// Ingreso sin contraseña: desafío del backend firmado con la clave del Secure Enclave (Face ID).
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var attemptedAutomatically = false
    @State private var showForgetConfirmation = false

    var body: some View {
        ZStack {
            BrandBackground()
            VStack(spacing: 28) {
                CuyPayLogo(size: 28)
                    .padding(.top, 40)
                Spacer()

                VStack(spacing: 14) {
                    Button {
                        Task { await app.loginWithFaceID() }
                    } label: {
                        Image(systemName: "faceid")
                            .font(.system(size: 64, weight: .light))
                            .foregroundStyle(Theme.mint)
                            .frame(width: 132, height: 132)
                            .symbolEffect(.pulse, options: .repeating, isActive: app.isAuthenticating)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel(Text("Ingresar con Face ID"))

                    Text("Hola de nuevo")
                        .font(.system(.title, design: .rounded).weight(.bold))
                    Text("Ingresa a CuyPay con Face ID. Sin contraseñas.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                if let error = app.loginError {
                    ErrorBanner(message: error)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                Spacer()

                VStack(spacing: 12) {
                    PrimaryButton(title: "Ingresar con Face ID", systemImage: "faceid", isLoading: app.isAuthenticating) {
                        Task { await app.loginWithFaceID() }
                    }
                    Button("¿No eres tú? Usar otra cuenta") {
                        showForgetConfirmation = true
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                }
            }
            .padding(24)
            .animation(.smooth, value: app.loginError)
        }
        .sensoryFeedback(.error, trigger: app.loginError) { _, newValue in newValue != nil }
        .confirmationDialog(
            "¿Desvincular este dispositivo?",
            isPresented: $showForgetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Desvincular y registrarme de nuevo", role: .destructive) {
                Task { await app.forgetDevice() }
            }
        } message: {
            Text("Borraremos la llave segura de este iPhone. Podrás registrarte con otro número.")
        }
        .task {
            guard !attemptedAutomatically else { return }
            attemptedAutomatically = true
            try? await Task.sleep(for: .milliseconds(400))
            await app.loginWithFaceID()
        }
    }
}

#Preview {
    LoginView()
        .appEnvironment(.preview(route: .login))
}
