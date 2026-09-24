/* =========================================================================
   calculos.js — Reglas de negocio puras de Gestión de Transporte
   -------------------------------------------------------------------------
   - Sin acceso a DOM ni a IndexedDB: todas las funciones reciben datos y
     devuelven datos. Se usan igual en el navegador, en Node (pruebas) y en
     Google Apps Script: apps-script/Calculos.gs es una copia EXACTA de este
     archivo (la prueba tests/calculos.test.js verifica que sean iguales).
   - Todas las pantallas (dashboard, listado, detalle, informes, CSV) usan
     calcularViaje() y resumirPeriodo(); no hay fórmulas repetidas.
   - Montos en pesos chilenos enteros (CLP). Se redondea cada componente.
   ========================================================================= */
(function (raiz) {
  'use strict';

  /* ---------- Catálogos de valores válidos ---------- */
  const ESTADOS = ['planificado', 'realizado', 'cancelado'];
  const MODALIDADES = ['propio', 'tercerizado'];
  const FORMAS_COBRO = ['km', 'fija'];
  const MODOS_TRANSPORTISTA = ['km', 'fijo'];
  const MODOS_CHOFER = ['ninguno', 'km', 'fijo'];
  const TRATAMIENTOS_IVA = ['neto', 'incluido', 'pendiente'];
  const IVA_PCT_DEFECTO = 19;
  // Planilla Pedregoso–Lonquimay (mar-2026): "Chofer" = km × $200. Editable en Ajustes.
  const CHOFER_TARIFA_KM_DEFECTO = 200;
  const SCHEMA_VIAJE = 2;
  const MONTO_MAXIMO = 1e11; // tope de seguridad contra errores de tipeo

  /* ---------- Utilidades numéricas ---------- */
  function esNumero(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }
  function n(v) {
    return esNumero(v) ? v : 0;
  }
  function redondearPesos(v) {
    const r = Math.round(n(v));
    return r === 0 ? 0 : r; // evita -0
  }

  /* ---------- Identificadores ---------- */
  function generarId() {
    const c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /* =======================================================================
     Reglas de cálculo (ver README → Fórmulas)
     ======================================================================= */

  /** Regla 1 y 2: ingreso base por km o tarifa fija. */
  function ingresoBase(v) {
    if (v.formaCobro === 'fija') return redondearPesos(v.tarifa);
    return redondearPesos(n(v.km) * n(v.tarifa));
  }

  /** Cobros adicionales al cliente (sobreestadía, vuelta, etc.), en neto. */
  function totalCobrosAdicionales(v) {
    return (Array.isArray(v.cobrosAdicionales) ? v.cobrosAdicionales : [])
      .reduce((s, g) => s + redondearPesos(g && g.monto), 0);
  }

  /** Ingreso neto = ingreso base + cobros adicionales (las planillas del cliente usan "Extra"). */
  function ingresoNeto(v) {
    return ingresoBase(v) + totalCobrosAdicionales(v);
  }

  /** Regla 3: IVA separado, solo si está activado. No es ingreso ni margen. */
  function impuesto(neto, aplica, pct) {
    if (!aplica) return 0;
    return redondearPesos(n(neto) * n(pct) / 100);
  }

  /** Regla 5: peaje real si fue ingresado (incluso 0); si no, el estimado marcado como tal. */
  function peajesAplicados(v) {
    if (esNumero(v.peajesReales)) {
      return { monto: redondearPesos(v.peajesReales), fuente: 'real', esEstimado: false };
    }
    if (esNumero(v.peajesEstimados) && v.peajesEstimados > 0) {
      return { monto: redondearPesos(v.peajesEstimados), fuente: 'estimado', esEstimado: true };
    }
    return { monto: 0, fuente: 'ninguno', esEstimado: false };
  }

  /** Regla 4: costo del transportista tercero (por km o monto fijo). Solo en tercerizados. */
  function costoTransportista(v) {
    if (v.modalidad !== 'tercerizado') return 0;
    const t = v.transportista || {};
    if (t.modo === 'fijo') return redondearPesos(t.montoFijo);
    return redondearPesos(n(v.km) * n(t.tarifaKm));
  }

  /** Pago al chofer del viaje: por km, monto fijo o sin pago. Es un costo directo. */
  function costoChofer(v) {
    const ch = v.chofer || {};
    if (ch.modo === 'km') return redondearPesos(n(v.km) * n(ch.tarifaKm));
    if (ch.modo === 'fijo') return redondearPesos(ch.monto);
    return 0;
  }

  function totalOtrosGastos(v) {
    return (Array.isArray(v.otrosGastos) ? v.otrosGastos : [])
      .reduce((s, g) => s + redondearPesos(g && g.monto), 0);
  }

  /** Regla 8: margen porcentual; null cuando el ingreso es 0 (no se divide por cero). */
  function margenPorcentual(margen, ingreso) {
    if (!(n(ingreso) > 0)) return null;
    return (n(margen) / n(ingreso)) * 100;
  }

  /** Cálculo completo de un viaje (reglas 1 a 8). Única fuente para todas las vistas. */
  function calcularViaje(v) {
    const base = ingresoBase(v);
    const adicionales = totalCobrosAdicionales(v);
    const neto = base + adicionales;
    const pct = esNumero(v.ivaPct) ? v.ivaPct : IVA_PCT_DEFECTO;
    const aplica = !!v.aplicaIva;
    const iva = impuesto(neto, aplica, pct);
    const peajes = peajesAplicados(v);
    const combustible = redondearPesos(v.combustible);
    const comida = redondearPesos(v.comida);
    const transportista = costoTransportista(v);
    const chofer = costoChofer(v);
    const otros = totalOtrosGastos(v);
    // Regla 6 (+ pago al chofer)
    const costosDirectos = peajes.monto + combustible + comida + transportista + chofer + otros;
    // Regla 7
    const margenBruto = neto - costosDirectos;
    return {
      ingresoBase: base,
      cobrosAdicionales: adicionales,
      ingresoNeto: neto,
      aplicaIva: aplica,
      ivaPct: aplica ? pct : 0,
      iva,
      totalConIva: neto + iva,
      peajes: peajes.monto,
      peajesFuente: peajes.fuente,
      peajesEsEstimado: peajes.esEstimado,
      combustible,
      comida,
      costoTransportista: transportista,
      costoChofer: chofer,
      otrosGastos: otros,
      costosDirectos,
      margenBruto,
      margenPct: margenPorcentual(margenBruto, neto)
    };
  }

  /* =======================================================================
     Agregados de período (regla 9)
     - Ingresos, costos, margen y km: solo viajes REALIZADOS.
     - Resultado estimado: margen realizados + margen planificados.
     - Cancelados: se cuentan, pero no suman montos.
     ======================================================================= */
  function resumenVacio() {
    return {
      viajes: 0, km: 0, ingresoNeto: 0, iva: 0, totalConIva: 0,
      costosDirectos: 0, margenBruto: 0, margenPct: null, conPeajeEstimado: 0
    };
  }
  function acumular(r, v, c) {
    r.viajes += 1;
    r.km += n(v.km);
    r.ingresoNeto += c.ingresoNeto;
    r.iva += c.iva;
    r.totalConIva += c.totalConIva;
    r.costosDirectos += c.costosDirectos;
    r.margenBruto += c.margenBruto;
    if (c.peajesEsEstimado) r.conPeajeEstimado += 1;
  }
  function cerrar(r) {
    r.km = Math.round(r.km * 10) / 10;
    r.margenPct = margenPorcentual(r.margenBruto, r.ingresoNeto);
    return r;
  }

  function resumirPeriodo(viajes) {
    const realizados = resumenVacio();
    const planificados = resumenVacio();
    const porModalidad = { propio: resumenVacio(), tercerizado: resumenVacio() };
    let cancelados = 0;
    let porConfirmar = 0;
    for (const v of viajes) {
      const c = calcularViaje(v);
      if (v.estado === 'realizado') {
        acumular(realizados, v, c);
        if (porModalidad[v.modalidad]) acumular(porModalidad[v.modalidad], v, c);
      } else if (v.estado === 'planificado') {
        acumular(planificados, v, c);
      } else {
        cancelados += 1;
      }
      if (v.estado !== 'cancelado' && v.netoConfirmado === false) porConfirmar += 1;
    }
    cerrar(realizados);
    cerrar(planificados);
    cerrar(porModalidad.propio);
    cerrar(porModalidad.tercerizado);
    return {
      total: viajes.length,
      realizados,
      planificados,
      cancelados,
      porConfirmar,
      porModalidad,
      resultadoEstimado: realizados.margenBruto + planificados.margenBruto
    };
  }

  /** Agrupa viajes por clave y devuelve [{clave, resumen}] ordenado por clave. */
  function agruparYResumir(viajes, claveFn) {
    const grupos = new Map();
    for (const v of viajes) {
      const k = claveFn(v);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(v);
    }
    return Array.from(grupos.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([clave, lista]) => ({ clave, resumen: resumirPeriodo(lista) }));
  }

  /* =======================================================================
     Parseo de entradas (formato chileno: punto de miles, coma decimal)
     Devuelven { valor: number|null, error: string|null }. Vacío = null.
     ======================================================================= */
  function limpiar(texto) {
    return String(texto == null ? '' : texto).trim().replace(/[\s$]/g, '');
  }

  /** Pesos enteros: "1.650", "1650", "$ 90.000". */
  function parsearMonto(texto) {
    const t = limpiar(texto);
    if (t === '') return { valor: null, error: null };
    if (t.startsWith('-')) return { valor: null, error: 'No se permiten montos negativos.' };
    if (t.includes(',')) return { valor: null, error: 'Ingresa pesos enteros, sin decimales.' };
    if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(t)) {
      return { valor: null, error: 'Monto no válido. Ejemplo: 1.650' };
    }
    const valor = parseInt(t.replace(/\./g, ''), 10);
    if (valor > MONTO_MAXIMO) return { valor: null, error: 'El monto es demasiado alto. Revisa el valor.' };
    return { valor, error: null };
  }

  /** Decimales: "1.000" = mil; "12,5" = doce coma cinco; "12.5" = doce coma cinco. */
  function parsearDecimal(texto) {
    let t = limpiar(texto);
    if (t === '') return { valor: null, error: null };
    if (t.startsWith('-')) return { valor: null, error: 'No se permiten valores negativos.' };
    if (t.includes(',')) {
      if (!/^(\d{1,3}(\.\d{3})+|\d+),\d+$/.test(t)) return { valor: null, error: 'Número no válido. Ejemplo: 12,5' };
      t = t.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
      t = t.replace(/\./g, '');
    } else if (!/^\d+(\.\d+)?$/.test(t)) {
      return { valor: null, error: 'Número no válido. Ejemplo: 12,5' };
    }
    const valor = parseFloat(t);
    if (!Number.isFinite(valor)) return { valor: null, error: 'Número no válido.' };
    if (valor > MONTO_MAXIMO) return { valor: null, error: 'El valor es demasiado alto.' };
    return { valor, error: null };
  }

  /* ---------- Fechas (YYYY-MM-DD, sin zona horaria) ---------- */
  function esFechaValida(texto) {
    if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
    const [a, m, d] = texto.split('-').map(Number);
    if (a < 2000 || a > 2100) return false;
    const f = new Date(a, m - 1, d);
    return f.getFullYear() === a && f.getMonth() === m - 1 && f.getDate() === d;
  }

  /* =======================================================================
     Normalización y validación de registros
     ======================================================================= */
  function textoONada(v) {
    return typeof v === 'string' ? v : '';
  }
  function numeroNoNegativoONull(v) {
    return esNumero(v) && v >= 0 ? v : null;
  }

  /** Completa valores por defecto y corrige tipos (migración y restauración). */
  function normalizarViaje(r) {
    const v = Object.assign({}, r || {});
    v.id = typeof v.id === 'string' && v.id ? v.id : generarId();
    v.codigo = textoONada(v.codigo);
    v.schema = SCHEMA_VIAJE;
    v.fecha = esFechaValida(v.fecha) ? v.fecha : '';
    v.estado = ESTADOS.includes(v.estado) ? v.estado : 'planificado';
    v.modalidad = MODALIDADES.includes(v.modalidad) ? v.modalidad : 'propio';
    v.formaCobro = FORMAS_COBRO.includes(v.formaCobro) ? v.formaCobro : 'km';
    ['cliente', 'sitio', 'localidad', 'direccion', 'origen', 'destino', 'contacto', 'descripcion', 'notas',
      'rutaId', 'rutaNombre', 'camionId', 'camionNombre'].forEach(k => { v[k] = textoONada(v[k]); });
    v.km = numeroNoNegativoONull(v.km);
    v.tarifa = numeroNoNegativoONull(v.tarifa);
    v.peajesEstimados = numeroNoNegativoONull(v.peajesEstimados);
    v.peajesReales = numeroNoNegativoONull(v.peajesReales);
    v.combustible = numeroNoNegativoONull(v.combustible);
    v.comida = numeroNoNegativoONull(v.comida);
    v.aplicaIva = !!v.aplicaIva;
    v.ivaPct = esNumero(v.ivaPct) && v.ivaPct >= 0 && v.ivaPct <= 100 ? v.ivaPct : IVA_PCT_DEFECTO;
    const t = (v.transportista && typeof v.transportista === 'object') ? v.transportista : {};
    v.transportista = {
      modo: MODOS_TRANSPORTISTA.includes(t.modo) ? t.modo : 'km',
      tarifaKm: numeroNoNegativoONull(t.tarifaKm),
      montoFijo: numeroNoNegativoONull(t.montoFijo)
    };
    const ch = (v.chofer && typeof v.chofer === 'object') ? v.chofer : {};
    v.chofer = {
      modo: MODOS_CHOFER.includes(ch.modo) ? ch.modo : 'ninguno',
      tarifaKm: numeroNoNegativoONull(ch.tarifaKm),
      monto: numeroNoNegativoONull(ch.monto)
    };
    const lineas = lista => (Array.isArray(lista) ? lista : [])
      .filter(g => g && typeof g === 'object')
      .map(g => ({
        id: typeof g.id === 'string' && g.id ? g.id : generarId(),
        concepto: textoONada(g.concepto),
        monto: esNumero(g.monto) && g.monto >= 0 ? g.monto : 0
      }));
    v.otrosGastos = lineas(v.otrosGastos);
    v.cobrosAdicionales = lineas(v.cobrosAdicionales);
    if (v.tarifaRef && typeof v.tarifaRef === 'object') {
      const tr = v.tarifaRef;
      v.tarifaRef = {
        id: textoONada(tr.id),
        nombre: textoONada(tr.nombre),
        modalidad: FORMAS_COBRO.includes(tr.modalidad) ? tr.modalidad : 'km',
        monto: esNumero(tr.monto) ? tr.monto : 0,
        ivaTratamiento: TRATAMIENTOS_IVA.includes(tr.ivaTratamiento) ? tr.ivaTratamiento : 'pendiente',
        vigenciaDesde: textoONada(tr.vigenciaDesde)
      };
    } else {
      v.tarifaRef = null;
    }
    v.netoConfirmado = typeof v.netoConfirmado === 'boolean'
      ? v.netoConfirmado
      : !(v.tarifaRef && v.tarifaRef.ivaTratamiento === 'pendiente');
    v.demo = !!v.demo;
    v.creado = textoONada(v.creado);
    v.actualizado = textoONada(v.actualizado);
    return v;
  }

  /** Validación de negocio. Devuelve { campo: mensaje }. Objeto vacío = válido. */
  function validarViaje(v) {
    const e = {};
    const noNeg = (campo, valor, obligatorio, etiqueta) => {
      if (valor === null || valor === undefined) {
        if (obligatorio) e[campo] = `${etiqueta} es obligatorio.`;
        return;
      }
      if (!esNumero(valor)) e[campo] = `${etiqueta} no es un número válido.`;
      else if (valor < 0) e[campo] = `${etiqueta} no puede ser negativo.`;
    };
    if (!v.fecha) e.fecha = 'La fecha es obligatoria.';
    else if (!esFechaValida(v.fecha)) e.fecha = 'La fecha no es válida (años 2000 a 2100).';
    if (!ESTADOS.includes(v.estado)) e.estado = 'Selecciona un estado.';
    if (!String(v.sitio || '').trim()) e.sitio = 'Indica el sitio u obra.';
    else if (v.sitio.length > 120) e.sitio = 'Máximo 120 caracteres.';
    if (!String(v.localidad || '').trim()) e.localidad = 'Indica la localidad.';
    else if (v.localidad.length > 80) e.localidad = 'Máximo 80 caracteres.';
    if ((v.cliente || '').length > 120) e.cliente = 'Máximo 120 caracteres.';
    if ((v.direccion || '').length > 200) e.direccion = 'Máximo 200 caracteres.';
    if ((v.origen || '').length > 120) e.origen = 'Máximo 120 caracteres.';
    if ((v.destino || '').length > 120) e.destino = 'Máximo 120 caracteres.';
    if ((v.contacto || '').length > 200) e.contacto = 'Máximo 200 caracteres.';
    if ((v.descripcion || '').length > 2000) e.descripcion = 'Máximo 2.000 caracteres.';
    if ((v.notas || '').length > 2000) e.notas = 'Máximo 2.000 caracteres.';
    if (!v.camionId) e.camionId = 'Selecciona el tipo de camión.';
    if (!MODALIDADES.includes(v.modalidad)) e.modalidad = 'Selecciona la modalidad.';
    if (!FORMAS_COBRO.includes(v.formaCobro)) e.formaCobro = 'Selecciona la forma de cobro.';
    noNeg('tarifa', v.tarifa, true, 'La tarifa');
    const kmObligatorio = v.formaCobro === 'km' ||
      (v.modalidad === 'tercerizado' && v.transportista && v.transportista.modo === 'km') ||
      (v.chofer && v.chofer.modo === 'km');
    noNeg('km', v.km, kmObligatorio, 'Los kilómetros');
    if (!e.km && kmObligatorio && !(v.km > 0)) e.km = 'Los kilómetros deben ser mayores a 0 para cobrar o pagar por km.';
    if (v.aplicaIva) {
      if (!esNumero(v.ivaPct) || v.ivaPct < 0 || v.ivaPct > 100) e.ivaPct = 'El IVA debe estar entre 0 y 100 %.';
    }
    noNeg('peajesEstimados', v.peajesEstimados, false, 'Los peajes estimados');
    noNeg('peajesReales', v.peajesReales, false, 'Los peajes reales');
    noNeg('combustible', v.combustible, false, 'El combustible');
    noNeg('comida', v.comida, false, 'La comida');
    if (v.modalidad === 'tercerizado') {
      const t = v.transportista || {};
      if (!MODOS_TRANSPORTISTA.includes(t.modo)) e['transportista.modo'] = 'Selecciona cómo se paga al transportista.';
      else if (t.modo === 'km') noNeg('transportista.tarifaKm', t.tarifaKm, true, 'La tarifa del transportista');
      else noNeg('transportista.montoFijo', t.montoFijo, true, 'El monto del transportista');
    }
    const ch = v.chofer || {};
    if (ch.modo && !MODOS_CHOFER.includes(ch.modo)) e['chofer.modo'] = 'Selecciona cómo se paga al chofer.';
    else if (ch.modo === 'km') noNeg('chofer.tarifaKm', ch.tarifaKm, true, 'El pago al chofer por km');
    else if (ch.modo === 'fijo') noNeg('chofer.monto', ch.monto, true, 'El pago fijo al chofer');
    (v.otrosGastos || []).forEach(g => {
      if (!String(g.concepto || '').trim()) e[`gasto.${g.id}.concepto`] = 'Indica el concepto del gasto.';
      else if (g.concepto.length > 80) e[`gasto.${g.id}.concepto`] = 'Máximo 80 caracteres.';
      noNeg(`gasto.${g.id}.monto`, g.monto, true, 'El monto del gasto');
    });
    (v.cobrosAdicionales || []).forEach(g => {
      if (!String(g.concepto || '').trim()) e[`cobro.${g.id}.concepto`] = 'Indica el concepto del cobro.';
      else if (g.concepto.length > 80) e[`cobro.${g.id}.concepto`] = 'Máximo 80 caracteres.';
      noNeg(`cobro.${g.id}.monto`, g.monto, true, 'El monto del cobro');
    });
    return e;
  }

  /* =======================================================================
     Catálogos: normalización (compartida por la app y Apps Script)
     ======================================================================= */
  function normalizarRuta(r) {
    const o = r || {};
    return {
      id: textoONada(o.id) || generarId(),
      nombre: textoONada(o.nombre),
      origen: textoONada(o.origen),
      destino: textoONada(o.destino),
      localidad: textoONada(o.localidad),
      km: numeroNoNegativoONull(o.km),
      peajes: numeroNoNegativoONull(o.peajes),
      vigencia: esFechaValida(o.vigencia) ? o.vigencia : '',
      notas: textoONada(o.notas),
      demo: !!o.demo,
      version: esNumero(o.version) ? o.version : 0,
      creado: textoONada(o.creado),
      actualizado: textoONada(o.actualizado),
      actualizadoPor: textoONada(o.actualizadoPor)
    };
  }

  function normalizarCamion(c) {
    const o = c || {};
    return {
      id: textoONada(o.id) || generarId(),
      nombre: textoONada(o.nombre),
      capacidadKg: numeroNoNegativoONull(o.capacidadKg),
      activo: o.activo !== false,
      notas: textoONada(o.notas),
      version: esNumero(o.version) ? o.version : 0,
      creado: textoONada(o.creado),
      actualizado: textoONada(o.actualizado),
      actualizadoPor: textoONada(o.actualizadoPor)
    };
  }

  function normalizarTarifa(t) {
    const o = t || {};
    return {
      id: textoONada(o.id) || generarId(),
      camionId: textoONada(o.camionId),
      nombre: textoONada(o.nombre),
      modalidad: FORMAS_COBRO.includes(o.modalidad) ? o.modalidad : 'km',
      monto: numeroNoNegativoONull(o.monto) === null ? 0 : o.monto,
      ivaTratamiento: TRATAMIENTOS_IVA.includes(o.ivaTratamiento) ? o.ivaTratamiento : 'pendiente',
      vigenciaDesde: esFechaValida(o.vigenciaDesde) ? o.vigenciaDesde : '',
      vigenciaHasta: esFechaValida(o.vigenciaHasta) ? o.vigenciaHasta : '',
      activa: o.activa !== false,
      notas: textoONada(o.notas),
      version: esNumero(o.version) ? o.version : 0,
      creado: textoONada(o.creado),
      actualizado: textoONada(o.actualizado),
      actualizadoPor: textoONada(o.actualizadoPor)
    };
  }

  /* =======================================================================
     Catálogo inicial (reunión 22-09-2026 y planillas de marzo 2026)
     Lo carga el backend al configurar las hojas. Editable después.
     ======================================================================= */
  const FECHA_REUNION = '2026-09-22';
  const CATALOGO_INICIAL = {
    camiones: [
      { id: 'cam-6000kg', nombre: 'Camión 6.000 kg', capacidadKg: 6000, activo: true,
        notas: 'En las planillas figura como "Fuso 6.000 kg".' },
      { id: 'cam-1700kg', nombre: 'Camión 1.700 kg', capacidadKg: 1700, activo: true,
        notas: 'Por confirmar capacidad: una planilla dice "JAC 1.750 kg" y otra "Jac 1700 kg".' }
    ],
    tarifas: [
      { id: 'tar-6000-km', camionId: 'cam-6000kg', nombre: 'Por kilómetro', modalidad: 'km', monto: 1650,
        ivaTratamiento: 'neto', vigenciaDesde: FECHA_REUNION, activa: true,
        notas: 'Informada en la reunión. Neta según planilla Antofagasta: 1.378 km × $1.650 = $2.273.700 "Valor NETO".' },
      { id: 'tar-6000-stgo', camionId: 'cam-6000kg', nombre: 'Vuelta en Santiago', modalidad: 'fija', monto: 90000,
        ivaTratamiento: 'neto', vigenciaDesde: FECHA_REUNION, activa: true,
        notas: 'Reunión: $90.000 netos más IVA.' },
      { id: 'tar-1700-km', camionId: 'cam-1700kg', nombre: 'Por kilómetro', modalidad: 'km', monto: 1440,
        ivaTratamiento: 'pendiente', vigenciaDesde: FECHA_REUNION, activa: true,
        notas: 'POR CONFIRMAR. Informada en la reunión, pero en las planillas de marzo 2026 el camión chico se cobró cerca de $1.200/km (Pedregoso $930.000 / 775 km; Coquimbo $600.000 / 510 km), y $1.440/km coincide con lo que cobra el transportista por el camión de 6.000 kg (Antofagasta). Tampoco se indicó si incluye IVA.' },
      { id: 'tar-1700-stgo', camionId: 'cam-1700kg', nombre: 'Vuelta en Santiago', modalidad: 'fija', monto: 70000,
        ivaTratamiento: 'pendiente', vigenciaDesde: FECHA_REUNION, activa: true,
        notas: 'POR CONFIRMAR si incluye IVA: la reunión no lo precisó.' }
    ]
  };

  /** Suma días a una fecha AAAA-MM-DD sin depender de la zona horaria. */
  function sumarDias(iso, dias) {
    const [a, m, d] = iso.split('-').map(Number);
    const f = new Date(Date.UTC(a, m - 1, d + dias));
    return f.toISOString().slice(0, 10);
  }

  /** Datos de demostración (marcados demo: true), con fechas relativas a "hoy". */
  function datosDemo(hoy) {
    const tarifa = id => {
      const t = CATALOGO_INICIAL.tarifas.find(x => x.id === id);
      return { id: t.id, nombre: t.nombre, modalidad: t.modalidad, monto: t.monto, ivaTratamiento: t.ivaTratamiento, vigenciaDesde: t.vigenciaDesde };
    };
    const base = {
      demo: true, aplicaIva: true, ivaPct: IVA_PCT_DEFECTO,
      cliente: 'Cliente de ejemplo', direccion: 'Dirección de ejemplo 123', origen: 'Bodega de ejemplo', contacto: '',
      descripcion: '', notas: 'Registro de demostración.'
    };
    const rutas = [
      { id: 'demo-ruta-1', nombre: 'Ruta de ejemplo · Bodega a Obra Norte', origen: 'Bodega de ejemplo', destino: 'Obra Norte',
        localidad: 'Sector Norte', km: 85, peajes: 6200, vigencia: hoy, notas: 'Ruta de demostración.', demo: true },
      { id: 'demo-ruta-2', nombre: 'Ruta de ejemplo · Viaje largo', origen: 'Bodega de ejemplo', destino: 'Obra Sur',
        localidad: 'Sector Sur', km: 1000, peajes: 48000, vigencia: hoy, notas: 'Ruta de demostración.', demo: true }
    ].map(normalizarRuta);
    const viajes = [
      Object.assign({}, base, {
        id: 'demo-viaje-1', codigo: 'DEMO-001', fecha: sumarDias(hoy, -3), estado: 'realizado',
        sitio: 'Obra Sur', localidad: 'Sector Sur', destino: 'Obra Sur', rutaId: 'demo-ruta-2', rutaNombre: rutas[1].nombre,
        camionId: 'cam-6000kg', camionNombre: 'Camión 6.000 kg', modalidad: 'tercerizado',
        km: 1000, formaCobro: 'km', tarifa: 1650, tarifaRef: tarifa('tar-6000-km'), netoConfirmado: true,
        transportista: { modo: 'km', tarifaKm: 1440 },
        descripcion: 'Caso de la reunión: 1.000 km cobrados a $1.650/km y pagados al transportista a $1.440/km. Margen esperado: $210.000.'
      }),
      Object.assign({}, base, {
        id: 'demo-viaje-2', codigo: 'DEMO-002', fecha: sumarDias(hoy, -6), estado: 'realizado',
        sitio: 'Obra Norte', localidad: 'Sector Norte', destino: 'Obra Norte', rutaId: 'demo-ruta-1', rutaNombre: rutas[0].nombre,
        camionId: 'cam-1700kg', camionNombre: 'Camión 1.700 kg', modalidad: 'propio',
        km: 85, formaCobro: 'fija', tarifa: 70000, tarifaRef: tarifa('tar-1700-stgo'), netoConfirmado: false,
        peajesEstimados: 6200, combustible: 18000, comida: 7000,
        chofer: { modo: 'km', tarifaKm: CHOFER_TARIFA_KM_DEFECTO }
      }),
      Object.assign({}, base, {
        id: 'demo-viaje-3', codigo: 'DEMO-003', fecha: sumarDias(hoy, -12), estado: 'realizado',
        sitio: 'Obra Poniente', localidad: 'Sector Poniente', destino: 'Obra Poniente',
        camionId: 'cam-6000kg', camionNombre: 'Camión 6.000 kg', modalidad: 'propio',
        km: 40, formaCobro: 'fija', tarifa: 90000, tarifaRef: tarifa('tar-6000-stgo'), netoConfirmado: true,
        peajesEstimados: 3000, peajesReales: 3400, combustible: 22000, comida: 6000,
        chofer: { modo: 'fijo', monto: 15000 },
        otrosGastos: [{ id: 'demo-g-1', concepto: 'Estacionamiento', monto: 3000 }]
      }),
      Object.assign({}, base, {
        id: 'demo-viaje-4', codigo: 'DEMO-004', fecha: sumarDias(hoy, -38), estado: 'realizado',
        sitio: 'Obra Norte', localidad: 'Sector Norte', destino: 'Obra Norte',
        camionId: 'cam-1700kg', camionNombre: 'Camión 1.700 kg', modalidad: 'tercerizado',
        km: 320, formaCobro: 'km', tarifa: 1200, tarifaRef: null, netoConfirmado: true,
        transportista: { modo: 'fijo', montoFijo: 300000 },
        cobrosAdicionales: [{ id: 'demo-c-1', concepto: 'Sobreestadía', monto: 50000 }]
      }),
      Object.assign({}, base, {
        id: 'demo-viaje-5', codigo: 'DEMO-005', fecha: sumarDias(hoy, 4), estado: 'planificado',
        sitio: 'Obra Oriente', localidad: 'Sector Oriente', destino: 'Obra Oriente',
        camionId: 'cam-6000kg', camionNombre: 'Camión 6.000 kg', modalidad: 'tercerizado',
        km: 450, formaCobro: 'km', tarifa: 1650, tarifaRef: tarifa('tar-6000-km'), netoConfirmado: true,
        peajesEstimados: 22000, transportista: { modo: 'km', tarifaKm: 1440 }
      }),
      Object.assign({}, base, {
        id: 'demo-viaje-6', codigo: 'DEMO-006', fecha: sumarDias(hoy, -20), estado: 'cancelado',
        sitio: 'Obra Sur', localidad: 'Sector Sur', destino: 'Obra Sur',
        camionId: 'cam-1700kg', camionNombre: 'Camión 1.700 kg', modalidad: 'propio',
        km: 60, formaCobro: 'fija', tarifa: 70000, tarifaRef: tarifa('tar-1700-stgo'), netoConfirmado: false,
        notas: 'Registro de demostración. Viaje cancelado: no suma a ingresos ni costos.'
      })
    ].map(normalizarViaje);
    return { rutas, viajes };
  }

  /* =======================================================================
     Autocomprobación (se ejecuta en Ajustes y con `node tests/calculos.test.js`)
     ======================================================================= */
  function viajeBase(extra) {
    return normalizarViaje(Object.assign({
      fecha: '2026-09-22', estado: 'realizado', sitio: 'Prueba', localidad: 'Prueba',
      camionId: 'x', modalidad: 'propio', formaCobro: 'km', km: 0, tarifa: 0, aplicaIva: false, ivaPct: 19
    }, extra));
  }

  function autocomprobacion() {
    const resultados = [];
    const comprobar = (nombre, obtenido, esperado) => {
      const ok = Object.is(obtenido, esperado) ||
        (esNumero(obtenido) && esNumero(esperado) && Math.abs(obtenido - esperado) < 1e-9);
      resultados.push({ nombre, ok, esperado, obtenido });
    };

    // Caso obligatorio de la reunión: 1000 km, cobro 1.650/km, transportista 1.440/km.
    const reunion = calcularViaje(viajeBase({
      km: 1000, tarifa: 1650, modalidad: 'tercerizado',
      transportista: { modo: 'km', tarifaKm: 1440 }
    }));
    comprobar('Reunión · ingreso neto 1.000 km × $1.650', reunion.ingresoNeto, 1650000);
    comprobar('Reunión · costo transportista 1.000 km × $1.440', reunion.costosDirectos, 1440000);
    comprobar('Reunión · margen bruto', reunion.margenBruto, 210000);

    // Cobro fijo con IVA: el IVA no suma al ingreso ni al margen.
    const fijo = calcularViaje(viajeBase({
      formaCobro: 'fija', tarifa: 90000, km: 40, aplicaIva: true, ivaPct: 19,
      peajesEstimados: 5000, combustible: 20000, comida: 8000
    }));
    comprobar('Tarifa fija · ingreso neto = tarifa', fijo.ingresoNeto, 90000);
    comprobar('Tarifa fija · IVA 19 % separado', fijo.iva, 17100);
    comprobar('Tarifa fija · total con IVA', fijo.totalConIva, 107100);
    comprobar('Tarifa fija · costos directos', fijo.costosDirectos, 33000);
    comprobar('Tarifa fija · margen no incluye IVA', fijo.margenBruto, 57000);
    const sinIva = calcularViaje(viajeBase({
      formaCobro: 'fija', tarifa: 90000, aplicaIva: false,
      peajesEstimados: 5000, combustible: 20000, comida: 8000
    }));
    comprobar('IVA activado o no: mismo margen', sinIva.margenBruto, fijo.margenBruto);

    // Ingreso cero: sin división por cero.
    const cero = calcularViaje(viajeBase({ km: 50, tarifa: 0, combustible: 10000 }));
    comprobar('Ingreso cero · margen negativo', cero.margenBruto, -10000);
    comprobar('Ingreso cero · margen % sin dato (null)', cero.margenPct, null);

    // Peaje real vs estimado.
    const est = calcularViaje(viajeBase({ km: 100, tarifa: 1650, peajesEstimados: 12000 }));
    comprobar('Peaje · sin real usa estimado', est.peajes, 12000);
    comprobar('Peaje · marcado como estimado', est.peajesEsEstimado, true);
    const real = calcularViaje(viajeBase({ km: 100, tarifa: 1650, peajesEstimados: 12000, peajesReales: 15300 }));
    comprobar('Peaje · real reemplaza estimado', real.peajes, 15300);
    comprobar('Peaje · real no se marca como estimado', real.peajesEsEstimado, false);
    const realCero = calcularViaje(viajeBase({ km: 100, tarifa: 1650, peajesEstimados: 12000, peajesReales: 0 }));
    comprobar('Peaje · real en $0 cuenta como real', realCero.peajes, 0);

    // Transportista: monto fijo y viaje propio.
    const tFijo = calcularViaje(viajeBase({
      km: 300, tarifa: 1650, modalidad: 'tercerizado', transportista: { modo: 'fijo', montoFijo: 380000 }
    }));
    comprobar('Transportista monto fijo', tFijo.costoTransportista, 380000);
    const propio = calcularViaje(viajeBase({
      km: 300, tarifa: 1650, modalidad: 'propio', transportista: { modo: 'km', tarifaKm: 1440 }
    }));
    comprobar('Viaje propio no suma costo transportista', propio.costoTransportista, 0);

    // Otros gastos.
    const otros = calcularViaje(viajeBase({
      km: 10, tarifa: 1000, otrosGastos: [{ concepto: 'Estacionamiento', monto: 2500 }, { concepto: 'Lavado', monto: 1500 }]
    }));
    comprobar('Otros gastos suman a costos directos', otros.costosDirectos, 4000);

    // Cobros adicionales (p. ej. sobreestadía) suman al ingreso neto.
    const extra = calcularViaje(viajeBase({
      km: 1378, tarifa: 1650, modalidad: 'tercerizado', transportista: { modo: 'km', tarifaKm: 1440 },
      cobrosAdicionales: [{ concepto: 'Sobreestadía', monto: 100000 }]
    }));
    comprobar('Cobro adicional suma al ingreso neto', extra.ingresoNeto, 2373700);
    comprobar('Cobro adicional · margen', extra.margenBruto, 389380);

    // Pago al chofer: por km, fijo y sin pago.
    const chKm = calcularViaje(viajeBase({ km: 775, formaCobro: 'fija', tarifa: 930000, chofer: { modo: 'km', tarifaKm: 200 } }));
    comprobar('Chofer por km: 775 km × $200 = $155.000', chKm.costoChofer, 155000);
    comprobar('Chofer suma a costos directos', chKm.costosDirectos, 155000);
    const chFijo = calcularViaje(viajeBase({ km: 40, formaCobro: 'fija', tarifa: 90000, chofer: { modo: 'fijo', monto: 15000 } }));
    comprobar('Chofer monto fijo', chFijo.margenBruto, 75000);
    const chNo = calcularViaje(viajeBase({ km: 40, formaCobro: 'fija', tarifa: 90000, chofer: { modo: 'ninguno', tarifaKm: 200 } }));
    comprobar('Chofer "sin pago" no suma', chNo.costoChofer, 0);

    // Resumen de período.
    const resumen = resumirPeriodo([
      viajeBase({ km: 1000, tarifa: 1650, modalidad: 'tercerizado', transportista: { modo: 'km', tarifaKm: 1440 } }),
      viajeBase({ estado: 'planificado', formaCobro: 'fija', tarifa: 70000, combustible: 20000 }),
      viajeBase({ estado: 'cancelado', formaCobro: 'fija', tarifa: 90000 })
    ]);
    comprobar('Resumen · ingresos solo de realizados', resumen.realizados.ingresoNeto, 1650000);
    comprobar('Resumen · cancelados no suman', resumen.cancelados, 1);
    comprobar('Resumen · resultado estimado = realizados + planificados', resumen.resultadoEstimado, 260000);

    // Parseo en formato chileno.
    comprobar('Parseo · "1.650" = 1650', parsearMonto('1.650').valor, 1650);
    comprobar('Parseo · "$ 90.000" = 90000', parsearMonto('$ 90.000').valor, 90000);
    comprobar('Parseo · monto negativo rechazado', parsearMonto('-500').valor, null);
    comprobar('Parseo · km "1.000" = 1000', parsearDecimal('1.000').valor, 1000);
    comprobar('Parseo · km "12,5" = 12,5', parsearDecimal('12,5').valor, 12.5);
    comprobar('Validación · fecha 2026-02-30 inválida', esFechaValida('2026-02-30'), false);

    return resultados;
  }

  const Calculos = {
    ESTADOS, MODALIDADES, FORMAS_COBRO, MODOS_TRANSPORTISTA, MODOS_CHOFER, TRATAMIENTOS_IVA,
    IVA_PCT_DEFECTO, CHOFER_TARIFA_KM_DEFECTO, SCHEMA_VIAJE, CATALOGO_INICIAL, FECHA_REUNION,
    esNumero, redondearPesos, generarId, sumarDias,
    ingresoBase, totalCobrosAdicionales, ingresoNeto, impuesto, peajesAplicados, costoTransportista, costoChofer,
    totalOtrosGastos, margenPorcentual, calcularViaje, resumirPeriodo, agruparYResumir,
    parsearMonto, parsearDecimal, esFechaValida,
    normalizarViaje, validarViaje, normalizarRuta, normalizarCamion, normalizarTarifa,
    datosDemo, autocomprobacion
  };

  raiz.Calculos = Calculos;
  if (typeof module !== 'undefined' && module.exports) module.exports = Calculos;
})(typeof self !== 'undefined' ? self : globalThis);
