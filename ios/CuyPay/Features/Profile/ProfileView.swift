import SwiftUI

/// Perfil y seguridad: estado KYC, Face ID / Secure Enclave, dispositivos, cerrar sesión.
struct ProfileView: View {
    @Environment(AppModel.self) private var app
    @State private var devices: [Device] = []
    @State private var devicesLoaded = false
    @State private var errorMessage: String?
    @State private var showKYC = false
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
                                Text(verbatim: user.email).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 6)
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

#Preview {
    NavigationStack {
        ProfileView()
    }
    .appEnvironment(.preview())
}
