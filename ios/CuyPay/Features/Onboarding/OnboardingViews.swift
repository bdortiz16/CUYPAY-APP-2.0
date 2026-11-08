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
                        ProfileFormView(model: model)
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
        guard let user = app.user else { return }
        app.didAuthenticate(user)
    }
}

// MARK: - Bienvenida

struct WelcomeView: View {
    @Environment(AppModel.self) private var app
    let model: OnboardingModel
    @State private var appeared = false

    var body: some View {
        ZStack {
            BrandBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    CuyPayLogo(size: 26)
                        .padding(.top, 24)

                    Text("Tu dinero entre Colombia y Brasil, \(Text("al mejor precio").foregroundStyle(Theme.mint))")
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)

                    Text("Recibe en COP con Bre-B, convierte a BRL, envía al instante.")
                        .font(.title3)
                        .foregroundStyle(.secondary)

                    GlassEffectContainer(spacing: 14) {
                        VStack(spacing: 14) {
                            ValuePropRow(
                                systemImage: "arrow.down.left.circle.fill",
                                title: "Recibe en COP con Bre-B",
                                subtitle: "Tu propia llave Bre-B para recibir desde cualquier banco."
                            )
                            ValuePropRow(
                                systemImage: "arrow.left.arrow.right.circle.fill",
                                title: "Convierte a BRL",
                                subtitle: "Tasa transparente y sin costos ocultos."
                            )
                            ValuePropRow(
                                systemImage: "paperplane.circle.fill",
                                title: "Envía al instante",
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
                if app.environment.isMock {
                    SecondaryButton(title: "Explorar demo", systemImage: "sparkles") {
                        app.enterDemo()
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 8)
        }
        .toolbar(.hidden, for: .navigationBar)
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
                .foregroundStyle(Theme.mint)
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
            subtitle: "Te enviaremos un código por SMS para verificarlo."
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
            subtitle: "Lo enviamos al \(model.formattedPhone)."
        ) {
            ZStack {
                TextField("", text: $model.otpCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focused)
                    .opacity(0.02)
                    .onChange(of: model.otpCode) {
                        model.sanitizeOTP()
                        if model.isOTPComplete { model.confirmOTP() }
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
                                index == characters.count ? Glass.regular.tint(Theme.mint.opacity(0.25)) : Glass.regular,
                                in: .rect(cornerRadius: 16)
                            )
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .contentShape(.rect)
            .onTapGesture { focused = true }

            if app.environment.isMock || app.environment.name == "Dev" {
                Label("Entorno de desarrollo: usa el código 123456", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            Button("Reenviar código") {
                Task { await model.requestOTP(api: app.api) }
            }
            .font(.subheadline.weight(.semibold))
            .disabled(model.isLoading)
        } footer: {
            PrimaryButton(title: "Continuar", isEnabled: model.isOTPComplete) {
                model.confirmOTP()
            }
        }
        .onAppear { focused = true }
    }
}

// MARK: - Datos personales

struct ProfileFormView: View {
    @Bindable var model: OnboardingModel
    @FocusState private var field: Field?

    private enum Field { case firstName, lastName, email }

    var body: some View {
        OnboardingScaffold(
            title: "Cuéntanos de ti",
            subtitle: "Usa tu nombre tal como aparece en tu documento de identidad."
        ) {
            VStack(spacing: 12) {
                TextField("Nombres", text: $model.firstName)
                    .textContentType(.givenName)
                    .focused($field, equals: .firstName)
                    .submitLabel(.next)
                    .onSubmit { field = .lastName }
                    .formFieldStyle()
                TextField("Apellidos", text: $model.lastName)
                    .textContentType(.familyName)
                    .focused($field, equals: .lastName)
                    .submitLabel(.next)
                    .onSubmit { field = .email }
                    .formFieldStyle()
                TextField("Correo electrónico", text: $model.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($field, equals: .email)
                    .submitLabel(.done)
                    .onSubmit { model.confirmProfile() }
                    .formFieldStyle()
            }
        } footer: {
            PrimaryButton(title: "Continuar", isEnabled: model.isProfileValid) {
                model.confirmProfile()
            }
        }
        .onAppear { field = .firstName }
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
                    .foregroundStyle(Theme.mint)
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
