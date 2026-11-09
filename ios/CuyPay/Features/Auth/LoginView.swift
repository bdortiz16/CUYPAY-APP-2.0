import SwiftUI

/// Ingreso sin contraseña: desafío del backend firmado con la clave del Secure Enclave (Face ID).
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var attemptedAutomatically = false
    @State private var showForgetConfirmation = false
    @State private var showPasswordLogin = false

    var body: some View {
        ZStack {
            BrandBackground()
            VStack(spacing: 24) {
                CuyPayLogo(size: 26)
                    .padding(.top, 28)

                Spacer()

                // Hero Card biométrica de alta gama
                VStack(spacing: 22) {
                    ZStack {
                        // Resplandor exterior sutil
                        Circle()
                            .fill(Theme.spruce.opacity(0.12))
                            .frame(width: 140, height: 140)
                            .scaleEffect(app.isAuthenticating ? 1.06 : 1.0)
                            .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: app.isAuthenticating)

                        Circle()
                            .fill(Theme.spruce.opacity(0.08))
                            .frame(width: 114, height: 114)

                        Button {
                            Task { await app.loginWithFaceID() }
                        } label: {
                            Image(systemName: "faceid")
                                .font(.system(size: 50, weight: .light))
                                .foregroundStyle(Theme.spruce)
                                .frame(width: 90, height: 90)
                                .symbolEffect(.pulse, options: .repeating, isActive: app.isAuthenticating)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(.regular.interactive(), in: .circle)
                        .accessibilityLabel(Text("Ingresar con Face ID"))
                    }

                    VStack(spacing: 8) {
                        Text("Hola de nuevo")
                            .font(.system(.title2, design: .rounded).weight(.bold))
                            .foregroundStyle(Theme.ink)

                        Text("Ingresa con tu biometría segura")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "lock.shield.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.spruce)
                        Text("Secure Enclave · Cifrado punto a punto")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Theme.spruce.opacity(0.08), in: .capsule)
                }
                .padding(.vertical, 28)
                .padding(.horizontal, 20)
                .frame(maxWidth: .infinity)
                .glassEffect(.regular, in: .rect(cornerRadius: Theme.cardRadius))

                if let error = app.loginError {
                    GlassCard(tint: Theme.negative.opacity(0.08)) {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(Theme.negative)
                                    .font(.subheadline)
                                    .padding(.top, 1)

                                Text(error)
                                    .font(.footnote)
                                    .foregroundStyle(.primary)

                                Spacer(minLength: 0)
                            }

                            Button {
                                showPasswordLogin = true
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "key.fill")
                                    Text("Ingresar con contraseña")
                                }
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Theme.spruceSolid)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                Spacer()

                VStack(spacing: 14) {
                    PrimaryButton(title: "Ingresar con Face ID", systemImage: "faceid", isLoading: app.isAuthenticating) {
                        Task { await app.loginWithFaceID() }
                    }

                    Button {
                        showPasswordLogin = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "key.horizontal")
                            Text("Ingresar con contraseña")
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.spruceSolid)
                        .padding(.vertical, 6)
                    }

                    Button {
                        showForgetConfirmation = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "person.crop.circle.badge.questionmark")
                            Text("¿No eres tú? Usar otra cuenta")
                        }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                    }
                }
            }
            .padding(20)
            .animation(.smooth, value: app.loginError)
        }
        .sensoryFeedback(.error, trigger: app.loginError) { _, newValue in newValue != nil }
        .sheet(isPresented: $showPasswordLogin) {
            PasswordLoginSheet()
        }
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

// MARK: - Hoja de login con contraseña

struct PasswordLoginSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var phoneDigits = ""
    @State private var password = ""
    @State private var errorMessage: String?
    @FocusState private var focused: Field?

    private enum Field { case phone, password }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                VStack(spacing: 20) {
                    VStack(spacing: 8) {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(Theme.spruce)
                        Text("Ingresar con contraseña")
                            .font(.title2.weight(.bold))
                        Text("Escribe tu número de celular y contraseña de CuyPay")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 16)

                    VStack(spacing: 14) {
                        HStack(spacing: 10) {
                            Text(verbatim: "🇨🇴 +57")
                                .font(.body.weight(.semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 14)
                                .glassEffect(.regular, in: .rect(cornerRadius: 16))

                            TextField("300 123 4567", text: $phoneDigits)
                                .keyboardType(.numberPad)
                                .textContentType(.telephoneNumber)
                                .focused($focused, equals: .phone)
                                .padding(14)
                                .glassEffect(.regular, in: .rect(cornerRadius: 16))
                        }

                        SecureField("Contraseña o PIN", text: $password)
                            .textContentType(.password)
                            .focused($focused, equals: .password)
                            .padding(14)
                            .glassEffect(.regular, in: .rect(cornerRadius: 16))

                        if let error = errorMessage {
                            ErrorBanner(message: error)
                        }
                    }

                    Spacer()

                    PrimaryButton(
                        title: "Ingresar",
                        isLoading: app.isAuthenticating,
                        isEnabled: phoneDigits.filter(\.isASCIIDigit).count >= 10 && password.count >= 4
                    ) {
                        Task {
                            errorMessage = nil
                            let success = await app.loginWithPassword(phone: phoneDigits, password: password)
                            if success {
                                dismiss()
                            } else {
                                errorMessage = app.loginError ?? "Celular o contraseña incorrectos"
                            }
                        }
                    }
                }
                .padding(24)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancelar") { dismiss() }
                        .foregroundStyle(Theme.spruceSolid)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { focused = .phone }
    }
}

#Preview {
    LoginView()
        .appEnvironment(.preview(route: .login))
}
