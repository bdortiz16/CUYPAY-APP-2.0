import SwiftUI

/// Perfil y seguridad: estado KYC, Face ID / Secure Enclave, dispositivos, cerrar sesión.
struct ProfileView: View {
    @Environment(AppModel.self) private var app
    @State private var devices: [Device] = []
    @State private var devicesLoaded = false
    @State private var errorMessage: String?
    @State private var showKYC = false
    @State private var showEditContact = false
    @State private var editContactFocus: EditContactProfileSheet.FocusField?
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
                            VStack(alignment: .leading, spacing: 4) {
                                Text(verbatim: user.fullName).font(.title3.weight(.semibold))
                                HStack(spacing: 6) {
                                    Text(verbatim: user.phone)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    if user.phoneVerified == true {
                                        StatusBadge(text: "WhatsApp", color: Theme.success)
                                    }
                                }
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
                            editContactFocus = .phone
                            showEditContact = true
                        } label: {
                            HStack {
                                Label("Cambiar celular por WhatsApp", systemImage: "phone.badge.checkmark")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.spruce)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }

                        Button {
                            editContactFocus = .email
                            showEditContact = true
                        } label: {
                            HStack {
                                Label("Cambiar correo con código WhatsApp", systemImage: "envelope.badge.shield.half.filled")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Theme.spruce)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }

                        Button {
                            editContactFocus = .firstName
                            showEditContact = true
                        } label: {
                            HStack {
                                Label("Editar nombre del titular", systemImage: "pencil.line")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    } footer: {
                        Text("Cualquier cambio de celular o correo se confirma con un código de 6 dígitos enviado por WhatsApp. Si ya tienes una tarjeta activa, reemplázala en Tarjeta Virtual para sincronizar el nuevo contacto con Apple Wallet.")
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
            EditContactProfileSheet(initialFocus: editContactFocus)
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

/// Hoja reutilizable para actualizar nombre, correo y celular con confirmación OTP por WhatsApp (o correo).
struct EditContactProfileSheet: View {
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

    var subtitle: String? = nil
    var saveButtonTitle: LocalizedStringKey = "Guardar datos"
    var initialFocus: FocusField? = nil
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
        guard let user = app.user else { return true }
        return e164Phone != user.phone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var emailChanged: Bool {
        guard let user = app.user else { return true }
        return cleanEmail != user.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var requiresOTPConfirmation: Bool {
        phoneChanged || emailChanged
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
        let isPlaceholderName = cleanFirstName.lowercased() == "usuario" && cleanLastName.lowercased() == "cuypay"
        return cleanFirstName.count >= 2 &&
            cleanLastName.count >= 2 &&
            !isPlaceholderName &&
            isEmailValid &&
            isPhoneValid
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
            .navigationTitle(step == .form ? "Datos de contacto" : "Confirmar código")
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
                    email = user.hasPlaceholderEmail ? "" : user.email
                    let digits = user.phone.filter(\.isASCIIDigit)
                    if digits.count == 12, digits.hasPrefix("57") {
                        phoneDigits = String(digits.dropFirst(2))
                    } else {
                        phoneDigits = String(digits.suffix(10))
                    }
                }
                if let initialFocus {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        focusedField = initialFocus
                    }
                }
            }
        }
    }

    private var formContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(
                verbatim: subtitle ??
                    String(localized: "Actualiza tu celular o correo y confírmalo con un código por WhatsApp. Aquí también llegan las alertas de tu tarjeta virtual y Apple Wallet.")
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

            VStack(alignment: .leading, spacing: 6) {
                Text("Correo electrónico")
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

            VStack(alignment: .leading, spacing: 6) {
                Text("Celular con WhatsApp (Colombia)")
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
                            let filtered = String(phoneDigits.filter(\.isASCIIDigit).prefix(10))
                            if filtered != phoneDigits { phoneDigits = filtered }
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
                Text("Ingresa el código de 6 dígitos")
                    .font(.title3.weight(.bold))
                if let otpResponse {
                    Text(
                        otpResponse.channel == .email
                            ? LocalizedStringKey("Enviamos el código al correo \(otpResponse.maskedDestination).")
                            : LocalizedStringKey("Enviamos el código por WhatsApp a \(otpResponse.maskedDestination).")
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
                title: saveButtonTitle,
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
                    firstName: cleanFirstName,
                    lastName: cleanLastName,
                    email: cleanEmail,
                    phone: e164Phone
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
