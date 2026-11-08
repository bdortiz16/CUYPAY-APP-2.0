  // Cuentas y saldos. Toda interfaz los necesita para pintar la cabecera.
  app.get('/api/accounts', async (req, res, next) => {
    try {
      const id = await getUserId()
      const data = await withSession((c) => c.account.user.__get__accounts({ id }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Catálogo de monedas. Lo consume useCurrencies para armar los medios de pago.
  // Son unas decenas: basta un `limit` explícito, que deja a la vista el corte de
  // 200 del guardia.
  app.get('/api/currencies', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.transaction.currency.find({ limit: 200 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Enlaces de cobro del comercio, los más nuevos primero. El servicio corta en
  // 200 por consulta: sin el orden, quien pasara de 200 enlaces dejaría de ver
  // los que acaba de crear.
  //
  // Es una ventana a propósito, no la lista entera: solo se pinta, y nada se crea
  // por no ver un enlace. El `limit` va explícito para que el corte se vea aquí.
  app.get('/api/payment-links', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.user.__get__paymentRequests({ order: 'id DESC', limit: 200 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Creación de un enlace de cobro. El body va al PRIMER NIVEL: el SDK
  // (sin rawPayload) lo envuelve en { data: {...} } e inyecta country/recaptcha.
  // Volver a envolverlo aquí lo dejaría doble-anidado y el servicio responde 465.
  app.post('/api/payment-links', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.paymentRequest.addNewPaymentRequest(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Detalle de un enlace. Lo consulta tanto el comercio como el pagador.
  app.get('/api/payment-links/:id', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.paymentRequest.getPaymentRequestDetailsPublic({ payment_request_id: req.params.id }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Vigilancia de los pagos en curso de un enlace. Cada vez que alguien elige un
  // medio en el checkout queda un intento (paymentRequestLog) con su medio de
  // recaudo, y el backend vigila ese medio más o menos un minuto. El checkout la
  // renueva mientras está abierto; si quien paga lo cierra antes de que llegue el
  // pago, nadie la renovaría. El detalle del enlace llama aquí mientras el cobro
  // está pendiente, y así el pago se detecta aunque el checkout ya no esté.
  //
  // Una vez cada 50 s por enlace, aunque lo pidan varias pestañas: más seguido no
  // cambia cuándo vence la vigilancia.
  const LINK_WATCH_TTL_MS = 50 * 1000
  const linkWatchedAt = new Map()
  app.post('/api/payment-links/:id/watch', async (req, res, next) => {
    try {
      const id = req.params.id
      const now = Date.now()
      if (now - (linkWatchedAt.get(id) || 0) < LINK_WATCH_TTL_MS) {
        res.json({ armed: 0, fresh: true })
        return
      }
      linkWatchedAt.set(id, now)

      // Un solo enlace. Con el include de una relación de muchos (los intentos), el
      // guardia admite como mucho 50 en la consulta principal.
      const found = await withSession((c) => c.deposit.user.__get__paymentRequests({
        where: { id },
        include: ['paymentRequestLogs'],
        limit: 1,
      }))
      if (typeof found?.status === 'number' && (found.status < 200 || found.status >= 300)) {
        linkWatchedAt.delete(id)
        sendSdkResult(res, found)
        return
      }

      // Intentos que todavía pueden recibir un pago: pendientes y dentro de su
      // tolerancia. Una cotización renovada deja más de uno vivo a la vez.
      const logs = (Array.isArray(found?.data) ? found.data[0]?.paymentRequestLogs : null) || []
      const live = logs.filter((log) => {
        if (!log?.deposit_provider_id || log.state !== 'pending') return false
        const until = new Date(log.tolerance_date || log.expiration_date).getTime()
        return Number.isFinite(until) && until > now
      })
      const providers = [...new Map(live.map((log) => [log.deposit_provider_id, log])).values()]

      const results = await Promise.all(providers.map((log) => withSession((c) => (
        c.deposit.paymentRequest.subscribeToNewDepositsForPaymentRequestPublic({
          deposit_provider_id: log.deposit_provider_id,
          currency: log.currency,
        })
      )).catch(() => null)))
      const armed = results.filter((r) => r && r.status >= 200 && r.status < 300).length
      // Si alguno falló, la próxima llamada reintenta en vez de esperar 50 s.
      if (armed < providers.length) linkWatchedAt.delete(id)
      res.json({ armed, pending: providers.length })
    } catch (err) {
      linkWatchedAt.delete(req.params.id)
      next(err)
    }
  })

// ================================================

  // Cuentas de recaudo provisionadas: el CATÁLOGO de la plataforma, un medio por
  // moneda y tipo, unas decenas. El `limit` va explícito porque el guardia corta en
  // 200 aunque no se pida; si un día pasa de ahí, hay que paginar por `id`.
  app.get('/api/deposit-accounts', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositAccount.find({ limit: 200 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

 y se crea otra, cada una con su propia dirección. Así una
  // cuenta llegó a unos 530 medios repetidos (27 de octubre de 2026).
  app.get('/api/deposit-providers', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.deposit.user.__get__depositProviders(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })'),n(

// ================================================

  // Lo que el usuario ya configuró. La relación devuelve activas E históricas: el
  // core filtra por `enabled`, acá no se toca.
  //
  // Se leen TODAS, de a 200 por `id` (fetchAllById): guardar crea una si no ve
  // ninguna activa para ese alcance, y las históricas se acumulan. Cortada en 200,
  // la activa puede no llegar y se crearía otra.
  app.get('/api/deposit-provider-user-configs', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.deposit.user.__get__depositProviderUserConfigs(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Crear. `account_id` acota la configuración a una cuenta; omitirlo la hace
  // general. El `userId` no viaja: lo deriva el backend del token.
  app.post('/api/deposit-provider-user-configs', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProviderUserConfig.addNewDepositProviderUserConfigPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Actualizar. REEMPLAZA el `custom` completo, no es un patch: lo que no se
  // manda se borra.
  app.post('/api/deposit-provider-user-configs/update', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProviderUserConfig.updateDepositProviderUserConfigPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Consulta al directorio Bre-B. Se lee AL REVÉS de lo que parece: el directorio
  // responde con error cuando la llave NO existe, que es justo el caso que busca
  // quien está creando una. Por eso ESE error no se propaga como fallo.
  //
  // Solo ese. Sin alias, o con `?alias=a&alias=b` (Express lo entrega como array),
  // el JSON Schema del servicio responde 465 remotequeryguard_7, y leerlo como
  // "libre" reservaría una llave sin haber preguntado. Va un 400: el cliente lanza
  // y el veredicto queda desconocido, que es lo honesto.
  app.get('/api/breb/resolve', async (req, res, next) => {
    const alias = req.query.alias
    if (typeof alias !== 'string' || !alias.trim()) {
      res.status(400).json({ error: 'Falta el alias a consultar', code: null })
      return
    }
    try {
      const data = await withSession((c) => c.withdraw.withdrawAccount.resolveBrebAliasPublic({ alias }))
      if (isHttpSuccess(data?.status)) {
        res.json(data)
        return
      }
      // La llave NO existe: `withdrawaccount_23` ("Cannot resolve breb alias").
      // NO pasa por sendSdkResult: el cliente lo distingue por la FORMA, con
      // `.error` al primer nivel está libre; con `.data`, ocupada. Cualquier otro
      // error (guardia, sesión, servicio caído) sale como error, con su status.
      const error = data?.data?.error
      if (error?.code === 'withdrawaccount_23') {
        res.json({ error })
        return
      }
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Reclama una llave. El deposit_account_id es el id del CATÁLOGO de la
  // plataforma (el medio provisionado), no el de la llave.
  app.post('/api/deposit-providers', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProvider.createDepositProviderByAccountIdPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Bloquear, desbloquear y eliminar comparten forma: POST por id.
  app.post('/api/deposit-providers/:id/block', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProvider.blockDepositProviderPublic({ deposit_provider_id: req.params.id }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

  app.post('/api/deposit-providers/:id/unblock', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProvider.reactivateDepositProviderPublic({ deposit_provider_id: req.params.id }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

  app.post('/api/deposit-providers/:id/cancel', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProvider.cancelDepositProviderPublic({ deposit_provider_id: req.params.id }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Pide al backend que vigile los depósitos de una llave. NO es un webhook y no
  // recibe URL: el aviso viaja por el canal de tiempo real. La vigilancia caduca,
  // así que el cliente la renueva.
  app.post('/api/deposit-providers/:id/subscribe', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.depositProvider.subscribeToNewDeposits({
        deposit_provider_id: req.params.id,
        account_id: req.body?.account_id,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Lo recibido por la cuenta: los 200 más RECIENTES.
  //
  // Es una ventana a propósito, no la lista entera: el sondeo la relee cada pocos
  // segundos y el historial no para de crecer. Sin `order` llegaban los 200 más
  // VIEJOS y, pasado ese número, ningún depósito nuevo aparecía.
  app.get('/api/deposits', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.deposit.user.__get__deposits({ order: 'id DESC', limit: 200 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Proveedores de tarjeta: qué monedas hay y qué datos pide cada uno.
  // `info_needed` sale de aquí, y por eso el formulario de titular no se hardcodea.
  //
  // Catálogo chico (uno por moneda): basta un `limit` explícito, que deja a la vista
  // el corte de 200 del guardia.
  app.get('/api/card-providers', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.cardProvider.find({ limit: 200 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

... Esta lista es la que el producto
  // usa para que haya un solo vocabulario.
  //
  // Unos 250 países. En este catálogo el guardia de identity admite hasta 300 (y
  // corta ahí sin avisar): el `limit` va explícito con ese tope.
  app.get('/api/countries', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.identity.country.find({ limit: 300 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })'),n(

// ================================================

  // Departamentos de un país. Segundo escalón de la cascada país → provincia →
  // ciudad: el emisor espera el `code` del catálogo (`valle_del_cauca`), no lo que
  // alguien escriba. Un catálogo vacío no es un fallo —hay países sin división
  // cargada—: la interfaz cae a texto libre, como hace el producto.
  app.get('/api/provinces', async (req, res, next) => {
    try {
      const { country } = req.query
      // El SDK espera `where` en la RAÍZ del argumento. Envuelto en `filter` no
      // viaja, y la llamada responde 200 con el catálogo MUNDIAL entero (3766
      // provincias en vez de las 32 de Colombia): el fallo es silencioso.
      //
      // Un país tiene unas decenas; el guardia de identity admite 300 aquí y corta
      // ahí sin avisar, así que el `limit` va explícito.
      const query = country ? { where: { country }, limit: 300 } : { limit: 300 }
      const data = await withSession((c) => c.identity.province.find(query))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Ciudades de un departamento. Tercer escalón de la cascada.
  app.get('/api/cities', async (req, res, next) => {
    try {
      const { province } = req.query
      // Mismo contrato que /api/provinces. Envuelto en `filter` devuelve las 1297
      // ciudades del país entero para CUALQUIER departamento, y entonces la cascada
      // deja elegir una ciudad que no pertenece a la provincia elegida. El emisor
      // rechaza esa combinación al crear el titular, con `cardholder_5`, sin decir
      // cuál de los dos campos sobra.
      //
      // El que más tiene es Antioquia, con 125 municipios: cabe en un `limit` de 200,
      // explícito porque el guardia corta ahí sin avisar.
      const query = province ? { where: { province }, limit: 200 } : { limit: 200 }
      const data = await withSession((c) => c.identity.city.find(query))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Abre la cuenta de tarjetas de UN usuario. Una llamada crea la cuenta
  // contable, su billetera espejo y —solo la primera vez— el titular.
  //
  // Devuelve el id de la BILLETERA, no el de la cuenta contable: para quedarte con
  // el ledger hay que releer /api/card-accounts y casar por account_id.
  //
  // TODO(integrador): guarda la asociación usuario -> cuenta ANTES de llamar. Si
  // esto funciona y tu registro no llega a escribirse, la cuenta queda huérfana y
  // no hay operación que la borre.
  app.post('/api/card-accounts', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.card.setupAccountPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Las cuentas contables abiertas. Son TODAS las del negocio.
  //
  // Se leen TODAS, de a 200 por `id` (fetchAllById): hay una por usuario final, y
  // abrir una relee esta lista para encontrar la nueva. Cortada en 200, la recién
  // abierta no aparece.
  //
  // TODO(integrador): filtra por las del usuario de la sesión antes de responder.
  app.get('/api/card-accounts', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.farming.user.__get__ledgerAccounts(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Titulares de tarjeta ya registrados. Se leen TODOS, de a 200 por `id`
  // (fetchAllById): crecen con cada usuario final, y uno que no llega no se puede
  // elegir para emitir ni para reparar una tarjeta.
  app.get('/api/card-holders', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.farming.user.__get__cardHolders(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

 sin decir por qué.
  app.post('/api/card-holders', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.cardHolder.addNewCardHolderPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })'),n(

// ================================================

 de texto responde 465
  // remotequeryguard_7 sin crear nada. Se normaliza aquí, en la frontera, porque
  // un input de formulario entrega texto aunque el usuario escriba un número.
  // `userId` no se manda: el backend lo toma de la sesión.
  //
  // TODO(integrador): comprueba que `ledger_account_id` es del usuario de la sesión.
  app.post('/api/cards', async (req, res, next) => {
    try {
      const body = req.body || {}
      const products = (Array.isArray(body.products) ? body.products : []).map((item) => {
        const n = Number(item?.quantity)
        return item && item.quantity != null && Number.isFinite(n) ? { ...item, quantity: n } : item
      })
      const data = await withSession((c) => c.marketplace.sale.addNewSalePublic({ ...body, products }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })'),n(

// ================================================

  // El catálogo de productos de tarjeta, con sus existencias dentro.
  //
  // El filtro NO es una optimización: sin where, este endpoint devuelve el catálogo
  // entero del marketplace —decenas de MB, más de 45 s— y cualquier cliente con un
  // timeout normal lo vive como si el servidor se hubiera colgado.
  //
  // Y el stock va en el mismo include, no en una llamada aparte: el modelo stock no
  // expone GET, así que las existencias solo se leen como relación del producto.
  app.get('/api/card-products', async (req, res, next) => {
    try {
      // `where`/`include` van en la raíz. Envuelto en `filter` esta llamada ni
      // siquiera responde: status 0.
      //
      // `stocks` es una relación de muchos, y con ella el guardia admite como mucho 50
      // productos por consulta. Los de tarjeta son unos pocos (virtual y física por
      // moneda): basta ese `limit`, explícito.
      const query = { where: { category: 'card' }, include: ['stocks'], limit: 50 }
      const data = await withSession((c) => c.marketplace.product.find(query))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Las direcciones de entrega ya registradas.
  //
  // Se leen ANTES de crear una: el marketplace no deduplica por correo y no hay
  // operación que borre una dirección, así que sin esta consulta cada emisión deja
  // un duplicado. Es lo que hace el producto.
  //
  // Por eso se leen TODAS, de a 200 por `id` (fetchAllById): hay una por correo de
  // entrega, y cortada en 200 la que ya existe "no está" y se crea otra.
  //
  // Se lee por la RELACIÓN del usuario: el modelo `shippingAddress` no expone GET.
  app.get('/api/card-deliveries', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.marketplace.user.__get__shippingAddresses(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // El destino de entrega. En una tarjeta virtual es un correo, con dirección de
  // tipo digital; la física usa el mismo mecanismo con una postal real.
  app.post('/api/card-delivery', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.marketplace.shippingAddress.addNewShippingAddressPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Las tarjetas emitidas. Son TODAS las del negocio, de todos sus usuarios.
  //
  // Se leen TODAS, de a 200 por `id` (fetchAllById): la interfaz las filtra por
  // cuenta contable, y cortadas en 200 las de un usuario pueden no llegar nunca.
  //
  // TODO(integrador): filtra por la cuenta contable del usuario de la sesión.
  app.get('/api/cards', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.farming.user.__get__cards(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Vincula una tarjeta con su titular. Hace falta porque el enlace puede no
  // llegar solo, y sin titular no se pueden mostrar los datos de la tarjeta.
  app.post('/api/cards/:id/holder', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.card.attachCardHolderPublic({
        ...req.body,
        card_id: req.params.id,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // La URL del marco del emisor: es donde el usuario ve su número y su CVV.
  //
  // Es lo ÚNICO de esta integración que puedes reenviar al navegador de tu usuario:
  // no lleva credencial tuya. El número completo no pasa por aquí en ningún momento.
  //
  // TODO(integrador): comprueba que la tarjeta es del usuario de la sesión.
  app.post('/api/cards/:id/look-url', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.card.getCardLookUrlPublic({
        ...req.body,
        card_id: req.params.id,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Congela, reactiva o cancela. Un solo endpoint para los tres.
  //
  // Cancelar es PERMANENTE y la tarjeta desaparece de la lista: no queda historial.
  //
  // TODO(integrador): comprueba que la tarjeta es del usuario de la sesión.
  app.post('/api/cards/:id/working-state', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.card.updateWorkingStatePublic({
        ...req.body,
        card_id: req.params.id,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Renombra la tarjeta.
  app.post('/api/cards/:id/label', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.card.updateLabelPublic({
        ...req.body,
        card_id: req.params.id,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Pone al día una cuenta contable. Sin esto los movimientos no aparecen: el
  // gasto ocurre fuera de tu aplicación y no hay webhook que avise.
  //
  // TODO(integrador): comprueba que la cuenta es del usuario de la sesión.
  app.post('/api/card-accounts/:id/sync', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.farming.ledgerAccount.forceSyncLedgerTransactionsPublic({
        ledger_account_id: req.params.id,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Los movimientos ya sincronizados. Son TODOS los del negocio.
  //
  // Se leen TODOS, de a 200 por `id` (fetchAllById): la interfaz los filtra por
  // cuenta contable, y cortados en 200 los de un usuario pueden no llegar nunca.
  // Crecen con cada gasto: pasar `ledger_account_id` en el `where` (segundo
  // argumento de fetchAllById) achica también la lectura.
  //
  // TODO(integrador): filtra por la cuenta contable del usuario de la sesión.
  app.get('/api/card-transactions', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.farming.user.__get__cardTransactions(filter)))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Pares de conversión disponibles.
  app.get('/api/pairs', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.swap.pair.getAllPairsForPublic({}))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Los medios por los que se puede enviar: uno por moneda y tipo (breb, bank,
  // internal_network). De aquí salen los mínimos, los máximos, las tarifas y qué
  // datos pide cada alta de cuenta (`info_needed`). El `limit` va explícito: el
  // guardia de consultas corta en 200 aunque no se pida, y así se ve dónde.
  app.get('/api/withdraw-providers', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.withdraw.withdrawProvider.find({
        where: { enabled: true, visible: true },
        limit: 200,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Las cuentas de destino registradas. Las ocultas no vuelven: "borrar" una
  // cuenta es ocultarla, y el backend la conserva por los retiros que ya tiene.
  //
  // Se leen TODAS, de a 200 por `id` (fetchAllById): el guardia corta cada consulta
  // en 200 sin avisar, y una cuenta que no llega "no existe" para la pantalla, que
  // la vuelve a inscribir. Así se duplicaban.
  //
  // TODO(integrador): devuelve TODAS las cuentas de destino del negocio. Si tus
  // usuarios no deben verse entre sí, filtra aquí por las que le corresponden al
  // usuario de tu sesión.
  app.get('/api/withdraw-accounts', async (req, res, next) => {
    try {
      const data = await fetchAllById((filter) => withSession((c) => c.withdraw.user.__get__withdrawAccounts(filter)), {
        where: { visible: true, state: { inq: ['in_progress', 'complete', 'pending'] } },
      })
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Alta de una cuenta de destino. Cada medio pide lo suyo en `info_needed`
  // (lo declara el proveedor): Bre-B la llave y el titular que resolvió, bancaria
  // el banco, el tipo, el número y el titular, red interna el correo o el teléfono.
  //
  // TODO(integrador): la cuenta queda a nombre de tu negocio. Registra a qué
  // usuario tuyo pertenece antes de devolverla.
  app.post('/api/withdraw-accounts', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.withdraw.withdrawAccount.addNewWithdrawAccount(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // "Eliminar" una cuenta de destino: se oculta.
  //
  // TODO(integrador): comprueba que :id es de una cuenta que el usuario de tu
  // sesión puede tocar.
  app.post('/api/withdraw-accounts/:id/hide', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.withdraw.withdrawAccount.updateVisibility({
        withdraw_account_id: req.params.id,
        visible: false,
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // A quién pertenece una llave Bre-B: nombre, apellido y documento del titular.
  // Se lee AL DERECHO, al revés que la consulta del recaudo: aquí la llave tiene
  // que existir, y un error (`withdrawaccount_23`, "Cannot resolve breb alias")
  // significa que no se le puede enviar.
  //
  // Sin alias, o con uno que no es texto, el JSON Schema del servicio responde 465
  // remotequeryguard_7: se corta antes con un 400 que dice qué falta.
  app.post('/api/withdraw-accounts/resolve', async (req, res, next) => {
    const alias = req.body?.alias
    if (typeof alias !== 'string' || !alias.trim()) {
      res.status(400).json({ error: 'Falta la llave Bre-B (alias) a resolver', code: null })
      return
    }
    try {
      const data = await withSession((c) => c.withdraw.withdrawAccount.resolveBrebAliasPublic({ alias }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Un envío por Bre-B o bancario. Queda en `pending`: el dinero no se mueve
  // hasta confirmarlo (ruta /confirm). El body va al PRIMER NIVEL: el SDK lo
  // envuelve en { data: {...} }; anidarlo aquí lo doblaría y daría 465.
  //
  // TODO(integrador): `account_id` (de dónde sale el dinero) y
  // `withdraw_account_id` (a dónde va) llegan del navegador. Comprueba que el
  // usuario de tu sesión puede usar los dos ANTES de llamar al SDK.
  app.post('/api/withdrawals', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.withdraw.withdraw.addNewWithdrawPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Un envío por red interna, a otra cuenta de la plataforma. Sin costo:
  // `cost_information: { cost_id: 'none' }`. A tu PROPIO usuario no se puede
  // (`withdraw_22`, "Use the selfTransfer…").
  //
  // TODO(integrador): misma comprobación que /api/withdrawals.
  app.post('/api/transfers', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.withdraw.withdraw.addNewTransferPublic(req.body))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // El segundo paso de todo envío: pasarlo a `confirmed`. Sin esto se queda en
  // `pending` y el dinero no sale.
  //
  // TODO(integrador): comprueba que :id es un retiro de una cuenta del usuario de
  // tu sesión.
  app.post('/api/withdrawals/:id/confirm', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.withdraw.withdraw.addUpdateWithdraw({
        withdraw_id: req.params.id,
        state: 'confirmed',
      }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Retiros de una cuenta en un rango de fechas. La pantalla lo usa para saber
  // en qué quedó un envío que no recibió respuesta (corte de red): lo busca por
  // monto y destino antes de reintentar, para no pagar dos veces.
  //
  // Se lee el rango ENTERO, de a 200 por `id` (fetchAllById), y se ordena aquí por
  // `created_at`. Pedirlo ordenado por fecha y sin paginar cortaba en 200 sin
  // avisar y, en ascendente, perdía justo lo más reciente: el envío que se busca.
  // Si una página falla se responde ese error; una lista a medias diría "no
  // está" de un envío que sí salió.
  app.get('/api/withdrawals', async (req, res, next) => {
    try {
      const { account_id: accountId, from, to } = req.query
      const states = String(req.query.states || 'accepted').split(',').filter(Boolean)
      const data = await fetchAllById((filter) => withSession((c) => c.withdraw.user.__get__withdraws(filter)), {
        where: {
          account_id: accountId,
          state: { inq: states },
          created_at: { between: [from, to] },
        },
      })
      if (isHttpSuccess(data?.status)) {
        const at = (w) => Date.parse(w?.created_at) || 0
        data.data.sort((a, b) => at(a) - at(b))
      }
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

  // Un retiro por id. Es el comprobante, y lo que relee un reintento.
  app.get('/api/withdrawals/:id', async (req, res, next) => {
    try {
      // Un solo registro: `limit: 1`, explícito.
      const data = await withSession((c) => c.withdraw.user.__get__withdraws({
        where: { id: req.params.id },
        limit: 1,
      }))
      if (!isHttpSuccess(data?.status)) {
        sendSdkResult(res, data)
        return
      }
      const list = Array.isArray(data?.data) ? data.data : []
      if (!list.length) {
        res.status(404).json({ error: 'Retiro no encontrado', code: null })
        return
      }
      res.json({ data: list[0] })
    } catch (err) { next(err) }
  })

// ================================================

  // Las identidades verificadas del negocio. El alta de una cuenta bancaria
  // PROPIA elige a nombre de cuál queda.
  //
  // Son las del KYC de la cuenta que firma: una o unas pocas. Basta un `limit`
  // explícito, que deja a la vista el corte de 200 del guardia.
  app.get('/api/identities', async (req, res, next) => {
    try {
      const data = await withSession((c) => c.identity.user.__get__identities({ limit: 200 }))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

  // Los tipos de documento de un país. El alta de una cuenta bancaria de un
  // TERCERO los pide según su nacionalidad.
  //
  // Catálogo chico (unos pocos tipos por país): basta un `limit` explícito, que
  // deja a la vista el corte de 200 del guardia.
  app.get('/api/documents', async (req, res, next) => {
    try {
      const nationality = req.query.nationality
      const data = await withSession((c) => c.identity.document.find(
        nationality ? { where: { nationality }, limit: 200 } : { limit: 200 },
      ))
      sendSdkResult(res, data)
    } catch (err) { next(err) }
  })

// ================================================

}
 */
import { withSession, getUserId } from './coinsenda.js'
import { isHttpSuccess } from '@coinsenda/sdk'

/**
 * Contesta con el resultado del SDK, traduciendo su forma a HTTP.
 *
 * El SDK NO lanza cuando el servicio responde 4xx: retorna \`{ status, data }\` con
 * el error dentro. Reenviarlo con \`res.json(data)\` lo entregaba como **HTTP 200**,
 * y el cliente —que solo mira \`res.ok\`— daba por buena una operación fallida.
 * Afectaba a crear, bloquear, desbloquear, eliminar y suscribir.
 */
const sendSdkResult = (res, result) => {
  const status = result?.status
  if (typeof status === 'number' && !isHttpSuccess(status)) {
    const body = result?.data || {}
    // El detalle viene ANIDADO y como objeto:
    //   { error: { statusCode, name, message, code } }
    // Reenviarlo tal cual dejaba al cliente construyendo un Error con un objeto, y
    // el usuario leía 

// ================================================

import '../../scripts/require-node.mjs'
import 'dotenv/config'
import { timingSafeEqual } from 'node:crypto'
import express from 'express'
import cors from 'cors'
import { registerRoutes } from './routes.js'

const app = express()

app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173', credentials: true }))
app.use(express.json())

// La salud va ANTES del guard: es la sonda de `yarn verify` y de cualquier
// orquestador, y no revela nada.
app.get('/api/health', (req, res) => res.json({ ok: true }))

/**
 * Guard de acceso.
 *
 * Este proceso es el único que ve la clave privada, así que quien le habla puede
 * crear, bloquear y eliminar llaves de la cuenta REAL. CORS no basta: solo lo
 * respetan los navegadores, y un `curl` sin cabecera `Origin` lo ignora por
 * completo.
 *
 * Sin `INTEGRATION_TOKEN` definido el guard se apaga, para no romper el primer
 * arranque en local — pero se avisa, porque en cualquier máquina compartida eso es
 * una puerta abierta.
 */
const token = process.env.INTEGRATION_TOKEN
/*__REQUIRE_TOKEN__*/
if (!token) {
  console.warn('[server] Sin INTEGRATION_TOKEN: /api queda ABIERTO a quien alcance este puerto.')
} else {
  app.use('/api', (req, res, next) => {
    const sent = req.get('x-integration-token') || ''
    // Comparación en tiempo constante: con `===` la duración del fallo filtra
    // cuántos caracteres coincidían.
    const a = Buffer.from(sent)
    const b = Buffer.from(token)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'No autorizado' })
      return
    }
    next()
  })
}

registerRoutes(app)

// Los errores del SDK no se reenvían tal cual: pueden traer identificadores
// internos, y el navegador no necesita más que el motivo.
app.use((err, req, res, next) => {
  console.error('[coinsenda]', err?.message || err)
  res.status(err?.status || 500).json({ error: err?.message || 'Error inesperado' })
})

const port = process.env.PORT || 8787
// A LOOPBACK por defecto. Sin host, Express enlaza a 0.0.0.0 y el proceso que
// guarda la clave privada queda expuesto a toda la red local. Quien lo despliegue
// de verdad pone `BIND_HOST` a conciencia.
const host = process.env.BIND_HOST || '127.0.0.1'
app.listen(port, host, () => console.log(`[server] escuchando en http://${host}:${port}`))


// ================================================

),l=(e=>{const n=[...e.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)];return n.map(((a,o)=>{const r=o+1<n.length?n[o+1].index:e.length,t=e.slice(a.index,r),i=[...new Set([...t.matchAll(/c\.(\w+)\.(\w+)\.(\w+)\(/g)].map((e=>{let[,n,a,o]=e;return`${n}.${a}.${o}`})))];return{method:a[1].toUpperCase(),path:a[2],calls:i}}))})(Gl(n));return`# Cómo funciona esta integración

Contexto para quien modifique o diagnostique este repositorio, persona o agente.
\`AGENTS.md\` dice qué puedes tocar; esto explica por qué las cosas están como están
y qué se rompe si las cambias. Describe el comportamiento de Coinsenda verificado
en staging y producción el 27 de octubre de 2026.

## El recorrido de una petición

\`\`\`
web/ (navegador)               server/ (Node)                    Coinsenda
sdkPorts.js ──── /api/… ────▶ routes.js ── withSession ──▶ @coinsenda/sdk ──▶ deposit, transaction…
             proxy de Vite         firma RS256,                 HTTP; no lanza:
             + x-integration-token sesión en memoria             { status, data }
\`\`\`

- **La interfaz** (\`web/src/core\`) no conoce la API: pide datos y acciones por los
  puertos de \`web/src/ports/sdkPorts.js\`.
- **\`sdkPorts.js\` llama a \`/api/*\`.** En desarrollo, Vite lo reenvía a \`server/\` y le
  agrega \`x-integration-token\` leyendo \`INTEGRATION_TOKEN\` de \`web/.env\` (sin
  prefijo \`VITE_\`, así que nunca llega al bundle).
- **\`server/\`** escucha por defecto solo en \`127.0.0.1\` (\`BIND_HOST\`). Si
  \`INTEGRATION_TOKEN\` está definido, rechaza todo \`/api\` que no traiga esa cabecera;
  sin él, \`/api\` queda abierto a quien alcance el puerto.
- **\`server/src/coinsenda.js\`** firma un JWT RS256 de 5 minutos con la clave privada,
  lo canjea por una sesión \`{ jwt, refresh_token }\` y la renueva sola 60 s antes de
  vencer: primero con el refresh token y, si falla, firmando otra vez. La sesión
  vive en memoria del proceso; un script aparte firma la suya.

## Las rutas de este repositorio

Solo existen las que pide el Blueprint. Encima de cada una, \`server/src/routes.js\`
explica sus casos raros: léelo antes de cambiarla.

| Método | Ruta | SDK |
| --- | --- | --- |
${l.map((e=>`| ${e.method} | \`${e.path}\` | ${e.calls.map((e=>`\`${e}\``)).join(

// ================================================

#!/usr/bin/env node
/**
 * Falla de verdad: con problemas sale con código ≠ 0.
 *
 * Nació al revés —informar y salir con 0 siempre, para no cortar el primer
 * arranque— y esa comodidad tenía un precio que no compensa: quien encadena
 * `yarn verify && …`, o mira el código de salida en vez de leer la salida, daba por
 * bueno un repositorio que no autentica. Es exactamente el fallo silencioso contra
 * el que este archivo advierte.
 *
 * Con `--soft` se recupera el comportamiento permisivo, para el primer arranque
 * cuando todavía falta registrar la clave pública.
 */
const soft = process.argv.includes('--soft')
const problems = []
const fail = (why) => { problems.push(why) }
/**
 * Verifica que la integración autentica contra Coinsenda.
 *
 *   yarn verify   (con el server ya levantado: yarn start:dev)
 *
 * Sonda /api/health (estructural) y /api/currencies (pasa por withSession, así que
 * ejercita la firma real). Si la auth falla, imprime la clave PÚBLICA y cómo
 * registrarla. No bloquea: si el server no responde, explica y sale con código 0.
 */
import { readFileSync, existsSync } from 'node:fs'

const readEnv = (key) => {
  if (process.env[key]) return process.env[key]
  if (!existsSync('server/.env')) return undefined
  const line = readFileSync('server/.env', 'utf8')
    .split('\n')
    .find((l) => !l.trim().startsWith('#') && l.trim().startsWith(key + '='))
  return line ? line.slice(line.indexOf('=') + 1).trim() : undefined
}

const port = readEnv('PORT') || '8787'
const base = 'http://localhost:' + port
const identity = readEnv('COINSENDA_EMAIL')
  || readEnv('COINSENDA_PHONE_NUMBER')
  || readEnv('COINSENDA_USER_ID')
  || '(sin definir)'

/**
 * El guardián de /api, si está definido.
 *
 * Sin esto, definir INTEGRATION_TOKEN —que es justo lo que el arranque
 * recomienda— hacía que verify sondeara sin la cabecera, recibiera un 401 del
 * guardián y culpara a la clave pública. El arranque bien hecho rompía la
 * comprobación del arranque.
 *
 * En el navegador la cabecera la pone el proxy de Vite; aquí vamos directos al
 * servidor, así que hay que ponerla a mano.
 */
const integrationToken = readEnv('INTEGRATION_TOKEN')

const get = async (path) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(base + path, {
      signal: controller.signal,
      headers: integrationToken ? { 'x-integration-token': integrationToken } : undefined,
    })
    return { ok: res.ok, status: res.status }
  } finally {
    clearTimeout(timer)
  }
}

const printPublicKey = () => {
  if (existsSync('keys/public.pem')) {
    console.log('\nRegistra esta clave PÚBLICA en Ajustes -> Desarrollador -> API public key de tu cuenta de Coinsenda:\n')
    console.log(readFileSync('keys/public.pem', 'utf8'))
  } else {
    console.log('No hay keys/public.pem. Corre "yarn setup" para generarla.')
  }
  console.log('El identificador que firma debe coincidir con esa cuenta. Ahora mismo: ' + identity)
}

let health
try {
  health = await get('/api/health')
} catch (_) {
  console.log('[verify] El server no responde en ' + base + '. Levántalo con "yarn start:dev" y reintenta.')
  process.exit(0)
}

if (!health.ok) {
  console.log('[verify] /api/health respondió ' + health.status + '. Revisa el server.')
  process.exit(soft ? 0 : 1)
}
console.log('[verify] Salud OK en ' + base + '/api/health')

let auth
try {
  auth = await get('/api/currencies')
} catch (_) {
  console.log('[verify] No se pudo consultar /api/currencies.')
  printPublicKey()
  process.exit(0)
}

if (auth.ok) {
  console.log('[verify] Autenticación OK: /api/currencies respondió 2xx con el identificador ' + identity + '.')
} else if (auth.status === 401) {
  // Dos 401 muy distintos comparten código. El del guardián se reconoce porque lo
  // emite el propio servidor antes de tocar el SDK, y la pista es si hay token.
  console.log('[verify] /api/currencies respondió 401.')
  if (integrationToken) {
    console.log('[verify] Es el guardián local de /api, no Coinsenda: la cabecera x-integration-token no coincide.')
    console.log('[verify] Revisa que INTEGRATION_TOKEN sea el MISMO en server/.env y en web/.env.')
    fail('el guardián de /api rechazó la petición')
  } else {
    console.log('[verify] No hay INTEGRATION_TOKEN definido, así que el 401 viene de Coinsenda.')
    printPublicKey()
    fail('la sesión no autenticó')
  }
} else {
  console.log('[verify] /api/currencies respondió ' + auth.status + ': la sesión no autenticó.')
  printPublicKey()
  fail('la sesión no autenticó')
}

// ── La interfaz ────────────────────────────────────────────────────────────────
//
// Sondear solo el servidor certificaba integraciones rotas: con la auth en verde,
// la pantalla podía estar en blanco y esto decía "todo listo". Aquí se comprueba lo
// mínimo que se puede sin un navegador —que Vite sirve y que el HTML trae el punto
// de montaje— y se dice EN VOZ ALTA lo que no se ha comprobado.
// Deducida, no cableada: WEB_ORIGIN ya está en server/.env y es lo que el propio
// servidor usa para CORS. Cablear 5173 aquí hacía que, con los puertos movidos para
// convivir con otra integración, verify sondeara el front equivocado.
const webBase = process.env.WEB_URL || readEnv('WEB_ORIGIN') || 'http://localhost:5173'
let web
try {
  web = await fetch(webBase, { redirect: 'follow' })
} catch (_) {
  console.log('[verify] La interfaz no responde en ' + webBase + '. ¿Arrancaste "yarn start:dev"?')
  fail('la interfaz no responde')
  web = null
}

if (web) {
  const html = await web.text()
  if (!web.ok || !html.includes('id="root"')) {
    console.log('[verify] ' + webBase + ' respondió ' + web.status + ' sin el punto de montaje.')
    fail('la interfaz no sirve el punto de montaje')
  } else {
    console.log('[verify] La interfaz sirve en ' + webBase + '.')
  }
}

// Lo que esta herramienta NO puede ver. Se dice siempre, porque el agente lee esta
// salida y hasta ahora leía "todo listo" con la pantalla en blanco.
console.log('')
console.log('[verify] FALTA la comprobación visual, y no la des por hecha:')
console.log('[verify]   abre ' + webBase + ', confirma que el flujo RENDERIZA')
console.log('[verify]   y que la consola del navegador está limpia.')

if (problems.length) {
  console.log('')
  console.log('[verify] Con problemas: ' + problems.join('; ') + '.')
} else {
  console.log('')
  console.log('[verify] Servidor y auth en verde. Falta tu comprobación visual.')
}

// ── Dónde está corriendo ───────────────────────────────────────────────────────
//
// SIEMPRE, y al final. Va después del veredicto y ANTES de cualquier salida con
// código distinto de cero, porque el caso en que estas dos direcciones más falta
// hacen es justo aquel en el que algo falló y hay que ir a mirarlo.
//
// Se imprime aquí y no se deja a criterio del agente: quien pide la integración
// necesita las dos URL pase lo que pase, y da igual si al otro lado hay Cursor,
// Claude Code, Codex o nadie.
console.log('')
console.log('[verify] ─────────────────────────────────────────────')
console.log('[verify]  Interfaz (web):  ' + webBase)
console.log('[verify]  API (servidor):  ' + base)
console.log('[verify] ─────────────────────────────────────────────')

if (problems.length && !soft) process.exit(1)


// ================================================

/**
 * Cliente de Coinsenda y ciclo de sesión.
 *
 * El intercambio es: firmamos un JWT de vida corta con NUESTRA clave privada, el
 * servicio lo verifica con la pública que registramos en el perfil y nos devuelve
 * una sesión ({ jwt, refresh_token }). Es lo que evita guardar una contraseña o una
 * API key de larga vida.
 *
 * La sesión se cachea en memoria y se renueva sola antes de expirar (leyendo el
 * `exp` del propio jwt); sin eso, cada petición del navegador firmaría de nuevo.
 */
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'
import { CoinsendaClient, isHttpSuccess } from '@coinsenda/sdk'

const privateKey = readFileSync(process.env.COINSENDA_PRIVATE_KEY_PATH, 'utf8')

export const client = new CoinsendaClient({
  domain: process.env.COINSENDA_DOMAIN || 'coinsenda.com',
})

let session = null // { jwt, refreshToken, expiresAt }
let cachedUserId = null

/**
 * Identificador de la cuenta que firma el token. El SDK admite email, teléfono o
 * userId; se elige el que esté definido en el entorno. No es derivable del JWT
 * (el claim usr solo existe DESPUÉS de autenticar), por eso es config de arranque.
 */
const buildIdentity = () => {
  if (process.env.COINSENDA_EMAIL) return { email: process.env.COINSENDA_EMAIL }
  if (process.env.COINSENDA_PHONE_NUMBER) return { phone_number: process.env.COINSENDA_PHONE_NUMBER }
  if (process.env.COINSENDA_USER_ID) return { userId: process.env.COINSENDA_USER_ID }
  throw new Error('Define COINSENDA_EMAIL, COINSENDA_PHONE_NUMBER o COINSENDA_USER_ID: es el identificador que firma el token.')
}

/** JWT RS256 de vida corta que prueba que poseemos la clave privada. */
const signAssertion = () => jwt.sign(
  { ...buildIdentity(), iat: Math.floor(Date.now() / 1000) },
  privateKey,
  { algorithm: 'RS256', expiresIn: '5m' },
)

/** Aplica una respuesta de auth ({ jwt, refresh_token }) a la sesión del SDK. */
const applySession = (payload) => {
  const data = payload?.data?.data || payload?.data || payload
  if (!data?.jwt) {
    throw new Error(
      'El servicio no devolvió jwt. Registra tu clave PÚBLICA en '
      + 'Ajustes -> Desarrollador -> API public key de tu cuenta de Coinsenda.',
    )
  }
  const { exp } = jwt.decode(data.jwt) || {}
  session = {
    jwt: data.jwt,
    refreshToken: data.refresh_token || null,
    expiresAt: exp ? exp * 1000 : Date.now() + 5 * 60_000,
  }
  client.setJwt(data.jwt)
  if (data.refresh_token) client.setRefreshToken(data.refresh_token)
  return session
}

/** Login completo: firma y canjea el token por una sesión. */
const login = async () => {
  const res = await client.auth.passport.authPubkey({ data: { signed_token: signAssertion() } })
  if (!isHttpSuccess(res.status)) {
    throw new Error(`Autenticación fallida (status ${res.status}); revisa email, dominio y la clave pública registrada.`)
  }
  return applySession(res)
}

/**
 * Devuelve una sesión válida, renovándola si hace falta. El margen de 60s evita
 * usar un token que caduca en pleno vuelo de la petición. Se prefiere renovar con
 * el refresh_token; si no hay o falla, se vuelve a firmar.
 */
export const getSession = async () => {
  if (session && session.expiresAt - Date.now() > 60_000) return session

  if (session?.refreshToken) {
    try {
      const res = await client.auth.oauth.grantRefreshToken({ data: { refresh_token: session.refreshToken } })
      if (isHttpSuccess(res.status)) return applySession(res)
    } catch (_) {
      // El refresh caducó o el SDK no lo aceptó: caemos a un login completo.
    }
  }

  return login()
}

/**
 * userId de la sesión. Prioridad: override explícito por env; si no, el perfil; y
 * como último recurso el claim `usr` del propio jwt. Se cachea.
 */
export const getUserId = async () => {
  if (cachedUserId) return cachedUserId
  if (process.env.COINSENDA_USER_ID) {
    cachedUserId = process.env.COINSENDA_USER_ID
    return cachedUserId
  }
  await getSession()
  try {
    const res = await client.transaction.user.__get__profile()
    const profile = res?.data?.data || res?.data || {}
    cachedUserId = profile.userId || profile.user_id || profile.id || null
  } catch (_) {
    // El perfil no respondió; probamos con el claim del jwt.
  }
  if (!cachedUserId && session?.jwt) cachedUserId = jwt.decode(session.jwt)?.usr || null
  if (!cachedUserId) throw new Error('No se pudo resolver el userId (perfil ni claim usr del jwt).')
  return cachedUserId
}

/** Ejecuta una llamada del SDK con sesión garantizada. */
export const withSession = async (fn) => {
  await getSession()
  return fn(client)
}
