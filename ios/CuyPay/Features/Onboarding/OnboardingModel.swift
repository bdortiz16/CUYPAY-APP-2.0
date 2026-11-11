import Foundation
import Observation
import UIKit

/// Estado del registro: teléfono → OTP → datos → Face ID (clave Secure Enclave + registro) → KYC.
@Observable
@MainActor
final class OnboardingModel {
    enum Step: Hashable {
        case phone
        case otp
        case profile
        case password
        case faceID
        case kycIntro
        case kycStatus
    }

    var path: [Step] = []

    var phoneDigits = ""
    var otpId: String?
    var otpExpiresAt: Date?
    var otpCode = ""
    var password = ""
    var confirmPassword = ""
    var firstName = ""
    var lastName = ""
    var email = ""

    var isLoading = false
    var errorMessage: String?

    // MARK: Saneamiento (se llama desde `.onChange` en las vistas)

    func sanitizePhone() {
        let filtered = String(phoneDigits.filter(\.isASCIIDigit).prefix(10))
        if filtered != phoneDigits { phoneDigits = filtered }
    }

    func sanitizeOTP() {
        let filtered = String(otpCode.filter(\.isASCIIDigit).prefix(6))
        if filtered != otpCode { otpCode = filtered }
    }

    // MARK: Validaciones

    /// Celular colombiano: 10 dígitos que empiezan por 3.
    var isPhoneValid: Bool { phoneDigits.count == 10 && phoneDigits.hasPrefix("3") }
    var e164Phone: String { "+57" + phoneDigits }
    var formattedPhone: String {
        guard phoneDigits.count == 10 else { return e164Phone }
        let d = Array(phoneDigits)
        return "+57 \(String(d[0..<3])) \(String(d[3..<6])) \(String(d[6..<10]))"
    }
    var isOTPComplete: Bool { otpCode.count == 6 }
    var isPasswordValid: Bool { password.count >= 4 && password == confirmPassword }
    var isEmailValid: Bool {
        let clean = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard clean != "usuario@cuypay.com", !clean.hasSuffix("@pendiente.cuypay.com") else {
            return false
        }
        let parts = clean.split(separator: "@")
        return parts.count == 2 && parts[1].contains(".") && !parts[0].isEmpty && parts[1].last != "."
    }
    var isProfileValid: Bool {
        let cleanFirst = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanLast = lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        let isPlaceholderName = cleanFirst.lowercased() == "usuario" && cleanLast.lowercased() == "cuypay"
        return cleanFirst.count >= 2 &&
            cleanLast.count >= 2 &&
            !isPlaceholderName &&
            isEmailValid
    }

    // MARK: Acciones

    func requestOTP(api: any CuyPayAPI) async {
        guard isPhoneValid, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await api.requestOTP(phone: e164Phone)
            otpId = response.otpId
            otpExpiresAt = response.expiresAt
            otpCode = ""
            if path.last != .otp { path.append(.otp) }
        } catch {
            errorMessage = error.userMessage
        }
    }

    func confirmOTP(api: any CuyPayAPI) async {
        guard isOTPComplete, !isLoading else { return }
        guard let otpId else {
            errorMessage = String(localized: "Solicita un nuevo código por WhatsApp.")
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            _ = try await api.verifyOTP(otpId: otpId, phone: e164Phone, otpCode: otpCode)
            if path.last != .profile {
                path.append(.profile)
            }
        } catch {
            errorMessage = error.userMessage
            otpCode = ""
        }
    }

    func confirmProfileStep() {
        guard isProfileValid else {
            if firstName.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 ||
                lastName.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 {
                errorMessage = String(localized: "Ingresa tus nombres y apellidos reales.")
            } else if !isEmailValid {
                errorMessage = String(localized: "Ingresa un correo electrónico válido.")
            }
            return
        }
        errorMessage = nil
        path.append(.password)
    }

    func confirmPasswordStep() {
        guard isPasswordValid else {
            if password.count < 4 {
                errorMessage = String(localized: "La contraseña debe tener al menos 4 caracteres.")
            } else if password != confirmPassword {
                errorMessage = String(localized: "Las contraseñas no coinciden.")
            }
            return
        }
        errorMessage = nil
        path.append(.faceID)
    }

    /// Crea la clave en el Secure Enclave y registra la cuenta + dispositivo.
    func enrollAndRegister(app: AppModel) async {
        guard !isLoading, let otpId else { return }
        guard isProfileValid else {
            errorMessage = String(localized: "Completa tu nombre y correo electrónico antes de continuar.")
            path = [.phone, .otp, .profile]
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        // Confirmamos que Face ID funciona antes de crear la clave.
        guard await BiometricAuthenticator.authenticate(reason: String(localized: "Activa Face ID para proteger tu cuenta CuyPay")) else {
            errorMessage = String(localized: "Necesitamos Face ID para proteger tu cuenta. Actívalo en Ajustes > Face ID y código.")
            return
        }

        do {
            let publicKey = try await app.deviceKeys.createKey()
            let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let cleanFirst = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanLast = lastName.trimmingCharacters(in: .whitespacesAndNewlines)

            let request = RegisterRequest(
                otpId: otpId,
                otpCode: otpCode,
                phone: e164Phone,
                email: cleanEmail,
                firstName: cleanFirst,
                lastName: cleanLast,
                country: "CO",
                deviceName: UIDevice.current.name,
                devicePublicKey: publicKey,
                password: password
            )
            let session = try await app.api.register(request)
            app.user = session.user
            path.append(.kycIntro)
        } catch let error as APIError where error.code == .otpInvalid {
            try? app.deviceKeys.deleteKey()
            errorMessage = error.userMessage
            path = [.phone, .otp]
        } catch is DeviceKeyError {
            errorMessage = String(localized: "No pudimos crear la llave segura en este dispositivo.")
        } catch {
            try? app.deviceKeys.deleteKey()
            errorMessage = error.userMessage
        }
    }
}
