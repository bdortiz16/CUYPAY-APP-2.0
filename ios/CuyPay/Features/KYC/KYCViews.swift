import SwiftUI

// MARK: - Intro KYC

struct KYCIntroView: View {
    @Environment(AppModel.self) private var app
    let onStarted: () -> Void
    let onSkip: () -> Void

    @State private var isStarting = false
    @State private var errorMessage: String?

    init(onStarted: @escaping () -> Void, onSkip: @escaping () -> Void) {
        self.onStarted = onStarted
        self.onSkip = onSkip
    }

    var body: some View {
        OnboardingScaffold(
            title: "Verifica tu identidad",
            subtitle: "Es obligatorio por regulación financiera y protege tu cuenta. Toma unos 3 minutos."
        ) {
            GlassEffectContainer(spacing: 12) {
                VStack(spacing: 12) {
                    KYCStepRow(number: 1, systemImage: "person.text.rectangle", title: "Foto de tu documento", subtitle: "Cédula de ciudadanía o de extranjería, por ambos lados.")
                    KYCStepRow(number: 2, systemImage: "face.smiling", title: "Selfie en video corto", subtitle: "Para confirmar que eres tú.")
                    KYCStepRow(number: 3, systemImage: "checkmark.seal", title: "Revisión", subtitle: "Normalmente en pocos minutos.")
                }
            }
            Label("Tus datos se procesan cifrados con Sumsub, nuestro aliado de verificación.", systemImage: "lock.fill")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let errorMessage {
                ErrorBanner(message: errorMessage)
            }
        } footer: {
            VStack(spacing: 10) {
                PrimaryButton(title: "Verificar mi identidad", systemImage: "person.badge.shield.checkmark", isLoading: isStarting) {
                    Task { await start() }
                }
                Button("Hacerlo más tarde", action: onSkip)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func start() async {
        isStarting = true
        errorMessage = nil
        defer { isStarting = false }
        do {
            let outcome = try await app.kyc.startVerification()
            if outcome == .cancelled {
                errorMessage = String(localized: "Cerraste la verificación antes de terminar. Puedes retomarla cuando quieras.")
            } else {
                onStarted()
            }
        } catch {
            if let apiErr = error as? APIError, case .notAuthenticated = apiErr {
                await app.logout()
                return
            }
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.userMessage
        }
    }
}

private struct KYCStepRow: View {
    let number: Int
    let systemImage: String
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(Theme.spruce)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("Paso \(number)"))
    }
}

// MARK: - Estado KYC

struct KYCStatusView: View {
    @Environment(AppModel.self) private var app
    let startsVerificationIfNeeded: Bool
    let onFinish: () -> Void

    @State private var status: KYCStatusResponse?
    @State private var isWorking = false
    @State private var errorMessage: String?

    init(startsVerificationIfNeeded: Bool = false, onFinish: @escaping () -> Void) {
        self.startsVerificationIfNeeded = startsVerificationIfNeeded
        self.onFinish = onFinish
    }

    private var current: KYCStatus { status?.status ?? app.user?.kycStatus ?? .pending }

    var body: some View {
        ZStack {
            BrandBackground()
            VStack(spacing: 24) {
                Spacer()
                statusIcon
                    .frame(height: 120)
                Text(title)
                    .font(.system(.title, design: .rounded).weight(.bold))
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if current == .retry, let labels = status?.rejectLabels, !labels.isEmpty {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Revisa lo siguiente:").font(.subheadline.weight(.semibold))
                            ForEach(labels, id: \.self) { label in
                                Label(Self.describe(rejectLabel: label), systemImage: "exclamationmark.circle")
                                    .font(.subheadline)
                            }
                        }
                    }
                }
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }
                Spacer()
                actions
            }
            .padding(24)
            .animation(.smooth, value: current)
        }
        .sensoryFeedback(.success, trigger: current == .approved)
        .task { await poll() }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch current {
        case .approved:
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 96))
                .foregroundStyle(Theme.positive)
                .symbolEffect(.bounce, value: current)
                .transition(.scale.combined(with: .opacity))
        case .rejected:
            Image(systemName: "xmark.shield")
                .font(.system(size: 88, weight: .light))
                .foregroundStyle(.secondary)
        case .retry:
            Image(systemName: "arrow.clockwise.circle")
                .font(.system(size: 88, weight: .light))
                .foregroundStyle(Theme.warning)
        case .notStarted:
            Image(systemName: "person.badge.shield.checkmark")
                .font(.system(size: 88, weight: .light))
                .foregroundStyle(Theme.spruce)
        case .pending, .unknown:
            Image(systemName: "hourglass")
                .font(.system(size: 80, weight: .light))
                .foregroundStyle(Theme.spruce)
                .symbolEffect(.rotate, options: .repeating)
        }
    }

    private var title: LocalizedStringKey {
        switch current {
        case .approved: "¡Identidad verificada!"
        case .rejected: "No pudimos aprobar tu verificación"
        case .retry: "Necesitamos que corrijas algunos datos"
        case .notStarted: "Aún no has verificado tu identidad"
        case .pending, .unknown: "Estamos verificando tu identidad"
        }
    }

    private var message: LocalizedStringKey {
        switch current {
        case .approved: "Ya puedes crear tu llave Bre-B, convertir a BRL y enviar dinero."
        case .rejected: "Por políticas de cumplimiento no podemos compartir más detalles. Si crees que se trata de un error, escríbenos a soporte@cuypay.com."
        case .retry: "Vuelve a intentarlo con fotos nítidas, buena luz y sin reflejos."
        case .notStarted: "Verifícate para activar todas las funciones de CuyPay."
        case .pending, .unknown: "Suele tomar unos minutos. Te avisaremos cuando termine; mientras tanto puedes explorar la app."
        }
    }

    @ViewBuilder
    private var actions: some View {
        switch current {
        case .approved:
            PrimaryButton(title: "Ir a mi cuenta", systemImage: "arrow.right", action: onFinish)
        case .retry, .notStarted:
            VStack(spacing: 10) {
                PrimaryButton(title: current == .retry ? "Reintentar verificación" : "Verificar ahora", isLoading: isWorking) {
                    Task { await restart() }
                }
                Button("Más tarde", action: onFinish)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        case .rejected:
            SecondaryButton(title: "Entendido", action: onFinish)
        case .pending, .unknown:
            SecondaryButton(title: "Continuar", action: onFinish)
        }
    }

    private func poll() async {
        if startsVerificationIfNeeded, current == .notStarted || current == .retry {
            await restart()
        }
        // Consulta cada 3 s mientras esté en revisión (máx. ~3 min con la vista abierta).
        for _ in 0..<60 {
            await refresh()
            guard current == .pending || current == .unknown else { return }
            do {
                try await Task.sleep(for: .seconds(3))
            } catch {
                return // vista cerrada
            }
        }
    }

    private func refresh() async {
        do {
            let response = try await app.api.kycStatus()
            status = response
            app.apply(kycStatus: response)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func restart() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            _ = try await app.kyc.startVerification()
            await refresh()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.userMessage
        }
    }

    /// Traducción amigable de etiquetas comunes de rechazo de Sumsub.
    static func describe(rejectLabel: String) -> String {
        switch rejectLabel {
        case "BAD_PROPORTIONS", "LOW_QUALITY", "BLURRY":
            String(localized: "La foto del documento no es nítida")
        case "SCREENSHOTS", "GRAPHIC_EDITOR":
            String(localized: "Usa fotos tomadas en el momento, no capturas de pantalla")
        case "DOCUMENT_PAGE_MISSING", "INCOMPLETE_DOCUMENT":
            String(localized: "Falta una cara del documento")
        case "SELFIE_MISMATCH", "BAD_FACE_MATCHING":
            String(localized: "La selfie no coincide con el documento")
        case "EXPIRATION_DATE":
            String(localized: "El documento está vencido")
        default:
            String(localized: "Revisa la información enviada")
        }
    }
}

/// Flujo KYC presentado como hoja desde la app (banner del inicio / perfil).
struct KYCFlowSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var showStatus = false

    var body: some View {
        NavigationStack {
            Group {
                if showStatus || app.user?.kycStatus != .notStarted {
                    KYCStatusView { dismiss() }
                } else {
                    KYCIntroView {
                        withAnimation { showStatus = true }
                    } onSkip: {
                        dismiss()
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
    }
}

#Preview("KYC intro") {
    NavigationStack {
        KYCIntroView(onStarted: {}, onSkip: {})
    }
    .appEnvironment(.preview(kycStatus: .notStarted))
}

#Preview("KYC estado") {
    KYCStatusView(onFinish: {})
        .appEnvironment(.preview(kycStatus: .approved))
}
