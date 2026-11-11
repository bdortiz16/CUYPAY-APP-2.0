import Foundation
import Testing
@testable import CuyPay

@Suite("Extracción de datos seguros de tarjeta")
struct CardSecureDataExtractorTests {
    @Test("Extrae PAN, vencimiento y CVC desde el HTML SSR del emisor")
    func parsesLiveIssuerHtml() throws {
        let sampleHtml = """
        <!DOCTYPE html><html><head><meta charSet="utf-8"/></head><body><div id="__next"><div id="card" class="card"><p class="pan" id="pan">4599 1900 7575 6187<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 16H6"/></svg></p><div id="exp-code-container" class="exp-code-container"><p class="expiration-date" id="expiration-date">Exp: <!-- -->09/31</p><p class="security-code" id="security-code">CVV<!-- -->: <!-- -->767</p></div></div></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"fieldList":"pan,code,expiration"}}}</script></body></html>
        """

        let details = try CardSecureDataExtractor.parse(html: sampleHtml)
        #expect(details.rawPan == "4599190075756187")
        #expect(details.formattedPan == "4599 1900 7575 6187")
        #expect(details.expiry == "09/31")
        #expect(details.cvv == "767")
    }

    @Test("Normaliza año de 4 dígitos a MM/YY")
    func normalizesFourDigitYear() throws {
        let html = """
        <div id="card">
          <p id="pan">4599 1900 1234 5678</p>
          <p id="expiration-date">Exp: 08/2032</p>
          <p id="security-code">CVC: 904</p>
        </div>
        """

        let details = try CardSecureDataExtractor.parse(html: html)
        #expect(details.rawPan == "4599190012345678")
        #expect(details.expiry == "08/32")
        #expect(details.cvv == "904")
    }
}
