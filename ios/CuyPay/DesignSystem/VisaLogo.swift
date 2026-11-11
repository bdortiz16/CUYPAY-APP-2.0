import SwiftUI

/// Wordmark vectorial oficial de Visa (proporción ~3.10:1, coordenadas normalizadas 0…1).
struct VisaWordmark: Shape {
    static let aspectRatio: CGFloat = 3.0964

    func path(in rect: CGRect) -> Path {
        guard rect.width > 0, rect.height > 0 else { return Path() }
        let targetRatio = Self.aspectRatio
        let currentRatio = rect.width / rect.height
        let drawSize: CGSize = if currentRatio > targetRatio {
            CGSize(width: rect.height * targetRatio, height: rect.height)
        } else {
            CGSize(width: rect.width, height: rect.width / targetRatio)
        }
        let origin = CGPoint(
            x: rect.midX - drawSize.width / 2,
            y: rect.midY - drawSize.height / 2
        )
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + x * drawSize.width, y: origin.y + y * drawSize.height)
        }

        var p = Path()
        // V (con remate superior izquierdo característico)
        p.move(to: pt(0.37967, 0.01780))
        p.addLine(to: pt(0.24875, 0.98491))
        p.addLine(to: pt(0.16333, 0.98491))
        p.addLine(to: pt(0.09892, 0.21300))
        p.addCurve(to: pt(0.07971, 0.12811), control1: pt(0.09500, 0.16553), control2: pt(0.09163, 0.14811))
        p.addCurve(to: pt(0.00000, 0.04580), control1: pt(0.06029, 0.09547), control2: pt(0.02821, 0.06489))
        p.addLine(to: pt(0.00192, 0.01780))
        p.addLine(to: pt(0.13942, 0.01780))
        p.addCurve(to: pt(0.17667, 0.11637), control1: pt(0.15798, 0.01775), control2: pt(0.17379, 0.05958))
        p.addLine(to: pt(0.21071, 0.67604))
        p.addLine(to: pt(0.29479, 0.01780))
        p.closeSubpath()

        // S
        p.move(to: pt(0.71437, 0.66920))
        p.addCurve(to: pt(0.60117, 0.28577), control1: pt(0.71471, 0.41388), control2: pt(0.60037, 0.39982))
        p.addCurve(to: pt(0.63542, 0.20475), control1: pt(0.60142, 0.25106), control2: pt(0.61208, 0.21417))
        p.addCurve(to: pt(0.71512, 0.24810), control1: pt(0.66276, 0.19671), control2: pt(0.69030, 0.21168))
        p.addLine(to: pt(0.72929, 0.04296))
        p.addCurve(to: pt(0.65371, 0.00000), control1: pt(0.70512, 0.01483), control2: pt(0.67953, 0.00028))
        p.addCurve(to: pt(0.51712, 0.31983), control1: pt(0.57383, 0.00000), control2: pt(0.51762, 0.13160))
        p.addCurve(to: pt(0.58787, 0.58302), control1: pt(0.51662, 0.45904), control2: pt(0.55725, 0.53658))
        p.addCurve(to: pt(0.62979, 0.70314), control1: pt(0.61937, 0.63037), control2: pt(0.62996, 0.66082))
        p.addCurve(to: pt(0.58146, 0.79783), control1: pt(0.62958, 0.76816), control2: pt(0.60471, 0.79667))
        p.addCurve(to: pt(0.49846, 0.73681), control1: pt(0.54083, 0.79977), control2: pt(0.51729, 0.76390))
        p.addLine(to: pt(0.48383, 0.94865))
        p.addCurve(to: pt(0.57367, 1.00000), control1: pt(0.50271, 0.97549), control2: pt(0.53754, 0.99897))
        p.addCurve(to: pt(0.71437, 0.66920), control1: pt(0.65854, 1.00000), control2: pt(0.71408, 0.87021))
        p.closeSubpath()

        // A (contorno exterior + triángulo interior con regla even-odd)
        p.move(to: pt(0.92525, 0.98491))
        p.addLine(to: pt(1.00000, 0.98491))
        p.addLine(to: pt(0.93479, 0.01780))
        p.addLine(to: pt(0.86579, 0.01780))
        p.addCurve(to: pt(0.83137, 0.08876), control1: pt(0.85071, 0.01737), control2: pt(0.83706, 0.04550))
        p.addLine(to: pt(0.71017, 0.98491))
        p.addLine(to: pt(0.79500, 0.98491))
        p.addLine(to: pt(0.81188, 0.84041))
        p.addLine(to: pt(0.91554, 0.84041))
        p.closeSubpath()

        p.move(to: pt(0.83513, 0.64224))
        p.addLine(to: pt(0.87762, 0.27906))
        p.addLine(to: pt(0.90212, 0.64224))
        p.closeSubpath()

        // I
        p.move(to: pt(0.49512, 0.01780))
        p.addLine(to: pt(0.42833, 0.98491))
        p.addLine(to: pt(0.34750, 0.98491))
        p.addLine(to: pt(0.41437, 0.01780))
        p.closeSubpath()

        return p
    }
}

/// Vista lista para incrustar la marca Visa en tarjetas virtuales y resúmenes.
struct VisaLogoView: View {
    var height: CGFloat = 18
    var color: Color = .white

    var body: some View {
        VisaWordmark()
            .fill(color, style: FillStyle(eoFill: true))
            .frame(width: height * VisaWordmark.aspectRatio, height: height)
            .accessibilityLabel(Text(verbatim: "Visa"))
    }
}

#Preview {
    ZStack {
        Theme.onyx.ignoresSafeArea()
        VisaLogoView(height: 28, color: .white)
    }
}
