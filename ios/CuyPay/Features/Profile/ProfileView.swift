import SwiftUI
import UIKit

/// Hub principal de Perfil e Identidad inspirado en un diseño limpio y minimalista:
/// sin opciones muertas y sin fila de 4x1000 (CuyPay no cobra 4x1000).
struct ProfileView: View {
    @Environment(AppModel.self) private var app
    @Environment(WalletStore.self) private var store

    @State private var editContactTarget: EditContactProfileSheet.Target?
    @State private var showReceiveSheet = false
    @State private var showSavingsSheet = false
    @State private var showLoansSheet = false
    @State private var showNotificationsSheet = false
    @State private var showHelpSheet = false
    @State private var showKYCSheet = false
    @State private var confirmLogout = false

    var body: some View {
        ZStack {
            BrandBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let user = app.user {
                        userHeaderButton(for: user)

                        if user.hasPlaceholderContact {
                            contactWarningCard
                        }
                    }

                    // Tarjeta destacada: Recibe dinero al instante · Elige tus llaves Bre-B
                    Button {
                        if app.isKYCApproved {
                            showReceiveSheet = true
                        } else {
                            showKYCSheet = true
                        }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "key.horizontal.fill")
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(Theme.spruce)
                                .frame(width: 38, height: 38)
                                .background(Theme.spruce.opacity(0.12), in: .circle)

                            VStack(alignment: .leading, spacing: 3) {
                                Text("Recibe dinero al instante")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(.primary)
                                Text(
                                    store.brebKey.map { "Tu llave activa: \($0.alias)" }
                                        ?? "Genera y activa tu llave Bre-B al instante"
                                )
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            }

                            Spacer()

                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        .padding(18)
                        .contentShape(.rect(cornerRadius: 20))
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))

                    // Lista limpia de secciones funcionales (sin 4x1000)
                    VStack(spacing: 0) {
                        hubButtonRow(
                            icon: "lock.rotation",
                            title: "Bolsillo de Ahorro",
                            subtitle: "Bloquea a 30, 60, 90, 180 o 360 días y gana intereses"
                        ) {
                            if app.isKYCApproved {
                                showSavingsSheet = true
                            } else {
                                showKYCSheet = true
                            }
                        }

                        Divider().padding(.leading, 56)

                        hubButtonRow(
                            icon: "banknote",
                            title: "Créditos CuyPay",
                            subtitle: "Solicita de 30 a 360 días con Pagaré electrónico"
                        ) {
                            if app.isKYCApproved {
                                showLoansSheet = true
                            } else {
                                showKYCSheet = true
                            }
                        }

                        Divider().padding(.leading, 56)

                        NavigationLink {
                            AccountConfigurationView()
                        } label: {
                            hubRowContent(
                                icon: "gearshape",
                                title: "Configurar",
                                subtitle: "Tarjeta, Cuenta, Llaves, Límites, Perfil"
                            )
                        }
                        .buttonStyle(.plain)

                        Divider().padding(.leading, 56)

                        NavigationLink {
                            SecurityCenterView()
                        } label: {
                            hubRowContent(
                                icon: "shield",
                                title: "Centro de Seguridad",
                                subtitle: "Face ID, contraseña, bloqueo automático y dispositivos"
                            )
                        }
                        .buttonStyle(.plain)

                        Divider().padding(.leading, 56)

                        NavigationLink {
                            LegalDocumentsHubView()
                        } label: {
                            hubRowContent(
                                icon: "doc.text",
                                title: "Documentos",
                                subtitle: "Pagarés, Paz y Salvo, Certificados de ahorro y términos"
                            )
                        }
                        .buttonStyle(.plain)

                        Divider().padding(.leading, 56)

                        ShareLink(
                            item: URL(string: "https://cuypay.com")!,
                            subject: Text("Únete a CuyPay"),
                            message: Text("Envía y recibe al instante con Bre-B, usa tu tarjeta virtual en Apple Pay y ahorra sin 4x1000 en CuyPay: https://cuypay.com")
                        ) {
                            hubRowContent(
                                icon: "person.badge.plus",
                                title: "Invitar a CuyPay",
                                subtitle: "Comparte la app con amigos y familiares"
                            )
                        }
                        .buttonStyle(.plain)

                        Divider().padding(.leading, 56)

                        hubButtonRow(
                            icon: "arrow.turn.down.left",
                            title: "Salir de la aplicación",
                            subtitle: nil,
                            tint: Theme.negative
                        ) {
                            confirmLogout = true
                        }
                    }
                    .padding(.vertical, 4)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))

                    footerVersionLabel
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
        }
        .navigationTitle("Tu cuenta")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showHelpSheet = true
                } label: {
                    Image(systemName: "questionmark.circle")
                }
                .accessibilityLabel(Text("Ayuda y soporte"))

                Button {
                    showNotificationsSheet = true
                } label: {
                    Image(systemName: store.unreadNotificationsCount > 0 ? "bell.badge.fill" : "bell")
                }
                .accessibilityLabel(Text("Notificaciones"))
            }
        }
        .sheet(item: $editContactTarget) { target in
            EditContactProfileSheet(target: target)
        }
        .sheet(isPresented: $showReceiveSheet) {
            ReceiveView()
                .presentationDetents([.fraction(0.88), .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSavingsSheet) {
            SavingsView()
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showLoansSheet) {
            LoansView()
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showNotificationsSheet) {
            NotificationsSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showHelpSheet) {
            HelpSupportSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showKYCSheet) {
            KYCFlowSheet()
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog("¿Salir de CuyPay?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Cerrar sesión", role: .destructive) {
                Task { await app.logout() }
            }
        } message: {
            Text("Podrás volver a entrar rápidamente con Face ID o tu contraseña.")
        }
        .task {
            await app.refreshUser()
            if !store.brebKeyLoaded {
                await store.refreshBrebKey()
            }
        }
    }

    // MARK: - Subvistas del Hub

    private func userHeaderButton(for user: User) -> some View {
        Button {
            editContactTarget = .all
        } label: {
            HStack(spacing: 14) {
                AvatarView(initials: user.initials, size: 58, seed: user.id)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(verbatim: user.fullName)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        StatusBadge(text: user.kycStatus.badgeText, color: user.kycStatus.badgeColor)
                    }

                    let keyPart = store.brebKey.map { "Llave \($0.alias)" } ?? "Cuenta COP"
                    Text(verbatim: "\(keyPart) · \(user.phone)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    if !user.hasPlaceholderEmail {
                        Text(verbatim: user.email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 4)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private var contactWarningCard: some View {
        Button {
            editContactTarget = .all
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Completa tu correo y datos reales")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.primary)
                    Text("Necesario para emitir Pagarés, recibir alertas y vincular tu tarjeta virtual a Apple Wallet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .padding(14)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(Theme.warning.opacity(0.14)), in: .rect(cornerRadius: 18))
    }

    private func hubButtonRow(
        icon: String,
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey?,
        tint: Color = .primary,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            hubRowContent(icon: icon, title: title, subtitle: subtitle, tint: tint)
        }
        .buttonStyle(.plain)
    }

    private func hubRowContent(
        icon: String,
        title: LocalizedStringKey,
        subtitle: LocalizedStringKey?,
        tint: Color = .primary
    ) -> some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(tint == .primary ? Theme.spruce : tint)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(tint)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 15)
        .contentShape(.rect)
    }

    private var footerVersionLabel: some View {
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "2.0"
        let modeSuffix = app.environment.isMock ? " · demo" : ""
        return VStack(spacing: 2) {
            Text(verbatim: "CuyPay \(appVersion)\(modeSuffix) · Sin cobro de 4x1000")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            Text("Operado por XATECH SERVICES S.A.S. · NIT 901.799.579")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }
}

// MARK: - Subvista 1: Configurar (Tarjeta, Cuenta, Llaves, Límites, Perfil)

private struct AccountConfigurationView: View {
    @Environment(AppModel.self) private var app
    @State private var editTarget: EditContactProfileSheet.Target?
    @State private var showReceive = false
    @State private var showCard = false
    @State private var showSavings = false
    @State private var showLoans = false
    @State private var showKYC = false

    var body: some View {
        ZStack {
            BrandBackground()
            List {
                if let user = app.user {
                    Section("Datos verificados por WhatsApp") {
                        Button {
                            editTarget = .phone
                        } label: {
                            HStack {
                                Label("Cambiar celular", systemImage: "phone.badge.checkmark")
                                Spacer()
                                Text(verbatim: user.phone)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)

                        Button {
                            editTarget = .email
                        } label: {
                            HStack {
                                Label("Cambiar correo electrónico", systemImage: "envelope.badge.shield.half.filled")
                                Spacer()
                                Text(verbatim: user.hasPlaceholderEmail ? "Pendiente" : user.email)
                                    .font(.footnote)
                                    .foregroundStyle(user.hasPlaceholderEmail ? Theme.warning : .secondary)
                                    .lineLimit(1)
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)

                        Button {
                            editTarget = .name
                        } label: {
                            HStack {
                                Label("Nombre del titular", systemImage: "person.text.rectangle")
                                Spacer()
                                Text(verbatim: user.fullName)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                    .listRowBackground(Rectangle().fill(.thinMaterial))

                    Section("Productos y límites de tu cuenta") {
                        Button {
                            if app.isKYCApproved { showReceive = true } else { showKYC = true }
                        } label: {
                            HStack {
                                Label("Mi llave Bre-B", systemImage: "key.fill")
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)

                        Button {
                            if app.isKYCApproved { showCard = true } else { showKYC = true }
                        } label: {
                            HStack {
                                Label("Mi Tarjeta Virtual y Apple Pay", systemImage: "creditcard.fill")
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)

                        Button {
                            if app.isKYCApproved { showSavings = true } else { showKYC = true }
                        } label: {
                            HStack {
                                Label("Bolsillo de Ahorro", systemImage: "lock.rotation")
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)

                        Button {
                            if app.isKYCApproved { showLoans = true } else { showKYC = true }
                        } label: {
                            HStack {
                                Label("Créditos CuyPay", systemImage: "banknote.fill")
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.primary)

                        NavigationLink {
                            BeneficiariesView()
                        } label: {
                            Label("Beneficiarios inscritos", systemImage: "person.2.fill")
                        }

                        NavigationLink {
                            LimitsView()
                        } label: {
                            Label("Límites transaccionales", systemImage: "gauge.with.dots.needle.67percent")
                        }
                    }
                    .listRowBackground(Rectangle().fill(.thinMaterial))

                    Section("Verificación de identidad") {
                        Button {
                            showKYC = true
                        } label: {
                            HStack {
                                Label("Estado KYC", systemImage: "checkmark.shield")
                                Spacer()
                                StatusBadge(text: user.kycStatus.badgeText, color: user.kycStatus.badgeColor)
                            }
                        }
                        .foregroundStyle(.primary)

                        HStack {
                            Label("Nivel de cuenta", systemImage: "rosette")
                            Spacer()
                            Text(user.tier == .full ? LocalizedStringKey("Completo") : LocalizedStringKey("Básico"))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Rectangle().fill(.thinMaterial))
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Configurar")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editTarget) { target in
            EditContactProfileSheet(target: target)
        }
        .sheet(isPresented: $showReceive) {
            ReceiveView()
                .presentationDetents([.fraction(0.88), .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showCard) {
            CardView()
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSavings) {
            SavingsView()
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showLoans) {
            LoansView()
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showKYC) {
            KYCFlowSheet()
        }
    }
}

// MARK: - Subvista 2: Centro de Seguridad (Biometría, Contraseña, Bloqueo automático, Dispositivos)

private struct SecurityCenterView: View {
    @Environment(AppModel.self) private var app
    @AppStorage(AppModel.autoLockKey) private var autoLockInterval: Int = 60

    @State private var devices: [Device] = []
    @State private var devicesLoaded = false
    @State private var hasPassword = true
    @State private var showChangePassword = false
    @State private var deviceToRemove: Device?
    @State private var confirmForget = false
    @State private var errorMessage: String?

    private var biometryName: String {
        switch BiometricAuthenticator.availableBiometry() {
        case .faceID: "Face ID"
        case .touchID: "Touch ID"
        case .opticID: "Optic ID"
        case .none: String(localized: "No disponible")
        }
    }

    private var usesSoftwareKey: Bool {
        (app.deviceKeys as? SecureEnclaveKeyManager)?.isUsingSoftwareFallback ?? false
    }

    var body: some View {
        ZStack {
            BrandBackground()
            List {
                if let errorMessage {
                    Section {
                        ErrorBanner(message: errorMessage)
                    }
                    .listRowBackground(Color.clear)
                }

                Section {
                    HStack {
                        Label("Biometría activa", systemImage: "faceid")
                        Spacer()
                        Text(verbatim: biometryName)
                            .foregroundStyle(.secondary)
                    }

                    HStack {
                        Label("Criptografía del dispositivo", systemImage: "cpu")
                        Spacer()
                        Text(usesSoftwareKey ? LocalizedStringKey("Software (desarrollo)") : LocalizedStringKey("Secure Enclave P-256"))
                            .foregroundStyle(usesSoftwareKey ? Theme.warning : .secondary)
                    }

                    Button {
                        showChangePassword = true
                    } label: {
                        HStack {
                            Label(hasPassword ? "Cambiar contraseña de acceso" : "Crear contraseña de respaldo", systemImage: "key.viewfinder")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(.primary)

                    Picker(selection: $autoLockInterval) {
                        Text("Inmediato").tag(0)
                        Text("1 minuto").tag(60)
                        Text("5 minutos").tag(300)
                        Text("15 minutos").tag(900)
                    } label: {
                        Label("Bloqueo automático", systemImage: "timer")
                    }
                } header: {
                    Text("Protección de acceso")
                } footer: {
                    Text("Tu clave privada vive dentro del Secure Enclave de este iPhone. Cada envío, retiro, bloqueo de ahorro o firma de Pagaré se autoriza con Face ID.")
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))

                Section("Dispositivos autorizados") {
                    if !devicesLoaded {
                        ProgressView()
                    }
                    ForEach(devices) { device in
                        HStack(spacing: 12) {
                            Image(systemName: device.name.localizedCaseInsensitiveContains("ipad") ? "ipad" : "iphone")
                                .font(.title3)
                                .foregroundStyle(Theme.spruce)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(verbatim: device.name)
                                        .font(.body.weight(.medium))
                                    if device.current {
                                        StatusBadge(text: "Este iPhone", color: Theme.spruce)
                                    }
                                }
                                if let lastUsed = device.lastUsedAt {
                                    Text("Último uso: \(lastUsed.formatted(.relative(presentation: .named)))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if !device.current {
                                Button(role: .destructive) {
                                    deviceToRemove = device
                                } label: {
                                    Image(systemName: "trash")
                                        .foregroundStyle(Theme.negative)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))

                Section {
                    Button("Desvincular este dispositivo", systemImage: "iphone.slash", role: .destructive) {
                        confirmForget = true
                    }
                } footer: {
                    Text("Usa esta opción solo si vas a entregar o cambiar de iPhone.")
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Centro de Seguridad")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showChangePassword) {
            ChangePasswordSheet(hasExistingPassword: hasPassword) {
                hasPassword = true
            }
        }
        .confirmationDialog(
            "¿Eliminar dispositivo?",
            isPresented: Binding(get: { deviceToRemove != nil }, set: { if !$0 { deviceToRemove = nil } }),
            titleVisibility: .visible,
            presenting: deviceToRemove
        ) { device in
            Button("Revocar acceso a \(device.name)", role: .destructive) {
                Task { await remove(device) }
            }
        } message: { _ in
            Text("Ese dispositivo perderá acceso inmediato a tu cuenta. Confirmaremos con Face ID.")
        }
        .confirmationDialog("¿Desvincular este iPhone?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Desvincular dispositivo", role: .destructive) {
                Task { await app.forgetDevice() }
            }
        } message: {
            Text("Se eliminará la llave criptográfica de este dispositivo y deberás volver a iniciar sesión.")
        }
        .task {
            if ![0, 60, 300, 900].contains(autoLockInterval) {
                autoLockInterval = 60
            }
            async let secTask = app.api.securitySettings()
            async let devTask: Void = loadDevices()
            if let sec = try? await secTask, let hasPwd = sec.hasPassword {
                hasPassword = hasPwd
            }
            _ = await devTask
        }
    }

    private func loadDevices() async {
        do {
            devices = try await app.api.devices()
            errorMessage = nil
        } catch {
            errorMessage = error.userMessage
        }
        devicesLoaded = true
    }

    private func remove(_ device: Device) async {
        do {
            try await app.api.deleteDevice(id: device.id)
            await loadDevices()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

private struct ChangePasswordSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let hasExistingPassword: Bool
    let onUpdated: () -> Void

    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var canSubmit: Bool {
        (!hasExistingPassword || !currentPassword.isEmpty) &&
            newPassword.count >= 4 &&
            newPassword == confirmPassword &&
            !isSaving
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }

                        if hasExistingPassword {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Contraseña actual")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                SecureField("Tu contraseña actual", text: $currentPassword)
                                    .textContentType(.password)
                                    .formFieldStyle()
                            }
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Nueva contraseña (mínimo 4 caracteres)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            SecureField("Nueva contraseña", text: $newPassword)
                                .textContentType(.newPassword)
                                .formFieldStyle()
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Confirmar nueva contraseña")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            SecureField("Repite la nueva contraseña", text: $confirmPassword)
                                .textContentType(.newPassword)
                                .formFieldStyle()
                        }

                        if !confirmPassword.isEmpty && newPassword != confirmPassword {
                            Label("Las contraseñas no coinciden.", systemImage: "exclamationmark.circle")
                                .font(.caption)
                                .foregroundStyle(Theme.negative)
                        }

                        PrimaryButton(
                            title: "Guardar contraseña",
                            systemImage: "checkmark.shield.fill",
                            isLoading: isSaving,
                            isEnabled: canSubmit
                        ) {
                            Task { await submit() }
                        }
                        .padding(.top, 8)
                    }
                    .padding(20)
                }
            }
            .navigationTitle(hasExistingPassword ? "Cambiar contraseña" : "Crear contraseña")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        isSaving = true
        errorMessage = nil
        do {
            try await app.api.changePassword(
                currentPassword: hasExistingPassword ? currentPassword : nil,
                newPassword: newPassword
            )
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onUpdated()
            dismiss()
        } catch {
            errorMessage = error.userMessage
            isSaving = false
        }
    }
}

// MARK: - Subvista 3: Documentos (Pagarés, Paz y Salvo, Certificados de Ahorro y Contratos)

private struct LegalDocumentsHubView: View {
    @Environment(AppModel.self) private var app
    @State private var loans: [LoanItem] = []
    @State private var blocks: [SavingsBlock] = []
    @State private var isLoading = true
    @State private var selectedLoan: LoanItem?
    @State private var selectedBlock: SavingsBlock?

    var body: some View {
        ZStack {
            BrandBackground()
            List {
                Section("Pagarés Electrónicos y Paz y Salvo") {
                    if isLoading {
                        ProgressView()
                    } else if loans.isEmpty {
                        Text("No tienes Pagarés suscritos todavía.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(loans) { loan in
                            Button {
                                selectedLoan = loan
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(verbatim: loan.promissoryNoteNumber)
                                            .font(.subheadline.monospaced().weight(.bold))
                                        Text("\(loan.principal.formatted()) · \(loan.termDays) días")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    StatusBadge(
                                        text: LocalizedStringKey(loan.status.title),
                                        color: loan.status == .paid ? Theme.positive : Theme.spruce
                                    )
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))

                Section("Certificados de Bolsillo de Ahorro") {
                    if isLoading {
                        ProgressView()
                    } else if blocks.isEmpty {
                        Text("No tienes certificados de ahorro registrados.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(blocks) { block in
                            Button {
                                selectedBlock = block
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text("Bolsillo \(block.termDays) días · \(String(format: "%.1f", block.lockedRate))% E.A.")
                                            .font(.subheadline.weight(.semibold))
                                        Text("\(block.principal.formatted()) · Reintegro \(block.maturesAt.formatted(date: .abbreviated, time: .shortened))")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "doc.badge.checkmark")
                                        .foregroundStyle(Theme.spruce)
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))

                Section("Marco Legal y Privacidad") {
                    Link(destination: URL(string: "https://cuypay.com/terminos")!) {
                        HStack {
                            Label("Términos y Condiciones de Uso", systemImage: "book.closed")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .foregroundStyle(.primary)

                    Link(destination: URL(string: "https://cuypay.com/privacidad")!) {
                        HStack {
                            Label("Política de Tratamiento de Datos (Habeas Data)", systemImage: "hand.raised")
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .foregroundStyle(.primary)
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Documentos")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selectedLoan) { loan in
            PromissoryNoteViewerSheet(loan: loan)
        }
        .sheet(item: $selectedBlock) { block in
            SavingsCertificateSheet(block: block)
        }
        .task {
            async let l = app.api.userLoans()
            async let s = app.api.userSavings()
            if let loanRes = try? await l { loans = loanRes.loans }
            if let savRes = try? await s { blocks = savRes.blocks }
            isLoading = false
        }
    }
}

// MARK: - Subvista 4: Ayuda y Soporte

private struct HelpSupportSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        GlassCard {
                            VStack(alignment: .leading, spacing: 10) {
                                Label("Atención directa CuyPay", systemImage: "headphones.circle.fill")
                                    .font(.headline)
                                    .foregroundStyle(Theme.spruce)
                                Text("¿Tienes dudas sobre un depósito Bre-B, tu tarjeta virtual Apple Pay, tu Bolsillo de Ahorro o un Crédito? Escríbenos y nuestro equipo te acompaña.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)

                                Divider()

                                Link(destination: URL(string: "mailto:soporte@cuypay.com")!) {
                                    HStack {
                                        Label("soporte@cuypay.com", systemImage: "envelope.fill")
                                            .font(.subheadline.weight(.semibold))
                                        Spacer()
                                        Image(systemName: "arrow.up.right")
                                            .font(.caption)
                                    }
                                    .padding(.vertical, 6)
                                }
                                .foregroundStyle(Theme.spruce)

                                Link(destination: URL(string: "https://cuypay.com")!) {
                                    HStack {
                                        Label("Centro web cuypay.com", systemImage: "globe")
                                            .font(.subheadline.weight(.semibold))
                                        Spacer()
                                        Image(systemName: "arrow.up.right")
                                            .font(.caption)
                                    }
                                    .padding(.vertical, 6)
                                }
                                .foregroundStyle(Theme.spruce)
                            }
                        }

                        GlassCard {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Preguntas rápidas")
                                    .font(.subheadline.weight(.bold))
                                faqItem(
                                    q: "¿CuyPay cobra 4x1000?",
                                    a: "No. En CuyPay no te cobramos 4x1000 en tus movimientos internos, recargas de tarjeta ni bolsillos de ahorro."
                                )
                                Divider()
                                faqItem(
                                    q: "¿Cuándo recibo los intereses de mi Bolsillo de Ahorro?",
                                    a: "Automáticamente en tu saldo disponible a la fecha y hora exacta en que se cumplen los 30, 60, 90, 180 o 360 días."
                                )
                                Divider()
                                faqItem(
                                    q: "¿Puedo pagar mi crédito antes de tiempo?",
                                    a: "Sí. Puedes abonar o pagar la totalidad en cualquier momento desde la sección Créditos sin ninguna penalidad."
                                )
                            }
                        }
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Ayuda y soporte")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
    }

    private func faqItem(q: String, a: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: q)
                .font(.footnote.weight(.semibold))
            Text(verbatim: a)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Hoja reutilizable para actualizar nombre, correo y celular con confirmación OTP por WhatsApp (o correo)

struct EditContactProfileSheet: View {
    enum Target: String, Identifiable {
        case all
        case phone
        case email
        case name

        var id: String { rawValue }
    }

    enum FocusField: Hashable {
        case firstName
        case lastName
        case email
        case phone
    }

    private enum Step {
        case form
        case otp
    }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var target: Target = .all
    var subtitle: String? = nil
    var saveButtonTitle: LocalizedStringKey = "Guardar datos"
    var onSaved: ((User) -> Void)? = nil

    @State private var step: Step = .form
    @State private var firstName = ""
    @State private var lastName = ""
    @State private var email = ""
    @State private var phoneDigits = ""
    @State private var otpResponse: ContactOTPResponse?
    @State private var otpCode = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var didInitialize = false
    @FocusState private var focusedField: FocusField?
    @FocusState private var otpFocused: Bool

    private var cleanFirstName: String {
        firstName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var cleanLastName: String {
        lastName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var cleanEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var e164Phone: String {
        "+57" + phoneDigits
    }

    private var formattedPhone: String {
        guard phoneDigits.count == 10 else { return e164Phone }
        let d = Array(phoneDigits)
        return "+57 \(String(d[0..<3])) \(String(d[3..<6])) \(String(d[6..<10]))"
    }

    private var phoneChanged: Bool {
        guard target == .phone || target == .all else { return false }
        guard let user = app.user else { return isPhoneValid }
        return isPhoneValid && e164Phone != user.phone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var emailChanged: Bool {
        guard target == .email || target == .all else { return false }
        guard let user = app.user else { return isEmailValid }
        return isEmailValid && cleanEmail != user.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var requiresOTPConfirmation: Bool {
        switch target {
        case .phone, .email:
            return true
        case .name:
            return false
        case .all:
            return phoneChanged || emailChanged
        }
    }

    private var isNameValid: Bool {
        let isPlaceholderName = cleanFirstName.lowercased() == "usuario" && cleanLastName.lowercased() == "cuypay"
        return cleanFirstName.count >= 2 && cleanLastName.count >= 2 && !isPlaceholderName
    }

    private var isEmailValid: Bool {
        guard cleanEmail != "usuario@cuypay.com", !cleanEmail.hasSuffix("@pendiente.cuypay.com") else {
            return false
        }
        let parts = cleanEmail.split(separator: "@")
        return parts.count == 2 && parts[1].contains(".") && !parts[0].isEmpty && parts[1].last != "."
    }

    private var isPhoneValid: Bool {
        phoneDigits.count == 10 && phoneDigits.hasPrefix("3")
    }

    private var isFormValid: Bool {
        switch target {
        case .phone:
            return isPhoneValid && phoneChanged
        case .email:
            return isEmailValid && emailChanged
        case .name:
            return isNameValid
        case .all:
            return isNameValid && isEmailValid && isPhoneValid
        }
    }

    private var navigationHeading: LocalizedStringKey {
        if step == .otp {
            return "Confirmar código WhatsApp"
        }
        switch target {
        case .phone: return "Cambiar celular"
        case .email: return "Cambiar correo"
        case .name: return "Nombre del titular"
        case .all: return "Datos de contacto"
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    if step == .form {
                        formContent
                    } else {
                        otpContent
                    }
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle(navigationHeading)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if step == .otp {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Editar") {
                            withAnimation(.smooth(duration: 0.25)) {
                                step = .form
                                errorMessage = nil
                            }
                        }
                        .disabled(isSaving)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
            .onAppear {
                guard !didInitialize else { return }
                didInitialize = true
                if let user = app.user {
                    firstName = user.hasPlaceholderName ? "" : user.firstName
                    lastName = user.hasPlaceholderName ? "" : user.lastName
                    email = (target == .email || user.hasPlaceholderEmail) ? "" : user.email
                    if target == .phone {
                        phoneDigits = ""
                    } else {
                        let digits = user.phone.filter(\.isASCIIDigit)
                        if digits.count == 12, digits.hasPrefix("57") {
                            phoneDigits = String(digits.dropFirst(2))
                        } else {
                            phoneDigits = String(digits.suffix(10))
                        }
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    switch target {
                    case .phone: focusedField = .phone
                    case .email: focusedField = .email
                    case .name, .all: focusedField = .firstName
                    }
                }
            }
        }
    }

    private var defaultSubtitle: String {
        switch target {
        case .phone:
            return "Ingresa tu nuevo número de celular. Te enviaremos un código de verificación de 6 dígitos por WhatsApp para confirmar el cambio."
        case .email:
            return "Ingresa tu nuevo correo electrónico. Confirmaremos el cambio enviando un código de verificación a tu WhatsApp registrado."
        case .name:
            return "Actualiza tus nombres y apellidos tal como aparecen en tu documento de identidad."
        case .all:
            return "Actualiza tu celular o correo y confírmalo con un código por WhatsApp. Aquí también llegan las alertas de tu tarjeta virtual y Apple Wallet."
        }
    }

    private var formContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(verbatim: subtitle ?? defaultSubtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if target == .phone, let currentPhone = app.user?.phone, !currentPhone.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "phone.badge.checkmark")
                        .foregroundStyle(Theme.spruce)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Celular actual registrado")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(verbatim: currentPhone)
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                    }
                    Spacer()
                }
                .padding(14)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
            }

            if target == .email, let user = app.user, !user.hasPlaceholderEmail {
                HStack(spacing: 10) {
                    Image(systemName: "envelope.badge.shield.half.filled")
                        .foregroundStyle(Theme.spruce)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Correo actual registrado")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(verbatim: user.email)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                    Spacer()
                }
                .padding(14)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
            }

            if target == .name || target == .all {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Nombres")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("Nombres reales", text: $firstName)
                        .textContentType(.givenName)
                        .textInputAutocapitalization(.words)
                        .focused($focusedField, equals: .firstName)
                        .formFieldStyle()
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Apellidos")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("Apellidos reales", text: $lastName)
                        .textContentType(.familyName)
                        .textInputAutocapitalization(.words)
                        .focused($focusedField, equals: .lastName)
                        .formFieldStyle()
                }
            }

            if target == .email || target == .all {
                VStack(alignment: .leading, spacing: 6) {
                    Text(target == .email ? "Nuevo correo electrónico" : "Correo electrónico")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("tucorreo@ejemplo.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .email)
                        .formFieldStyle()
                }
            }

            if target == .phone || target == .all {
                VStack(alignment: .leading, spacing: 6) {
                    Text(target == .phone ? "Nuevo celular con WhatsApp (Colombia)" : "Celular con WhatsApp (Colombia)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        Text(verbatim: "🇨🇴 +57")
                            .font(.body.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 16)
                            .glassEffect(.regular, in: .rect(cornerRadius: 18))
                        TextField("300 123 4567", text: $phoneDigits)
                            .keyboardType(.numberPad)
                            .textContentType(.telephoneNumber)
                            .monospacedDigit()
                            .focused($focusedField, equals: .phone)
                            .formFieldStyle()
                            .onChange(of: phoneDigits) {
                                var digits = phoneDigits.filter(\.isASCIIDigit)
                                if digits.count == 12 && digits.hasPrefix("57") {
                                    digits = String(digits.dropFirst(2))
                                }
                                let filtered = String(digits.prefix(10))
                                if filtered != phoneDigits { phoneDigits = filtered }
                            }
                    }
                }
            }

            if requiresOTPConfirmation && isFormValid {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "message.badge.filled.fill")
                        .font(.body)
                        .foregroundStyle(Theme.spruce)
                    Text(
                        phoneChanged
                            ? LocalizedStringKey("Enviaremos un código de 6 dígitos por WhatsApp al nuevo número \(formattedPhone) para confirmar que te pertenece.")
                            : LocalizedStringKey("Confirmaremos el cambio de correo enviando un código de 6 dígitos a tu WhatsApp registrado.")
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
            }

            if let errorMessage {
                ErrorBanner(message: errorMessage)
            }

            PrimaryButton(
                title: requiresOTPConfirmation ? "Enviar código por WhatsApp" : saveButtonTitle,
                systemImage: requiresOTPConfirmation ? "paperplane.fill" : "checkmark",
                isLoading: isSaving,
                isEnabled: isFormValid
            ) {
                Task { await handleFormSubmit() }
            }
            .padding(.top, 6)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 28)
    }

    private var otpContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Ingresa el código de WhatsApp")
                    .font(.title3.weight(.bold))
                if let otpResponse {
                    Text(
                        otpResponse.channel == .email
                            ? LocalizedStringKey("Enviamos el código al correo \(otpResponse.maskedDestination).")
                            : LocalizedStringKey("Te enviamos un código de 6 dígitos por WhatsApp a \(otpResponse.maskedDestination).")
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                if phoneChanged {
                    Label("Nuevo celular: \(formattedPhone)", systemImage: "phone.fill")
                        .font(.footnote.weight(.medium))
                }
                if emailChanged {
                    Label("Nuevo correo: \(cleanEmail)", systemImage: "envelope.fill")
                        .font(.footnote.weight(.medium))
                }
            }
            .foregroundStyle(.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 16))

            ZStack {
                TextField("", text: $otpCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($otpFocused)
                    .opacity(0.02)
                    .onChange(of: otpCode) {
                        let filtered = String(otpCode.filter(\.isASCIIDigit).prefix(6))
                        if filtered != otpCode { otpCode = filtered }
                        if otpCode.count == 6 {
                            Task { await confirmWithOTP() }
                        }
                    }
                    .accessibilityLabel(Text("Código de verificación"))
                HStack(spacing: 10) {
                    ForEach(0..<6, id: \.self) { index in
                        let characters = Array(otpCode)
                        Text(verbatim: index < characters.count ? String(characters[index]) : "")
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                            .frame(maxWidth: .infinity, minHeight: 56)
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
            .onTapGesture { otpFocused = true }

            if app.environment.isMock {
                Label("Entorno demo: usa el código 123456", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let errorMessage {
                ErrorBanner(message: errorMessage)
            }

            PrimaryButton(
                title: target == .phone ? "Confirmar nuevo celular" : saveButtonTitle,
                systemImage: "checkmark.shield.fill",
                isLoading: isSaving,
                isEnabled: otpCode.count == 6
            ) {
                Task { await confirmWithOTP() }
            }

            VStack(spacing: 12) {
                Button("Reenviar código por WhatsApp") {
                    Task { await requestVerificationCode(channel: "whatsapp") }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.spruce)
                .disabled(isSaving)

                if !phoneChanged, otpResponse?.emailOtpAvailable == true {
                    Button("Enviar código al nuevo correo electrónico") {
                        Task { await requestVerificationCode(channel: "email") }
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .disabled(isSaving)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 28)
        .onAppear { otpFocused = true }
    }

    private func handleFormSubmit() async {
        guard isFormValid, !isSaving else { return }
        if requiresOTPConfirmation {
            await requestVerificationCode(channel: "whatsapp")
        } else {
            await saveNameOnly()
        }
    }

    private func requestVerificationCode(channel: String) async {
        guard isFormValid, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let response = try await app.api.requestContactOTP(
                ContactOTPRequest(
                    phone: phoneChanged ? e164Phone : nil,
                    email: emailChanged ? cleanEmail : nil,
                    channel: channel
                )
            )
            otpResponse = response
            otpCode = ""
            withAnimation(.smooth(duration: 0.25)) {
                step = .otp
            }
            otpFocused = true
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func confirmWithOTP() async {
        guard otpCode.count == 6, !isSaving, let otpId = otpResponse?.otpId else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let updated = try await app.api.confirmContactUpdate(
                ConfirmContactUpdateRequest(
                    otpId: otpId,
                    otpCode: otpCode,
                    firstName: (target == .all || target == .name) ? cleanFirstName : nil,
                    lastName: (target == .all || target == .name) ? cleanLastName : nil,
                    email: emailChanged ? cleanEmail : nil,
                    phone: phoneChanged ? e164Phone : nil
                )
            )
            app.user = updated
            dismiss()
            onSaved?(updated)
        } catch {
            errorMessage = error.userMessage
            otpCode = ""
        }
    }

    private func saveNameOnly() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let req = UpdateProfileRequest(
                firstName: cleanFirstName,
                lastName: cleanLastName
            )
            let updated = try await app.api.updateProfile(req)
            app.user = updated
            dismiss()
            onSaved?(updated)
        } catch {
            errorMessage = error.userMessage
        }
    }
}

#Preview {
    NavigationStack {
        ProfileView()
    }
    .appEnvironment(.preview())
}
