import SwiftUI

/// Contenedor del onboarding (NavigationStack con pasos).
struct OnboardingFlowView: View {
    @Environment(AppModel.self) private var app
    @State private var model = OnboardingModel()

    var body: some View {
        NavigationStack(path: $model.path) {
            WelcomeView(model: model)
                .navigationDestination(for: OnboardingModel.Step.self) { step in
                    switch step {
                    case .phone:
                        PhoneEntryView(model: model)
                    case .otp:
                        OTPEntryView(model: model)
                    case .profile:
                        ProfileSetupView(model: model)
                    case .password:
                        PasswordSetupView(model: model)
                    case .faceID:
                        FaceIDEnrollmentView(model: model)
                    case .kycIntro:
                        KYCIntroView {
                            model.path.append(.kycStatus)
                        } onSkip: {
                            finish()
                        }
                        .navigationBarBackButtonHidden()
                    case .kycStatus:
                        KYCStatusView(startsVerificationIfNeeded: false) {
                            finish()
                        }
                        .navigationBarBackButtonHidden()
                    }
                }
        }
    }

    private func finish() {
        if let user = app.user {
            app.didAuthenticate(user)
        } else {
            Task {
                await app.refreshUser()
                if let user = app.user {
                    app.didAuthenticate(user)
                } else {
                    await app.forgetDevice()
                }
            }
        }
    }
}

// MARK: - Bienvenida

struct WelcomeView: View {
    @Environment(AppModel.self) private var app
    let model: OnboardingModel
    @State private var appeared = false
    @State private var showPasswordLogin = false

    var body: some View {
        ZStack {
            BrandBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    CuyPayLogo(size: 26)
                        .padding(.top, 24)

                    Text("Tu dinero entre Colombia y Brasil, \(Text("al mejor precio").foregroundStyle(Theme.coral))")
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)

                    Text("Recibe en COP con Bre-B, ahorra con intereses, pide créditos y envía al instante.")
                        .font(.title3)
                        .foregroundStyle(.secondary)

                    GlassEffectContainer(spacing: 14) {
                        VStack(spacing: 14) {
                            ValuePropRow(
                                systemImage: "arrow.down.left.circle.fill",
                                title: "Recibe en COP con Bre-B",
                                subtitle: "Tu propia llave Bre-B al instante desde cualquier banco."
                            )
                            ValuePropRow(
                                systemImage: "creditcard.circle.fill",
                                title: "Tarjeta Virtual, Ahorro y Créditos",
                                subtitle: "Paga con Apple Pay, bloquea ahorro con intereses o solicita crédito."
                            )
                            ValuePropRow(
                                systemImage: "paperplane.circle.fill",
                                title: "Envía al instante sin 4x1000",
                                subtitle: "Pagos Bre-B 24/7 a tus beneficiarios inscritos."
                            )
                        }
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 20)

                    Label("Protegido con Face ID y Secure Enclave", systemImage: "lock.shield.fill")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                PrimaryButton(title: "Crear cuenta", systemImage: "person.badge.plus") {
                    model.path.append(.phone)
                }
                SecondaryButton(title: "Ya tengo cuenta · Iniciar sesión", systemImage: "person.crop.circle.badge.checkmark") {
                    showPasswordLogin = true
                }
                if app.environment.isMock {
                    Button("Explorar modo demo") {
                        app.enterDemo()
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.spruce)
                    .padding(.top, 2)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showPasswordLogin) {
            PasswordLoginSheet()
        }
        .onAppear {
            withAnimation(.smooth(duration: 0.8).delay(0.15)) { appeared = true }
        }
    }
}

private struct ValuePropRow: View {
    let systemImage: String
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 30))
                .foregroundStyle(Theme.spruce)
                .symbolRenderingMode(.hierarchical)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Teléfono

struct PhoneEntryView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: OnboardingModel
    @FocusState private var focused: Bool

    var body: some View {
        OnboardingScaffold(
            title: "¿Cuál es tu celular?",
            subtitle: "Te enviaremos un código de 6 dígitos por WhatsApp para verificarlo."
        ) {
            HStack(spacing: 12) {
                Text(verbatim: "🇨🇴 +57")
                    .font(.title3.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 18))
                TextField("300 123 4567", text: $model.phoneDigits)
                    .keyboardType(.numberPad)
                    .textContentType(.telephoneNumber)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .focused($focused)
                    .padding(14)
                    .glassEffect(.regular, in: .rect(cornerRadius: 18))
                    .onChange(of: model.phoneDigits) { model.sanitizePhone() }
                    .accessibilityLabel(Text("Número de celular"))
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
        } footer: {
            PrimaryButton(title: "Enviar código", isLoading: model.isLoading, isEnabled: model.isPhoneValid) {
                Task { await model.requestOTP(api: app.api) }
            }
        }
        .onAppear { focused = true }
    }
}

// MARK: - OTP

struct OTPEntryView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: OnboardingModel
    @FocusState private var focused: Bool

    var body: some View {
        OnboardingScaffold(
            title: "Ingresa el código",
            subtitle: "Lo enviamos a tu WhatsApp \(model.formattedPhone)."
        ) {
            ZStack {
                TextField("", text: $model.otpCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focused)
                    .opacity(0.02)
                    .onChange(of: model.otpCode) {
                        model.sanitizeOTP()
                        if model.isOTPComplete {
                            Task { await model.confirmOTP(api: app.api) }
                        }
                    }
                    .accessibilityLabel(Text("Código de verificación"))
                HStack(spacing: 10) {
                    ForEach(0..<6, id: \.self) { index in
                        let characters = Array(model.otpCode)
                        Text(verbatim: index < characters.count ? String(characters[index]) : "")
                            .font(.title.weight(.semibold))
                            .monospacedDigit()
                            .frame(maxWidth: .infinity, minHeight: 60)
                            .glassEffect(
                                index == characters.count ? Glass.regular.tint(Theme.spruce.opacity(0.25)) : Glass.regular,
                                in: .rect(cornerRadius: 16)
                            )
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .contentShape(.rect)
            .onTapGesture { focused = true }

            if app.environment.isMock {
                Label("Entorno demo: usa el código 123456", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            Button("Reenviar código por WhatsApp") {
                Task { await model.requestOTP(api: app.api) }
            }
            .font(.subheadline.weight(.semibold))
            .disabled(model.isLoading)
        } footer: {
            PrimaryButton(title: "Verificar código", isLoading: model.isLoading, isEnabled: model.isOTPComplete) {
                Task { await model.confirmOTP(api: app.api) }
            }
        }
        .onAppear { focused = true }
    }
}

// MARK: - Datos del cliente (Nombre + Correo real)

struct ProfileSetupView: View {
    @Bindable var model: OnboardingModel
    @FocusState private var focusedField: Field?

    private enum Field {
        case firstName
        case lastName
        case email
    }

    var body: some View {
        OnboardingScaffold(
            title: "Tus datos de contacto",
            subtitle: "Ingresa tu nombre real y tu correo personal. Ahí recibirás los códigos de verificación de tu tarjeta virtual y Apple Wallet."
        ) {
            VStack(spacing: 16) {
                TextField("Nombres (como aparecen en tu documento)", text: $model.firstName)
                    .textContentType(.givenName)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .firstName)
                    .onSubmit { focusedField = .lastName }
                    .formFieldStyle()
                    .accessibilityLabel(Text("Nombres"))

                TextField("Apellidos", text: $model.lastName)
                    .textContentType(.familyName)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .lastName)
                    .onSubmit { focusedField = .email }
                    .formFieldStyle()
                    .accessibilityLabel(Text("Apellidos"))

                TextField("Correo electrónico", text: $model.email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focusedField, equals: .email)
                    .formFieldStyle()
                    .accessibilityLabel(Text("Correo electrónico"))

                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "envelope.badge.shield.half.filled")
                        .foregroundStyle(Theme.spruce)
                        .padding(.top, 2)
                    Text("Los códigos de seguridad de Apple Wallet y compras en línea llegarán a este correo y a tu celular \(model.formattedPhone).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)

                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
            }
        } footer: {
            PrimaryButton(title: "Continuar", isEnabled: model.isProfileValid) {
                model.confirmProfileStep()
            }
        }
        .onAppear { focusedField = .firstName }
    }
}

// MARK: - Contraseña / PIN

struct PasswordSetupView: View {
    @Bindable var model: OnboardingModel
    @FocusState private var focusedField: Field?

    private enum Field {
        case password
        case confirm
    }

    var body: some View {
        OnboardingScaffold(
            title: "Crea tu contraseña",
            subtitle: "La usarás para ingresar a CuyPay si Face ID no está disponible."
        ) {
            VStack(spacing: 16) {
                SecureField("Contraseña o PIN (mín. 4 dígitos)", text: $model.password)
                    .font(.body.weight(.medium))
                    .textContentType(.newPassword)
                    .focused($focusedField, equals: .password)
                    .formFieldStyle()
                    .accessibilityLabel(Text("Nueva contraseña"))

                SecureField("Confirma tu contraseña", text: $model.confirmPassword)
                    .font(.body.weight(.medium))
                    .textContentType(.newPassword)
                    .focused($focusedField, equals: .confirm)
                    .formFieldStyle()
                    .accessibilityLabel(Text("Confirmar contraseña"))

                HStack(spacing: 8) {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(Theme.spruce)
                    Text("Protege tu dinero y tus llaves Bre-B")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 4)

                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
            }
        } footer: {
            PrimaryButton(title: "Continuar", isEnabled: model.isPasswordValid) {
                model.confirmPasswordStep()
            }
        }
        .onAppear { focusedField = .password }
    }
}

// MARK: - Face ID

struct FaceIDEnrollmentView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: OnboardingModel

    var body: some View {
        OnboardingScaffold(
            title: "Activa Face ID",
            subtitle: "Creamos una llave única dentro del Secure Enclave de tu iPhone. Nunca sale del dispositivo y la usamos para autorizar tus ingresos, envíos y conversiones."
        ) {
            VStack(spacing: 20) {
                Image(systemName: "faceid")
                    .font(.system(size: 88, weight: .thin))
                    .foregroundStyle(Theme.spruce)
                    .symbolEffect(.bounce, value: model.isLoading)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Sin contraseñas: ingresas con tu rostro", systemImage: "person.crop.circle.badge.checkmark")
                        Label("Cada operación sensible pide Face ID", systemImage: "hand.raised.fill")
                        Label("Si cambias tu Face ID, deberás registrar el dispositivo de nuevo", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .font(.subheadline)
                    .symbolRenderingMode(.hierarchical)
                }

                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
            }
        } footer: {
            PrimaryButton(title: "Activar Face ID", systemImage: "faceid", isLoading: model.isLoading) {
                Task { await model.enrollAndRegister(app: app) }
            }
        }
    }
}

// MARK: - Andamiaje común

struct OnboardingScaffold<Content: View, Footer: View>: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer

    var body: some View {
        ZStack {
            BrandBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(title)
                        .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    Text(subtitle)
                        .font(.body)
                        .foregroundStyle(.secondary)
                    content
                }
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .safeAreaInset(edge: .bottom) {
            footer
                .padding(.horizontal, 24)
                .padding(.bottom, 8)
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension View {
    /// Campo de texto con vidrio.
    func formFieldStyle() -> some View {
        self
            .font(.body.weight(.medium))
            .padding(16)
            .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }
}

#Preview("Bienvenida") {
    OnboardingFlowView()
        .appEnvironment(.preview(route: .onboarding))
}

#Preview("Face ID") {
    NavigationStack {
        FaceIDEnrollmentView(model: OnboardingModel())
    }
    .appEnvironment(.preview(route: .onboarding))
}
