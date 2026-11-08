import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// Genera códigos QR nítidos con CoreImage (`CIQRCodeGenerator`).
enum QRCodeGenerator {
    /// - Parameters:
    ///   - string: contenido (ej. la llave Bre-B `@cuypayana123`).
    ///   - scale: factor de escalado entero para que el QR no se vea borroso.
    static func image(for string: String, scale: CGFloat = 12) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
