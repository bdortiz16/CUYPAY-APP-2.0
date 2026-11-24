import SwiftUI

/// Hoja "Nueva tarjeta virtual" estilo Nubank: el cliente elige entre tarjeta FIJA (para el día a día,
/// familiares o amigos) y TEMPORAL (para compras en internet; se cancela sola 24 h después de crearse).
/// Todas las tarjetas están a nombre del titular verificado y gastan del mismo bolsillo de tarjeta.
struct NewVirtualCardSheet: View {
    /// Se llama con la tarjeta recién emitida para seleccionarla en el carrusel.
    var onIssued: (CardItem) -> Void

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var step: Step = .chooseKind
    @State private var kind: VirtualCardKind = .fixed
    @State private var purpose: VirtualCardPurpose = .family
    @State private var label = ""
    @State private var isIssuing = false
    @State private var errorMessage: String?

    private enum Step { case chooseKind, details }

    private let fixedPurposes: [VirtualCardPurpose] = [.family, .friend, .personal, .online, .other]

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        switch step {
                        case .chooseKind: chooseKindStep
                        case .details: detailsStep
                        }
                        if let errorMessage {
                            ErrorBanner(message: errorMessage)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 28)
                }
                .scrollIndicators(.hidden)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if step == .details {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            withAnimation(.snappy) { step = .chooseKind }
                        } label: {
                            Image(systemName: "chevron.left")
                        }
                        .accessibilityLabel("Volver")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    CloseToolbarButton { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    // MARK: - Paso 1: tipo de tarjeta

    private var chooseKindStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Nueva tarjeta virtual")
                .font(.system(.title2, design: .serif).weight(.bold))
            Text("Crea tarjetas adicionales para tus familiares, amigos o compras por internet. Todas usan el saldo de tu bolsillo de tarjeta.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            kindOption(
                .fixed,
                icon: "creditcard.fill",
                title: "Tarjeta virtual fija",
                detail: "Úsala todos los días o compártela con un familiar o amigo. Permanece activa hasta que tú la elimines.",
                bullets: ["Ideal para suscripciones y gastos recurrentes", "Puedes bloquearla o eliminarla cuando quieras"]
            )

            kindOption(
                .temporary,
                icon: "clock.badge.checkmark.fill",
                title: "Tarjeta virtual temporal",
                detail: "Para compras en internet más seguras. Sus datos dejan de funcionar automáticamente 24 horas después de crearla.",
                bullets: ["Vence sola a las 24 h: no queda expuesta", "Si era tu única tarjeta, el saldo vuelve a tu cuenta Bre-B"]
            )

            PrimaryButton(title: "Continuar", systemImage: "arrow.right") {
                purpose = kind == .temporary ? .online : .family
                label = ""
                errorMessage = nil
                withAnimation(.snappy) { step = .details }
            }
            .padding(.top, 4)
        }
    }

    private func kindOption(
        _ option: VirtualCardKind,
        icon: String,
        title: LocalizedStringKey,
        detail: LocalizedStringKey,
        bullets: [LocalizedStringKey]
    ) -> some View {
        let selected = kind == option
        return Button {
            withAnimation(.snappy) { kind = option }
        } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(option == .temporary ? Theme.warning : Theme.spruce)
                    .frame(width: 40, height: 40)
                    .background((option == .temporary ? Theme.warning : Theme.spruce).opacity(0.14), in: .circle)

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 6)
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(selected ? Theme.spruce : Color.secondary.opacity(0.5))
                    }
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                    ForEach(Array(bullets.enumerated()), id: \.offset) { _, bullet in
                        Label(bullet, systemImage: "checkmark")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
            .overlay {
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(selected ? Theme.spruce : Color.clear, lineWidth: 2)
            }
            .contentShape(.rect(cornerRadius: 22))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: - Paso 2: para quién y nombre

    private var detailsStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(kind == .temporary ? LocalizedStringKey("Tarjeta temporal") : LocalizedStringKey("Tarjeta fija"))
                .font(.system(.title2, design: .serif).weight(.bold))

            if kind == .fixed {
                Text("¿Para quién es?")
                    .font(.subheadline.weight(.semibold))
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(fixedPurposes) { option in
                        purposeChip(option)
                    }
                }
            } else {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "clock.fill")
                        .foregroundStyle(Theme.warning)
                    Text("Esta tarjeta se cancelará automáticamente en 24 horas. Úsala para una compra en internet y olvídate de ella.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                .glassEffect(.regular.tint(Theme.warning.opacity(0.10)), in: .rect(cornerRadius: 18))
            }

            Text("Nombre de la tarjeta")
                .font(.subheadline.weight(.semibold))
            TextField(placeholderLabel, text: $label)
                .formFieldStyle()
                .textInputAutocapitalization(.words)
                .onChange(of: label) { _, newValue in
                    if newValue.count > 30 { label = String(newValue.prefix(30)) }
                }

            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "info.circle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("La tarjeta queda a tu nombre como titular y gasta del mismo bolsillo de tarjeta. Comparte sus datos solo con personas de confianza.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            PrimaryButton(
                title: kind == .temporary ? LocalizedStringKey("Crear tarjeta temporal") : LocalizedStringKey("Crear tarjeta fija"),
                systemImage: "faceid",
                isLoading: isIssuing
            ) {
                Task { await issue() }
            }
            .disabled(isIssuing)
            .padding(.top, 4)
        }
    }

    private var placeholderLabel: String {
        kind == .temporary ? "Temporal" : purpose.defaultLabel
    }

    private func purposeChip(_ option: VirtualCardPurpose) -> some View {
        let selected = purpose == option
        return Button {
            withAnimation(.snappy) { purpose = option }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: option.systemImage)
                Text(verbatim: option.title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(selected ? Color.white : Color.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(
                selected ? AnyShapeStyle(Theme.spruceSolid) : AnyShapeStyle(.thinMaterial),
                in: .rect(cornerRadius: 16)
            )
            .contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: - Acción

    private func issue() async {
        if app.user?.hasPlaceholderContact == true {
            errorMessage = String(localized: "Confirma primero tu correo y celular mediante código de seguridad en Perfil y seguridad.")
            return
        }
        isIssuing = true
        errorMessage = nil
        defer { isIssuing = false }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let card = try await app.api.issueVirtualCard(
                label: trimmed.isEmpty ? nil : trimmed,
                kind: kind,
                purpose: kind == .temporary ? .online : purpose
            )
            onIssued(card)
            dismiss()
        } catch {
            errorMessage = error.userMessage
        }
    }
}

#Preview {
    NewVirtualCardSheet { _ in }
        .appEnvironment(.preview())
}
