import SwiftUI

/// Perfil y seguridad: estado KYC, Face ID / Secure Enclave, dispositivos, cerrar sesión.
struct ProfileView: View {
    @Environment(AppModel.self) private var app
    @State private var devices: [Device] = []
    @State private var devicesLoaded = false
    @State private var errorMessage: String?
    @State private var showKYC = false
    @State private var showEditContact = false
    @State private var confirmLogout = false
    @State private var confirmForget = false
    @State private var deviceToRemove: Device?

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
                if let user = app.user {
                    Section {
                        HStack(spacing: 14) {
                            AvatarView(initials: user.initials, size: 60, seed: user.id)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(verbatim: user.fullName).font(.title3.weight(.semibold))
                                Text(verbatim: user.phone).font(.subheadline).foregroundStyle(.secondary)
                                if user.hasPlaceholderEmail {
                                    Text("Sin correo real configurado")
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(Theme.warning)
                                } else {
                                    Text(verbatim: user.email).font(.subheadline).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .padding(.vertical, 6)

                        if user.hasPlaceholderContact {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(Theme.warning)
                                Text("Actualiza tu correo y nombre reales para recibir los códigos de verificación de tu tarjeta virtual y Apple Wallet.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                        }

                        Button {
                            showEditContact = true
                        } label: {
                            Label("Editar correo, celular o nombre", systemImage: "pencil.line")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.spruce)
                        }
                    } footer: {
                        Text("Si actualizas tu correo o celular y ya tienes una tarjeta activa, reemplázala en Tarjeta Virtual para que Apple Wallet envíe los códigos al nuevo contacto.")
                    }
                    .listRowBackground(Rectangle().fill(.thinMaterial))

                    Section("Verificación de identidad") {
                        Button {
                            showKYC = true
                        } label: {
                            HStack {
                                Label("Estado KYC", systemImage: "person.text.rectangle")
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

                Section {
                    HStack {
                        Label("Biometría", systemImage: "faceid")
                        Spacer()
                        Text(verbatim: biometryName).foregroundStyle(.secondary)
                    }
                    HStack {
                        Label("Llave del dispositivo", systemImage: "cpu")
                        Spacer()
                        Text(usesSoftwareKey ? LocalizedStringKey("Software (solo desarrollo)") : LocalizedStringKey("Secure Enclave"))
                            .foregroundStyle(usesSoftwareKey ? Theme.warning : .secondary)
                    }
                    Picker(selection: Binding(
                        get: { UserDefaults.standard.integer(forKey: AppModel.autoLockKey).clampedToOptions() },
                        set: { UserDefaults.standard.set($0, forKey: AppModel.autoLockKey) }
                    )) {
                        Text("Inmediato").tag(0)
                        Text("1 minuto").tag(60)
                        Text("5 minutos").tag(300)
                        Text("15 minutos").tag(900)
                    } label: {
                        Label("Bloqueo automático", systemImage: "timer")
                    }
                } header: {
                    Text("Seguridad")
                } footer: {
                    Text("Tu llave privada vive en el Secure Enclave y nunca sale de este iPhone. Cada envío, conversión o cambio de seguridad se firma con Face ID. Si cambias tus biometrías deberás registrar el dispositivo de nuevo.")
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))

                Section("Dispositivos") {
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
                                    Text(verbatim: device.name).font(.body.weight(.medium))
                                    if device.current {
                                        StatusBadge(text: "Este dispositivo", color: Theme.spruce)
                                    }
                                }
                                if let lastUsed = device.lastUsedAt {
                                    Text("Último uso: \(lastUsed.formatted(.relative(presentation: .named)))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if !device.current {
                                Button(role: .destructive) {
                                    deviceToRemove = device
                                } label: {
                                    Label("Eliminar", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))

                if let errorMessage {
                    Section {
                        ErrorBanner(message: errorMessage)
                    }
                    .listRowBackground(Color.clear)
                }

                Section {
                    Button("Cerrar sesión", systemImage: "rectangle.portrait.and.arrow.right") {
                        confirmLogout = true
                    }
                    Button("Desvincular este dispositivo", systemImage: "iphone.slash", role: .destructive) {
                        confirmForget = true
                    }
                } footer: {
                    Text(verbatim: "CuyPay \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") · \(app.environment.name)\(app.environment.isMock ? " · mock" : "")")
                }
                .listRowBackground(Rectangle().fill(.thinMaterial))
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Perfil y seguridad")
        .sheet(isPresented: $showKYC) {
            KYCFlowSheet()
        }
        .sheet(isPresented: $showEditContact) {
            EditContactProfileSheet()
        }
        .confirmationDialog("¿Cerrar sesión?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Cerrar sesión", role: .destructive) {
                Task { await app.logout() }
            }
        } message: {
            Text("Podrás volver a entrar con Face ID.")
        }
        .confirmationDialog("¿Desvincular este dispositivo?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Desvincular", role: .destructive) {
                Task { await app.forgetDevice() }
            }
        } message: {
            Text("Borraremos la llave segura de este iPhone y tendrás que registrarte de nuevo.")
        }
        .confirmationDialog(
            "¿Eliminar dispositivo?",
            isPresented: Binding(get: { deviceToRemove != nil }, set: { if !$0 { deviceToRemove = nil } }),
            titleVisibility: .visible,
            presenting: deviceToRemove
        ) { device in
            Button("Eliminar \(device.name)", role: .destructive) {
                Task { await remove(device) }
            }
        } message: { _ in
            Text("Ese dispositivo ya no podrá acceder a tu cuenta. Te pediremos Face ID para confirmar.")
        }
        .task {
            await loadDevices()
            await app.refreshUser()
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

/// Hoja reutilizable para actualizar nombre, correo y celular de verificación (Apple Wallet / compras 3DS).
struct EditContactProfileSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var subtitle: String? = nil
    var saveButtonTitle: LocalizedStringKey = "Guardar datos"
    var onSaved: ((User) -> Void)? = nil

    @State private var firstName = ""
    @State private var lastName = ""
    @State private var email = ""
    @State private var phoneDigits = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var didInitialize = false

    private var isEmailValid: Bool {
        let clean = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard clean != "usuario@cuypay.com", !clean.hasSuffix("@pendiente.cuypay.com") else {
            return false
        }
        let parts = clean.split(separator: "@")
        return parts.count == 2 && parts[1].contains(".") && !parts[0].isEmpty && parts[1].last != "."
    }

    private var isPhoneValid: Bool {
        phoneDigits.count == 10 && phoneDigits.hasPrefix("3")
    }

    private var isFormValid: Bool {
        let cleanFirst = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanLast = lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        let isPlaceholderName = cleanFirst.lowercased() == "usuario" && cleanLast.lowercased() == "cuypay"
        return cleanFirst.count >= 2 &&
            cleanLast.count >= 2 &&
            !isPlaceholderName &&
            isEmailValid &&
            isPhoneValid
    }

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(
                            verbatim: subtitle ??
                                String(localized: "Confirma el correo y el celular donde recibirás los códigos de verificación de tu tarjeta virtual y Apple Wallet.")
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Nombres")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextField("Nombres reales", text: $firstName)
                                .textContentType(.givenName)
                                .textInputAutocapitalization(.words)
                                .formFieldStyle()
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Apellidos")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextField("Apellidos reales", text: $lastName)
                                .textContentType(.familyName)
                                .textInputAutocapitalization(.words)
                                .formFieldStyle()
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Correo electrónico")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            TextField("tucorreo@ejemplo.com", text: $email)
                                .keyboardType(.emailAddress)
                                .textContentType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .formFieldStyle()
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Celular (Colombia)")
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
                                    .formFieldStyle()
                                    .onChange(of: phoneDigits) {
                                        let filtered = String(phoneDigits.filter(\.isASCIIDigit).prefix(10))
                                        if filtered != phoneDigits { phoneDigits = filtered }
                                    }
                            }
                        }

                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }

                        PrimaryButton(
                            title: saveButtonTitle,
                            systemImage: "checkmark",
                            isLoading: isSaving,
                            isEnabled: isFormValid
                        ) {
                            Task { await save() }
                        }
                        .padding(.top, 6)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 28)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("Datos de verificación")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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
                    email = user.hasPlaceholderEmail ? "" : user.email
                    let digits = user.phone.filter(\.isASCIIDigit)
                    if digits.count == 12, digits.hasPrefix("57") {
                        phoneDigits = String(digits.dropFirst(2))
                    } else {
                        phoneDigits = String(digits.suffix(10))
                    }
                }
            }
        }
    }

    private func save() async {
        guard isFormValid, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let req = UpdateProfileRequest(
                firstName: firstName.trimmingCharacters(in: .whitespacesAndNewlines),
                lastName: lastName.trimmingCharacters(in: .whitespacesAndNewlines),
                email: email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                phone: "+57" + phoneDigits
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

private extension Int {
    func clampedToOptions() -> Int {
        let valid = [0, 60, 300, 900]
        return valid.contains(self) ? self : 60
    }
}

#Preview {
    NavigationStack {
        ProfileView()
    }
    .appEnvironment(.preview())
}
