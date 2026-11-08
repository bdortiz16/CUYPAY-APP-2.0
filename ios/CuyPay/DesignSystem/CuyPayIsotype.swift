import SwiftUI

/// Isotipo de CuyPay (la "C" con la silueta del cuy).
///
/// PROVISIONAL: vectorizado a partir de una captura de baja resolución del logo propuesto por Zarta Studio.
/// Reemplazar por el SVG oficial cuando la diseñadora lo entregue (ver `docs/brand/`).
/// Coordenadas normalizadas 0…1 dentro de un cuadrado; se centra en el `rect` recibido.
struct CuyPayIsotype: Shape {
    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let origin = CGPoint(x: rect.midX - side / 2, y: rect.midY - side / 2)
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + x * side, y: origin.y + y * side)
        }
        var p = Path()
        p.move(to: pt(0.8356, 0.9933))
        p.addCurve(to: pt(0.9623, 0.9220), control1: pt(0.8903, 0.9841), control2: pt(0.9320, 0.9607))
        p.addCurve(to: pt(0.9981, 0.8390), control1: pt(0.9807, 0.8985), control2: pt(0.9939, 0.8678))
        p.addCurve(to: pt(0.9981, 0.5945), control1: pt(0.9995, 0.8293), control2: pt(0.9995, 0.5970))
        p.addCurve(to: pt(0.9904, 0.5990), control1: pt(0.9965, 0.5919), control2: pt(0.9953, 0.5926))
        p.addCurve(to: pt(0.9267, 0.6550), control1: pt(0.9669, 0.6300), control2: pt(0.9525, 0.6427))
        p.addCurve(to: pt(0.8518, 0.6755), control1: pt(0.9109, 0.6625), control2: pt(0.8740, 0.6726))
        p.addCurve(to: pt(0.7907, 0.6877), control1: pt(0.8436, 0.6767), control2: pt(0.8045, 0.6844))
        p.addCurve(to: pt(0.7563, 0.6968), control1: pt(0.7710, 0.6924), control2: pt(0.7689, 0.6930))
        p.addCurve(to: pt(0.6006, 0.7740), control1: pt(0.6922, 0.7159), control2: pt(0.6477, 0.7380))
        p.addCurve(to: pt(0.4996, 0.9248), control1: pt(0.5519, 0.8111), control2: pt(0.5156, 0.8653))
        p.addCurve(to: pt(0.4922, 0.9793), control1: pt(0.4944, 0.9438), control2: pt(0.4923, 0.9594))
        p.addCurve(to: pt(0.4965, 0.9937), control1: pt(0.4921, 0.9905), control2: pt(0.4925, 0.9920))
        p.addCurve(to: pt(0.8356, 0.9933), control1: pt(0.4994, 0.9948), control2: pt(0.8285, 0.9945))
        p.closeSubpath()
        p.move(to: pt(0.2069, 0.9024))
        p.addCurve(to: pt(0.2014, 0.8878), control1: pt(0.2069, 0.9013), control2: pt(0.2045, 0.8948))
        p.addCurve(to: pt(0.1792, 0.8251), control1: pt(0.1894, 0.8602), control2: pt(0.1827, 0.8412))
        p.addCurve(to: pt(0.1764, 0.8132), control1: pt(0.1782, 0.8205), control2: pt(0.1769, 0.8152))
        p.addCurve(to: pt(0.1753, 0.7096), control1: pt(0.1695, 0.7893), control2: pt(0.1690, 0.7389))
        p.addCurve(to: pt(0.1789, 0.6921), control1: pt(0.1761, 0.7057), control2: pt(0.1778, 0.6978))
        p.addCurve(to: pt(0.3124, 0.4982), control1: pt(0.1946, 0.6184), control2: pt(0.2454, 0.5445))
        p.addCurve(to: pt(0.4376, 0.4420), control1: pt(0.3476, 0.4738), control2: pt(0.3979, 0.4512))
        p.addCurve(to: pt(0.4486, 0.4271), control1: pt(0.4526, 0.4385), control2: pt(0.4535, 0.4373))
        p.addCurve(to: pt(0.4386, 0.3863), control1: pt(0.4427, 0.4147), control2: pt(0.4386, 0.3980))
        p.addCurve(to: pt(0.4662, 0.3169), control1: pt(0.4387, 0.3644), control2: pt(0.4497, 0.3367))
        p.addCurve(to: pt(0.5452, 0.2636), control1: pt(0.4887, 0.2899), control2: pt(0.5134, 0.2732))
        p.addCurve(to: pt(0.6050, 0.2552), control1: pt(0.5642, 0.2578), control2: pt(0.5788, 0.2558))
        p.addCurve(to: pt(0.6727, 0.2594), control1: pt(0.6219, 0.2548), control2: pt(0.6614, 0.2572))
        p.addCurve(to: pt(0.7614, 0.2862), control1: pt(0.7017, 0.2649), control2: pt(0.7296, 0.2733))
        p.addCurve(to: pt(0.8223, 0.3135), control1: pt(0.7921, 0.2986), control2: pt(0.7947, 0.2997))
        p.addCurve(to: pt(0.8485, 0.3231), control1: pt(0.8419, 0.3232), control2: pt(0.8419, 0.3232))
        p.addCurve(to: pt(0.8909, 0.3124), control1: pt(0.8569, 0.3230), control2: pt(0.8774, 0.3178))
        p.addCurve(to: pt(0.9987, 0.1804), control1: pt(0.9444, 0.2911), control2: pt(0.9917, 0.2332))
        p.addCurve(to: pt(0.9988, 0.1369), control1: pt(0.9999, 0.1715), control2: pt(1.0000, 0.1460))
        p.addCurve(to: pt(0.9300, 0.0327), control1: pt(0.9937, 0.0974), control2: pt(0.9664, 0.0560))
        p.addCurve(to: pt(0.8504, 0.0089), control1: pt(0.9067, 0.0176), control2: pt(0.8812, 0.0100))
        p.addCurve(to: pt(0.4892, 0.0069), control1: pt(0.7993, 0.0069), control2: pt(0.5083, 0.0052))
        p.addCurve(to: pt(0.3840, 0.0225), control1: pt(0.4388, 0.0111), control2: pt(0.4044, 0.0162))
        p.addCurve(to: pt(0.3704, 0.0262), control1: pt(0.3802, 0.0237), control2: pt(0.3740, 0.0253))
        p.addCurve(to: pt(0.1836, 0.1251), control1: pt(0.3155, 0.0388), control2: pt(0.2343, 0.0818))
        p.addCurve(to: pt(0.0195, 0.3800), control1: pt(0.1032, 0.1938), control2: pt(0.0503, 0.2760))
        p.addCurve(to: pt(0.0069, 0.4415), control1: pt(0.0156, 0.3929), control2: pt(0.0089, 0.4261))
        p.addCurve(to: pt(0.0040, 0.4634), control1: pt(0.0061, 0.4478), control2: pt(0.0048, 0.4577))
        p.addCurve(to: pt(0.0028, 0.5549), control1: pt(0.0006, 0.4883), control2: pt(0.0000, 0.5356))
        p.addCurve(to: pt(0.0059, 0.5778), control1: pt(0.0035, 0.5593), control2: pt(0.0049, 0.5697))
        p.addCurve(to: pt(0.0356, 0.6907), control1: pt(0.0108, 0.6170), control2: pt(0.0196, 0.6501))
        p.addCurve(to: pt(0.1216, 0.8305), control1: pt(0.0556, 0.7413), control2: pt(0.0849, 0.7890))
        p.addCurve(to: pt(0.2028, 0.9036), control1: pt(0.1469, 0.8591), control2: pt(0.1897, 0.8976))
        p.addCurve(to: pt(0.2069, 0.9024), control1: pt(0.2062, 0.9051), control2: pt(0.2069, 0.9049))
        p.closeSubpath()
        return p
    }
}

#Preview {
    CuyPayIsotype()
        .fill(Theme.spruce)
        .frame(width: 160, height: 160)
        .padding()
}
