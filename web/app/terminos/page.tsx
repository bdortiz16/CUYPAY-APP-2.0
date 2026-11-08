import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/LegalPage";

export const metadata: Metadata = {
  title: "Términos y condiciones",
  description: "Condiciones de uso de la app CuyPay de XATECH SERVICES S.A.S. Borrador pendiente de revisión legal.",
  alternates: { canonical: "/terminos/" },
};

const TOC = [
  { id: "aceptacion", label: "1. Aceptación" },
  { id: "servicio", label: "2. El servicio" },
  { id: "requisitos", label: "3. Requisitos y cuenta" },
  { id: "breb", label: "4. Llave Bre-B y depósitos" },
  { id: "conversion", label: "5. Conversión COP → BRL" },
  { id: "envios", label: "6. Envíos y beneficiarios" },
  { id: "tarifas", label: "7. Tarifas" },
  { id: "limites", label: "8. Límites" },
  { id: "seguridad", label: "9. Seguridad y Face ID" },
  { id: "bloqueo", label: "10. Bloqueo y terminación" },
  { id: "responsabilidad", label: "11. Responsabilidad" },
  { id: "pqr", label: "12. Peticiones, quejas y reclamos" },
  { id: "ley", label: "13. Ley aplicable" },
];

export default function TerminosPage() {
  return (
    <LegalPage title="Términos y condiciones" updated="8 de noviembre de 2026" toc={TOC}>
      <h2 id="aceptacion">1. Aceptación</h2>
      <p>
        Estos términos regulan el uso de la aplicación CuyPay y los servicios ofrecidos por <strong>XATECH SERVICES S.A.S.</strong>{" "}
        (&quot;CuyPay&quot;). Al crear una cuenta aceptas estos términos y la{" "}
        <Link href="/privacidad/">Política de privacidad</Link>. Si no estás de acuerdo, no uses la app.
      </p>

      <h2 id="servicio">2. El servicio</h2>
      <p>CuyPay es una billetera digital para iPhone que te permite:</p>
      <ul>
        <li>Recibir pesos colombianos (COP) mediante una llave Bre-B a tu nombre.</li>
        <li>Mantener saldos en dos bolsillos: COP y reales brasileños (BRL).</li>
        <li>Convertir COP a BRL con una cotización previa y comisión informada.</li>
        <li>Enviar COP por Bre-B a beneficiarios inscritos y verificados.</li>
      </ul>
      <p>
        CuyPay no es un banco ni una entidad vigilada como establecimiento de crédito. Los fondos y las operaciones de pago se
        procesan a través de aliados autorizados (entre ellos Coinsenda para Bre-B y un aliado de pagos en Brasil). [Pendiente:
        detallar esquema regulatorio y custodia de fondos tras revisión legal.]
      </p>

      <h2 id="requisitos">3. Requisitos y cuenta</h2>
      <ul>
        <li>Ser mayor de 18 años y tener un número celular de Colombia.</li>
        <li>Completar la verificación de identidad (KYC) con Sumsub y suministrar información veraz.</li>
        <li>Usar un iPhone compatible con Face ID o código del dispositivo.</li>
      </ul>
      <p>
        Tu cuenta es personal e intransferible. Debes mantener tus datos actualizados. Podemos pedirte información adicional en
        cualquier momento para cumplir obligaciones de conocimiento del cliente.
      </p>

      <h2 id="breb">4. Llave Bre-B y depósitos</h2>
      <p>
        Una vez verificada tu identidad puedes crear una llave Bre-B. Los pesos que recibas en ella se acreditan en tu bolsillo
        COP. Si tu cuenta está bloqueada, los depósitos pueden quedar retenidos hasta que se resuelva la situación.
      </p>

      <h2 id="conversion">5. Conversión COP → BRL</h2>
      <p>
        Antes de convertir verás la tasa aplicada, la comisión y el monto exacto en reales que recibirás. La cotización es válida
        por 30 segundos; si vence, deberás solicitar una nueva. Al confirmar con Face ID la operación es definitiva. El monto en
        BRL se calcula como (monto en COP − comisión) × tasa, redondeado hacia abajo al centavo.
      </p>

      <h2 id="envios">6. Envíos y beneficiarios</h2>
      <p>
        Solo puedes enviar a beneficiarios inscritos. Al inscribir uno, consultamos el titular de la llave en el directorio
        Bre-B y lo verificamos en listas restrictivas. Un beneficiario puede quedar en revisión o ser rechazado por razones de
        cumplimiento. Eres responsable de confirmar que el nombre del titular corresponde a la persona a quien quieres enviar.
      </p>

      <h2 id="tarifas">7. Tarifas</h2>
      <p>
        Recibir pesos por Bre-B no tiene costo. La conversión tiene una comisión (actualmente 1 % con un mínimo de $ 2.000) y un
        margen incluido en la tasa, que siempre se muestran antes de confirmar. Cualquier cambio en tarifas se informará en la
        app con anticipación.
      </p>

      <h2 id="limites">8. Límites</h2>
      <p>
        Aplicamos límites diarios, mensuales y anuales por tipo de operación (enviar, convertir, recibir), según tu nivel de
        verificación y tu perfil de riesgo. Los periodos se calculan en hora de Bogotá. En la app puedes consultar cuánto has
        usado y cuánto te queda.
      </p>

      <h2 id="seguridad">9. Seguridad y Face ID</h2>
      <p>
        Cada operación sensible requiere tu aprobación con Face ID. No compartas tu celular desbloqueado ni el acceso a tu cuenta.
        Si pierdes tu iPhone o sospechas un uso no autorizado, escríbenos de inmediato a{" "}
        <a href="mailto:info@cuypay.com">info@cuypay.com</a> para bloquear tu cuenta.
      </p>

      <h2 id="bloqueo">10. Bloqueo y terminación</h2>
      <p>
        Podemos congelar o cerrar tu cuenta cuando lo exija la ley, una autoridad, nuestro sistema SARLAFT, o cuando detectemos
        fraude o incumplimiento de estos términos. Puedes cerrar tu cuenta en cualquier momento; antes debes retirar o convertir
        tus saldos según las opciones disponibles.
      </p>

      <h2 id="responsabilidad">11. Responsabilidad</h2>
      <p>
        CuyPay responde por la correcta ejecución de las operaciones que confirmes, en los términos de la ley. No respondemos por
        errores en los datos que tú suministres, por interrupciones de terceros ajenos a nuestro control (por ejemplo, caída del
        sistema Bre-B) ni por el uso de tu cuenta desde tu dispositivo con tu aprobación biométrica.
      </p>

      <h2 id="pqr">12. Peticiones, quejas y reclamos</h2>
      <p>
        Puedes presentar PQR a <a href="mailto:info@cuypay.com">info@cuypay.com</a>. Responderemos dentro de los plazos legales
        y, en todo caso, en máximo 15 días hábiles. También puedes acudir a la Superintendencia de Industria y Comercio.
      </p>

      <h2 id="ley">13. Ley aplicable</h2>
      <p>
        Estos términos se rigen por las leyes de la República de Colombia, incluida la Ley 1480 de 2011 (Estatuto del
        Consumidor). Cualquier controversia se resolverá ante los jueces competentes de Colombia.
      </p>
    </LegalPage>
  );
}
