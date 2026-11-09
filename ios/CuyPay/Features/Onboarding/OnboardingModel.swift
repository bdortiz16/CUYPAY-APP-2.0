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
        let parts = email.trimmingCharacters(in: .whitespaces).split(separator: "@")
        return parts.count == 2 && parts[1].contains(".") && !parts[0].isEmpty && parts[1].last != "."
    }
    var isProfileValid: Bool {
        firstName.trimmingCharacters(in: .whitespaces).count >= 2 &&
            lastName.trimmingCharacters(in: .whitespaces).count >= 2 &&
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

    func confirmOTP() {
        guard isOTPComplete else { return }
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
            let cleanEmail = email.trimmingCharacters(in: .whitespaces).lowercased()
            let cleanFirst = firstName.trimmingCharacters(in: .whitespaces)
            let cleanLast = lastName.trimmingCharacters(in: .whitespaces)

            let request = RegisterRequest(
                otpId: otpId,
                otpCode: otpCode,
                phone: e164Phone,
                email: cleanEmail.isEmpty ? "usuario@cuypay.com" : cleanEmail,
                firstName: cleanFirst.isEmpty ? "Usuario" : cleanFirst,
                lastName: cleanLast.isEmpty ? "CuyPay" : cleanLast,
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
