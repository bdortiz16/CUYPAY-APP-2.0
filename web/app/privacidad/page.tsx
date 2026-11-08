import type { Metadata } from "next";
import { LegalPage } from "@/components/site/LegalPage";

export const metadata: Metadata = {
  title: "Política de privacidad y tratamiento de datos",
  description:
    "Cómo XATECH SERVICES S.A.S. (CuyPay) trata tus datos personales según la Ley 1581 de 2012 y el Decreto 1377 de 2013. Borrador pendiente de revisión legal.",
  alternates: { canonical: "/privacidad/" },
};

const TOC = [
  { id: "responsable", label: "1. Responsable" },
  { id: "marco", label: "2. Marco legal" },
  { id: "datos", label: "3. Datos que tratamos" },
  { id: "biometria", label: "4. Biometría y Face ID" },
  { id: "finalidades", label: "5. Finalidades" },
  { id: "encargados", label: "6. Encargados y terceros" },
  { id: "transferencia", label: "7. Transferencia internacional" },
  { id: "derechos", label: "8. Tus derechos" },
  { id: "procedimiento", label: "9. Consultas y reclamos" },
  { id: "seguridad", label: "10. Seguridad" },
  { id: "conservacion", label: "11. Conservación" },
  { id: "menores", label: "12. Menores de edad" },
  { id: "cambios", label: "13. Cambios" },
];

export default function PrivacidadPage() {
  return (
    <LegalPage title="Política de privacidad" updated="8 de noviembre de 2026" toc={TOC}>
      <h2 id="responsable">1. Responsable del tratamiento</h2>
      <p>
        <strong>XATECH SERVICES S.A.S.</strong> (en adelante, &quot;CuyPay&quot;), sociedad colombiana, es la responsable del
        tratamiento de los datos personales recolectados a través de la aplicación CuyPay para iPhone, el sitio web
        www.cuypay.com y los canales de atención.
      </p>
      <ul>
        <li>Correo para asuntos de datos personales: <a href="mailto:info@cuypay.com">info@cuypay.com</a></li>
        <li>Domicilio: Bogotá D.C., Colombia. [NIT y dirección física pendientes de completar]</li>
      </ul>

      <h2 id="marco">2. Marco legal</h2>
      <p>
        Esta política se rige por el artículo 15 de la Constitución Política (derecho de Habeas Data), la{" "}
        <strong>Ley Estatutaria 1581 de 2012</strong>, el <strong>Decreto 1377 de 2013</strong> (compilado en el Decreto Único
        Reglamentario 1074 de 2015), la Ley 1266 de 2008 en lo que aplique a información financiera, y las instrucciones de la
        Superintendencia de Industria y Comercio (SIC).
      </p>

      <h2 id="datos">3. Datos que tratamos</h2>
      <table>
        <thead>
          <tr>
            <th>Categoría</th>
            <th>Ejemplos</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Identificación y contacto</td>
            <td>Nombres, apellidos, número celular, correo electrónico, país.</td>
          </tr>
          <tr>
            <td>Verificación de identidad (KYC)</td>
            <td>Tipo y número de documento, imágenes del documento, selfie y prueba de vida, resultado de la verificación.</td>
          </tr>
          <tr>
            <td>Transaccionales</td>
            <td>
              Saldos de los bolsillos COP y BRL, llave Bre-B, depósitos, envíos, conversiones, beneficiarios inscritos (nombre del
              titular, entidad y llave).
            </td>
          </tr>
          <tr>
            <td>Dispositivo y seguridad</td>
            <td>
              Identificador del dispositivo, clave pública generada en el Secure Enclave, dirección IP, registros de acceso y de
              firma de operaciones.
            </td>
          </tr>
          <tr>
            <td>Cumplimiento (SARLAFT)</td>
            <td>Resultados de consultas en listas restrictivas, alertas y reportes requeridos por la ley.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Las imágenes del documento y la selfie del proceso KYC son <strong>datos sensibles</strong>. Su suministro es
        facultativo, pero sin ellos no podemos abrir tu cuenta, porque la verificación de identidad es una obligación legal
        para prestar servicios de pago.
      </p>

      <h2 id="biometria">4. Biometría y Face ID</h2>
      <p>
        CuyPay usa Face ID (o el código del dispositivo) para que apruebes cada operación sensible.{" "}
        <strong>Tus datos biométricos de Face ID nunca salen de tu iPhone</strong>: Apple los procesa dentro del Secure Enclave y
        CuyPay no tiene acceso a ellos. Lo único que recibimos es una firma criptográfica (ECDSA P-256) que demuestra que la
        operación fue aprobada en tu dispositivo.
      </p>
      <p>
        La selfie y la prueba de vida del proceso KYC son distintas de Face ID: las procesa nuestro proveedor Sumsub con el
        único fin de verificar tu identidad (ver sección 6).
      </p>

      <h2 id="finalidades">5. Finalidades</h2>
      <ul>
        <li>Crear y administrar tu cuenta, tus bolsillos y tu llave Bre-B.</li>
        <li>Verificar tu identidad y prevenir fraude y suplantación.</li>
        <li>Procesar depósitos, envíos por Bre-B y conversiones de COP a BRL.</li>
        <li>
          Cumplir obligaciones de prevención de lavado de activos y financiación del terrorismo (SARLAFT), incluidos los reportes
          a la UIAF cuando la ley lo exija.
        </li>
        <li>Aplicar límites transaccionales y monitorear operaciones inusuales.</li>
        <li>Atender solicitudes, quejas y reclamos, y enviarte notificaciones del servicio.</li>
        <li>Con tu autorización expresa y revocable: enviarte información comercial de CuyPay.</li>
      </ul>

      <h2 id="encargados">6. Encargados y terceros</h2>
      <p>Compartimos datos solo en la medida necesaria con encargados que actúan bajo nuestras instrucciones:</p>
      <ul>
        <li><strong>Sumsub</strong>: verificación de identidad (KYC) y prueba de vida.</li>
        <li><strong>Coinsenda</strong>: procesamiento de pagos Bre-B en pesos colombianos.</li>
        <li><strong>Sartblock</strong>: consulta de listas restrictivas (AML) sobre beneficiarios.</li>
        <li><strong>Aliado de pagos en Brasil</strong>: liquidación de los reales (BRL) y operaciones PIX.</li>
        <li>Proveedores de infraestructura en la nube, mensajería SMS y correo.</li>
        <li>Autoridades competentes, cuando exista una orden legal o una obligación de reporte.</li>
      </ul>

      <h2 id="transferencia">7. Transferencia y transmisión internacional</h2>
      <p>
        Para convertir tus pesos en reales es necesario transmitir datos a nuestro aliado de pagos en{" "}
        <strong>Brasil</strong>, país que cuenta con la Lei Geral de Proteção de Dados (LGPD). Algunos encargados (por ejemplo,
        Sumsub y los proveedores de nube) pueden procesar datos en otros países. En todos los casos lo hacemos conforme al
        artículo 26 de la Ley 1581 de 2012, con contratos de transmisión que exigen niveles adecuados de protección, o con tu
        autorización expresa, que otorgas al aceptar esta política en la app.
      </p>

      <h2 id="derechos">8. Tus derechos como titular</h2>
      <ul>
        <li>Conocer, actualizar y rectificar tus datos.</li>
        <li>Solicitar prueba de la autorización otorgada.</li>
        <li>Ser informado sobre el uso que damos a tus datos.</li>
        <li>Presentar quejas ante la Superintendencia de Industria y Comercio.</li>
        <li>
          Revocar la autorización o pedir la supresión de tus datos, salvo cuando exista un deber legal o contractual de
          conservarlos (por ejemplo, registros SARLAFT).
        </li>
        <li>Acceder gratuitamente a tus datos personales.</li>
      </ul>

      <h2 id="procedimiento">9. Consultas y reclamos</h2>
      <p>
        Escríbenos a <a href="mailto:info@cuypay.com">info@cuypay.com</a> desde el correo registrado, indicando tu nombre,
        número de documento y la solicitud.
      </p>
      <ul>
        <li><strong>Consultas</strong>: respondemos en máximo 10 días hábiles (prorrogables 5 días hábiles más).</li>
        <li>
          <strong>Reclamos</strong>: respondemos en máximo 15 días hábiles (prorrogables 8 días hábiles más). Si el reclamo está
          incompleto, te pediremos completarlo dentro de los 5 días siguientes.
        </li>
      </ul>

      <h2 id="seguridad">10. Seguridad de la información</h2>
      <p>
        Aplicamos cifrado en tránsito (TLS) y en reposo, firma de cada operación con una clave guardada en el Secure Enclave,
        control de acceso por roles con autenticación de dos factores para nuestro equipo, registros de auditoría inmutables y
        separación de secretos en el servidor. Ningún sistema es infalible; si ocurre un incidente que afecte tus datos te
        avisaremos y lo informaremos a la SIC según la ley.
      </p>

      <h2 id="conservacion">11. Conservación</h2>
      <p>
        Conservamos tus datos mientras tengas una cuenta activa y, después, durante el tiempo exigido por las normas comerciales,
        tributarias y de prevención de lavado de activos (en general, al menos 5 años desde la última operación).
      </p>

      <h2 id="menores">12. Menores de edad</h2>
      <p>CuyPay es solo para mayores de 18 años. No recolectamos conscientemente datos de menores.</p>

      <h2 id="cambios">13. Cambios a esta política</h2>
      <p>
        Si hacemos cambios sustanciales te avisaremos en la app o por correo antes de que entren en vigor. Esta política está
        vigente desde su publicación definitiva y la base de datos será inscrita en el Registro Nacional de Bases de Datos
        (RNBD) cuando aplique.
      </p>
    </LegalPage>
  );
}
