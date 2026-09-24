/* =========================================================================
   app.js — Interfaz de Gestión de Transporte (versión en línea)
   -------------------------------------------------------------------------
   Secciones:
     1. Configuración
     2. Estado global
     3. Utilidades DOM (sin innerHTML con datos del usuario)
     4. Formato (CLP, fechas, números)
     5. Avisos, diálogos y confirmaciones
     6. Estado desde la nube (Nube, api.js) + cambios pendientes locales
     7. Enrutador, estructura, login y sincronización
     8. Vistas: Inicio, Viajes, Detalle, Formulario, Rutas, Camiones y
        tarifas, Informes, Respaldo, Ajustes, Más
     9. Adjuntos (compresión y visor)
    10. Exportación CSV
    11. Service worker (actualizaciones)
    12. Arranque
   Todas las cifras salen de Calculos.calcularViaje / resumirPeriodo.
   Los datos compartidos viven en Google Sheets; ver api.js.
   ========================================================================= */
(() => {
  'use strict';

  const C = window.Calculos;
  const DB = window.DB;       // almacenamiento local (borradores, caché, cola)
  const Nube = window.Nube;   // backend Apps Script

  /* =======================================================================
     1. Configuración
     ======================================================================= */
  const APP_VERSION = '2.0.2'; // Mantener igual a VERSION en sw.js
  const NOMBRE_POR_DEFECTO = 'Gestión de Transporte';
  const INTERVALO_SYNC_MS = Math.max(15, Number((window.CONFIG_APP || {}).INTERVALO_SYNC_SEG) || 45) * 1000;
  const IMG = {
    tipos: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
    extensiones: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
    maxEntradaMB: 20,       // tamaño máximo del archivo original
    ladoMax: 1600,          // px del lado mayor después de optimizar
    calidad: 0.8,           // calidad JPEG
    maxPorCategoria: 12     // fotos por categoría y viaje
  };
  const CATEGORIAS = {
    guia: 'Guía de despacho firmada',
    entrega: 'Entrega de materiales'
  };
  const ETQ = {
    estado: { planificado: 'Planificado', realizado: 'Realizado', cancelado: 'Cancelado' },
    modalidad: { propio: 'Camión propio', tercerizado: 'Tercerizado' },
    formaCobro: { km: 'Por kilómetro', fija: 'Tarifa fija' },
    iva: { neto: 'Neto (+ IVA)', incluido: 'Incluye IVA', pendiente: 'IVA por confirmar' },
    modoTransportista: { km: 'Por kilómetro', fijo: 'Monto fijo' },
    modoChofer: { ninguno: 'Sin pago', km: 'Por kilómetro', fijo: 'Monto fijo' },
    rol: { admin: 'Administrador', usuario: 'Usuario' }
  };

  /* =======================================================================
     2. Estado global
     ======================================================================= */
  const S = {
    cfg: {},
    camiones: [],
    tarifas: [],
    rutas: [],
    viajes: [],
    usuarios: new Map(),
    adj: { porViaje: new Map(), total: 0, bytes: 0, lista: [] },
    periodoInicio: null,
    periodoInformes: null,
    form: null,            // formulario de viaje en edición
    urls: [],              // object URLs de la vista en pantalla (se liberan al reemplazarla)
    urlsColeccion: null,   // lista donde se registran las URLs de la vista que se está construyendo
    renderToken: 0,
    guardando: false,
    refrescoPendiente: false,
    sw: { registro: null, esperando: false, actualizando: false },
    instalar: null,        // evento beforeinstallprompt (Chrome/Android) para instalar la app
    restauracion: null     // respaldo validado en vista previa
  };

  /* =======================================================================
     3. Utilidades DOM
     ======================================================================= */
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const $$ = (sel, raiz) => Array.from((raiz || document).querySelectorAll(sel));

  /** Crea elementos sin innerHTML. Los textos siempre van como nodos de texto. */
  function h(tag, attrs, ...hijos) {
    const el = document.createElement(tag);
    const diferidos = [];
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.setAttribute('class', v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value' || k === 'checked' || k === 'selected') diferidos.push([k, v]);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    agregar(el, hijos);
    diferidos.forEach(([k, v]) => { el[k] = v; });
    return el;
  }

  function agregar(el, ...hijos) {
    for (const c of hijos.flat(Infinity)) {
      if (c === null || c === undefined || c === false || c === true) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function vaciar(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  function reemplazar(el, ...hijos) {
    vaciar(el);
    return agregar(el, hijos);
  }

  let contadorIds = 0;
  const uid = (pref) => `${pref}-${++contadorIds}`;

  /* Íconos de trazo propios (24×24). Solo datos constantes, sin HTML. */
  const ICONOS = {
    inicio: ['M3 10.5 12 3l9 7.5', 'M5 9v12h14V9', 'M10 21v-6h4v6'],
    viajes: ['M2 6h11v10H2z', 'M13 9h4.5l3.5 4.5V16h-8', 'M4.5 18a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0', 'M15.5 18a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'],
    nuevo: ['M12 5v14', 'M5 12h14'],
    informes: ['M4 20V11', 'M10 20V5', 'M16 20v-6', 'M21 20H3'],
    mas: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    rutas: ['M3 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M17 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M7 18h8a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h8'],
    tarifas: ['M3 12V4h8l10 10-8 8z', 'M7.5 8h.01'],
    respaldo: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
    ajustes: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 5v4', 'M9 15v4'],
    buscar: ['M10.5 17a6.5 6.5 0 1 0 0-13a6.5 6.5 0 0 0 0 13z', 'M20 20l-4.6-4.6'],
    editar: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
    duplicar: ['M8 8h12v12H8z', 'M4 16V4h12'],
    eliminar: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
    imprimir: ['M6 9V3h12v6', 'M6 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-2', 'M6 14h12v7H6z'],
    camara: ['M3 8h4l2-3h6l2 3h4v12H3z', 'M12 17a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7z'],
    descargar: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
    subir: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
    cerrar: ['M6 6l12 12', 'M18 6L6 18'],
    ok: ['M5 12.5l4.5 4.5L19 7'],
    alerta: ['M12 3l10 18H2z', 'M12 10v5', 'M12 18h.01'],
    info: ['M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5h.01'],
    izquierda: ['M15 5l-7 7 7 7'],
    derecha: ['M9 5l7 7-7 7'],
    filtro: ['M4 5h16l-6 8v6l-4-2v-4z'],
    ojo: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6z'],
    recargar: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7']
  };

  function icono(nombre, clase) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', `ico ${clase || ''}`.trim());
    (ICONOS[nombre] || []).forEach(d => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  /** Botón con ícono y texto visible (o aria-label si soloIcono). */
  function boton({ texto, icono: ico, clase = 'btn', tipo = 'button', onClick, soloIcono = false, attrs = {} }) {
    return h('button', Object.assign({
      type: tipo,
      class: clase + (soloIcono ? ' btn-icono' : ''),
      onclick: onClick,
      'aria-label': soloIcono ? texto : null,
      title: soloIcono ? texto : null
    }, attrs), ico ? icono(ico) : null, soloIcono ? null : h('span', null, texto));
  }

  function enlaceBoton({ texto, href, icono: ico, clase = 'btn' }) {
    return h('a', { class: clase, href }, ico ? icono(ico) : null, h('span', null, texto));
  }

  function insignia(texto, tono) {
    return h('span', { class: `insignia insignia-${tono || 'neutra'}` }, texto);
  }

  function insigniaEstado(estado) {
    const tonos = { planificado: 'info', realizado: 'ok', cancelado: 'neutra' };
    return insignia(ETQ.estado[estado] || estado, tonos[estado]);
  }

  function registrarUrl(url) {
    (S.urlsColeccion || S.urls).push(url);
    return url;
  }

  function liberarUrls(lista) {
    lista.forEach(u => URL.revokeObjectURL(u));
  }

  /** Llamar justo después de poner la vista nueva en pantalla: recién ahí se liberan
      las URLs de la anterior (antes, sus imágenes podían seguir cargando y fallar). */
  function mostrarUrls(lista) {
    const anteriores = S.urls;
    S.urls = lista;
    S.urlsColeccion = lista;
    if (anteriores !== lista) liberarUrls(anteriores);
  }

  function debounce(fn, ms) {
    let t = null;
    const f = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    f.ahora = (...args) => { clearTimeout(t); t = null; return fn(...args); };
    f.pendiente = () => t !== null;
    f.cancelar = () => { clearTimeout(t); t = null; };
    return f;
  }

  function sinTildes(t) {
    return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /* =======================================================================
     4. Formato
     ======================================================================= */
  const fmtCLP = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
  const fmtEntero = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
  const fmtDecimal = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });
  const fmtUnDecimal = new Intl.NumberFormat('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtFecha = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtFechaLarga = new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtMes = new Intl.DateTimeFormat('es-CL', { month: 'long', year: 'numeric' });
  const fmtMesCorto = new Intl.DateTimeFormat('es-CL', { month: 'short' });
  const fmtFechaHora = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const clp = v => fmtCLP.format(Math.round(v || 0)).replace(/^-/, '−');
  const numero = v => (C.esNumero(v) ? fmtDecimal.format(v) : '—');
  const km = v => (C.esNumero(v) ? `${fmtDecimal.format(v)} km` : '—');
  const pct = v => (C.esNumero(v) ? `${fmtUnDecimal.format(v).replace(/^-/, '−')} %` : '—');
  const pad = n => String(n).padStart(2, '0');

  function clpCorto(v) {
    const a = Math.abs(v);
    const signo = v < 0 ? '−' : '';
    if (a >= 1e6) return `${signo}$${fmtUnDecimal.format(a / 1e6)} M`;
    if (a >= 1e4) return `${signo}$${fmtEntero.format(Math.round(a / 1e3))} mil`;
    return clp(v);
  }

  function aFecha(iso) {
    if (!C.esFechaValida(iso)) return null;
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(a, m - 1, d);
  }
  const fechaCorta = iso => { const f = aFecha(iso); return f ? fmtFecha.format(f) : 'Sin fecha'; };
  const fechaLarga = iso => { const f = aFecha(iso); return f ? fmtFechaLarga.format(f) : 'Sin fecha'; };
  const fechaHora = isoTs => { const f = new Date(isoTs); return isNaN(f) ? '—' : fmtFechaHora.format(f); };
  const capitalizar = t => t.charAt(0).toUpperCase() + t.slice(1);
  const nombreMes = mes => { const [a, m] = mes.split('-').map(Number); return capitalizar(fmtMes.format(new Date(a, m - 1, 1))); };
  const nombreMesCorto = mes => { const [a, m] = mes.split('-').map(Number); return `${capitalizar(fmtMesCorto.format(new Date(a, m - 1, 1)).replace('.', ''))} ${String(a).slice(2)}`; };

  function hoyISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const mesActual = () => hoyISO().slice(0, 7);
  function moverMes(mes, delta) {
    const [a, m] = mes.split('-').map(Number);
    const f = new Date(a, m - 1 + delta, 1);
    return `${f.getFullYear()}-${pad(f.getMonth() + 1)}`;
  }
  function tamanoLegible(bytes) {
    if (!C.esNumero(bytes)) return '—';
    if (bytes === 0) return '0 KB';
    if (bytes >= 1024 * 1024) return `${fmtUnDecimal.format(bytes / 1024 / 1024)} MB`;
    return `${fmtEntero.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
  }
  const montoParaInput = v => (C.esNumero(v) ? fmtEntero.format(v) : '');
  const decimalParaInput = v => (C.esNumero(v) ? fmtDecimal.format(v) : '');

  /* =======================================================================
     5. Avisos, diálogos y confirmaciones
     ======================================================================= */
  function toast(mensaje, tipo = 'ok', opciones = {}) {
    const cont = $('#toasts');
    const nodo = h('div', { class: `toast toast-${tipo}`, role: tipo === 'error' ? 'alert' : null },
      icono(tipo === 'error' ? 'alerta' : tipo === 'aviso' ? 'info' : 'ok'),
      h('p', null, mensaje),
      opciones.accion ? h('button', {
        type: 'button', class: 'toast-accion',
        onclick: () => { cerrar(); opciones.accion.fn(); }
      }, opciones.accion.texto) : null,
      h('button', { type: 'button', class: 'toast-cerrar', 'aria-label': 'Cerrar aviso', onclick: () => cerrar() }, icono('cerrar'))
    );
    function cerrar() {
      nodo.classList.add('saliendo');
      setTimeout(() => nodo.remove(), 200);
    }
    cont.appendChild(nodo);
    setTimeout(cerrar, opciones.duracion || (tipo === 'error' ? 9000 : 5000));
  }

  /** Abre un <dialog> modal. constructor(dlg, cerrar) arma el contenido. */
  function abrirDialogo(constructor, opciones = {}) {
    return new Promise(resolve => {
      const previo = document.activeElement;
      const idTitulo = uid('dlg-titulo');
      const dlg = h('dialog', { class: `dialogo ${opciones.clase || ''}`, 'aria-labelledby': idTitulo });
      let valor;
      const cerrar = (v) => { valor = v; if (dlg.open) dlg.close(); };
      dlg.addEventListener('close', () => {
        dlg.remove();
        if (previo && typeof previo.focus === 'function' && document.contains(previo)) previo.focus();
        resolve(valor);
      });
      constructor(dlg, cerrar, idTitulo);
      document.body.appendChild(dlg);
      dlg.showModal();
      const foco = dlg.querySelector('[data-foco-inicial]') || dlg.querySelector('input, select, textarea, button');
      if (foco) foco.focus();
    });
  }

  function confirmar({ titulo, mensaje, detalle, textoConfirmar = 'Confirmar', peligro = false, textoCancelar = 'Cancelar' }) {
    return abrirDialogo((dlg, cerrar, idTitulo) => {
      agregar(dlg,
        h('div', { class: 'dialogo-cuerpo' },
          h('h2', { id: idTitulo, class: 'dialogo-titulo' }, titulo),
          mensaje ? h('p', null, mensaje) : null,
          detalle || null
        ),
        h('div', { class: 'dialogo-acciones' },
          h('button', { type: 'button', class: 'btn btn-secundario', onclick: () => cerrar(false), 'data-foco-inicial': peligro ? true : null }, textoCancelar),
          h('button', { type: 'button', class: `btn ${peligro ? 'btn-peligro' : 'btn-primario'}`, onclick: () => cerrar(true), 'data-foco-inicial': peligro ? null : true }, textoConfirmar)
        )
      );
    }).then(v => v === true);
  }

  /**
   * Formulario en diálogo para catálogos. campos: [{nombre, etiqueta, tipo, opciones, obligatorio, ayuda, max}]
   * alGuardar(datos) puede lanzar Error para mostrarlo sin cerrar. Resuelve true si guardó.
   */
  function dialogoFormulario({ titulo, descripcion, campos, valores = {}, textoGuardar = 'Guardar', validar, alGuardar }) {
    return abrirDialogo((dlg, cerrar, idTitulo) => {
      const pref = uid('df');
      const errorGeneral = h('p', { class: 'error error-general', role: 'alert', hidden: true });
      const nodos = {};
      const form = h('form', { class: 'dialogo-form', novalidate: true });
      const cuerpo = h('div', { class: 'dialogo-cuerpo' },
        h('h2', { id: idTitulo, class: 'dialogo-titulo' }, titulo),
        descripcion ? h('p', { class: 'texto-suave' }, descripcion) : null
      );
      const rejilla = h('div', { class: 'rejilla-campos' });
      campos.forEach(cp => {
        const id = `${pref}-${cp.nombre}`;
        const idErr = `${id}-error`;
        const idAyuda = cp.ayuda ? `${id}-ayuda` : null;
        const describe = [idAyuda, idErr].filter(Boolean).join(' ');
        const v = valores[cp.nombre];
        let control;
        if (cp.tipo === 'select') {
          control = h('select', { id, name: cp.nombre, 'aria-describedby': describe, required: cp.obligatorio, value: v == null ? '' : v },
            cp.opciones.map(([val, txt]) => h('option', { value: val }, txt)));
        } else if (cp.tipo === 'textarea') {
          control = h('textarea', { id, name: cp.nombre, rows: 3, maxlength: cp.max || 500, 'aria-describedby': describe, value: v || '' });
        } else if (cp.tipo === 'checkbox') {
          control = h('input', { id, name: cp.nombre, type: 'checkbox', checked: !!v, 'aria-describedby': describe });
        } else {
          const tipos = { fecha: 'date', texto: 'text', monto: 'text', decimal: 'text' };
          control = h('input', {
            id, name: cp.nombre, type: tipos[cp.tipo] || 'text',
            inputmode: cp.tipo === 'monto' ? 'numeric' : cp.tipo === 'decimal' ? 'decimal' : null,
            autocomplete: 'off', maxlength: cp.max || (cp.tipo === 'texto' ? 120 : null),
            required: cp.obligatorio, 'aria-describedby': describe,
            value: cp.tipo === 'monto' ? montoParaInput(v) : cp.tipo === 'decimal' ? decimalParaInput(v) : (v || '')
          });
          if (cp.tipo === 'monto') control.addEventListener('blur', () => formatearMonto(control));
        }
        nodos[cp.nombre] = control;
        const envoltura = cp.tipo === 'checkbox'
          ? h('div', { class: `campo campo-check ${cp.ancho === 'completo' ? 'completo' : ''}` },
            h('div', { class: 'check' }, control, h('label', { for: id }, cp.etiqueta)),
            idAyuda ? h('p', { class: 'ayuda', id: idAyuda }, cp.ayuda) : null,
            h('p', { class: 'error', id: idErr, hidden: true }))
          : h('div', { class: `campo ${cp.ancho === 'completo' || cp.tipo === 'textarea' ? 'completo' : ''}` },
            h('label', { for: id }, cp.etiqueta, cp.obligatorio ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
            cp.prefijo ? h('div', { class: 'entrada-compuesta' }, h('span', { class: 'prefijo', 'aria-hidden': 'true' }, cp.prefijo), control) : control,
            idAyuda ? h('p', { class: 'ayuda', id: idAyuda }, cp.ayuda) : null,
            h('p', { class: 'error', id: idErr, hidden: true }));
        rejilla.appendChild(envoltura);
      });
      agregar(cuerpo, rejilla, errorGeneral);
      const btnGuardar = h('button', { type: 'submit', class: 'btn btn-primario' }, textoGuardar);
      agregar(form, cuerpo, h('div', { class: 'dialogo-acciones' },
        h('button', { type: 'button', class: 'btn btn-secundario', onclick: () => cerrar(false) }, 'Cancelar'),
        btnGuardar));
      dlg.appendChild(form);

      let ocupado = false;
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (ocupado) return;
        const datos = {};
        const errores = {};
        campos.forEach(cp => {
          const el = nodos[cp.nombre];
          if (cp.tipo === 'checkbox') { datos[cp.nombre] = el.checked; return; }
          const bruto = el.value.trim();
          if (cp.tipo === 'monto' || cp.tipo === 'decimal') {
            const r = cp.tipo === 'monto' ? C.parsearMonto(bruto) : C.parsearDecimal(bruto);
            if (r.error) errores[cp.nombre] = r.error;
            datos[cp.nombre] = r.valor;
          } else if (cp.tipo === 'fecha') {
            if (bruto && !C.esFechaValida(bruto)) errores[cp.nombre] = 'Fecha no válida.';
            datos[cp.nombre] = bruto;
          } else {
            datos[cp.nombre] = bruto;
          }
          if (cp.obligatorio && !errores[cp.nombre] && (datos[cp.nombre] === '' || datos[cp.nombre] === null)) {
            errores[cp.nombre] = 'Este campo es obligatorio.';
          }
        });
        Object.assign(errores, validar ? validar(datos) || {} : {}, errores);
        campos.forEach(cp => {
          const el = nodos[cp.nombre];
          const pErr = $(`#${pref}-${cp.nombre}-error`, dlg);
          if (errores[cp.nombre]) {
            el.setAttribute('aria-invalid', 'true');
            pErr.textContent = errores[cp.nombre];
            pErr.hidden = false;
          } else {
            el.removeAttribute('aria-invalid');
            pErr.hidden = true;
          }
        });
        const primero = campos.find(cp => errores[cp.nombre]);
        if (primero) { nodos[primero.nombre].focus(); return; }
        ocupado = true;
        btnGuardar.disabled = true;
        errorGeneral.hidden = true;
        try {
          await alGuardar(datos);
          cerrar(true);
        } catch (err) {
          errorGeneral.textContent = err.message || 'No se pudo guardar.';
          errorGeneral.hidden = false;
        } finally {
          ocupado = false;
          btnGuardar.disabled = false;
        }
      });
    }).then(v => v === true);
  }

  function formatearMonto(input) {
    const r = C.parsearMonto(input.value);
    if (!r.error && r.valor !== null) input.value = montoParaInput(r.valor);
  }
  function formatearDecimal(input) {
    const r = C.parsearDecimal(input.value);
    if (!r.error && r.valor !== null) input.value = decimalParaInput(r.valor);
  }

  function descargarBlob(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: nombre, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function marcaTiempoArchivo() {
    const d = new Date();
    return `${hoyISO()}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  /* =======================================================================
     6. Estado desde la nube + cambios pendientes del dispositivo
     ======================================================================= */
  function preferenciasLocales() { return Nube.leerLocal('gt-preferencias') || {}; }
  function guardarPreferenciaLocal(clave, valor) {
    const p = preferenciasLocales();
    p[clave] = valor;
    Nube.escribirLocal('gt-preferencias', p);
  }

  /** Reconstruye S desde los datos descargados + la cola local. No usa la red. */
  function construirEstado() {
    const d = Nube.vista();
    const prefs = preferenciasLocales();
    S.cfg = Object.assign({
      nombreApp: NOMBRE_POR_DEFECTO, ivaPct: C.IVA_PCT_DEFECTO, ivaPorDefecto: true, choferTarifaKm: C.CHOFER_TARIFA_KM_DEFECTO
    }, d.config, { tema: prefs.tema || 'auto', ultimoRespaldo: prefs.ultimoRespaldo || '' });
    S.camiones = d.camiones.map(C.normalizarCamion).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    S.tarifas = d.tarifas.map(C.normalizarTarifa);
    S.rutas = d.rutas.map(C.normalizarRuta).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    S.viajes = d.viajes.map(C.normalizarViaje);
    S.usuarios = new Map(d.usuarios.map(u => [u.usuario, u.nombre]));
    const porViaje = new Map();
    let bytes = 0;
    d.adjuntos.forEach(a => {
      const r = porViaje.get(a.viajeId) || { guia: 0, entrega: 0 };
      if (a.categoria === 'guia') r.guia += 1; else r.entrega += 1;
      porViaje.set(a.viajeId, r);
      bytes += C.esNumero(a.tamano) ? a.tamano : (a.blob ? a.blob.size : 0);
    });
    S.adj = { porViaje, total: d.adjuntos.length, bytes, lista: d.adjuntos };
    aplicarIdentidad();
    actualizarAvisosGlobales();
    actualizarIndicadorSync();
    actualizarUsuarioUI();
  }

  async function recargar() { construirEstado(); }

  const nombreUsuario = u => (u ? (S.usuarios.get(u) || u) : '—');
  const esAdmin = () => Nube.esAdmin();

  /** Texto de error para operaciones en línea. */
  function mensajeError(err, accion) {
    if (err && err.red) return `${accion}: se necesita conexión a internet. Intenta de nuevo cuando tengas señal.`;
    return `${accion}: ${err && err.message ? err.message : err}`;
  }

  /** Tras un conflicto u objeto inexistente, trae los datos actuales y vuelve a dibujar. */
  async function refrescarTrasError(err) {
    if (!err || !['conflicto', 'noExiste', 'enUso'].includes(err.codigo)) return;
    try { await Nube.sincronizar(); } catch (e) { /* sin conexión */ }
    construirEstado();
    renderizar();
  }

  /** Ejecuta fn sobre la lista con a lo más `limite` tareas simultáneas. */
  async function mapConLimite(lista, limite, fn) {
    const salida = new Array(lista.length);
    let i = 0;
    const trabajador = async () => { while (i < lista.length) { const k = i++; salida[k] = await fn(lista[k], k); } };
    await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, trabajador));
    return salida;
  }

  /** Fotos de un viaje con su imagen (desde caché local o descargada del servidor). */
  async function adjuntosDeViaje(viajeId) {
    const lista = S.adj.lista.filter(a => a.viajeId === viajeId)
      .sort((a, b) => String(a.creado).localeCompare(String(b.creado)));
    return mapConLimite(lista, 4, async a => {
      try { return Object.assign({}, a, { blob: await Nube.blobAdjunto(a) }); } catch (err) { return Object.assign({}, a, { blob: null, errorCarga: err.message }); }
    });
  }

  const cantidadDemo = () => ({
    viajes: S.viajes.filter(v => v.demo).length,
    rutas: S.rutas.filter(r => r.demo).length
  });

  async function eliminarDemoConConfirmacion() {
    const n = cantidadDemo();
    if (!n.viajes && !n.rutas) { toast('No hay datos de demostración.', 'aviso'); return; }
    if (!esAdmin()) { toast('Solo un administrador puede eliminar los datos de demostración.', 'aviso'); return; }
    const ok = await confirmar({
      titulo: 'Eliminar datos de demostración',
      mensaje: `Se eliminarán para todos los usuarios ${n.viajes} viaje(s) y ${n.rutas} ruta(s) marcados como demostración. Los registros reales, camiones y tarifas no se tocan.`,
      textoConfirmar: 'Eliminar demostración',
      peligro: true
    });
    if (!ok) return;
    try {
      const r = await Nube.eliminarDemo();
      construirEstado();
      toast(`Se eliminaron ${r.viajes} viaje(s) y ${r.rutas} ruta(s) de demostración.`);
      renderizar();
    } catch (err) {
      toast(mensajeError(err, 'No se pudieron eliminar'), 'error');
    }
  }

  /* =======================================================================
     7. Enrutador y estructura
     ======================================================================= */
  const NAV = [
    { ruta: '/inicio', texto: 'Inicio', icono: 'inicio' },
    { ruta: '/viajes', texto: 'Viajes', icono: 'viajes' },
    { ruta: '/rutas', texto: 'Rutas frecuentes', icono: 'rutas' },
    { ruta: '/tarifas', texto: 'Camiones y tarifas', icono: 'tarifas' },
    { ruta: '/informes', texto: 'Informes', icono: 'informes' },
    { ruta: '/respaldo', texto: 'Respaldo', icono: 'respaldo' },
    { ruta: '/ajustes', texto: 'Ajustes', icono: 'ajustes' }
  ];
  const NAV_MOVIL = [
    { ruta: '/inicio', texto: 'Inicio', icono: 'inicio' },
    { ruta: '/viajes', texto: 'Viajes', icono: 'viajes' },
    { ruta: '/viajes/nuevo', texto: 'Nuevo', icono: 'nuevo', destacado: true },
    { ruta: '/informes', texto: 'Informes', icono: 'informes' },
    { ruta: '/mas', texto: 'Más', icono: 'mas' }
  ];

  function construirNavegacion() {
    const lista = $('#nav-lateral');
    reemplazar(lista, NAV.map(n => h('li', null,
      h('a', { href: `#${n.ruta}`, class: 'nav-enlace', dataset: { ruta: n.ruta } }, icono(n.icono), h('span', null, n.texto)))));
    const movil = $('#nav-inferior-lista');
    reemplazar(movil, NAV_MOVIL.map(n => h('li', null,
      h('a', { href: `#${n.ruta}`, class: `nav-inf-enlace ${n.destacado ? 'destacado' : ''}`, dataset: { ruta: n.ruta } },
        icono(n.icono), h('span', null, n.texto)))));
    $$('.indicador-sync').forEach(b => b.addEventListener('click', () => { if (Nube.sesion()) abrirDialogoSync(); }));
  }

  /** Nombre y rol del usuario en la barra lateral. */
  function actualizarUsuarioUI() {
    const cont = $('#lateral-usuario');
    if (!cont) return;
    const ses = Nube.sesion();
    if (!ses) { vaciar(cont); return; }
    reemplazar(cont,
      h('span', { class: 'usuario-nombre' }, ses.usuario.nombre || ses.usuario.usuario),
      h('span', { class: 'usuario-rol' }, ETQ.rol[ses.usuario.rol] || ses.usuario.rol),
      h('a', { href: '#/ajustes', class: 'usuario-enlace' }, 'Cuenta y ajustes'));
  }

  /* ---------- Login ---------- */
  function vistaLogin() {
    const marcaLogin = h('div', { class: 'login-marca' },
      h('span', { class: 'marca-simbolo', 'aria-hidden': 'true' }),
      h('span', { class: 'login-nombre', 'data-nombre-app': true }, S.cfg.nombreApp || NOMBRE_POR_DEFECTO));
    if (!Nube.configurada()) {
      return {
        titulo: 'Configuración pendiente',
        nodo: h('div', { class: 'login' }, h('div', { class: 'tarjeta login-tarjeta' }, marcaLogin,
          h('h1', { class: 'vista-titulo', tabindex: '-1' }, 'Falta configurar el servidor'),
          h('p', null, 'Edita el archivo config.js y pega en API_URL la dirección de la Aplicación web de Google Apps Script (termina en /exec). Los pasos están en el README.')))
      };
    }
    const inUsuario = h('input', { type: 'text', id: 'login-usuario', name: 'usuario', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 30 });
    const inClave = h('input', { type: 'password', id: 'login-clave', name: 'clave', autocomplete: 'current-password', required: true, maxlength: 100 });
    const verClave = h('input', { type: 'checkbox', id: 'login-ver' });
    verClave.addEventListener('change', () => { inClave.type = verClave.checked ? 'text' : 'password'; });
    const error = h('p', { class: 'error', role: 'alert', hidden: true });
    const aviso = h('p', { class: 'texto-suave', role: 'status', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-primario btn-grande btn-bloque' }, 'Ingresar');
    const form = h('form', { class: 'tarjeta login-tarjeta', novalidate: true, 'aria-labelledby': 'login-titulo' },
      marcaLogin,
      h('h1', { class: 'vista-titulo', id: 'login-titulo', tabindex: '-1' }, 'Ingresar'),
      h('p', { class: 'texto-suave' }, 'Usa el usuario y la clave que te entregó el administrador.'),
      h('div', { class: 'campo' }, h('label', { for: 'login-usuario' }, 'Usuario'), inUsuario),
      h('div', { class: 'campo' }, h('label', { for: 'login-clave' }, 'Clave'), inClave),
      h('div', { class: 'campo campo-check' }, h('div', { class: 'check' }, verClave, h('label', { for: 'login-ver' }, 'Mostrar clave'))),
      error,
      btn,
      aviso);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      if (!inUsuario.value.trim() || !inClave.value) {
        error.textContent = 'Ingresa usuario y clave.';
        error.hidden = false;
        (inUsuario.value.trim() ? inClave : inUsuario).focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Ingresando…';
      error.hidden = true;
      aviso.hidden = true;
      // Apps Script puede tardar varios segundos cuando lleva rato sin uso.
      const lento = setTimeout(() => {
        aviso.textContent = 'El servidor de Google está tardando en responder. Espera un momento; la app reintenta sola.';
        aviso.hidden = false;
      }, 6000);
      try {
        await Nube.iniciarSesion(inUsuario.value, inClave.value);
        construirEstado();
        await arrancarTrasSesion();
      } catch (err) {
        error.textContent = !err.red ? err.message
          : navigator.onLine === false ? 'No hay conexión a internet. Para ingresar se necesita conexión.'
            : 'El servidor de Google no respondió. Suele pasar cuando la app lleva rato sin uso: intenta de nuevo en unos segundos.';
        error.hidden = false;
        inClave.select();
      } finally {
        clearTimeout(lento);
        aviso.hidden = true;
        btn.disabled = false;
        btn.textContent = 'Ingresar';
      }
    });
    setTimeout(() => inUsuario.focus(), 0);
    return { titulo: 'Ingresar', nodo: h('div', { class: 'login' }, form) };
  }

  /** Pantalla mientras se descargan los datos por primera vez en este dispositivo. */
  function vistaCargando() {
    const sync = Nube.estadoSync();
    const error = !sync.sincronizando && sync.error;
    return {
      titulo: 'Cargando',
      nodo: h('div', { class: 'login' }, h('div', { class: 'tarjeta login-tarjeta', role: 'status' },
        h('h1', { class: 'vista-titulo', tabindex: '-1' }, error ? 'No se pudieron descargar los datos' : 'Descargando datos…'),
        h('p', { class: 'texto-suave' }, error ? error.message : 'La primera vez en este dispositivo se descargan los viajes y catálogos desde el servidor.'),
        error ? h('div', { class: 'grupo-botones' },
          boton({ texto: 'Reintentar', icono: 'recargar', clase: 'btn btn-primario', onClick: () => arrancarTrasSesion() }),
          boton({ texto: 'Cerrar sesión', clase: 'btn btn-secundario', onClick: () => cerrarSesionUI() })) : h('div', { class: 'cargando-barra', 'aria-hidden': 'true' })))
    };
  }

  /** Tras ingresar (o al abrir con sesión): descarga, envía pendientes y activa el sondeo. */
  async function arrancarTrasSesion() {
    iniciarSondeo();
    actualizarUsuarioUI();
    const primeraVez = Nube.datos().revision < 0;
    if (primeraVez) renderizar();
    try {
      await Nube.sincronizar();
    } catch (err) {
      if (!primeraVez && !err.red) toast(mensajeError(err, 'No se pudieron actualizar los datos'), 'error');
    }
    construirEstado();
    await renderizar({ silencioso: !primeraVez });
    Nube.procesarCola().catch(() => {});
  }

  async function cerrarSesionUI() {
    const cola = Nube.estadoCola();
    if (cola.total) {
      const ok = await confirmar({
        titulo: 'Hay cambios sin enviar',
        mensaje: `Hay ${cola.total} cambio(s) guardados solo en este dispositivo. Si cierras sesión se perderán. Conéctate y espera a que se envíen, o ciérrala igual.`,
        textoConfirmar: 'Cerrar sesión igual', peligro: true
      });
      if (!ok) return;
    }
    detenerSondeo();
    S.form = null;
    S.cerrandoSesion = true;
    await Nube.cerrarSesion();
    S.cerrandoSesion = false;
    construirEstado();
    actualizarUsuarioUI();
    location.hash = '#/inicio';
    renderizar();
  }

  /* ---------- Sondeo de cambios de otros usuarios ---------- */
  let temporizadorSync = null;
  function iniciarSondeo() {
    if (temporizadorSync) return;
    temporizadorSync = setInterval(revisarCambios, INTERVALO_SYNC_MS);
  }
  function detenerSondeo() {
    clearInterval(temporizadorSync);
    temporizadorSync = null;
  }
  async function revisarCambios() {
    if (!Nube.sesion() || document.visibilityState !== 'visible' || !navigator.onLine) return;
    try {
      await Nube.procesarCola();
      await Nube.comprobarCambios();
    } catch (err) { /* el indicador muestra el estado */ }
  }

  function marcarNavegacion(ruta) {
    const seccion = ruta.startsWith('/viajes/nuevo') ? '/viajes/nuevo'
      : ruta.startsWith('/viajes') ? '/viajes' : ruta;
    const enMas = ['/rutas', '/tarifas', '/respaldo', '/ajustes', '/mas'].includes(seccion);
    $$('[data-ruta]').forEach(a => {
      const r = a.dataset.ruta;
      const activo = r === seccion || (r === '/mas' && enMas && a.classList.contains('nav-inf-enlace'));
      if (activo) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function parsearHash() {
    const bruto = decodeURI(location.hash.replace(/^#/, '')) || '/inicio';
    const [ruta, qs] = bruto.split('?');
    return { ruta: ruta || '/inicio', params: new URLSearchParams(qs || '') };
  }

  function navegar(hash) {
    if (location.hash === hash) renderizar();
    else location.hash = hash;
  }

  /**
   * Dibuja la vista de la ruta actual.
   * opciones.silencioso: refresco por datos nuevos (no mueve el scroll ni el foco).
   */
  async function renderizar(opciones = {}) {
    const token = ++S.renderToken;
    const urlsVista = [];
    S.urlsColeccion = urlsVista;
    const { ruta, params } = parsearHash();
    const sinSesion = !Nube.sesion();
    document.body.classList.toggle('sin-sesion', sinSesion);
    if (sinSesion || Nube.datos().revision < 0) {
      document.body.classList.remove('en-formulario');
      const v = sinSesion ? vistaLogin() : vistaCargando();
      reemplazar($('#contenido'), v.nodo);
      mostrarUrls(urlsVista);
      document.title = `${v.titulo} · ${S.cfg.nombreApp || NOMBRE_POR_DEFECTO}`;
      return;
    }
    // Guarda el borrador pendiente antes de salir del formulario.
    if (S.form && !/^\/viajes\/(nuevo|[^/]+\/(editar|duplicar))$/.test(ruta)) {
      await salirDelFormulario();
    }
    const scrollPrevio = window.scrollY;
    let vista;
    try {
      let m;
      if (ruta === '/inicio' || ruta === '/') vista = await vistaInicio();
      else if (ruta === '/viajes') vista = await vistaViajes(params);
      else if (ruta === '/viajes/nuevo') vista = await vistaFormularioViaje('nuevo');
      else if ((m = /^\/viajes\/([^/]+)\/editar$/.exec(ruta))) vista = await vistaFormularioViaje('editar', m[1]);
      else if ((m = /^\/viajes\/([^/]+)\/duplicar$/.exec(ruta))) vista = await vistaFormularioViaje('duplicar', m[1]);
      else if ((m = /^\/viajes\/([^/]+)$/.exec(ruta))) vista = await vistaDetalleViaje(m[1]);
      else if (ruta === '/rutas') vista = vistaRutas();
      else if (ruta === '/tarifas') vista = vistaTarifas();
      else if (ruta === '/informes') vista = vistaInformes();
      else if (ruta === '/respaldo') vista = vistaRespaldo();
      else if (ruta === '/ajustes') vista = await vistaAjustes();
      else if (ruta === '/mas') vista = vistaMas();
      else vista = vistaNoEncontrada();
    } catch (err) {
      console.error(err);
      vista = { titulo: 'Error', nodo: h('div', { class: 'tarjeta' }, h('h1', { class: 'vista-titulo', tabindex: '-1' }, 'Algo falló'), h('p', null, err.message || String(err))) };
    }
    if (token !== S.renderToken) return; // hubo otra navegación mientras cargaba
    if (vista && vista.redirigir) { liberarUrls(urlsVista); location.replace(vista.redirigir); return; }
    const main = $('#contenido');
    reemplazar(main, vista.nodo);
    mostrarUrls(urlsVista);
    document.title = `${vista.titulo} · ${S.cfg.nombreApp || NOMBRE_POR_DEFECTO}`;
    document.body.classList.toggle('en-formulario', !!vista.formulario);
    marcarNavegacion(ruta);
    S.refrescoPendiente = false;
    if (opciones.silencioso) {
      window.scrollTo(0, scrollPrevio);
      return;
    }
    window.scrollTo(0, 0);
    const titulo = $('h1', main);
    if (titulo && renderizar.yaInicio) titulo.focus({ preventScroll: true });
    renderizar.yaInicio = true;
  }

  /** Refresca la vista por datos nuevos sin interrumpir a quien está escribiendo. */
  function refrescarSiCorresponde() {
    const activo = document.activeElement;
    const escribiendo = activo && $('#contenido').contains(activo) && /^(INPUT|SELECT|TEXTAREA)$/.test(activo.tagName);
    if (S.form || document.querySelector('dialog[open]') || escribiendo || !Nube.sesion()) {
      S.refrescoPendiente = true;
      return;
    }
    renderizar({ silencioso: true });
  }

  function cabeceraVista(titulo, { subtitulo, acciones, volver } = {}) {
    return h('div', { class: 'vista-cabecera' },
      h('div', { class: 'vista-cabecera-texto' },
        volver ? h('a', { class: 'enlace-volver', href: volver.href }, icono('izquierda'), h('span', null, volver.texto)) : null,
        h('h1', { class: 'vista-titulo', tabindex: '-1' }, titulo),
        subtitulo ? h('p', { class: 'vista-subtitulo' }, subtitulo) : null),
      acciones ? h('div', { class: 'vista-acciones' }, acciones) : null);
  }

  function estadoVacio({ titulo, texto, accion }) {
    return h('div', { class: 'vacio' },
      h('div', { class: 'vacio-icono', 'aria-hidden': 'true' }, icono('viajes')),
      h('h2', null, titulo),
      texto ? h('p', null, texto) : null,
      accion || null);
  }

  function vistaNoEncontrada(que) {
    return {
      titulo: 'No encontrado',
      nodo: h('div', null,
        cabeceraVista(que === 'viaje' ? 'Viaje no encontrado' : 'Página no encontrada'),
        estadoVacio({
          titulo: que === 'viaje' ? 'Este viaje no existe o fue eliminado.' : 'La dirección no corresponde a ninguna sección.',
          accion: enlaceBoton({ texto: 'Ir al inicio', href: '#/inicio', clase: 'btn btn-primario' })
        }))
    };
  }

  /** Avisos persistentes: demostración, cambios pendientes, actualización, sin conexión. */
  function actualizarAvisosGlobales() {
    const cont = $('#avisos-globales');
    if (!cont) return;
    const avisos = [];
    if (!Nube.sesion()) { vaciar(cont); return; }
    const demo = cantidadDemo();
    if (demo.viajes || demo.rutas) {
      avisos.push(h('div', { class: 'aviso aviso-demo' },
        icono('info'),
        h('p', null, h('strong', null, 'Datos de demostración activos. '),
          `${demo.viajes} viaje(s) y ${demo.rutas} ruta(s) de ejemplo están incluidos en los totales.`),
        esAdmin() ? h('button', { type: 'button', class: 'btn btn-pequeno', onclick: eliminarDemoConConfirmacion }, 'Eliminar demostración') : null));
    }
    const cola = Nube.estadoCola();
    if (cola.conflictos || cola.errores) {
      avisos.push(h('div', { class: 'aviso aviso-error' },
        icono('alerta'),
        h('p', null, h('strong', null, `${cola.conflictos + cola.errores} cambio(s) necesitan tu revisión. `),
          cola.conflictos ? 'Otro usuario modificó un viaje que editaste.' : 'El servidor rechazó un envío.'),
        h('button', { type: 'button', class: 'btn btn-pequeno btn-secundario', onclick: abrirDialogoSync }, 'Revisar')));
    } else if (cola.total) {
      avisos.push(h('div', { class: 'aviso aviso-pendiente' },
        icono('subir'),
        h('p', null, h('strong', null, `${cola.total} cambio(s) pendientes de envío. `),
          navigator.onLine ? 'Se están enviando.' : 'Se enviarán solos cuando vuelva la señal.'),
        h('button', { type: 'button', class: 'btn btn-pequeno btn-secundario', onclick: abrirDialogoSync }, 'Ver')));
    }
    if (S.sw.esperando) {
      avisos.push(h('div', { class: 'aviso aviso-actualizacion' },
        icono('recargar'),
        h('p', null, h('strong', null, 'Hay una nueva versión disponible. '), 'Tus datos se mantienen.'),
        h('button', { type: 'button', class: 'btn btn-pequeno btn-primario', onclick: aplicarActualizacion }, 'Actualizar ahora')));
    }
    if (!navigator.onLine) {
      avisos.push(h('div', { class: 'aviso aviso-offline' },
        icono('alerta'),
        h('p', null, h('strong', null, 'Sin conexión. '), 'Puedes consultar y registrar viajes; se guardan en este teléfono y se envían al volver la señal.')));
    }
    reemplazar(cont, avisos);
  }

  /** Indicador compacto del estado de sincronización (barra lateral y superior). */
  function actualizarIndicadorSync() {
    const cola = Nube.estadoCola();
    const sync = Nube.estadoSync();
    let estado = 'ok';
    let texto = 'Sincronizado';
    if (!Nube.sesion()) { estado = 'off'; texto = 'Sin sesión'; }
    else if (cola.conflictos || cola.errores) { estado = 'error'; texto = `${cola.conflictos + cola.errores} por revisar`; }
    else if (!navigator.onLine) { estado = 'off'; texto = cola.total ? `Sin señal · ${cola.total} pendiente(s)` : 'Sin conexión'; }
    else if (cola.total) { estado = 'pendiente'; texto = `${cola.total} pendiente(s)`; }
    else if (sync.sincronizando) { estado = 'pendiente'; texto = 'Sincronizando…'; }
    else if (sync.error && sync.error.red) { estado = 'off'; texto = 'Sin conexión con el servidor'; }
    $$('.indicador-sync').forEach(b => {
      b.dataset.estado = estado;
      b.setAttribute('aria-label', `Estado de sincronización: ${texto}. Ver detalle`);
      reemplazar(b, h('span', { class: 'sync-punto', 'aria-hidden': 'true' }), h('span', { class: 'sync-texto' }, texto));
    });
  }

  /** Detalle de sincronización: última descarga, cambios pendientes y conflictos. */
  function abrirDialogoSync() {
    abrirDialogo((dlg, cerrar, idTitulo) => {
      const cuerpo = h('div', { class: 'dialogo-cuerpo' });
      const pintar = () => {
        const cola = Nube.estadoCola();
        const sync = Nube.estadoSync();
        const describir = it => {
          if (it.tipo === 'viaje') {
            const v = it.datos.viaje;
            return `${it.datos.versionBase === null ? 'Viaje nuevo' : 'Cambios en'} ${v.codigo || ''} · ${v.sitio || 'sin sitio'} (${fechaCorta(v.fecha)})`;
          }
          if (it.tipo === 'adjunto') return `Foto de ${CATEGORIAS[it.datos.adjunto.categoria] ? CATEGORIAS[it.datos.adjunto.categoria].toLowerCase() : 'viaje'}`;
          return 'Eliminar una foto';
        };
        reemplazar(cuerpo,
          h('h2', { id: idTitulo, class: 'dialogo-titulo' }, 'Sincronización'),
          h('dl', { class: 'datos datos-compactos' },
            h('div', { class: 'dato' }, h('dt', null, 'Conexión'), h('dd', null, navigator.onLine ? 'En línea' : 'Sin conexión')),
            h('div', { class: 'dato' }, h('dt', null, 'Última actualización'), h('dd', null, sync.ultima ? fechaHora(sync.ultima) : 'Nunca')),
            h('div', { class: 'dato' }, h('dt', null, 'Usuario'), h('dd', null, `${Nube.sesion().usuario.nombre} (${ETQ.rol[Nube.sesion().usuario.rol] || Nube.sesion().usuario.rol})`))),
          sync.error && !sync.error.red ? h('p', { class: 'error' }, sync.error.message) : null,
          cola.items.length
            ? h('ul', { class: 'lista-cola' }, cola.items.map(it => h('li', { class: `cola-item cola-${it.estado}` },
              h('div', { class: 'cola-texto' },
                h('strong', null, describir(it)),
                h('span', { class: 'texto-suave' }, it.estado === 'pendiente' ? 'Pendiente de envío' : it.estado === 'conflicto' ? 'Conflicto: otro usuario lo modificó' : `Error: ${it.mensaje}`)),
              h('div', { class: 'cola-acciones' },
                it.estado === 'conflicto' ? boton({ texto: 'Resolver', clase: 'btn btn-pequeno btn-primario', onClick: async () => { cerrar(); await resolverConflictoUI(it.id); } }) : null,
                it.estado === 'error' ? boton({ texto: 'Reintentar', clase: 'btn btn-pequeno btn-secundario', onClick: async () => { await Nube.reintentar(it.id); pintar(); } }) : null,
                boton({ texto: 'Descartar', clase: 'btn btn-pequeno btn-peligro-suave', onClick: async () => {
                  const ok = await confirmar({ titulo: 'Descartar cambio', mensaje: 'Este cambio no se enviará y se perderá.', textoConfirmar: 'Descartar', peligro: true });
                  if (!ok) return;
                  await Nube.descartar(it.id);
                  construirEstado();
                  pintar();
                  refrescarSiCorresponde();
                } })))))
            : h('p', { class: 'texto-suave' }, 'No hay cambios pendientes en este dispositivo.'));
      };
      pintar();
      agregar(dlg, cuerpo, h('div', { class: 'dialogo-acciones' },
        boton({ texto: 'Actualizar ahora', icono: 'recargar', clase: 'btn btn-secundario', onClick: async () => {
          try {
            await Nube.procesarCola();
            await Nube.sincronizar();
            construirEstado();
            pintar();
            refrescarSiCorresponde();
            toast('Datos actualizados.');
          } catch (err) { toast(mensajeError(err, 'No se pudo actualizar'), 'error'); pintar(); }
        } }),
        h('button', { type: 'button', class: 'btn btn-primario', onclick: () => cerrar(), 'data-foco-inicial': true }, 'Cerrar')));
    });
  }

  /** Muestra las dos versiones de un conflicto y aplica la elección. */
  async function resolverConflictoUI(itemId) {
    const it = Nube.estadoCola().items.find(x => x.id === itemId);
    if (!it) return;
    const actual = it.actual;
    const mio = it.datos.viaje;
    const cMio = C.calcularViaje(C.normalizarViaje(mio));
    const cSuyo = actual ? C.calcularViaje(C.normalizarViaje(actual)) : null;
    const eleccion = await abrirDialogo((dlg, cerrar, idTitulo) => {
      agregar(dlg,
        h('div', { class: 'dialogo-cuerpo' },
          h('h2', { id: idTitulo, class: 'dialogo-titulo' }, 'Otro usuario modificó este viaje'),
          h('p', null, actual
            ? `${nombreUsuario(actual.actualizadoPor)} lo cambió el ${fechaHora(actual.actualizado)}, mientras tú lo editabas. Elige qué versión conservar.`
            : it.mensaje),
          actual ? h('table', { class: 'tabla tabla-conflicto' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Dato'), h('th', { scope: 'col' }, 'Tu versión'), h('th', { scope: 'col' }, `Versión de ${nombreUsuario(actual.actualizadoPor)}`))),
            h('tbody', null,
              [['Fecha', fechaCorta(mio.fecha), fechaCorta(actual.fecha)], ['Estado', ETQ.estado[mio.estado], ETQ.estado[actual.estado]],
                ['Sitio', mio.sitio, actual.sitio], ['Km', numero(mio.km), numero(actual.km)],
                ['Ingreso neto', clp(cMio.ingresoNeto), clp(cSuyo.ingresoNeto)], ['Costos directos', clp(cMio.costosDirectos), clp(cSuyo.costosDirectos)],
                ['Margen bruto', clp(cMio.margenBruto), clp(cSuyo.margenBruto)]]
                .map(([d, a, b]) => h('tr', { class: a !== b ? 'difiere' : null }, h('th', { scope: 'row' }, d), h('td', null, a || '—'), h('td', null, b || '—'))))) : null),
        h('div', { class: 'dialogo-acciones' },
          h('button', { type: 'button', class: 'btn btn-secundario', onclick: () => cerrar('suyo'), 'data-foco-inicial': true }, 'Descartar mis cambios'),
          h('button', { type: 'button', class: 'btn btn-primario', onclick: () => cerrar('mio') }, 'Guardar mi versión')));
    }, { clase: 'dialogo-ancho' });
    if (eleccion !== 'mio' && eleccion !== 'suyo') return;
    await Nube.resolverConflicto(itemId, eleccion);
    construirEstado();
    toast(eleccion === 'mio' ? 'Se guardó tu versión.' : 'Se descartaron tus cambios.');
    renderizar();
  }

  function aplicarIdentidad() {
    const nombre = S.cfg.nombreApp || NOMBRE_POR_DEFECTO;
    $$('[data-nombre-app]').forEach(el => { el.textContent = nombre; });
  }

  function aplicarTema(tema) {
    const t = ['auto', 'claro', 'oscuro'].includes(tema) ? tema : 'auto';
    document.documentElement.dataset.tema = t;
    const oscuro = t === 'oscuro' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', oscuro ? '#111418' : '#f3f4f1');
  }

  /* =======================================================================
     Filtros y períodos compartidos
     ======================================================================= */
  function rangoDePeriodo(p) {
    if (p.modo === 'mes') {
      const [a, m] = p.mes.split('-').map(Number);
      return { desde: `${p.mes}-01`, hasta: `${p.mes}-${pad(new Date(a, m, 0).getDate())}` };
    }
    if (p.modo === 'anio') return { desde: `${p.anio}-01-01`, hasta: `${p.anio}-12-31` };
    if (p.modo === 'rango') return { desde: p.desde || '', hasta: p.hasta || '' };
    return { desde: '', hasta: '' };
  }

  function etiquetaPeriodo(p) {
    if (p.modo === 'mes') return nombreMes(p.mes);
    if (p.modo === 'anio') return `Año ${p.anio}`;
    if (p.modo === 'rango') {
      if (p.desde && p.hasta) return `${fechaCorta(p.desde)} al ${fechaCorta(p.hasta)}`;
      if (p.desde) return `Desde ${fechaCorta(p.desde)}`;
      if (p.hasta) return `Hasta ${fechaCorta(p.hasta)}`;
    }
    return 'Todos los registros';
  }

  const enRango = (v, r) => (!r.desde || v.fecha >= r.desde) && (!r.hasta || v.fecha <= r.hasta);

  /**
   * Selector de período sin re-render (mantiene el foco).
   * modos: subconjunto de ['mes','anio','rango','todo'].
   */
  function selectorPeriodo(periodo, modos, alCambiar) {
    const p = Object.assign({}, periodo);
    const pref = uid('per');
    const nombres = { mes: 'Mes', anio: 'Año', rango: 'Rango', todo: 'Todo' };
    const salidaMes = h('output', { class: 'paso-valor', 'aria-live': 'polite' }, nombreMes(p.mes));
    const salidaAnio = h('output', { class: 'paso-valor', 'aria-live': 'polite' }, String(p.anio));
    const inDesde = h('input', { type: 'date', id: `${pref}-desde`, value: p.desde || '' });
    const inHasta = h('input', { type: 'date', id: `${pref}-hasta`, value: p.hasta || '' });
    const errRango = h('p', { class: 'error', id: `${pref}-error`, hidden: true });
    inDesde.setAttribute('aria-describedby', errRango.id);
    inHasta.setAttribute('aria-describedby', errRango.id);

    const paneles = {
      mes: h('div', { class: 'paso' },
        boton({ texto: 'Mes anterior', icono: 'izquierda', soloIcono: true, clase: 'btn btn-secundario', onClick: () => { p.mes = moverMes(p.mes, -1); salidaMes.textContent = nombreMes(p.mes); emitir(); } }),
        salidaMes,
        boton({ texto: 'Mes siguiente', icono: 'derecha', soloIcono: true, clase: 'btn btn-secundario', onClick: () => { p.mes = moverMes(p.mes, 1); salidaMes.textContent = nombreMes(p.mes); emitir(); } })),
      anio: h('div', { class: 'paso' },
        boton({ texto: 'Año anterior', icono: 'izquierda', soloIcono: true, clase: 'btn btn-secundario', onClick: () => { p.anio -= 1; salidaAnio.textContent = String(p.anio); emitir(); } }),
        salidaAnio,
        boton({ texto: 'Año siguiente', icono: 'derecha', soloIcono: true, clase: 'btn btn-secundario', onClick: () => { p.anio += 1; salidaAnio.textContent = String(p.anio); emitir(); } })),
      rango: h('div', { class: 'rango' },
        h('div', { class: 'campo campo-compacto' }, h('label', { for: inDesde.id }, 'Desde'), inDesde),
        h('div', { class: 'campo campo-compacto' }, h('label', { for: inHasta.id }, 'Hasta'), inHasta),
        errRango),
      todo: h('p', { class: 'texto-suave periodo-todo' }, 'Se consideran todos los viajes registrados.')
    };
    const cambiarRango = () => {
      const d = inDesde.value;
      const hs = inHasta.value;
      if (d && hs && d > hs) {
        errRango.textContent = 'La fecha "desde" debe ser anterior o igual a "hasta".';
        errRango.hidden = false;
        return;
      }
      errRango.hidden = true;
      p.desde = d;
      p.hasta = hs;
      emitir();
    };
    inDesde.addEventListener('change', cambiarRango);
    inHasta.addEventListener('change', cambiarRango);

    const botones = modos.map(m => h('button', {
      type: 'button', class: 'segmento', 'aria-pressed': String(p.modo === m),
      onclick: () => {
        p.modo = m;
        if (m === 'rango' && !p.desde && !p.hasta) {
          const r = rangoDePeriodo({ modo: 'mes', mes: p.mes });
          p.desde = r.desde; p.hasta = r.hasta; inDesde.value = r.desde; inHasta.value = r.hasta;
        }
        mostrar();
        emitir();
      }
    }, nombres[m]));

    function mostrar() {
      botones.forEach((b, i) => b.setAttribute('aria-pressed', String(modos[i] === p.modo)));
      Object.entries(paneles).forEach(([k, el]) => { el.hidden = k !== p.modo; });
    }
    function emitir() { alCambiar(Object.assign({}, p)); }
    mostrar();
    return h('div', { class: 'periodo', role: 'group', 'aria-label': 'Período' },
      h('div', { class: 'segmentos', role: 'group', 'aria-label': 'Tipo de período' }, botones),
      modos.map(m => paneles[m]));
  }

  function periodoInicial(modo) {
    return { modo, mes: mesActual(), anio: new Date().getFullYear(), desde: '', hasta: '' };
  }

  /** Construye el enlace a la lista de viajes con filtros (trazabilidad de KPIs). */
  function enlaceViajes(filtros) {
    const qs = new URLSearchParams();
    Object.entries(filtros).forEach(([k, v]) => { if (v) qs.set(k, v); });
    const s = qs.toString();
    return `#/viajes${s ? `?${s}` : ''}`;
  }

  /* =======================================================================
     8a. Componentes compartidos de viajes
     ======================================================================= */
  const tono = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutro');

  function kpi({ etiqueta, valor, sub, href, tono: t }) {
    return h('a', { class: `kpi ${t ? `kpi-${t}` : ''}`, href },
      h('span', { class: 'kpi-etiqueta' }, etiqueta),
      h('span', { class: 'kpi-valor' }, valor),
      sub ? h('span', { class: 'kpi-sub' }, sub) : null,
      h('span', { class: 'kpi-ir' }, 'Ver viajes', icono('derecha')));
  }

  function compararFecha(a, b) {
    return a.fecha.localeCompare(b.fecha) || String(a.creado).localeCompare(String(b.creado));
  }

  function ordenarViajes(lista, orden) {
    const calc = new Map(lista.map(v => [v.id, C.calcularViaje(v)]));
    const copia = lista.slice();
    const por = {
      'fecha-asc': (a, b) => compararFecha(a, b),
      'margen-desc': (a, b) => calc.get(b.id).margenBruto - calc.get(a.id).margenBruto,
      'margen-asc': (a, b) => calc.get(a.id).margenBruto - calc.get(b.id).margenBruto,
      'ingreso-desc': (a, b) => calc.get(b.id).ingresoNeto - calc.get(a.id).ingresoNeto,
      'codigo-asc': (a, b) => a.codigo.localeCompare(b.codigo, 'es', { numeric: true }),
      'fecha-desc': (a, b) => compararFecha(b, a)
    };
    return copia.sort(por[orden] || por['fecha-desc']);
  }

  function alertasDeViaje(v, c) {
    const lista = [];
    if (v._pendiente === 'pendiente') lista.push(insignia('Pendiente de envío', 'pendiente'));
    if (v._pendiente === 'conflicto') lista.push(insignia('Conflicto de edición', 'error'));
    if (v._pendiente === 'error') lista.push(insignia('Error de envío', 'error'));
    if (v.demo) lista.push(insignia('Demo', 'demo'));
    if (v.estado !== 'cancelado' && !v.netoConfirmado) lista.push(insignia('IVA por confirmar', 'aviso'));
    if (v.estado !== 'cancelado' && c.peajesEsEstimado) lista.push(insignia('Peaje estimado', 'info'));
    return lista;
  }

  function filaViaje(v) {
    const c = C.calcularViaje(v);
    const cancelado = v.estado === 'cancelado';
    const adj = S.adj.porViaje.get(v.id);
    const nFotos = adj ? adj.guia + adj.entrega : 0;
    return h('li', null, h('a', { class: `fila-viaje estado-${v.estado}`, href: `#/viajes/${encodeURIComponent(v.id)}` },
      h('div', { class: 'fv-principal' },
        h('div', { class: 'fv-meta' },
          h('span', { class: 'fv-codigo' }, v.codigo || 'Código por asignar'),
          h('span', null, fechaCorta(v.fecha)),
          insigniaEstado(v.estado)),
        h('div', { class: 'fv-titulo' }, v.sitio || 'Sin sitio'),
        h('div', { class: 'fv-sub' }, [v.localidad, v.cliente, v.camionNombre, ETQ.modalidad[v.modalidad],
          nFotos ? `${nFotos} foto(s)` : null].filter(Boolean).join(' · ')),
        h('div', { class: 'fv-alertas' }, alertasDeViaje(v, c))),
      h('div', { class: `fv-montos ${cancelado ? 'no-suma' : ''}` },
        h('div', { class: 'fv-monto' }, h('span', { class: 'fv-etq' }, 'Ingreso neto'), h('span', { class: 'fv-valor' }, clp(c.ingresoNeto))),
        h('div', { class: 'fv-monto' }, h('span', { class: 'fv-etq' }, cancelado ? 'No suma (cancelado)' : `Margen ${pct(c.margenPct)}`),
          h('span', { class: `fv-valor ${cancelado ? '' : tono(c.margenBruto)}` }, clp(c.margenBruto))))));
  }

  /** Desglose de ingreso, IVA, costos y margen. Usado por detalle, formulario e informe. */
  function desglose(v, c) {
    const fila = (etq, valor, opciones = {}) => h('tr', { class: opciones.clase || null },
      h('th', { scope: 'row' }, etq, opciones.nota ? h('span', { class: 'desglose-nota' }, opciones.nota) : null),
      h('td', null, valor));
    const baseTexto = v.formaCobro === 'fija'
      ? 'Tarifa fija'
      : `${numero(v.km)} km × ${clp(v.tarifa)}`;
    const filas = [
      h('tr', { class: 'desglose-seccion' }, h('th', { scope: 'rowgroup', colspan: 2 }, 'Ingreso')),
      fila('Ingreso base', clp(c.ingresoBase), { nota: baseTexto })
    ];
    (v.cobrosAdicionales || []).forEach(g => filas.push(fila(g.concepto || 'Cobro adicional', clp(g.monto), { nota: 'Cobro adicional' })));
    filas.push(fila('Ingreso neto', clp(c.ingresoNeto), { clase: 'desglose-total' }));
    if (c.aplicaIva) {
      filas.push(fila(`IVA (${numero(c.ivaPct)} %)`, clp(c.iva), { nota: 'Se cobra aparte; no es ingreso ni margen', clase: 'desglose-iva' }));
      filas.push(fila('Total a cobrar con IVA', clp(c.totalConIva), { clase: 'desglose-iva' }));
    } else {
      filas.push(fila('IVA', 'No aplicado', { clase: 'desglose-iva' }));
    }
    filas.push(h('tr', { class: 'desglose-seccion' }, h('th', { scope: 'rowgroup', colspan: 2 }, 'Costos directos')));
    const notaPeaje = c.peajesFuente === 'real' ? 'Monto real'
      : c.peajesFuente === 'estimado' ? 'ESTIMADO: falta el monto real' : 'Sin peajes';
    filas.push(fila('Peajes', clp(c.peajes), { nota: notaPeaje, clase: c.peajesEsEstimado ? 'desglose-estimado' : null }));
    filas.push(fila('Combustible', clp(c.combustible)));
    filas.push(fila('Comida', clp(c.comida)));
    if (v.modalidad === 'tercerizado') {
      const t = v.transportista || {};
      filas.push(fila('Transportista tercero', clp(c.costoTransportista), {
        nota: t.modo === 'fijo' ? 'Monto fijo' : `${numero(v.km)} km × ${clp(t.tarifaKm)}`
      }));
    }
    const ch = v.chofer || {};
    if (ch.modo === 'km' || ch.modo === 'fijo') {
      filas.push(fila('Pago al chofer', clp(c.costoChofer), {
        nota: ch.modo === 'fijo' ? 'Monto fijo' : `${numero(v.km)} km × ${clp(ch.tarifaKm)}`
      }));
    }
    (v.otrosGastos || []).forEach(g => filas.push(fila(g.concepto || 'Otro gasto', clp(g.monto), { nota: 'Otro gasto directo' })));
    filas.push(fila('Costos directos', clp(c.costosDirectos), { clase: 'desglose-total' }));
    filas.push(h('tr', { class: 'desglose-seccion' }, h('th', { scope: 'rowgroup', colspan: 2 }, 'Resultado')));
    filas.push(fila('Margen bruto', clp(c.margenBruto), { clase: `desglose-margen ${tono(c.margenBruto)}` }));
    filas.push(fila('Margen porcentual', c.margenPct === null ? 'Sin ingreso' : pct(c.margenPct), { clase: `desglose-margen ${tono(c.margenBruto)}` }));
    return h('table', { class: 'desglose' },
      h('caption', { class: 'visualmente-oculto' }, 'Desglose de ingreso, costos y margen'),
      h('tbody', null, filas));
  }

  /* =======================================================================
     8b. Vista Inicio (dashboard)
     ======================================================================= */
  async function vistaInicio() {
    if (!S.periodoInicio) S.periodoInicio = periodoInicial('mes');
    const resultados = h('div', { class: 'inicio-resultados' });
    const pintar = () => reemplazar(resultados, contenidoInicio(S.periodoInicio));
    pintar();
    const nodo = h('div', null,
      cabeceraVista('Inicio', {
        subtitulo: 'Resumen del período. Toca un indicador para ver los viajes que lo componen.',
        acciones: enlaceBoton({ texto: 'Nuevo viaje', href: '#/viajes/nuevo', icono: 'nuevo', clase: 'btn btn-primario' })
      }),
      h('section', { class: 'barra-periodo', 'aria-label': 'Período del resumen' },
        selectorPeriodo(S.periodoInicio, ['mes', 'rango'], p => { S.periodoInicio = p; pintar(); })),
      resultados);
    return { titulo: 'Inicio', nodo };
  }

  function contenidoInicio(p) {
    if (!S.viajes.length) {
      return estadoVacio({
        titulo: 'Aún no hay viajes registrados',
        texto: 'Registra el primer viaje para ver ingresos, costos y márgenes.',
        accion: enlaceBoton({ texto: 'Registrar viaje', href: '#/viajes/nuevo', icono: 'nuevo', clase: 'btn btn-primario' })
      });
    }
    const r = rangoDePeriodo(p);
    const lista = S.viajes.filter(v => enRango(v, r));
    const res = C.resumirPeriodo(lista);
    const R = res.realizados;
    const base = { desde: r.desde, hasta: r.hasta };
    const demoEnPeriodo = lista.filter(v => v.demo).length;
    const esMes = p.modo === 'mes';

    const kpis = h('div', { class: 'kpis' },
      kpi({
        etiqueta: 'Viajes realizados', valor: fmtEntero.format(R.viajes),
        sub: `${res.planificados.viajes} planificado(s) · ${res.cancelados} cancelado(s)`,
        href: enlaceViajes(Object.assign({}, base, { estado: 'realizado' }))
      }),
      kpi({
        etiqueta: 'Kilómetros realizados', valor: km(R.km),
        sub: 'Km cobrables de viajes realizados',
        href: enlaceViajes(Object.assign({}, base, { estado: 'realizado' }))
      }),
      kpi({
        etiqueta: 'Ingresos netos', valor: clp(R.ingresoNeto),
        sub: R.iva ? `IVA aparte: ${clp(R.iva)}` : 'Sin IVA aplicado',
        href: enlaceViajes(Object.assign({}, base, { estado: 'realizado', orden: 'ingreso-desc' }))
      }),
      kpi({
        etiqueta: 'Costos directos', valor: clp(R.costosDirectos),
        sub: R.conPeajeEstimado ? `${R.conPeajeEstimado} viaje(s) con peaje estimado` : 'Peajes, combustible, comida, transportista y otros',
        href: enlaceViajes(Object.assign({}, base, { estado: 'realizado' }))
      }),
      kpi({
        etiqueta: 'Margen bruto', valor: clp(R.margenBruto), tono: tono(R.margenBruto),
        sub: 'Ingreso neto − costos directos',
        href: enlaceViajes(Object.assign({}, base, { estado: 'realizado', orden: 'margen-desc' }))
      }),
      kpi({
        etiqueta: 'Margen porcentual', valor: pct(R.margenPct), tono: tono(R.margenBruto),
        sub: R.ingresoNeto ? 'Margen bruto sobre ingreso neto' : 'Sin ingresos en el período',
        href: enlaceViajes(Object.assign({}, base, { estado: 'realizado', orden: 'margen-asc' }))
      }),
      kpi({
        etiqueta: esMes ? 'Resultado estimado del mes' : 'Resultado estimado del período',
        valor: clp(res.resultadoEstimado), tono: tono(res.resultadoEstimado),
        sub: `Realizado ${clp(R.margenBruto)} + planificado ${clp(res.planificados.margenBruto)}`,
        href: enlaceViajes(Object.assign({}, base, { estado: 'activos' }))
      }),
      tarjetaDistribucion(res, base));

    const alertas = alertasInicio(lista, R, base);
    const recientes = S.viajes.slice().sort((a, b) => compararFecha(b, a)).slice(0, 5);

    return h('div', null,
      h('p', { class: 'periodo-etiqueta' }, h('strong', null, etiquetaPeriodo(p)),
        ` · ${lista.length} viaje(s) en el período`,
        demoEnPeriodo ? h('span', { class: 'texto-demo' }, ` · incluye ${demoEnPeriodo} de demostración`) : null),
      kpis,
      alertas,
      h('section', { class: 'tarjeta', 'aria-labelledby': 'titulo-recientes' },
        h('div', { class: 'tarjeta-cabecera' },
          h('h2', { id: 'titulo-recientes' }, 'Últimos viajes'),
          h('div', { class: 'tarjeta-acciones' },
            enlaceBoton({ texto: 'Ver todos', href: '#/viajes', clase: 'btn btn-secundario btn-pequeno' }),
            enlaceBoton({ texto: 'Nuevo viaje', href: '#/viajes/nuevo', icono: 'nuevo', clase: 'btn btn-primario btn-pequeno' }))),
        h('ul', { class: 'lista-viajes' }, recientes.map(filaViaje))));
  }

  function tarjetaDistribucion(res, base) {
    const P = res.porModalidad.propio;
    const T = res.porModalidad.tercerizado;
    const total = P.viajes + T.viajes;
    const cab = h('span', { class: 'kpi-etiqueta' }, 'Propios vs tercerizados');
    if (!total) {
      return h('div', { class: 'kpi kpi-ancho distribucion' }, cab,
        h('span', { class: 'kpi-sub' }, 'Sin viajes realizados en el período.'));
    }
    const pP = Math.round((P.viajes / total) * 100);
    const pT = 100 - pP;
    const segmento = (clase, porcentaje) => {
      const s = h('span', { class: `dist-seg ${clase}` });
      s.style.width = `${porcentaje}%`;
      return s;
    };
    const leyenda = (clase, etq, r, modalidad, porcentaje) => h('a', {
      class: 'dist-fila', href: enlaceViajes(Object.assign({}, base, { estado: 'realizado', modalidad }))
    },
      h('span', { class: `dist-punto ${clase}`, 'aria-hidden': 'true' }),
      h('span', { class: 'dist-nombre' }, etq),
      h('span', { class: 'dist-dato' }, `${r.viajes} viaje(s) · ${porcentaje} %`),
      h('span', { class: `dist-dato ${tono(r.margenBruto)}` }, `Margen ${clp(r.margenBruto)}`));
    return h('div', { class: 'kpi kpi-ancho distribucion' }, cab,
      h('div', {
        class: 'barra-distribucion', role: 'img',
        'aria-label': `Camión propio ${P.viajes} viaje(s), ${pP} %; tercerizado ${T.viajes} viaje(s), ${pT} %`
      }, segmento('propio', pP), segmento('tercerizado', pT)),
      h('div', { class: 'dist-leyenda' },
        leyenda('propio', 'Camión propio', P, 'propio', pP),
        leyenda('tercerizado', 'Tercerizado', T, 'tercerizado', pT)));
  }

  function alertasInicio(lista, R, base) {
    const items = [];
    const porConfirmar = lista.filter(v => v.estado !== 'cancelado' && !v.netoConfirmado).length;
    if (porConfirmar) {
      items.push({ texto: `${porConfirmar} viaje(s) con tarifa por confirmar: no se sabe si el monto incluye IVA.`, href: enlaceViajes(Object.assign({}, base, { revision: 'iva' })) });
    }
    if (R.conPeajeEstimado) {
      items.push({ texto: `${R.conPeajeEstimado} viaje(s) realizados usan peaje estimado. Ingresa el monto real cuando lo tengas.`, href: enlaceViajes(Object.assign({}, base, { estado: 'realizado', revision: 'peaje' })) });
    }
    const sinGuia = lista.filter(v => v.estado === 'realizado' && !((S.adj.porViaje.get(v.id) || {}).guia > 0)).length;
    if (sinGuia) {
      items.push({ texto: `${sinGuia} viaje(s) realizados sin foto de la guía de despacho firmada.`, href: enlaceViajes(Object.assign({}, base, { estado: 'realizado', revision: 'guia' })) });
    }
    const cola = Nube.estadoCola();
    if (cola.conflictos || cola.errores) {
      items.push({ texto: `${cola.conflictos + cola.errores} cambio(s) de este dispositivo necesitan tu revisión.`, href: '#/inicio', accion: abrirDialogoSync });
    }
    if (!items.length) return null;
    return h('section', { class: 'tarjeta alertas', 'aria-labelledby': 'titulo-revisar' },
      h('h2', { id: 'titulo-revisar' }, 'Para revisar'),
      h('ul', null, items.map(i => h('li', null, i.accion
        ? h('button', { type: 'button', class: 'alerta-boton', onclick: i.accion }, icono('alerta'), h('span', null, i.texto), icono('derecha'))
        : h('a', { href: i.href }, icono('alerta'), h('span', null, i.texto), icono('derecha'))))));
  }

  /* =======================================================================
     8c. Vista Viajes (listado con filtros)
     ======================================================================= */
  const CLAVES_FILTRO = ['q', 'desde', 'hasta', 'estado', 'camion', 'modalidad', 'cliente', 'localidad', 'sitio', 'revision', 'datos', 'orden'];

  function filtrarViajes(f) {
    const q = sinTildes(f.q || '').trim();
    return S.viajes.filter(v => {
      if (f.desde && v.fecha < f.desde) return false;
      if (f.hasta && v.fecha > f.hasta) return false;
      if (f.estado === 'activos') { if (v.estado === 'cancelado') return false; } else if (f.estado && v.estado !== f.estado) return false;
      if (f.camion && v.camionId !== f.camion) return false;
      if (f.modalidad && v.modalidad !== f.modalidad) return false;
      if (f.cliente && v.cliente !== f.cliente) return false;
      if (f.localidad && v.localidad !== f.localidad) return false;
      if (f.sitio && v.sitio !== f.sitio) return false;
      if (f.datos === 'reales' && v.demo) return false;
      if (f.datos === 'demo' && !v.demo) return false;
      if (f.revision === 'iva' && (v.netoConfirmado || v.estado === 'cancelado')) return false;
      if (f.revision === 'peaje' && !C.calcularViaje(v).peajesEsEstimado) return false;
      if (f.revision === 'guia' && ((S.adj.porViaje.get(v.id) || {}).guia > 0)) return false;
      if (q) {
        const texto = sinTildes([v.codigo, v.cliente, v.sitio, v.localidad, v.direccion, v.origen, v.destino,
          v.contacto, v.camionNombre, v.rutaNombre, v.descripcion, v.notas].join(' '));
        if (!texto.includes(q)) return false;
      }
      return true;
    });
  }

  function valoresDistintos(campo) {
    return Array.from(new Set(S.viajes.map(v => v[campo]).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'es'));
  }

  async function vistaViajes(params) {
    const f = {};
    CLAVES_FILTRO.forEach(k => { f[k] = params.get(k) || ''; });
    if (!f.orden) f.orden = 'fecha-desc';

    const totales = h('div', { class: 'totales-lista', 'aria-live': 'polite' });
    const listaCont = h('div', { class: 'lista-cont' });
    const contador = h('span', { class: 'insignia insignia-info filtros-contador' });

    const opcionesSelect = (pares, valor) => pares.map(([v, t]) => h('option', { value: v, selected: v === valor }, t));
    const sel = (id, etiqueta, clave, pares) => {
      const s = h('select', { id, name: clave, dataset: { filtro: clave } }, opcionesSelect(pares, f[clave]));
      s.value = f[clave];
      return h('div', { class: 'campo campo-compacto' }, h('label', { for: id }, etiqueta), s);
    };
    const fecha = (id, etiqueta, clave) => h('div', { class: 'campo campo-compacto' },
      h('label', { for: id }, etiqueta),
      h('input', { type: 'date', id, name: clave, value: f[clave], dataset: { filtro: clave } }));

    const hayDemo = S.viajes.some(v => v.demo);
    const camionesUsados = S.camiones.map(c => [c.id, c.nombre]);
    const panel = h('div', { class: 'filtros-rejilla' },
      fecha('fv-desde', 'Desde', 'desde'),
      fecha('fv-hasta', 'Hasta', 'hasta'),
      sel('fv-estado', 'Estado', 'estado', [['', 'Todos'], ['realizado', 'Realizado'], ['planificado', 'Planificado'], ['cancelado', 'Cancelado'], ['activos', 'Realizados y planificados']]),
      sel('fv-camion', 'Tipo de camión', 'camion', [['', 'Todos']].concat(camionesUsados)),
      sel('fv-modalidad', 'Modalidad', 'modalidad', [['', 'Todas'], ['propio', 'Camión propio'], ['tercerizado', 'Tercerizado']]),
      sel('fv-cliente', 'Cliente', 'cliente', [['', 'Todos']].concat(valoresDistintos('cliente').map(x => [x, x]))),
      sel('fv-localidad', 'Localidad', 'localidad', [['', 'Todas']].concat(valoresDistintos('localidad').map(x => [x, x]))),
      sel('fv-sitio', 'Sitio u obra', 'sitio', [['', 'Todos']].concat(valoresDistintos('sitio').map(x => [x, x]))),
      sel('fv-revision', 'Pendientes de revisión', 'revision', [['', 'Sin filtro'], ['iva', 'Tarifa con IVA por confirmar'], ['peaje', 'Peaje estimado (sin real)'], ['guia', 'Sin foto de guía firmada']]),
      hayDemo ? sel('fv-datos', 'Origen de los datos', 'datos', [['', 'Todos'], ['reales', 'Solo reales'], ['demo', 'Solo demostración']]) : null,
      h('div', { class: 'filtros-acciones' },
        h('button', { type: 'button', class: 'btn btn-secundario', onclick: limpiar }, 'Limpiar filtros')));

    const activos = () => CLAVES_FILTRO.filter(k => k !== 'q' && k !== 'orden' && f[k]).length;
    const detalles = h('details', { class: 'filtros', open: activos() > 0 ? true : null },
      h('summary', null, icono('filtro'), h('span', null, 'Filtros'), contador),
      panel);

    const buscar = h('input', {
      type: 'search', id: 'fv-buscar', name: 'q', value: f.q, placeholder: 'Código, sitio, localidad, cliente…',
      autocomplete: 'off', dataset: { filtro: 'q' }
    });
    const orden = h('select', { id: 'fv-orden', name: 'orden', dataset: { filtro: 'orden' } },
      opcionesSelect([['fecha-desc', 'Fecha: más recientes'], ['fecha-asc', 'Fecha: más antiguos'], ['margen-desc', 'Mayor margen'],
        ['margen-asc', 'Menor margen'], ['ingreso-desc', 'Mayor ingreso'], ['codigo-asc', 'Código']], f.orden));
    orden.value = f.orden;

    function aplicar() {
      history.replaceState(null, '', enlaceViajes(f));
      const n = activos();
      contador.textContent = n ? String(n) : '';
      contador.hidden = !n;
      const filtrados = ordenarViajes(filtrarViajes(f), f.orden);
      const res = C.resumirPeriodo(filtrados);
      const R = res.realizados;
      reemplazar(totales,
        h('p', { class: 'totales-cuenta' }, h('strong', null, `${filtrados.length} viaje(s)`),
          ` · ${R.viajes} realizado(s) · ${res.planificados.viajes} planificado(s) · ${res.cancelados} cancelado(s)`),
        h('dl', { class: 'totales-montos' },
          h('div', null, h('dt', null, 'Ingreso neto'), h('dd', null, clp(R.ingresoNeto))),
          h('div', null, h('dt', null, 'Costos directos'), h('dd', null, clp(R.costosDirectos))),
          h('div', null, h('dt', null, 'Margen bruto'), h('dd', { class: tono(R.margenBruto) }, `${clp(R.margenBruto)} · ${pct(R.margenPct)}`)),
          h('div', null, h('dt', null, 'Km'), h('dd', null, km(R.km)))),
        h('p', { class: 'texto-suave totales-nota' }, 'Los montos consideran solo viajes realizados, con la misma regla del inicio.'));
      if (!S.viajes.length) {
        reemplazar(listaCont, estadoVacio({
          titulo: 'Aún no hay viajes', texto: 'Registra el primero; puedes corregir los valores sugeridos.',
          accion: enlaceBoton({ texto: 'Registrar viaje', href: '#/viajes/nuevo', icono: 'nuevo', clase: 'btn btn-primario' })
        }));
      } else if (!filtrados.length) {
        reemplazar(listaCont, estadoVacio({
          titulo: 'No hay viajes con estos filtros',
          accion: h('button', { type: 'button', class: 'btn btn-secundario', onclick: limpiar }, 'Limpiar filtros')
        }));
      } else {
        reemplazar(listaCont, h('ul', { class: 'lista-viajes' }, filtrados.map(filaViaje)));
      }
    }

    function limpiar() {
      CLAVES_FILTRO.forEach(k => { if (k !== 'orden') f[k] = ''; });
      $$('[data-filtro]', nodo).forEach(el => { if (el.dataset.filtro !== 'orden') el.value = ''; });
      aplicar();
    }

    const aplicarDiferido = debounce(aplicar, 160);
    const nodo = h('div', null,
      cabeceraVista('Viajes', {
        acciones: enlaceBoton({ texto: 'Nuevo viaje', href: '#/viajes/nuevo', icono: 'nuevo', clase: 'btn btn-primario' })
      }),
      h('div', { class: 'barra-herramientas' },
        h('div', { class: 'campo campo-buscar' },
          h('label', { for: 'fv-buscar', class: 'visualmente-oculto' }, 'Buscar viajes'),
          h('div', { class: 'entrada-compuesta' }, h('span', { class: 'prefijo', 'aria-hidden': 'true' }, icono('buscar')), buscar)),
        h('div', { class: 'campo campo-compacto campo-orden' }, h('label', { for: 'fv-orden' }, 'Ordenar'), orden)),
      detalles,
      totales,
      listaCont);

    nodo.addEventListener('input', ev => {
      const clave = ev.target.dataset && ev.target.dataset.filtro;
      if (clave === 'q') { f.q = ev.target.value; aplicarDiferido(); }
    });
    nodo.addEventListener('change', ev => {
      const clave = ev.target.dataset && ev.target.dataset.filtro;
      if (!clave || clave === 'q') return;
      if ((clave === 'desde' || clave === 'hasta') && ev.target.value && !C.esFechaValida(ev.target.value)) return;
      f[clave] = ev.target.value;
      aplicar();
    });
    aplicar();
    return { titulo: 'Viajes', nodo };
  }

  /* =======================================================================
     8d. Vista Detalle de viaje (informe por viaje)
     ======================================================================= */
  async function vistaDetalleViaje(idCodificado) {
    const id = decodeURIComponent(idCodificado);
    const v = S.viajes.find(x => x.id === id);
    if (!v) return vistaNoEncontrada('viaje');
    const c = C.calcularViaje(v);
    const adjuntos = await adjuntosDeViaje(id);
    const codigo = v.codigo || 'Viaje por enviar';

    const dato = (etq, valor) => (valor || valor === 0) ? h('div', { class: 'dato' }, h('dt', null, etq), h('dd', null, valor)) : null;
    const tr = v.tarifaRef;
    let notaTarifa = null;
    if (tr) {
      const esperado = tr.ivaTratamiento === 'incluido' ? Math.round(tr.monto / (1 + (v.ivaPct || C.IVA_PCT_DEFECTO) / 100)) : tr.monto;
      notaTarifa = `${tr.nombre}: ${clp(tr.monto)}${tr.modalidad === 'km' ? ' por km' : ' fija'} · ${ETQ.iva[tr.ivaTratamiento]}` +
        (tr.vigenciaDesde ? ` · vigente desde ${fechaCorta(tr.vigenciaDesde)}` : '') +
        (esperado !== v.tarifa || tr.modalidad !== v.formaCobro ? ' · modificada en este viaje' : '');
    }

    const eliminarViaje = async () => {
      const ok = await confirmar({
        titulo: `Eliminar el viaje ${codigo}`,
        mensaje: `Se eliminará para todos los usuarios el viaje a ${v.sitio} y sus ${adjuntos.length} foto(s). Esta acción no se puede deshacer.`,
        textoConfirmar: 'Eliminar viaje',
        peligro: true
      });
      if (!ok) return;
      try {
        const enServidor = Nube.datos().viajes.find(x => x.id === v.id);
        await Nube.eliminarViaje(v.id, enServidor ? enServidor.version : null);
        await DB.eliminarBorrador(`viaje-${v.id}`).catch(() => {});
        construirEstado();
        toast(`Viaje ${codigo} eliminado.`);
        navegar('#/viajes');
      } catch (err) {
        toast(mensajeError(err, 'No se pudo eliminar'), 'error');
        refrescarTrasError(err);
      }
    };

    let avisoPendiente = null;
    if (v._pendiente === 'conflicto') {
      avisoPendiente = h('div', { class: 'aviso aviso-error' }, icono('alerta'),
        h('p', null, h('strong', null, 'Conflicto de edición. '), 'Otro usuario modificó este viaje mientras lo editabas. Se muestra tu versión, que aún no se guarda en el servidor.'),
        boton({ texto: 'Resolver', clase: 'btn btn-pequeno btn-primario', onClick: () => resolverConflictoUI(v._itemId) }));
    } else if (v._pendiente === 'error') {
      avisoPendiente = h('div', { class: 'aviso aviso-error' }, icono('alerta'),
        h('p', null, h('strong', null, 'No se pudo enviar. '), v._mensaje || ''),
        boton({ texto: 'Revisar', clase: 'btn btn-pequeno btn-secundario', onClick: abrirDialogoSync }));
    } else if (v._pendiente === 'pendiente') {
      avisoPendiente = h('div', { class: 'aviso aviso-pendiente' }, icono('subir'),
        h('p', null, h('strong', null, 'Pendiente de envío. '), navigator.onLine ? 'Se está enviando al servidor.' : 'Está guardado en este teléfono y se enviará solo cuando vuelva la señal.'));
    }

    const nodo = h('div', { class: 'detalle' },
      cabeceraVista(`${codigo} · ${v.sitio || 'Sin sitio'}`, {
        volver: { href: '#/viajes', texto: 'Viajes' },
        subtitulo: `${capitalizar(fechaLarga(v.fecha))} · ${v.localidad}`,
        acciones: [
          enlaceBoton({ texto: 'Editar', href: `#/viajes/${encodeURIComponent(v.id)}/editar`, icono: 'editar', clase: 'btn btn-primario' }),
          enlaceBoton({ texto: 'Duplicar', href: `#/viajes/${encodeURIComponent(v.id)}/duplicar`, icono: 'duplicar', clase: 'btn btn-secundario' }),
          boton({ texto: 'Imprimir informe', icono: 'imprimir', clase: 'btn btn-secundario', onClick: () => window.print() }),
          boton({ texto: 'Eliminar', icono: 'eliminar', clase: 'btn btn-peligro-suave', onClick: eliminarViaje })
        ]
      }),
      h('div', { class: 'detalle-insignias' }, insigniaEstado(v.estado), insignia(ETQ.modalidad[v.modalidad], 'neutra'), alertasDeViaje(v, c)),
      avisoPendiente,
      v.estado === 'cancelado' ? h('div', { class: 'aviso aviso-suave' }, icono('info'), h('p', null, 'Viaje cancelado: no suma a ingresos, costos ni márgenes del período.')) : null,
      h('div', { class: 'detalle-rejilla' },
        h('section', { class: 'tarjeta', 'aria-labelledby': 'd-datos' },
          h('h2', { id: 'd-datos' }, 'Datos del viaje'),
          h('dl', { class: 'datos' },
            dato('Fecha', fechaCorta(v.fecha)),
            dato('Estado', ETQ.estado[v.estado]),
            dato('Cliente', v.cliente),
            dato('Sitio u obra', v.sitio),
            dato('Localidad', v.localidad),
            dato('Dirección de entrega', v.direccion),
            dato('Origen', v.origen),
            dato('Destino', v.destino),
            dato('Ruta frecuente', v.rutaNombre),
            dato('Contacto en sitio', v.contacto),
            dato('Tipo de camión', v.camionNombre),
            dato('Modalidad', ETQ.modalidad[v.modalidad]),
            dato('Km cobrables', km(v.km)))),
        h('section', { class: 'tarjeta', 'aria-labelledby': 'd-cobro' },
          h('h2', { id: 'd-cobro' }, 'Cobro'),
          h('dl', { class: 'datos' },
            dato('Forma de cobro', ETQ.formaCobro[v.formaCobro]),
            dato(v.formaCobro === 'km' ? 'Tarifa neta por km' : 'Tarifa neta fija', clp(v.tarifa)),
            dato('Tarifa de catálogo usada', notaTarifa || 'Ingresada manualmente'),
            dato('Monto neto confirmado', v.netoConfirmado ? 'Sí' : 'No: falta confirmar si la tarifa incluye IVA'),
            dato('IVA', v.aplicaIva ? `${numero(v.ivaPct)} % aparte` : 'No aplicado'))),
        h('section', { class: 'tarjeta tarjeta-desglose', 'aria-labelledby': 'd-resultado' },
          h('h2', { id: 'd-resultado' }, 'Resultado del viaje'),
          desglose(v, c)),
        (v.descripcion || v.notas) ? h('section', { class: 'tarjeta', 'aria-labelledby': 'd-notas' },
          h('h2', { id: 'd-notas' }, 'Descripción y observaciones'),
          v.descripcion ? h('div', { class: 'texto-largo' }, h('h3', null, 'Descripción del servicio'), h('p', null, v.descripcion)) : null,
          v.notas ? h('div', { class: 'texto-largo' }, h('h3', null, 'Observaciones y notas'), h('p', null, v.notas)) : null) : null,
        h('section', { class: 'tarjeta tarjeta-fotos', 'aria-labelledby': 'd-fotos' },
          h('h2', { id: 'd-fotos' }, 'Fotografías de respaldo'),
          ['guia', 'entrega'].map(cat => seccionFotos({
            categoria: cat,
            adjuntos: adjuntos.filter(a => a.categoria === cat),
            codigo: v.codigo,
            onAgregar: async (archivos, estadoNodo) => {
              const existentes = adjuntos.filter(a => a.categoria === cat).length;
              const { listos, errores } = await procesarArchivos(archivos, cat, existentes, estadoNodo);
              errores.forEach(e => toast(e, 'error'));
              if (!listos.length) return;
              try {
                await Nube.encolarFotos(v.id, listos, []);
                construirEstado();
                toast(navigator.onLine ? `${listos.length} foto(s) enviándose al servidor.` : `${listos.length} foto(s) guardadas en el teléfono; se enviarán al volver la señal.`);
                renderizar({ silencioso: true });
                Nube.procesarCola().catch(() => {});
              } catch (err) {
                toast(`No se pudieron guardar las fotos: ${err.message}. Puede que el almacenamiento del navegador esté lleno.`, 'error');
              }
            },
            onQuitar: async (a) => {
              const ok = await confirmar({ titulo: 'Eliminar foto', mensaje: `Se eliminará para todos los usuarios esta foto de "${CATEGORIAS[a.categoria]}".`, textoConfirmar: 'Eliminar foto', peligro: true });
              if (!ok) return;
              await Nube.encolarFotos(v.id, [], [a.id]);
              construirEstado();
              toast('Foto eliminada.');
              renderizar({ silencioso: true });
              Nube.procesarCola().catch(() => {});
            }
          })))),
      h('p', { class: 'texto-suave detalle-meta' },
        v.creado ? `Creado por ${nombreUsuario(v.creadoPor)} el ${fechaHora(v.creado)}` : 'Aún no se guarda en el servidor',
        v.actualizado && v.version > 1 ? ` · Última modificación por ${nombreUsuario(v.actualizadoPor)} el ${fechaHora(v.actualizado)}` : '',
        v.demo ? ' · Registro de demostración' : ''));
    return { titulo: `${codigo} · ${v.sitio}`, nodo };
  }

  /* =======================================================================
     8e. Formulario de viaje (nuevo, editar, duplicar)
     ======================================================================= */
  const tarifasDeCamion = camionId => S.tarifas.filter(t => t.camionId === camionId);
  const tarifaVigente = (t, fecha) =>
    (!t.vigenciaDesde || !fecha || fecha >= t.vigenciaDesde) && (!t.vigenciaHasta || !fecha || fecha <= t.vigenciaHasta);

  function tarifaSugerida(camionId, fecha) {
    const lista = tarifasDeCamion(camionId).filter(t => t.activa);
    return lista.find(t => t.modalidad === 'km' && tarifaVigente(t, fecha))
      || lista.find(t => tarifaVigente(t, fecha)) || lista[0] || null;
  }

  function copiaTarifa(t) {
    return { id: t.id, nombre: t.nombre, modalidad: t.modalidad, monto: t.monto, ivaTratamiento: t.ivaTratamiento, vigenciaDesde: t.vigenciaDesde };
  }

  /** Si la tarifa incluye IVA se precarga el neto; si está por confirmar se usa el monto tal cual y queda marcada. */
  function netoDeTarifa(t, ivaPct) {
    return t.ivaTratamiento === 'incluido' ? Math.round(t.monto / (1 + ivaPct / 100)) : t.monto;
  }

  function ivaPctDeF(F) {
    const r = C.parsearDecimal(F.ivaPct);
    return r.valor === null || r.error ? (C.esNumero(S.cfg.ivaPct) ? S.cfg.ivaPct : C.IVA_PCT_DEFECTO) : r.valor;
  }

  function aplicarTarifaEnF(F, t) {
    if (!t) { F.tarifaId = ''; F.tarifaRef = null; F.netoConfirmado = true; return; }
    F.tarifaId = t.id;
    F.tarifaRef = copiaTarifa(t);
    F.formaCobro = t.modalidad;
    F.tarifa = montoParaInput(netoDeTarifa(t, ivaPctDeF(F)));
    F.netoConfirmado = t.ivaTratamiento !== 'pendiente';
  }

  function formularioVacio() {
    const camion = S.camiones.find(c => c.activo) || null;
    const F = {
      id: C.generarId(), codigo: '', creado: '', demo: false,
      fecha: hoyISO(), estado: 'realizado', rutaId: '', rutaNombre: '',
      cliente: '', sitio: '', localidad: '', direccion: '', origen: '', destino: '', contacto: '',
      camionId: camion ? camion.id : '', camionNombre: camion ? camion.nombre : '',
      modalidad: 'tercerizado', tarifaId: '', tarifaRef: null, formaCobro: 'km', tarifa: '', km: '',
      netoConfirmado: true, aplicaIva: S.cfg.ivaPorDefecto !== false,
      ivaPct: decimalParaInput(C.esNumero(S.cfg.ivaPct) ? S.cfg.ivaPct : C.IVA_PCT_DEFECTO),
      peajesEstimados: '', peajesReales: '', combustible: '', comida: '',
      transportistaModo: 'km', transportistaTarifaKm: '', transportistaMontoFijo: '',
      choferModo: 'ninguno', choferTarifaKm: montoParaInput(S.cfg.choferTarifaKm), choferMonto: '', choferTocado: false,
      otrosGastos: [], cobrosAdicionales: [], descripcion: '', notas: '', actualizarRuta: false
    };
    if (camion) aplicarTarifaEnF(F, tarifaSugerida(camion.id, F.fecha));
    return F;
  }

  function formularioDesdeViaje(v, duplicar) {
    const lineas = lista => lista.map(g => ({ id: duplicar ? C.generarId() : g.id, concepto: g.concepto, monto: montoParaInput(g.monto) }));
    return {
      id: duplicar ? C.generarId() : v.id,
      codigo: duplicar ? '' : v.codigo,
      creado: duplicar ? '' : v.creado,
      demo: duplicar ? false : v.demo,
      fecha: duplicar ? hoyISO() : v.fecha,
      estado: duplicar ? 'planificado' : v.estado,
      rutaId: v.rutaId, rutaNombre: v.rutaNombre,
      cliente: v.cliente, sitio: v.sitio, localidad: v.localidad, direccion: v.direccion,
      origen: v.origen, destino: v.destino, contacto: v.contacto,
      camionId: v.camionId, camionNombre: v.camionNombre, modalidad: v.modalidad,
      tarifaId: v.tarifaRef ? v.tarifaRef.id : '', tarifaRef: v.tarifaRef ? Object.assign({}, v.tarifaRef) : null,
      formaCobro: v.formaCobro, tarifa: montoParaInput(v.tarifa), km: decimalParaInput(v.km),
      netoConfirmado: v.netoConfirmado, aplicaIva: v.aplicaIva, ivaPct: decimalParaInput(v.ivaPct),
      peajesEstimados: montoParaInput(v.peajesEstimados),
      peajesReales: duplicar ? '' : montoParaInput(v.peajesReales),
      combustible: montoParaInput(v.combustible), comida: montoParaInput(v.comida),
      transportistaModo: v.transportista.modo,
      transportistaTarifaKm: montoParaInput(v.transportista.tarifaKm),
      transportistaMontoFijo: montoParaInput(v.transportista.montoFijo),
      choferModo: v.chofer.modo,
      choferTarifaKm: montoParaInput(C.esNumero(v.chofer.tarifaKm) ? v.chofer.tarifaKm : S.cfg.choferTarifaKm),
      choferMonto: montoParaInput(v.chofer.monto),
      choferTocado: true,
      otrosGastos: lineas(v.otrosGastos), cobrosAdicionales: lineas(v.cobrosAdicionales),
      descripcion: v.descripcion, notas: duplicar ? '' : v.notas, actualizarRuta: false
    };
  }

  const MAPA_ERRORES = {
    'transportista.tarifaKm': 'transportistaTarifaKm',
    'transportista.montoFijo': 'transportistaMontoFijo',
    'transportista.modo': 'transportistaModo',
    'chofer.tarifaKm': 'choferTarifaKm',
    'chofer.monto': 'choferMonto',
    'chofer.modo': 'choferModo'
  };
  function claveFormulario(k) {
    if (MAPA_ERRORES[k]) return MAPA_ERRORES[k];
    let m = /^gasto\.(.+)\.(concepto|monto)$/.exec(k);
    if (m) return `og-${m[1]}-${m[2]}`;
    m = /^cobro\.(.+)\.(concepto|monto)$/.exec(k);
    if (m) return `ca-${m[1]}-${m[2]}`;
    return k;
  }

  /** Convierte el formulario (textos) en un viaje y reúne errores de parseo y de negocio. */
  function construirViaje(F) {
    const errores = {};
    const monto = k => { const r = C.parsearMonto(F[k]); if (r.error) errores[k] = r.error; return r.valor; };
    const decimal = k => { const r = C.parsearDecimal(F[k]); if (r.error) errores[k] = r.error; return r.valor; };
    const lineas = (lista, pref) => lista
      .filter(l => String(l.concepto).trim() !== '' || String(l.monto).trim() !== '')
      .map(l => {
        const r = C.parsearMonto(l.monto);
        if (r.error) errores[`${pref}-${l.id}-monto`] = r.error;
        return { id: l.id, concepto: String(l.concepto).trim(), monto: r.valor };
      });
    const camion = S.camiones.find(c => c.id === F.camionId);
    const ruta = S.rutas.find(r => r.id === F.rutaId);
    const tercerizado = F.modalidad === 'tercerizado';
    const ivaR = C.parsearDecimal(F.ivaPct);
    if (F.aplicaIva && ivaR.error) errores.ivaPct = ivaR.error;
    const viaje = {
      id: F.id, codigo: F.codigo, creado: F.creado, demo: !!F.demo,
      fecha: F.fecha, estado: F.estado,
      cliente: F.cliente.trim(), sitio: F.sitio.trim(), localidad: F.localidad.trim(), direccion: F.direccion.trim(),
      origen: F.origen.trim(), destino: F.destino.trim(), contacto: F.contacto.trim(),
      rutaId: F.rutaId || '', rutaNombre: ruta ? ruta.nombre : (F.rutaId ? F.rutaNombre : ''),
      camionId: F.camionId, camionNombre: camion ? camion.nombre : F.camionNombre,
      modalidad: F.modalidad, formaCobro: F.formaCobro,
      tarifa: monto('tarifa'), km: decimal('km'),
      tarifaRef: F.tarifaRef, netoConfirmado: F.tarifaRef && F.tarifaRef.ivaTratamiento === 'pendiente' ? !!F.netoConfirmado : true,
      aplicaIva: !!F.aplicaIva,
      ivaPct: ivaR.valor === null || ivaR.error ? (C.esNumero(S.cfg.ivaPct) ? S.cfg.ivaPct : C.IVA_PCT_DEFECTO) : ivaR.valor,
      peajesEstimados: monto('peajesEstimados'), peajesReales: monto('peajesReales'),
      combustible: monto('combustible'), comida: monto('comida'),
      transportista: tercerizado
        ? {
          modo: F.transportistaModo,
          tarifaKm: F.transportistaModo === 'km' ? monto('transportistaTarifaKm') : null,
          montoFijo: F.transportistaModo === 'fijo' ? monto('transportistaMontoFijo') : null
        }
        : { modo: 'km', tarifaKm: null, montoFijo: null },
      chofer: {
        modo: F.choferModo || 'ninguno',
        tarifaKm: F.choferModo === 'km' ? monto('choferTarifaKm') : null,
        monto: F.choferModo === 'fijo' ? monto('choferMonto') : null
      },
      otrosGastos: lineas(F.otrosGastos, 'og'),
      cobrosAdicionales: lineas(F.cobrosAdicionales, 'ca'),
      descripcion: F.descripcion.trim(), notas: F.notas.trim()
    };
    const negocio = C.validarViaje(viaje);
    Object.keys(negocio).forEach(k => {
      const kf = claveFormulario(k);
      if (!errores[kf]) errores[kf] = negocio[k];
    });
    return { viaje, errores };
  }

  async function salirDelFormulario() {
    const st = S.form;
    S.form = null;
    if (!st) return;
    if (st.guardarBorrador && st.guardarBorrador.pendiente()) await st.guardarBorrador.ahora();
    if (st.sucio && !st.guardado) toast('Tus cambios quedaron como borrador. Los recuperas al volver al formulario.', 'aviso');
  }

  async function vistaFormularioViaje(modo, idCod) {
    const id = idCod ? decodeURIComponent(idCod) : null;
    let base = null;
    if (modo !== 'nuevo') {
      base = S.viajes.find(v => v.id === id);
      if (!base) return vistaNoEncontrada('viaje');
    }
    if (!S.camiones.length) {
      return {
        titulo: 'Nuevo viaje',
        nodo: h('div', null, cabeceraVista('Nuevo viaje', { volver: { href: '#/viajes', texto: 'Viajes' } }),
          estadoVacio({
            titulo: 'Primero crea un tipo de camión',
            texto: 'Cada viaje necesita un tipo de camión para sugerir tarifas.',
            accion: enlaceBoton({ texto: 'Ir a Camiones y tarifas', href: '#/tarifas', clase: 'btn btn-primario' })
          }))
      };
    }
    const clave = modo === 'editar' ? `viaje-${id}` : 'viaje-nuevo';
    let borrador = null;
    try { borrador = await DB.leerBorrador(clave); } catch (err) { borrador = null; }
    let F;
    let adjNuevos = [];
    let adjEliminar = [];
    let avisoBorrador = null;
    let avisoCopia = null;
    if (modo === 'duplicar') {
      if (borrador) {
        const ok = await confirmar({
          titulo: 'Hay un viaje nuevo sin guardar',
          mensaje: 'Tienes un borrador de viaje nuevo. Si duplicas este viaje, ese borrador se reemplaza.',
          textoConfirmar: 'Reemplazar borrador', peligro: true
        });
        if (!ok) return { redirigir: `#/viajes/${encodeURIComponent(id)}` };
        await DB.eliminarBorrador(clave).catch(() => {});
      }
      F = formularioDesdeViaje(base, true);
      avisoCopia = `Copia de ${base.codigo}. Se dejó con fecha de hoy, estado "Planificado", sin peajes reales, sin observaciones y sin fotos. Revisa antes de guardar.`;
    } else if (borrador && borrador.datos && borrador.datos.F) {
      F = Object.assign(formularioVacio(), borrador.datos.F);
      adjNuevos = borrador.datos.adjuntosNuevos || [];
      adjEliminar = borrador.datos.adjuntosEliminar || [];
      avisoBorrador = `Recuperamos cambios sin guardar del ${fechaHora(borrador.guardado)}.`;
    } else {
      F = modo === 'nuevo' ? formularioVacio() : formularioDesdeViaje(base, false);
    }

    const st = {
      modo, clave, F,
      adjuntosExistentes: modo === 'editar' ? await adjuntosDeViaje(id) : [],
      adjuntosNuevos: adjNuevos,
      adjuntosEliminar: new Set(adjEliminar),
      sucio: !!avisoBorrador,
      guardado: false,
      intentado: false
    };
    // Un borrador restaurado de "nuevo" nunca debe apuntar a un viaje ya guardado.
    if (modo !== 'editar' && S.viajes.some(v => v.id === F.id)) {
      F.id = C.generarId();
      F.codigo = '';
      F.creado = '';
    }
    const estadoBorrador = h('p', { class: 'estado-borrador texto-suave', 'aria-live': 'polite' });
    st.guardarBorrador = debounce(async () => {
      if (st.cerrado) return; // formulario ya guardado o descartado: no revivir el borrador
      try {
        await DB.guardarBorrador(clave, {
          F, modo,
          adjuntosNuevos: st.adjuntosNuevos,
          adjuntosEliminar: Array.from(st.adjuntosEliminar),
          base: base ? base.actualizado : ''
        });
        estadoBorrador.textContent = 'Borrador guardado en este dispositivo.';
      } catch (err) {
        estadoBorrador.textContent = 'No se pudo guardar el borrador.';
      }
    }, 500);
    S.form = st;

    const refs = {};
    const hoy = hoyISO();

    /* ---- Constructores de campos ligados a F ---- */
    const req = () => h('span', { class: 'req', 'aria-hidden': 'true' }, ' *');
    function campo(nombre, etiqueta, o = {}) {
      const idc = `f-${nombre}`;
      const describe = [o.ayuda ? `${idc}-ayuda` : null, `${idc}-error`].filter(Boolean).join(' ');
      const tipo = o.tipo || 'texto';
      let input;
      if (tipo === 'textarea') {
        input = h('textarea', { id: idc, name: nombre, rows: 3, maxlength: o.max || 2000, 'aria-describedby': describe, value: F[nombre] || '' });
      } else {
        input = h('input', {
          id: idc, name: nombre,
          type: tipo === 'fecha' ? 'date' : 'text',
          inputmode: tipo === 'monto' ? 'numeric' : tipo === 'decimal' ? 'decimal' : null,
          autocomplete: 'off',
          maxlength: tipo === 'fecha' ? null : (o.max || (tipo === 'texto' ? 120 : 20)),
          required: o.obligatorio || null,
          list: o.lista || null,
          placeholder: o.placeholder || null,
          'aria-describedby': describe,
          dataset: { tipo },
          value: F[nombre] == null ? '' : F[nombre]
        });
      }
      refs[nombre] = input;
      const etq = h('label', { for: idc }, h('span', { class: 'etq-texto' }, etiqueta), o.obligatorio ? req() : null);
      refs[`etq-${nombre}`] = etq.firstChild;
      const control = (o.prefijo || o.sufijo)
        ? h('div', { class: 'entrada-compuesta' },
          o.prefijo ? h('span', { class: 'prefijo', 'aria-hidden': 'true' }, o.prefijo) : null,
          input,
          o.sufijo ? h('span', { class: 'sufijo', 'aria-hidden': 'true' }, o.sufijo) : null)
        : input;
      const ayuda = o.ayuda ? h('p', { class: 'ayuda', id: `${idc}-ayuda` }, o.ayuda) : null;
      if (ayuda) refs[`ayuda-${nombre}`] = ayuda;
      const envoltura = h('div', { class: `campo ${o.clase || ''}` }, etq, control, ayuda, h('p', { class: 'error', id: `${idc}-error`, hidden: true }));
      refs[`campo-${nombre}`] = envoltura;
      return envoltura;
    }

    function radios(nombre, etiqueta, opciones, o = {}) {
      const idE = `f-${nombre}-error`;
      const fs = h('fieldset', { class: `campo campo-radios ${o.clase || ''}`, 'aria-describedby': idE },
        h('legend', null, etiqueta, o.obligatorio ? req() : null),
        h('div', { class: 'segmentado' }, opciones.map(([val, txt]) => {
          const idr = `f-${nombre}-${val}`;
          return h('div', { class: 'segmentado-opcion' },
            h('input', { type: 'radio', id: idr, name: nombre, value: val, checked: F[nombre] === val }),
            h('label', { for: idr }, txt));
        })),
        h('p', { class: 'error', id: idE, hidden: true }));
      refs[`campo-${nombre}`] = fs;
      return fs;
    }

    function selector(nombre, etiqueta, opcionesFn, o = {}) {
      const idc = `f-${nombre}`;
      const describe = [o.ayuda ? `${idc}-ayuda` : null, `${idc}-error`].filter(Boolean).join(' ');
      const s = h('select', { id: idc, name: nombre, required: o.obligatorio || null, 'aria-describedby': describe }, opcionesFn());
      s.value = F[nombre] || '';
      refs[nombre] = s;
      const ayuda = o.ayuda ? h('p', { class: `ayuda ${o.claseAyuda || ''}`, id: `${idc}-ayuda` }, o.ayuda) : null;
      if (ayuda) refs[`ayuda-${nombre}`] = ayuda;
      const envoltura = h('div', { class: `campo ${o.clase || ''}` },
        h('label', { for: idc }, etiqueta, o.obligatorio ? req() : null), s, ayuda,
        h('p', { class: 'error', id: `${idc}-error`, hidden: true }));
      refs[`campo-${nombre}`] = envoltura;
      return envoltura;
    }

    function casilla(nombre, etiqueta, o = {}) {
      const idc = `f-${nombre}`;
      const input = h('input', { type: 'checkbox', id: idc, name: nombre, checked: !!F[nombre], 'aria-describedby': o.ayuda ? `${idc}-ayuda` : null });
      refs[nombre] = input;
      const etq = h('label', { for: idc }, etiqueta);
      refs[`etq-${nombre}`] = etq;
      const envoltura = h('div', { class: `campo campo-check ${o.clase || ''}` },
        h('div', { class: 'check' }, input, etq),
        o.ayuda ? h('p', { class: 'ayuda', id: `${idc}-ayuda` }, o.ayuda) : null);
      refs[`campo-${nombre}`] = envoltura;
      return envoltura;
    }

    function editorLineas(lista, pref, { titulo, etiquetaConcepto, textoAgregar, datalist, ayuda }) {
      const cont = h('ul', { class: 'lineas' });
      const pintar = () => reemplazar(cont, F[lista].map((l, i) => {
        const idC = `f-${pref}-${l.id}-concepto`;
        const idM = `f-${pref}-${l.id}-monto`;
        return h('li', { class: 'linea' },
          h('div', { class: 'campo' },
            h('label', { for: idC }, `${etiquetaConcepto} ${i + 1}`),
            h('input', { type: 'text', id: idC, value: l.concepto, maxlength: 80, list: datalist, autocomplete: 'off',
              'aria-describedby': `${idC}-error`, dataset: { lista, linea: l.id, campo: 'concepto' } }),
            h('p', { class: 'error', id: `${idC}-error`, hidden: true })),
          h('div', { class: 'campo' },
            h('label', { for: idM }, 'Monto neto'),
            h('div', { class: 'entrada-compuesta' }, h('span', { class: 'prefijo', 'aria-hidden': 'true' }, '$'),
              h('input', { type: 'text', inputmode: 'numeric', id: idM, value: l.monto, maxlength: 20, autocomplete: 'off',
                'aria-describedby': `${idM}-error`, dataset: { lista, linea: l.id, campo: 'monto', tipo: 'monto' } })),
            h('p', { class: 'error', id: `${idM}-error`, hidden: true })),
          boton({
            texto: `Quitar ${etiquetaConcepto.toLowerCase()} ${i + 1}`, icono: 'eliminar', soloIcono: true, clase: 'btn btn-fantasma linea-quitar',
            onClick: () => { F[lista] = F[lista].filter(x => x.id !== l.id); pintar(); cambio(); }
          }));
      }));
      pintar();
      return h('div', { class: 'editor-lineas' },
        h('h3', null, titulo),
        ayuda ? h('p', { class: 'ayuda' }, ayuda) : null,
        cont,
        boton({
          texto: textoAgregar, icono: 'nuevo', clase: 'btn btn-secundario btn-pequeno',
          onClick: () => {
            const nueva = { id: C.generarId(), concepto: '', monto: '' };
            F[lista].push(nueva);
            pintar();
            cambio();
            const el = document.getElementById(`f-${pref}-${nueva.id}-concepto`);
            if (el) el.focus();
          }
        }));
    }

    /* ---- Opciones dinámicas ---- */
    const opcionesRuta = () => {
      const ops = [h('option', { value: '' }, 'Sin ruta frecuente')];
      S.rutas.forEach(r => ops.push(h('option', { value: r.id }, `${r.nombre}${C.esNumero(r.km) ? ` · ${numero(r.km)} km` : ''}${r.demo ? ' (demo)' : ''}`)));
      if (F.rutaId && !S.rutas.some(r => r.id === F.rutaId)) ops.push(h('option', { value: F.rutaId }, `${F.rutaNombre || 'Ruta'} (ya no está en el catálogo)`));
      return ops;
    };
    const opcionesCamion = () => {
      const ops = [h('option', { value: '' }, 'Selecciona un tipo de camión')];
      S.camiones.forEach(c => {
        if (c.activo || c.id === F.camionId) ops.push(h('option', { value: c.id }, c.nombre + (c.activo ? '' : ' (inactivo)')));
      });
      if (F.camionId && !S.camiones.some(c => c.id === F.camionId)) ops.push(h('option', { value: F.camionId }, `${F.camionNombre || 'Camión'} (ya no está en el catálogo)`));
      return ops;
    };
    const opcionesTarifa = () => {
      const ops = [h('option', { value: '' }, 'Manual (sin tarifa de catálogo)')];
      tarifasDeCamion(F.camionId).filter(t => t.activa || t.id === F.tarifaId).forEach(t => {
        const fuera = !tarifaVigente(t, F.fecha);
        ops.push(h('option', { value: t.id },
          `${t.nombre} · ${clp(t.monto)}${t.modalidad === 'km' ? '/km' : ''} · ${ETQ.iva[t.ivaTratamiento]}${fuera ? ' · fuera de vigencia en esa fecha' : ''}${t.activa ? '' : ' (inactiva)'}`));
      });
      if (F.tarifaId && F.tarifaRef && !tarifasDeCamion(F.camionId).some(t => t.id === F.tarifaId)) {
        ops.push(h('option', { value: F.tarifaId }, `${F.tarifaRef.nombre} · ${clp(F.tarifaRef.monto)} (copia guardada en el viaje)`));
      }
      return ops;
    };

    /* ---- Datalists con valores ya usados ---- */
    const datalist = (id, valores) => h('datalist', { id }, valores.map(v => h('option', { value: v })));
    const conceptos = lista => Array.from(new Set(S.viajes.flatMap(v => v[lista].map(g => g.concepto)).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'es'));
    const lugares = Array.from(new Set(S.viajes.flatMap(v => [v.origen, v.destino]).concat(S.rutas.flatMap(r => [r.origen, r.destino])).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'es'));
    const listas = h('div', { hidden: true },
      datalist('dl-clientes', valoresDistintos('cliente')),
      datalist('dl-sitios', valoresDistintos('sitio')),
      datalist('dl-localidades', Array.from(new Set(valoresDistintos('localidad').concat(S.rutas.map(r => r.localidad).filter(Boolean))))),
      datalist('dl-lugares', lugares),
      datalist('dl-gastos', conceptos('otrosGastos')),
      datalist('dl-cobros', conceptos('cobrosAdicionales')));

    /* ---- Secciones ---- */
    refs.infoRuta = h('p', { class: 'ayuda', id: 'f-rutaId-ayuda' });
    refs.avisoFecha = h('p', { class: 'ayuda ayuda-aviso', hidden: true });
    const campoFecha = campo('fecha', 'Fecha del viaje', { tipo: 'fecha', obligatorio: true });
    campoFecha.appendChild(refs.avisoFecha);
    const campoRuta = selector('rutaId', 'Ruta frecuente', opcionesRuta, { ayuda: ' ', clase: 'completo' });
    campoRuta.replaceChild(refs.infoRuta, refs['ayuda-rutaId']);

    const seccionViaje = h('section', { class: 'tarjeta form-seccion', 'aria-labelledby': 'fs-viaje' },
      h('h2', { id: 'fs-viaje' }, 'Viaje'),
      h('div', { class: 'rejilla-campos' },
        campoFecha,
        radios('estado', 'Estado', [['planificado', 'Planificado'], ['realizado', 'Realizado'], ['cancelado', 'Cancelado']], { obligatorio: true }),
        campoRuta,
        campo('sitio', 'Sitio u obra', { obligatorio: true, lista: 'dl-sitios', placeholder: 'Ej.: Obra Norte' }),
        campo('localidad', 'Localidad', { obligatorio: true, lista: 'dl-localidades' }),
        campo('cliente', 'Cliente', { lista: 'dl-clientes', ayuda: 'Opcional.' }),
        campo('direccion', 'Dirección de entrega', { max: 200 }),
        campo('origen', 'Origen', { lista: 'dl-lugares' }),
        campo('destino', 'Destino', { lista: 'dl-lugares' }),
        campo('contacto', 'Contacto en sitio', { max: 200, ayuda: 'Nombre y teléfono del encargado. Opcional.', clase: 'completo' })));

    refs.infoTarifa = h('p', { class: 'ayuda', id: 'f-tarifaId-ayuda' });
    const campoTarifaCat = selector('tarifaId', 'Tarifa del catálogo', opcionesTarifa, { ayuda: ' ', clase: 'completo' });
    campoTarifaCat.replaceChild(refs.infoTarifa, refs['ayuda-tarifaId']);

    const seccionCobro = h('section', { class: 'tarjeta form-seccion', 'aria-labelledby': 'fs-cobro' },
      h('h2', { id: 'fs-cobro' }, 'Camión y cobro'),
      h('div', { class: 'rejilla-campos' },
        selector('camionId', 'Tipo de camión', opcionesCamion, { obligatorio: true }),
        radios('modalidad', 'Modalidad', [['propio', 'Camión propio'], ['tercerizado', 'Tercerizado']], { obligatorio: true }),
        campoTarifaCat,
        radios('formaCobro', 'Forma de cobro', [['km', 'Por kilómetro'], ['fija', 'Tarifa fija']], { obligatorio: true }),
        campo('tarifa', 'Tarifa neta por km', { tipo: 'monto', obligatorio: true, prefijo: '$', ayuda: 'Siempre editable. El catálogo no cambia.' }),
        campo('km', 'Kilómetros cobrables', { tipo: 'decimal', sufijo: 'km', ayuda: 'Obligatorio si se cobra o se paga por km. Usa coma para decimales.' }),
        casilla('netoConfirmado', 'Confirmé que esta tarifa es neta (sin IVA)', { ayuda: 'La tarifa del catálogo tiene el IVA por confirmar. Márcalo cuando lo confirmes.', clase: 'completo' }),
        casilla('aplicaIva', 'Aplicar IVA a este viaje', { ayuda: 'El IVA se muestra aparte; no suma al ingreso ni al margen.' }),
        campo('ivaPct', 'Porcentaje de IVA', { tipo: 'decimal', sufijo: '%', max: 6 })),
      editorLineas('cobrosAdicionales', 'ca', {
        titulo: 'Cobros adicionales al cliente',
        ayuda: 'Montos netos que suman al ingreso (ej.: sobreestadía, viaje de vuelta).',
        etiquetaConcepto: 'Cobro', textoAgregar: 'Agregar cobro adicional', datalist: 'dl-cobros'
      }));

    refs.infoTransportista = h('p', { class: 'ayuda ayuda-calculo', 'aria-live': 'polite' });
    refs.seccionTransportista = h('div', { class: 'subseccion' },
      h('h3', null, 'Transportista tercero'),
      h('div', { class: 'rejilla-campos' },
        radios('transportistaModo', 'Cómo se paga al transportista', [['km', 'Por kilómetro'], ['fijo', 'Monto fijo']], { obligatorio: true, clase: 'completo' }),
        campo('transportistaTarifaKm', 'Tarifa del transportista por km', { tipo: 'monto', obligatorio: true, prefijo: '$' }),
        campo('transportistaMontoFijo', 'Monto fijo del transportista', { tipo: 'monto', obligatorio: true, prefijo: '$' })),
      refs.infoTransportista);

    refs.infoChofer = h('p', { class: 'ayuda ayuda-calculo', 'aria-live': 'polite' });
    refs.seccionChofer = h('div', { class: 'subseccion' },
      h('h3', null, 'Pago al chofer'),
      h('p', { class: 'ayuda' }, `Costo directo del viaje. Para camión propio se sugiere ${clp(S.cfg.choferTarifaKm)} por km (Ajustes).`),
      h('div', { class: 'rejilla-campos' },
        radios('choferModo', 'Cómo se paga al chofer', [['ninguno', 'Sin pago'], ['km', 'Por km'], ['fijo', 'Monto fijo']], { clase: 'completo' }),
        campo('choferTarifaKm', 'Pago al chofer por km', { tipo: 'monto', obligatorio: true, prefijo: '$' }),
        campo('choferMonto', 'Pago fijo al chofer', { tipo: 'monto', obligatorio: true, prefijo: '$' })),
      refs.infoChofer);

    const seccionCostos = h('section', { class: 'tarjeta form-seccion', 'aria-labelledby': 'fs-costos' },
      h('h2', { id: 'fs-costos' }, 'Costos directos'),
      h('div', { class: 'rejilla-campos' },
        campo('peajesEstimados', 'Peajes estimados', { tipo: 'monto', prefijo: '$' }),
        campo('peajesReales', 'Peajes reales', { tipo: 'monto', prefijo: '$', ayuda: 'Si lo ingresas, reemplaza al estimado (incluso $0).' }),
        casilla('actualizarRuta', 'Actualizar la ruta con estos km y peajes', { clase: 'completo', ayuda: 'Solo si lo marcas se modifica el catálogo de rutas.' }),
        campo('combustible', 'Combustible', { tipo: 'monto', prefijo: '$' }),
        campo('comida', 'Comida', { tipo: 'monto', prefijo: '$' })),
      refs.seccionTransportista,
      refs.seccionChofer,
      editorLineas('otrosGastos', 'og', {
        titulo: 'Otros gastos directos',
        ayuda: 'Ej.: estacionamiento, sobreestadía pagada, remolque.',
        etiquetaConcepto: 'Gasto', textoAgregar: 'Agregar gasto', datalist: 'dl-gastos'
      }));

    const zonaFotos = h('div', { class: 'fotos-form' });
    const pintarFotos = () => reemplazar(zonaFotos, ['guia', 'entrega'].map(cat => {
      const existentes = st.adjuntosExistentes.filter(a => a.categoria === cat && !st.adjuntosEliminar.has(a.id));
      const nuevos = st.adjuntosNuevos.filter(a => a.categoria === cat).map(a => Object.assign({ nuevo: true }, a));
      return seccionFotos({
        categoria: cat,
        adjuntos: existentes.concat(nuevos),
        codigo: F.codigo,
        onAgregar: async (archivos, estadoNodo) => {
          const { listos, errores } = await procesarArchivos(archivos, cat, existentes.length + nuevos.length, estadoNodo);
          errores.forEach(e => toast(e, 'error'));
          if (!listos.length) return;
          st.adjuntosNuevos.push(...listos);
          pintarFotos();
          cambio();
          toast(`${listos.length} foto(s) lista(s). Se guardan al guardar el viaje.`);
        },
        onQuitar: async (a) => {
          const ok = await confirmar({
            titulo: 'Quitar foto',
            mensaje: a.nuevo ? 'La foto aún no se guarda; se quitará del formulario.' : 'La foto se eliminará al guardar el viaje.',
            textoConfirmar: 'Quitar foto', peligro: true
          });
          if (!ok) return;
          if (a.nuevo) st.adjuntosNuevos = st.adjuntosNuevos.filter(x => x.id !== a.id);
          else st.adjuntosEliminar.add(a.id);
          pintarFotos();
          cambio();
        }
      });
    }));
    pintarFotos();

    const seccionFotosForm = h('section', { class: 'tarjeta form-seccion', 'aria-labelledby': 'fs-fotos' },
      h('h2', { id: 'fs-fotos' }, 'Fotografías de respaldo'), zonaFotos);

    const seccionNotas = h('section', { class: 'tarjeta form-seccion', 'aria-labelledby': 'fs-notas' },
      h('h2', { id: 'fs-notas' }, 'Descripción y observaciones'),
      h('div', { class: 'rejilla-campos' },
        campo('descripcion', 'Descripción del servicio', { tipo: 'textarea', clase: 'completo', ayuda: 'Qué se retira y dónde se entrega.' }),
        campo('notas', 'Observaciones y notas', { tipo: 'textarea', clase: 'completo', ayuda: 'Incidencias, esperas, acuerdos.' })));

    /* ---- Resumen y barra de guardado ---- */
    const panelResumen = h('div', { class: 'resumen-contenido' });
    const barraMargen = h('div', { class: 'barra-guardar-resumen' });
    const btnGuardar = h('button', { type: 'submit', class: 'btn btn-primario btn-grande' }, icono('ok'), h('span', null, 'Guardar viaje'));
    const btnCancelar = h('button', { type: 'button', class: 'btn btn-secundario btn-grande', onclick: cancelar }, 'Cancelar');

    const form = h('form', { class: 'form-viaje', novalidate: true, 'aria-label': 'Datos del viaje' },
      listas,
      h('div', { class: 'form-columnas' },
        h('div', { class: 'form-principal' }, seccionViaje, seccionCobro, seccionCostos, seccionFotosForm, seccionNotas),
        h('aside', { class: 'form-resumen', 'aria-labelledby': 'titulo-resumen-form' },
          h('div', { class: 'tarjeta resumen-fijo' },
            h('h2', { id: 'titulo-resumen-form' }, 'Resultado del viaje'),
            h('p', { class: 'texto-suave' }, 'Se recalcula mientras escribes.'),
            panelResumen))),
      h('div', { class: 'barra-guardar' },
        barraMargen,
        h('div', { class: 'barra-guardar-acciones' }, btnCancelar, btnGuardar)));

    /* ---- Sincronización F ↔ DOM ---- */
    function fijar(nombre) {
      const el = refs[nombre];
      if (el && el.type === 'checkbox') el.checked = !!F[nombre];
      else if (el) el.value = F[nombre] == null ? '' : F[nombre];
      else $$(`input[name="${nombre}"]`, form).forEach(r => { r.checked = r.value === F[nombre]; });
    }

    function actualizarVista() {
      const ruta = S.rutas.find(r => r.id === F.rutaId);
      const kmV = C.parsearDecimal(F.km).valor;
      const peajeV = C.parsearMonto(F.peajesEstimados).valor;
      // Ruta
      if (ruta) {
        refs.infoRuta.textContent = `Precarga ${C.esNumero(ruta.km) ? `${numero(ruta.km)} km` : 'km sin dato'} y ${C.esNumero(ruta.peajes) ? `${clp(ruta.peajes)} de peajes estimados` : 'peajes sin dato'}` +
          `${ruta.vigencia ? ` (actualizada ${fechaCorta(ruta.vigencia)})` : ''}. Puedes cambiarlos en este viaje.`;
      } else {
        refs.infoRuta.textContent = F.rutaId ? 'La ruta ya no existe en el catálogo; el viaje conserva su nombre.' : 'Elige una ruta para precargar km y peajes estimados.';
      }
      const difiere = !!ruta && ((kmV ?? null) !== (ruta.km ?? null) || (peajeV ?? null) !== (ruta.peajes ?? null));
      refs['campo-actualizarRuta'].hidden = !difiere;
      if (ruta) refs['etq-actualizarRuta'].textContent = `Actualizar la ruta «${ruta.nombre}» con estos km y peajes estimados`;
      if (!difiere && F.actualizarRuta) { F.actualizarRuta = false; fijar('actualizarRuta'); }
      // Fecha futura con estado realizado
      const futura = F.estado === 'realizado' && C.esFechaValida(F.fecha) && F.fecha > hoy;
      refs.avisoFecha.hidden = !futura;
      refs.avisoFecha.textContent = futura ? 'La fecha es futura y el estado es "Realizado". Revisa si corresponde "Planificado".' : '';
      // Tarifa
      refs['etq-tarifa'].textContent = F.formaCobro === 'fija' ? 'Tarifa neta fija' : 'Tarifa neta por km';
      const tr = F.tarifaRef;
      if (tr) {
        const partes = [`Catálogo: ${clp(tr.monto)}${tr.modalidad === 'km' ? ' por km' : ' fija'} · ${ETQ.iva[tr.ivaTratamiento]}.`];
        if (tr.ivaTratamiento === 'incluido') partes.push('Se precargó el valor neto (sin IVA).');
        if (tr.ivaTratamiento === 'pendiente') partes.push('No está confirmado si el monto incluye IVA: el viaje queda marcado para revisión.');
        const aplicado = C.parsearMonto(F.tarifa).valor;
        if ((aplicado !== null && aplicado !== netoDeTarifa(tr, ivaPctDeF(F))) || tr.modalidad !== F.formaCobro) partes.push('Modificada en este viaje; el catálogo no cambia.');
        refs.infoTarifa.textContent = partes.join(' ');
        refs.infoTarifa.classList.toggle('ayuda-aviso', tr.ivaTratamiento === 'pendiente');
      } else {
        refs.infoTarifa.textContent = tarifasDeCamion(F.camionId).length
          ? 'Tarifa manual: se guarda tal como la escribas.'
          : 'Este tipo de camión no tiene tarifas en el catálogo. Ingresa la tarifa manualmente.';
        refs.infoTarifa.classList.remove('ayuda-aviso');
      }
      refs['campo-netoConfirmado'].hidden = !(tr && tr.ivaTratamiento === 'pendiente');
      refs['campo-ivaPct'].hidden = !F.aplicaIva;
      // Transportista
      const tercerizado = F.modalidad === 'tercerizado';
      refs.seccionTransportista.hidden = !tercerizado;
      refs['campo-transportistaTarifaKm'].hidden = F.transportistaModo !== 'km';
      refs['campo-transportistaMontoFijo'].hidden = F.transportistaModo !== 'fijo';
      // Chofer
      refs['campo-choferTarifaKm'].hidden = F.choferModo !== 'km';
      refs['campo-choferMonto'].hidden = F.choferModo !== 'fijo';
      // Resumen
      const { viaje, errores } = construirViaje(F);
      const v = C.normalizarViaje(viaje);
      const c = C.calcularViaje(v);
      if (tercerizado) {
        refs.infoTransportista.textContent = F.transportistaModo === 'km'
          ? `Costo del transportista: ${clp(c.costoTransportista)} (${numero(v.km || 0)} km × ${clp(v.transportista.tarifaKm)}).`
          : `Costo del transportista: ${clp(c.costoTransportista)}.`;
      }
      refs.infoChofer.textContent = F.choferModo === 'km'
        ? `Pago al chofer: ${clp(c.costoChofer)} (${numero(v.km || 0)} km × ${clp(v.chofer.tarifaKm)}).`
        : F.choferModo === 'fijo' ? `Pago al chofer: ${clp(c.costoChofer)}.` : 'Sin pago al chofer en este viaje.';
      reemplazar(panelResumen, desglose(v, c));
      reemplazar(barraMargen,
        h('span', { class: 'brs-etq' }, 'Margen'),
        h('strong', { class: `brs-valor ${tono(c.margenBruto)}` }, clp(c.margenBruto)),
        h('span', { class: 'brs-pct' }, c.margenPct === null ? 'sin ingreso' : pct(c.margenPct)));
      if (st.intentado) mostrarErrores(errores);
    }

    function efectos(nombre) {
      if (nombre === 'rutaId') {
        const r = S.rutas.find(x => x.id === F.rutaId);
        if (r) {
          F.rutaNombre = r.nombre;
          if (C.esNumero(r.km)) { F.km = decimalParaInput(r.km); fijar('km'); }
          if (C.esNumero(r.peajes)) { F.peajesEstimados = montoParaInput(r.peajes); fijar('peajesEstimados'); }
          ['origen', 'destino', 'localidad'].forEach(k => { if (!F[k].trim() && r[k]) { F[k] = r[k]; fijar(k); } });
          F.actualizarRuta = false;
          fijar('actualizarRuta');
        } else if (!F.rutaId) {
          F.rutaNombre = '';
        }
      }
      if (nombre === 'camionId') {
        const cam = S.camiones.find(x => x.id === F.camionId);
        F.camionNombre = cam ? cam.nombre : '';
        if (!F.tarifaRef || !tarifasDeCamion(F.camionId).some(t => t.id === F.tarifaId)) {
          aplicarTarifaEnF(F, tarifaSugerida(F.camionId, F.fecha));
          ['tarifa', 'formaCobro', 'netoConfirmado'].forEach(fijar);
        }
        reemplazar(refs.tarifaId, opcionesTarifa());
        refs.tarifaId.value = F.tarifaId;
      }
      if (nombre === 'tarifaId') {
        if (!F.tarifaId) { F.tarifaRef = null; F.netoConfirmado = true; }
        else aplicarTarifaEnF(F, S.tarifas.find(t => t.id === F.tarifaId));
        ['tarifa', 'formaCobro', 'netoConfirmado'].forEach(fijar);
      }
      if (nombre === 'fecha') {
        reemplazar(refs.tarifaId, opcionesTarifa());
        refs.tarifaId.value = F.tarifaId;
      }
      if (nombre === 'choferModo' || nombre === 'choferTarifaKm' || nombre === 'choferMonto') F.choferTocado = true;
      if (nombre === 'modalidad' && !F.choferTocado) {
        // Sugerencia: el camión propio paga chofer por km; el tercerizado no (lo paga el transportista).
        F.choferModo = F.modalidad === 'propio' ? 'km' : 'ninguno';
        if (!String(F.choferTarifaKm).trim()) F.choferTarifaKm = montoParaInput(S.cfg.choferTarifaKm);
        fijar('choferModo');
        fijar('choferTarifaKm');
      }
    }

    function cambio() {
      if (st.cerrado) return;
      st.sucio = true;
      estadoBorrador.textContent = '';
      actualizarVista();
      st.guardarBorrador();
    }

    function manejar(el, esChange) {
      if (!el || el.type === 'file') return;
      if (el.dataset && el.dataset.lista) {
        const l = F[el.dataset.lista].find(x => x.id === el.dataset.linea);
        if (l) l[el.dataset.campo] = el.value;
        cambio();
        return;
      }
      const nombre = el.name;
      if (!nombre || !(nombre in F)) return;
      if (el.type === 'radio') { if (!el.checked) return; F[nombre] = el.value; }
      else if (el.type === 'checkbox') F[nombre] = el.checked;
      else F[nombre] = el.value;
      if (esChange) efectos(nombre);
      cambio();
    }
    form.addEventListener('input', ev => manejar(ev.target, false));
    form.addEventListener('change', ev => manejar(ev.target, true));
    form.addEventListener('focusout', ev => {
      const el = ev.target;
      if (!el.dataset) return;
      if (el.dataset.tipo === 'monto') formatearMonto(el);
      else if (el.dataset.tipo === 'decimal') formatearDecimal(el);
      else return;
      if (el.dataset.lista) {
        const l = F[el.dataset.lista].find(x => x.id === el.dataset.linea);
        if (l) l[el.dataset.campo] = el.value;
      } else if (el.name in F) {
        F[el.name] = el.value;
      }
    });

    function mostrarErrores(errores) {
      $$('[aria-invalid="true"]', form).forEach(el => el.removeAttribute('aria-invalid'));
      $$('p.error', form).forEach(p => { p.hidden = true; p.textContent = ''; });
      Object.entries(errores).forEach(([k, msg]) => {
        const p = document.getElementById(`f-${k}-error`);
        if (p) { p.textContent = msg; p.hidden = false; }
        const el = document.getElementById(`f-${k}`);
        if (el) el.setAttribute('aria-invalid', 'true');
        else $$(`input[name="${k}"]`, form).forEach(r => r.setAttribute('aria-invalid', 'true'));
      });
    }

    function enfocarPrimerError(claves) {
      const candidatos = claves
        .map(k => document.getElementById(`f-${k}`) || $(`input[name="${k}"]`, form))
        .filter(el => el && !el.closest('[hidden]'));
      candidatos.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      if (candidatos[0]) {
        candidatos[0].focus({ preventScroll: true });
        candidatos[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    async function cancelar() {
      if (st.sucio) {
        const ok = await confirmar({
          titulo: 'Descartar cambios',
          mensaje: 'Se perderán los cambios que no has guardado en este viaje, incluidas las fotos nuevas.',
          textoConfirmar: 'Descartar cambios', peligro: true
        });
        if (!ok) return;
      }
      st.cerrado = true;
      st.guardarBorrador.cancelar();
      await DB.eliminarBorrador(clave).catch(() => {});
      st.sucio = false;
      S.form = null;
      navegar(modo === 'editar' ? `#/viajes/${encodeURIComponent(id)}` : modo === 'duplicar' ? `#/viajes/${encodeURIComponent(id)}` : '#/viajes');
    }

    async function descartarBorrador() {
      const ok = await confirmar({
        titulo: 'Descartar borrador',
        mensaje: 'Se perderán los cambios recuperados y el formulario volverá a su estado original.',
        textoConfirmar: 'Descartar borrador', peligro: true
      });
      if (!ok) return;
      st.cerrado = true;
      st.guardarBorrador.cancelar();
      await DB.eliminarBorrador(clave).catch(() => {});
      S.form = null;
      renderizar();
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (S.guardando) return;
      st.intentado = true;
      const { viaje, errores } = construirViaje(F);
      mostrarErrores(errores);
      const claves = Object.keys(errores);
      if (claves.length) {
        toast(`Revisa ${claves.length} campo(s) marcado(s) antes de guardar.`, 'error');
        enfocarPrimerError(claves);
        return;
      }
      S.guardando = true;
      btnGuardar.disabled = true;
      btnGuardar.lastChild.textContent = 'Guardando…';
      try {
        const normal = C.normalizarViaje(viaje);
        ['_pendiente', '_itemId', '_mensaje'].forEach(k => { delete normal[k]; });
        const ruta = S.rutas.find(r => r.id === normal.rutaId);
        const rutaActualizada = (F.actualizarRuta && ruta) ? { id: ruta.id, km: normal.km, peajes: normal.peajesEstimados } : null;
        const enServidor = modo === 'editar' ? Nube.datos().viajes.find(x => x.id === normal.id) : null;
        st.cerrado = true;
        st.guardarBorrador.cancelar();
        const r = await Nube.guardarViaje({
          viaje: normal,
          versionBase: enServidor ? enServidor.version : null,
          rutaActualizada,
          adjuntosNuevos: st.adjuntosNuevos,
          adjuntosEliminar: Array.from(st.adjuntosEliminar)
        });
        if (r.estado === 'error') {
          await Nube.descartarVarios(r.ids);
          throw new Error(r.mensaje);
        }
        await DB.eliminarBorrador(clave).catch(() => {});
        st.sucio = false;
        st.guardado = true;
        S.form = null;
        construirEstado();
        const conDemo = cantidadDemo().viajes > 0;
        if (r.estado === 'enviado') {
          toast(`Viaje ${r.viaje.codigo} guardado.${rutaActualizada ? ' La ruta frecuente se actualizó.' : ''}${conDemo ? ' Ojo: los totales aún incluyen datos de demostración.' : ''}`);
        } else if (r.estado === 'pendiente') {
          toast('Sin conexión: el viaje quedó guardado en este teléfono y se enviará solo al volver la señal.', 'aviso', { duracion: 9000 });
        }
        navegar(`#/viajes/${encodeURIComponent(normal.id)}`);
        if (r.estado === 'conflicto') setTimeout(() => resolverConflictoUI(r.itemId), 300);
      } catch (err) {
        st.cerrado = false; // se puede reintentar; se vuelve a guardar el borrador
        st.guardarBorrador();
        toast(`No se pudo guardar el viaje: ${err.message}`, 'error');
      } finally {
        S.guardando = false;
        btnGuardar.disabled = false;
        btnGuardar.lastChild.textContent = 'Guardar viaje';
      }
    });

    actualizarVista();

    const titulo = modo === 'editar' ? `Editar ${base.codigo || 'viaje por enviar'}` : modo === 'duplicar' ? 'Duplicar viaje' : 'Nuevo viaje';
    const nodo = h('div', { class: 'vista-formulario' },
      cabeceraVista(titulo, {
        volver: modo === 'nuevo' ? { href: '#/viajes', texto: 'Viajes' } : { href: `#/viajes/${encodeURIComponent(id)}`, texto: base.codigo || 'Viaje' },
        subtitulo: 'Los campos con * son obligatorios. Los valores sugeridos se pueden corregir.'
      }),
      avisoBorrador ? h('div', { class: 'aviso aviso-suave' }, icono('info'), h('p', null, avisoBorrador),
        h('button', { type: 'button', class: 'btn btn-pequeno btn-secundario', onclick: descartarBorrador }, 'Descartar borrador')) : null,
      avisoCopia ? h('div', { class: 'aviso aviso-suave' }, icono('info'), h('p', null, avisoCopia)) : null,
      F.demo ? h('div', { class: 'aviso aviso-demo' }, icono('info'), h('p', null, 'Estás editando un registro de demostración.')) : null,
      form,
      estadoBorrador);
    return { titulo, nodo, formulario: true };
  }

  /* =======================================================================
     9. Adjuntos: optimización, galería y visor
     ======================================================================= */
  async function optimizarImagen(archivo) {
    const ext = (archivo.name.split('.').pop() || '').toLowerCase();
    const tipoOk = IMG.tipos.includes(archivo.type) || (!archivo.type && IMG.extensiones.includes(ext));
    if (!tipoOk) throw new Error(`"${archivo.name}" no es una imagen compatible (JPG, PNG, WebP o HEIC).`);
    if (archivo.size > IMG.maxEntradaMB * 1024 * 1024) {
      throw new Error(`"${archivo.name}" pesa ${tamanoLegible(archivo.size)}; el máximo es ${IMG.maxEntradaMB} MB.`);
    }
    const url = URL.createObjectURL(archivo);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      try {
        await img.decode();
      } catch (err) {
        throw new Error(`No se pudo leer "${archivo.name}". Si es HEIC y tu navegador no lo abre, conviértela a JPG o toma la foto desde la app.`);
      }
      const ancho0 = img.naturalWidth;
      const alto0 = img.naturalHeight;
      if (!ancho0 || !alto0) throw new Error(`"${archivo.name}" no tiene dimensiones válidas.`);
      const escala = Math.min(1, IMG.ladoMax / Math.max(ancho0, alto0));
      const ancho = Math.max(1, Math.round(ancho0 * escala));
      const alto = Math.max(1, Math.round(alto0 * escala));
      const lienzo = document.createElement('canvas');
      lienzo.width = ancho;
      lienzo.height = alto;
      const ctx = lienzo.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ancho, alto);
      ctx.drawImage(img, 0, 0, ancho, alto);
      const blob = await new Promise((resolve, reject) => {
        lienzo.toBlob(b => (b ? resolve(b) : reject(new Error(`No se pudo optimizar "${archivo.name}".`))), 'image/jpeg', IMG.calidad);
      });
      // Si el original ya es JPEG, no requiere achicarse y pesa menos, se conserva.
      if (archivo.type === 'image/jpeg' && escala === 1 && archivo.size <= blob.size) {
        return { blob: new Blob([archivo], { type: 'image/jpeg' }), ancho, alto };
      }
      return { blob, ancho, alto };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function procesarArchivos(archivos, categoria, existentes, estadoNodo) {
    const listos = [];
    const errores = [];
    const cupo = IMG.maxPorCategoria - existentes;
    if (cupo <= 0) {
      errores.push(`Ya hay ${IMG.maxPorCategoria} fotos en "${CATEGORIAS[categoria]}". Elimina alguna para agregar otra.`);
      return { listos, errores };
    }
    const lote = archivos.slice(0, cupo);
    if (archivos.length > cupo) errores.push(`Solo se agregaron ${cupo} foto(s): el máximo es ${IMG.maxPorCategoria} por categoría.`);
    for (let i = 0; i < lote.length; i++) {
      if (estadoNodo) estadoNodo.textContent = `Optimizando foto ${i + 1} de ${lote.length}…`;
      try {
        const r = await optimizarImagen(lote[i]);
        const base = lote[i].name.replace(/\.[^.]+$/, '') || 'foto';
        listos.push({
          id: C.generarId(), categoria, nombre: `${base}.jpg`, tipo: r.blob.type, tamano: r.blob.size,
          ancho: r.ancho, alto: r.alto, creado: new Date().toISOString(), blob: r.blob
        });
      } catch (err) {
        errores.push(err.message);
      }
    }
    if (estadoNodo) estadoNodo.textContent = listos.length ? `${listos.length} foto(s) optimizada(s).` : '';
    return { listos, errores };
  }

  function seccionFotos({ categoria, adjuntos, codigo, onAgregar, onQuitar }) {
    const idInput = uid(`fotos-${categoria}`);
    const estado = h('p', { class: 'fotos-estado texto-suave', 'aria-live': 'polite' });
    const input = h('input', { type: 'file', id: idInput, accept: 'image/*', multiple: true, class: 'visualmente-oculto entrada-archivo' });
    input.addEventListener('change', () => {
      const archivos = Array.from(input.files || []);
      input.value = '';
      if (archivos.length) onAgregar(archivos, estado);
    });
    return h('div', { class: 'fotos' },
      h('div', { class: 'fotos-cabecera' },
        h('h3', null, CATEGORIAS[categoria]),
        h('span', { class: 'texto-suave' }, `${adjuntos.length} de ${IMG.maxPorCategoria}`)),
      adjuntos.length
        ? h('ul', { class: 'fotos-lista' }, adjuntos.map((a, i) => itemFoto(a, i, codigo, onQuitar)))
        : h('p', { class: 'texto-suave fotos-vacio' }, 'Sin fotos todavía.'),
      h('div', { class: 'fotos-agregar' },
        input,
        h('label', { for: idInput, class: 'btn btn-secundario' }, icono('camara'),
          h('span', null, categoria === 'guia' ? 'Agregar foto de guía' : 'Agregar foto de entrega'))),
      estado);
  }

  function itemFoto(a, i, codigo, onQuitar) {
    const nombreDescarga = `${codigo || 'viaje'}-${a.categoria === 'guia' ? 'guia-despacho' : 'entrega'}-${i + 1}.jpg`;
    const etq = `${CATEGORIAS[a.categoria]}, foto ${i + 1}`;
    const miniatura = a.blob
      ? h('button', { type: 'button', class: 'foto-miniatura', 'aria-label': `Ver ${etq}`, onclick: () => abrirVisor(a, etq, nombreDescarga, onQuitar) },
        h('img', { src: registrarUrl(URL.createObjectURL(a.blob)), alt: '', loading: 'lazy', width: 160, height: 120 }))
      : h('div', { class: 'foto-miniatura foto-sin-imagen', role: 'img', 'aria-label': `${etq}: no se pudo cargar` },
        icono('alerta'), h('span', null, navigator.onLine ? 'No se pudo cargar' : 'Disponible con conexión'));
    return h('li', { class: 'foto' },
      miniatura,
      h('div', { class: 'foto-pie' },
        h('span', { class: 'foto-peso' }, tamanoLegible(a.tamano || (a.blob && a.blob.size))),
        a.nuevo ? insignia('Sin guardar', 'aviso') : a._pendiente ? insignia(a._pendiente === 'pendiente' ? 'Sin enviar' : 'Error', a._pendiente === 'pendiente' ? 'pendiente' : 'error') : null,
        a.blob ? boton({ texto: `Descargar ${etq}`, icono: 'descargar', soloIcono: true, clase: 'btn btn-fantasma', onClick: () => descargarBlob(a.blob, nombreDescarga) }) : null,
        boton({ texto: `Eliminar ${etq}`, icono: 'eliminar', soloIcono: true, clase: 'btn btn-fantasma', onClick: () => onQuitar(a) })));
  }

  function abrirVisor(a, etq, nombreDescarga, onQuitar) {
    const url = registrarUrl(URL.createObjectURL(a.blob));
    abrirDialogo((dlg, cerrar, idTitulo) => {
      agregar(dlg,
        h('div', { class: 'dialogo-cuerpo visor' },
          h('h2', { id: idTitulo, class: 'dialogo-titulo' }, etq),
          h('img', { src: url, alt: etq }),
          h('p', { class: 'texto-suave' }, `${tamanoLegible(a.tamano)}${a.ancho ? ` · ${a.ancho} × ${a.alto} px` : ''}${a.nuevo ? ' · aún no guardada' : ''}`)),
        h('div', { class: 'dialogo-acciones' },
          boton({ texto: 'Eliminar', icono: 'eliminar', clase: 'btn btn-peligro-suave', onClick: () => cerrar('eliminar') }),
          boton({ texto: 'Descargar', icono: 'descargar', clase: 'btn btn-secundario', onClick: () => descargarBlob(a.blob, nombreDescarga) }),
          h('button', { type: 'button', class: 'btn btn-primario', onclick: () => cerrar(), 'data-foco-inicial': true }, 'Cerrar')));
    }, { clase: 'dialogo-ancho' }).then(r => { if (r === 'eliminar') onQuitar(a); });
  }

  /* =======================================================================
     8f. Rutas frecuentes
     ======================================================================= */
  function vistaRutas() {
    const usos = id => S.viajes.filter(v => v.rutaId === id).length;
    const dato = (etq, valor) => h('div', { class: 'dato' }, h('dt', null, etq), h('dd', null, valor));
    const contenido = S.rutas.length
      ? h('ul', { class: 'lista-tarjetas' }, S.rutas.map(r => h('li', { class: 'tarjeta tarjeta-item' },
        h('div', { class: 'item-cabecera' },
          h('h2', { class: 'item-titulo' }, r.nombre),
          r.demo ? insignia('Demo', 'demo') : null),
        h('p', { class: 'item-sub' }, [r.origen, r.destino].filter(Boolean).join(' → ') || 'Sin origen ni destino'),
        h('dl', { class: 'datos datos-compactos' },
          dato('Localidad', r.localidad || '—'),
          dato('Km sugeridos', km(r.km)),
          dato('Peajes estimados', C.esNumero(r.peajes) ? clp(r.peajes) : '—'),
          dato('Última actualización', r.vigencia ? fechaCorta(r.vigencia) : '—'),
          dato('Usada en', `${usos(r.id)} viaje(s)`)),
        r.notas ? h('p', { class: 'nota-catalogo' }, r.notas) : null,
        h('div', { class: 'item-acciones' },
          boton({ texto: 'Editar', icono: 'editar', clase: 'btn btn-secundario btn-pequeno', onClick: () => editarRuta(r), attrs: { 'aria-label': `Editar ruta ${r.nombre}` } }),
          boton({ texto: 'Eliminar', icono: 'eliminar', clase: 'btn btn-peligro-suave btn-pequeno', onClick: () => eliminarRuta(r), attrs: { 'aria-label': `Eliminar ruta ${r.nombre}` } })))))
      : estadoVacio({
        titulo: 'Sin rutas frecuentes',
        texto: 'Crea rutas con km y peajes estimados para precargarlos al registrar viajes.',
        accion: boton({ texto: 'Nueva ruta', icono: 'nuevo', clase: 'btn btn-primario', onClick: () => editarRuta(null) })
      });
    return {
      titulo: 'Rutas frecuentes',
      nodo: h('div', null,
        cabeceraVista('Rutas frecuentes', {
          subtitulo: 'Al elegir una ruta en un viaje se precargan km y peajes. Cambiarlos en el viaje no modifica el catálogo, salvo que lo marques.',
          acciones: boton({ texto: 'Nueva ruta', icono: 'nuevo', clase: 'btn btn-primario', onClick: () => editarRuta(null) })
        }),
        contenido)
    };
  }

  /** Errores de escritura en diálogos: mensaje claro y, si hubo conflicto, datos actualizados. */
  function errorEnDialogo(err, accion) {
    refrescarTrasError(err);
    return new Error(mensajeError(err, accion));
  }

  async function editarRuta(r) {
    const ok = await dialogoFormulario({
      titulo: r ? 'Editar ruta' : 'Nueva ruta',
      campos: [
        { nombre: 'nombre', etiqueta: 'Nombre de la ruta', tipo: 'texto', obligatorio: true, ancho: 'completo' },
        { nombre: 'origen', etiqueta: 'Origen', tipo: 'texto' },
        { nombre: 'destino', etiqueta: 'Destino', tipo: 'texto' },
        { nombre: 'localidad', etiqueta: 'Localidad', tipo: 'texto' },
        { nombre: 'km', etiqueta: 'Kilómetros sugeridos', tipo: 'decimal' },
        { nombre: 'peajes', etiqueta: 'Peajes estimados', tipo: 'monto', prefijo: '$' },
        { nombre: 'vigencia', etiqueta: 'Última actualización', tipo: 'fecha', obligatorio: true, ayuda: 'Fecha en que verificaste km y peajes.' },
        { nombre: 'notas', etiqueta: 'Notas', tipo: 'textarea' }
      ],
      valores: r || { vigencia: hoyISO() },
      validar: d => {
        const e = {};
        if (d.nombre && S.rutas.some(x => x.id !== (r && r.id) && sinTildes(x.nombre) === sinTildes(d.nombre))) e.nombre = 'Ya existe una ruta con ese nombre.';
        return e;
      },
      alGuardar: async d => {
        try {
          await Nube.guardarRegistro('rutas', C.normalizarRuta(Object.assign({}, r || {}, d, { id: r ? r.id : C.generarId() })), r ? r.version : null);
        } catch (err) { throw errorEnDialogo(err, 'No se pudo guardar la ruta'); }
      }
    });
    if (!ok) return;
    construirEstado();
    toast(r ? 'Ruta actualizada.' : 'Ruta creada.');
    renderizar();
  }

  async function eliminarRuta(r) {
    const n = S.viajes.filter(v => v.rutaId === r.id).length;
    const ok = await confirmar({
      titulo: `Eliminar la ruta "${r.nombre}"`,
      mensaje: n ? `${n} viaje(s) usan esta ruta. Conservarán el nombre y sus km y peajes; solo se quita del catálogo.` : 'Se quitará del catálogo de rutas para todos los usuarios.',
      textoConfirmar: 'Eliminar ruta', peligro: true
    });
    if (!ok) return;
    try {
      await Nube.eliminarRegistro('rutas', r.id);
      construirEstado();
      toast('Ruta eliminada.');
      renderizar();
    } catch (err) {
      toast(mensajeError(err, 'No se pudo eliminar la ruta'), 'error');
      refrescarTrasError(err);
    }
  }

  /* =======================================================================
     8g. Camiones y tarifas (solo administradores modifican)
     ======================================================================= */
  function vistaTarifas() {
    const admin = esAdmin();
    const bloques = S.camiones.length ? S.camiones.map(c => {
      const tarifas = tarifasDeCamion(c.id).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      const usos = S.viajes.filter(v => v.camionId === c.id).length;
      const idT = `cam-${c.id}`;
      return h('section', { class: 'tarjeta bloque-camion', 'aria-labelledby': idT },
        h('div', { class: 'tarjeta-cabecera' },
          h('div', null,
            h('h2', { id: idT }, c.nombre),
            h('p', { class: 'texto-suave' }, [
              C.esNumero(c.capacidadKg) ? `Capacidad ${fmtEntero.format(c.capacidadKg)} kg` : 'Capacidad sin dato',
              `${usos} viaje(s)`].join(' · '))),
          h('div', { class: 'tarjeta-acciones' },
            c.activo ? insignia('Activo', 'ok') : insignia('Inactivo', 'neutra'),
            admin ? boton({ texto: 'Editar', icono: 'editar', clase: 'btn btn-secundario btn-pequeno', onClick: () => editarCamion(c), attrs: { 'aria-label': `Editar ${c.nombre}` } }) : null,
            admin ? boton({ texto: 'Eliminar', icono: 'eliminar', clase: 'btn btn-peligro-suave btn-pequeno', onClick: () => eliminarCamion(c), attrs: { 'aria-label': `Eliminar ${c.nombre}` } }) : null)),
        c.notas ? h('p', { class: 'nota-catalogo' }, c.notas) : null,
        tarifas.length
          ? h('ul', { class: 'lista-tarifas' }, tarifas.map(t => itemTarifa(t, c, admin)))
          : h('p', { class: 'texto-suave' }, 'Sin tarifas. Agrega una para sugerirla al registrar viajes.'),
        admin ? boton({ texto: 'Agregar tarifa', icono: 'nuevo', clase: 'btn btn-secundario btn-pequeno', onClick: () => editarTarifa(null, c.id), attrs: { 'aria-label': `Agregar tarifa a ${c.nombre}` } }) : null);
    }) : [estadoVacio({
      titulo: 'Sin tipos de camión',
      texto: admin ? 'Crea al menos uno para registrar viajes.' : 'Pide a un administrador que cree los tipos de camión.',
      accion: admin ? boton({ texto: 'Nuevo tipo de camión', icono: 'nuevo', clase: 'btn btn-primario', onClick: () => editarCamion(null) }) : null
    })];
    return {
      titulo: 'Camiones y tarifas',
      nodo: h('div', null,
        cabeceraVista('Camiones y tarifas', {
          subtitulo: 'Las tarifas se sugieren al crear un viaje. Cada viaje guarda una copia de la tarifa usada, así que cambiar una tarifa no altera viajes anteriores.',
          acciones: admin ? [
            boton({ texto: 'Nuevo tipo de camión', icono: 'nuevo', clase: 'btn btn-secundario', onClick: () => editarCamion(null) }),
            boton({ texto: 'Nueva tarifa', icono: 'nuevo', clase: 'btn btn-primario', onClick: () => editarTarifa(null, S.camiones[0] ? S.camiones[0].id : '') })
          ] : null
        }),
        admin ? null : h('div', { class: 'aviso aviso-suave' }, icono('info'), h('p', null, 'Solo los administradores pueden modificar camiones y tarifas.')),
        bloques)
    };
  }

  function itemTarifa(t, c, admin) {
    const hoy = hoyISO();
    const vigente = tarifaVigente(t, hoy);
    return h('li', { class: `tarifa ${t.activa ? '' : 'inactiva'}` },
      h('div', { class: 'tarifa-principal' },
        h('span', { class: 'tarifa-nombre' }, t.nombre),
        h('span', { class: 'tarifa-monto' }, `${clp(t.monto)}${t.modalidad === 'km' ? ' por km' : ' fija'}`)),
      h('div', { class: 'tarifa-insignias' },
        insignia(ETQ.formaCobro[t.modalidad], 'neutra'),
        insignia(ETQ.iva[t.ivaTratamiento], t.ivaTratamiento === 'pendiente' ? 'aviso' : 'neutra'),
        insignia(t.activa ? 'Activa' : 'Inactiva', t.activa ? 'ok' : 'neutra'),
        t.activa && !vigente ? insignia('Fuera de vigencia hoy', 'aviso') : null),
      h('p', { class: 'texto-suave' },
        `Vigencia: ${t.vigenciaDesde ? `desde ${fechaCorta(t.vigenciaDesde)}` : 'sin fecha de inicio'}${t.vigenciaHasta ? ` hasta ${fechaCorta(t.vigenciaHasta)}` : ''}`),
      t.notas ? h('p', { class: `nota-catalogo ${t.ivaTratamiento === 'pendiente' ? 'nota-pendiente' : ''}` }, t.notas) : null,
      admin ? h('div', { class: 'item-acciones' },
        boton({ texto: 'Editar', icono: 'editar', clase: 'btn btn-secundario btn-pequeno', onClick: () => editarTarifa(t, c.id), attrs: { 'aria-label': `Editar tarifa ${t.nombre} de ${c.nombre}` } }),
        boton({ texto: 'Eliminar', icono: 'eliminar', clase: 'btn btn-peligro-suave btn-pequeno', onClick: () => eliminarTarifa(t), attrs: { 'aria-label': `Eliminar tarifa ${t.nombre} de ${c.nombre}` } })) : null);
  }

  async function editarCamion(c) {
    const ok = await dialogoFormulario({
      titulo: c ? 'Editar tipo de camión' : 'Nuevo tipo de camión',
      campos: [
        { nombre: 'nombre', etiqueta: 'Nombre', tipo: 'texto', obligatorio: true, ancho: 'completo', ayuda: 'Ej.: Camión 6.000 kg' },
        { nombre: 'capacidadKg', etiqueta: 'Capacidad (kg)', tipo: 'decimal' },
        { nombre: 'activo', etiqueta: 'Activo (disponible para viajes nuevos)', tipo: 'checkbox' },
        { nombre: 'notas', etiqueta: 'Notas', tipo: 'textarea' }
      ],
      valores: c || { activo: true },
      validar: d => {
        const e = {};
        if (d.nombre && S.camiones.some(x => x.id !== (c && c.id) && sinTildes(x.nombre) === sinTildes(d.nombre))) e.nombre = 'Ya existe un tipo de camión con ese nombre.';
        return e;
      },
      alGuardar: async d => {
        try {
          await Nube.guardarRegistro('camiones', C.normalizarCamion(Object.assign({}, c || {}, d, { id: c ? c.id : C.generarId() })), c ? c.version : null);
        } catch (err) { throw errorEnDialogo(err, 'No se pudo guardar'); }
      }
    });
    if (!ok) return;
    construirEstado();
    toast(c ? 'Tipo de camión actualizado.' : 'Tipo de camión creado.');
    renderizar();
  }

  async function eliminarCamion(c) {
    const usos = S.viajes.filter(v => v.camionId === c.id).length;
    try {
      if (usos) {
        const desactivar = await confirmar({
          titulo: 'No se puede eliminar',
          mensaje: `"${c.nombre}" está en ${usos} viaje(s). Para dejar de usarlo en viajes nuevos, márcalo como inactivo.`,
          textoConfirmar: c.activo ? 'Marcar como inactivo' : 'Entendido'
        });
        if (desactivar && c.activo) {
          await Nube.guardarRegistro('camiones', Object.assign({}, c, { activo: false }), c.version);
          construirEstado();
          toast(`"${c.nombre}" quedó inactivo.`);
          renderizar();
        }
        return;
      }
      const tarifas = tarifasDeCamion(c.id);
      const ok = await confirmar({
        titulo: `Eliminar "${c.nombre}"`,
        mensaje: tarifas.length ? `También se eliminarán sus ${tarifas.length} tarifa(s).` : 'No tiene viajes ni tarifas asociadas.',
        textoConfirmar: 'Eliminar', peligro: true
      });
      if (!ok) return;
      await Nube.eliminarRegistro('camiones', c.id);
      construirEstado();
      toast('Tipo de camión eliminado.');
      renderizar();
    } catch (err) {
      toast(mensajeError(err, 'No se pudo completar'), 'error');
      refrescarTrasError(err);
    }
  }

  async function editarTarifa(t, camionId) {
    if (!S.camiones.length) { toast('Primero crea un tipo de camión.', 'aviso'); return; }
    let guardada = null;
    const ok = await dialogoFormulario({
      titulo: t ? 'Editar tarifa' : 'Nueva tarifa',
      descripcion: 'Montos netos salvo que indiques "Incluye IVA". Si no está claro, usa "IVA por confirmar".',
      campos: [
        { nombre: 'camionId', etiqueta: 'Tipo de camión', tipo: 'select', obligatorio: true, opciones: S.camiones.map(c => [c.id, c.nombre]) },
        { nombre: 'nombre', etiqueta: 'Nombre de la tarifa', tipo: 'texto', obligatorio: true, ayuda: 'Ej.: Por kilómetro, Vuelta en Santiago' },
        { nombre: 'modalidad', etiqueta: 'Modalidad', tipo: 'select', obligatorio: true, opciones: [['km', 'Por kilómetro'], ['fija', 'Tarifa fija']] },
        { nombre: 'monto', etiqueta: 'Monto', tipo: 'monto', obligatorio: true, prefijo: '$' },
        { nombre: 'ivaTratamiento', etiqueta: 'IVA', tipo: 'select', obligatorio: true, opciones: [['neto', 'Neto: el IVA se agrega aparte'], ['incluido', 'El monto incluye IVA'], ['pendiente', 'IVA por confirmar']] },
        { nombre: 'vigenciaDesde', etiqueta: 'Vigente desde', tipo: 'fecha', obligatorio: true },
        { nombre: 'vigenciaHasta', etiqueta: 'Vigente hasta', tipo: 'fecha', ayuda: 'Opcional.' },
        { nombre: 'activa', etiqueta: 'Activa (se sugiere en viajes nuevos)', tipo: 'checkbox' },
        { nombre: 'notas', etiqueta: 'Notas', tipo: 'textarea' }
      ],
      valores: t || { camionId, modalidad: 'km', ivaTratamiento: 'pendiente', vigenciaDesde: hoyISO(), activa: true },
      validar: d => {
        const e = {};
        if (d.vigenciaDesde && d.vigenciaHasta && d.vigenciaHasta < d.vigenciaDesde) e.vigenciaHasta = 'Debe ser igual o posterior a "vigente desde".';
        return e;
      },
      alGuardar: async d => {
        try {
          guardada = await Nube.guardarRegistro('tarifas', C.normalizarTarifa(Object.assign({}, t || {}, d, { id: t ? t.id : C.generarId() })), t ? t.version : null);
        } catch (err) { throw errorEnDialogo(err, 'No se pudo guardar la tarifa'); }
      }
    });
    if (!ok) return;
    construirEstado();
    toast(t ? 'Tarifa actualizada. Los viajes anteriores conservan su copia.' : 'Tarifa creada.');
    // Resolver viajes que quedaron "por confirmar" con esta tarifa.
    if (t && t.ivaTratamiento === 'pendiente' && guardada && guardada.ivaTratamiento !== 'pendiente') {
      const afectados = S.viajes.filter(v => v.tarifaRef && v.tarifaRef.id === t.id && !v.netoConfirmado);
      if (afectados.length && guardada.ivaTratamiento === 'neto') {
        const confirmarViajes = await confirmar({
          titulo: 'Confirmar viajes anteriores',
          mensaje: `${afectados.length} viaje(s) usaron esta tarifa con el IVA por confirmar. ¿Marcarlos como montos netos confirmados?`,
          textoConfirmar: 'Marcar como confirmados', textoCancelar: 'Dejar como están'
        });
        if (confirmarViajes) {
          try {
            const n = await Nube.confirmarViajesTarifa(t.id);
            construirEstado();
            toast(`${n} viaje(s) marcados como confirmados.`);
          } catch (err) {
            toast(mensajeError(err, 'No se pudieron confirmar los viajes'), 'error');
          }
        }
      } else if (afectados.length && guardada.ivaTratamiento === 'incluido') {
        toast(`${afectados.length} viaje(s) usaron esta tarifa como neta. Revísalos y ajusta la tarifa neta si corresponde.`, 'aviso', {
          duracion: 12000, accion: { texto: 'Ver viajes', fn: () => navegar(enlaceViajes({ revision: 'iva' })) }
        });
      }
    }
    renderizar();
  }

  async function eliminarTarifa(t) {
    const n = S.viajes.filter(v => v.tarifaRef && v.tarifaRef.id === t.id).length;
    const ok = await confirmar({
      titulo: `Eliminar la tarifa "${t.nombre}"`,
      mensaje: n ? `${n} viaje(s) la usaron; conservan su copia y no cambian.` : 'Ningún viaje la usa.',
      textoConfirmar: 'Eliminar tarifa', peligro: true
    });
    if (!ok) return;
    try {
      await Nube.eliminarRegistro('tarifas', t.id);
      construirEstado();
      toast('Tarifa eliminada.');
      renderizar();
    } catch (err) {
      toast(mensajeError(err, 'No se pudo eliminar la tarifa'), 'error');
      refrescarTrasError(err);
    }
  }

  /* =======================================================================
     8h. Informes
     ======================================================================= */
  function vistaInformes() {
    if (!S.periodoInformes) S.periodoInformes = periodoInicial('anio');
    const cont = h('div', { class: 'informes' });
    const pintar = () => reemplazar(cont, contenidoInformes(S.periodoInformes));
    pintar();
    return {
      titulo: 'Informes',
      nodo: h('div', null,
        cabeceraVista('Informes', {
          subtitulo: 'Los montos consideran viajes realizados. El resultado estimado suma también los planificados.'
        }),
        h('section', { class: 'barra-periodo', 'aria-label': 'Período del informe' },
          selectorPeriodo(S.periodoInformes, ['mes', 'anio', 'rango', 'todo'], p => { S.periodoInformes = p; pintar(); })),
        cont)
    };
  }

  function listaMeses(p, lista) {
    if (p.modo === 'mes') return [p.mes];
    if (p.modo === 'anio') return Array.from({ length: 12 }, (_, i) => `${p.anio}-${pad(i + 1)}`);
    const fechas = lista.map(v => v.fecha).filter(Boolean).sort();
    let ini = (p.modo === 'rango' && p.desde) ? p.desde.slice(0, 7) : (fechas[0] || '').slice(0, 7);
    let fin = (p.modo === 'rango' && p.hasta) ? p.hasta.slice(0, 7) : (fechas[fechas.length - 1] || '').slice(0, 7);
    if (!ini || !fin) return [];
    const meses = [];
    for (let m = ini; m <= fin && meses.length < 120; m = moverMes(m, 1)) meses.push(m);
    return meses;
  }

  function contenidoInformes(p) {
    const r = rangoDePeriodo(p);
    const lista = S.viajes.filter(v => enRango(v, r));
    const res = C.resumirPeriodo(lista);
    const R = res.realizados;
    const etiqueta = etiquetaPeriodo(p);
    const realizados = lista.filter(v => v.estado === 'realizado');

    const stat = (etq, valor, t) => h('div', { class: 'stat' }, h('span', { class: 'stat-etq' }, etq), h('span', { class: `stat-valor ${t || ''}` }, valor));
    const resumen = h('section', { class: 'tarjeta', 'aria-labelledby': 'inf-resumen' },
      h('h2', { id: 'inf-resumen' }, `Resumen · ${etiqueta}`),
      lista.some(v => v.demo) ? h('p', { class: 'texto-demo' }, `Incluye ${lista.filter(v => v.demo).length} viaje(s) de demostración.`) : null,
      h('div', { class: 'stats' },
        stat('Viajes realizados', fmtEntero.format(R.viajes)),
        stat('Km cobrables', km(R.km)),
        stat('Ingreso neto', clp(R.ingresoNeto)),
        stat('IVA (aparte)', clp(R.iva)),
        stat('Costos directos', clp(R.costosDirectos)),
        stat('Margen bruto', clp(R.margenBruto), tono(R.margenBruto)),
        stat('Margen %', pct(R.margenPct), tono(R.margenBruto)),
        stat('Resultado estimado', clp(res.resultadoEstimado), tono(res.resultadoEstimado))),
      h('p', { class: 'texto-suave' }, `${res.planificados.viajes} planificado(s) por ${clp(res.planificados.margenBruto)} de margen estimado · ${res.cancelados} cancelado(s) sin efecto en montos.`));

    // Resumen mensual
    const meses = listaMeses(p, lista);
    const porMes = new Map(C.agruparYResumir(lista.filter(v => v.fecha), v => v.fecha.slice(0, 7)).map(g => [g.clave, g.resumen]));
    const vacio = C.resumirPeriodo([]);
    const filasMes = meses.map(m => ({ mes: m, res: porMes.get(m) || vacio }));
    const th = (t, num) => h('th', { scope: 'col', class: num ? 'num' : null }, t);
    const td = (t, clase) => h('td', { class: `num ${clase || ''}`.trim() }, t);
    const tablaMensual = meses.length ? h('div', { class: 'tabla-scroll', tabindex: '0', role: 'region', 'aria-label': 'Tabla de resumen mensual' },
      h('table', { class: 'tabla' },
        h('caption', { class: 'visualmente-oculto' }, `Resumen mensual · ${etiqueta}`),
        h('thead', null, h('tr', null, th('Mes'), th('Realizados', 1), th('Km', 1), th('Ingreso neto', 1), th('IVA', 1),
          th('Costos directos', 1), th('Margen bruto', 1), th('Margen %', 1), th('Resultado estimado', 1))),
        h('tbody', null, filasMes.map(({ mes, res: x }) => h('tr', null,
          h('th', { scope: 'row' }, nombreMes(mes)),
          td(fmtEntero.format(x.realizados.viajes)), td(numero(x.realizados.km)), td(clp(x.realizados.ingresoNeto)),
          td(clp(x.realizados.iva)), td(clp(x.realizados.costosDirectos)),
          td(clp(x.realizados.margenBruto), tono(x.realizados.margenBruto)), td(pct(x.realizados.margenPct)),
          td(clp(x.resultadoEstimado), tono(x.resultadoEstimado))))),
        h('tfoot', null, h('tr', null,
          h('th', { scope: 'row' }, 'Total'),
          td(fmtEntero.format(R.viajes)), td(numero(R.km)), td(clp(R.ingresoNeto)), td(clp(R.iva)), td(clp(R.costosDirectos)),
          td(clp(R.margenBruto), tono(R.margenBruto)), td(pct(R.margenPct)), td(clp(res.resultadoEstimado), tono(res.resultadoEstimado))))))
      : h('p', { class: 'texto-suave' }, 'No hay viajes con fecha en el período.');
    const seccionMensual = h('section', { class: 'tarjeta', 'aria-labelledby': 'inf-mensual' },
      h('h2', { id: 'inf-mensual' }, 'Resumen mensual'),
      meses.length > 1 ? graficoBarras(filasMes.map(f => ({ etiqueta: nombreMesCorto(f.mes), valor: f.res.realizados.margenBruto })),
        { titulo: 'Margen bruto por mes (viajes realizados)' }) : null,
      tablaMensual);

    // Comparaciones
    const porCamion = C.agruparYResumir(realizados, v => v.camionId || `nombre:${v.camionNombre}`).map(g => {
      const cam = S.camiones.find(c => c.id === g.clave);
      const nombre = cam ? cam.nombre : (realizados.find(v => (v.camionId || `nombre:${v.camionNombre}`) === g.clave) || {}).camionNombre || 'Sin tipo';
      return { nombre, r: g.resumen.realizados };
    });
    const porModalidad = [
      { nombre: 'Camión propio', r: res.porModalidad.propio },
      { nombre: 'Tercerizado', r: res.porModalidad.tercerizado }
    ];
    const seccionCamion = h('section', { class: 'tarjeta', 'aria-labelledby': 'inf-camion' },
      h('h2', { id: 'inf-camion' }, 'Comparación por tipo de camión'),
      porCamion.length ? tablaComparativa(porCamion, 'Tipo de camión', `Comparación por tipo de camión · ${etiqueta}`) : h('p', { class: 'texto-suave' }, 'Sin viajes realizados en el período.'));
    const seccionModalidad = h('section', { class: 'tarjeta', 'aria-labelledby': 'inf-modalidad' },
      h('h2', { id: 'inf-modalidad' }, 'Operación propia vs tercerizada'),
      tablaComparativa(porModalidad, 'Modalidad', `Operación propia vs tercerizada · ${etiqueta}`),
      h('div', { class: 'aviso aviso-suave' }, icono('info'),
        h('p', null, 'El margen de los viajes propios no descuenta costos fijos del camión (remuneraciones, mantención, seguros, permisos, depreciación ni financiamiento). Para evaluar la compra de un camión, compara contra esos costos mensuales, no solo contra el margen tercerizado.')));

    const seccionExportar = h('section', { class: 'tarjeta', 'aria-labelledby': 'inf-exportar' },
      h('h2', { id: 'inf-exportar' }, 'Exportar'),
      h('p', { class: 'texto-suave' }, `CSV separado por punto y coma, listo para Excel en español. Incluye los ${lista.length} viaje(s) del período (todos los estados).`),
      h('div', { class: 'grupo-botones' },
        boton({ texto: 'CSV de viajes', icono: 'descargar', clase: 'btn btn-secundario', onClick: () => exportarCSVViajes(lista, etiqueta) }),
        boton({ texto: 'CSV de gastos', icono: 'descargar', clase: 'btn btn-secundario', onClick: () => exportarCSVGastos(lista, etiqueta) }),
        enlaceBoton({ texto: 'Respaldo completo', href: '#/respaldo', icono: 'respaldo', clase: 'btn btn-fantasma' })));

    return h('div', null, resumen, seccionMensual, seccionCamion, seccionModalidad, seccionExportar);
  }

  function tablaComparativa(filas, etiquetaColumna, caption) {
    const th = (t, num) => h('th', { scope: 'col', class: num ? 'num' : null }, t);
    const td = (t, clase) => h('td', { class: `num ${clase || ''}`.trim() }, t);
    const porKm = (monto, kms) => (kms > 0 ? clp(monto / kms) : '—');
    return h('div', { class: 'tabla-scroll', tabindex: '0', role: 'region', 'aria-label': caption },
      h('table', { class: 'tabla' },
        h('caption', { class: 'visualmente-oculto' }, caption),
        h('thead', null, h('tr', null, th(etiquetaColumna), th('Viajes', 1), th('Km', 1), th('Ingreso neto', 1), th('Costos directos', 1),
          th('Margen bruto', 1), th('Margen %', 1), th('Ingreso por km', 1), th('Margen por km', 1))),
        h('tbody', null, filas.map(({ nombre, r }) => h('tr', null,
          h('th', { scope: 'row' }, nombre),
          td(fmtEntero.format(r.viajes)), td(numero(r.km)), td(clp(r.ingresoNeto)), td(clp(r.costosDirectos)),
          td(clp(r.margenBruto), tono(r.margenBruto)), td(pct(r.margenPct)),
          td(porKm(r.ingresoNeto, r.km)), td(porKm(r.margenBruto, r.km), tono(r.margenBruto)))))));
  }

  /** Gráfico de barras SVG propio con etiquetas de valor siempre visibles. */
  function graficoBarras(datos, { titulo }) {
    const NS = 'http://www.w3.org/2000/svg';
    const idT = uid('graf');
    const anchoBarra = 44;
    const sep = 20;
    const alto = 230;
    const sup = 30;
    const inf = 34;
    const ancho = Math.max(320, datos.length * (anchoBarra + sep) + sep);
    const max = Math.max(0, ...datos.map(d => d.valor));
    const min = Math.min(0, ...datos.map(d => d.valor));
    const rango = (max - min) || 1;
    const util = alto - sup - inf;
    const y = v => sup + ((max - v) / rango) * util;
    const y0 = y(0);
    const el = (tag, attrs, texto) => {
      const e = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
      if (texto !== undefined) e.textContent = texto;
      return e;
    };
    const svg = el('svg', { viewBox: `0 0 ${ancho} ${alto}`, width: ancho, height: alto, role: 'img', 'aria-labelledby': idT, class: 'grafico-svg' });
    svg.appendChild(el('line', { x1: 0, x2: ancho, y1: y0, y2: y0, class: 'grafico-eje' }));
    datos.forEach((d, i) => {
      const x = sep + i * (anchoBarra + sep);
      const yv = y(d.valor);
      const altoBarra = Math.max(d.valor === 0 ? 0 : 2, Math.abs(yv - y0));
      const top = d.valor >= 0 ? y0 - altoBarra : y0;
      svg.appendChild(el('rect', { x, y: top, width: anchoBarra, height: altoBarra, rx: 3, class: d.valor < 0 ? 'grafico-barra neg' : 'grafico-barra' }));
      const yEtq = d.valor >= 0 ? top - 7 : top + altoBarra + 15;
      svg.appendChild(el('text', { x: x + anchoBarra / 2, y: Math.max(12, Math.min(alto - inf - 2, yEtq)), class: 'grafico-valor', 'text-anchor': 'middle' }, d.valor === 0 ? '$0' : clpCorto(d.valor)));
      svg.appendChild(el('text', { x: x + anchoBarra / 2, y: alto - 10, class: 'grafico-etiqueta', 'text-anchor': 'middle' }, d.etiqueta));
    });
    return h('figure', { class: 'grafico' },
      h('figcaption', { id: idT }, titulo),
      h('div', { class: 'grafico-scroll' }, svg));
  }

  /* =======================================================================
     10. Exportación CSV
     ======================================================================= */
  function celdaCSV(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100).replace('.', ',');
    if (typeof v === 'boolean') return v ? 'Sí' : 'No';
    let t = String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // evita fórmulas al abrir en Excel
    if (/[;"\n\r]/.test(t)) t = `"${t.replace(/"/g, '""')}"`;
    return t;
  }

  function generarCSV(encabezados, filas) {
    return '﻿' + [encabezados].concat(filas).map(f => f.map(celdaCSV).join(';')).join('\r\n');
  }

  const slug = t => sinTildes(t).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'periodo';

  function exportarCSVViajes(lista, etiqueta) {
    if (!lista.length) { toast('No hay viajes en el período para exportar.', 'aviso'); return; }
    const enc = ['Código', 'Fecha', 'Estado', 'Cliente', 'Sitio u obra', 'Localidad', 'Dirección', 'Origen', 'Destino', 'Contacto',
      'Ruta frecuente', 'Tipo de camión', 'Modalidad', 'Km cobrables', 'Forma de cobro', 'Tarifa neta aplicada', 'Tarifa de catálogo',
      'IVA tarifa de catálogo', 'Neto confirmado', 'Ingreso base', 'Cobros adicionales', 'Ingreso neto', 'IVA %', 'IVA', 'Total con IVA',
      'Peajes estimados', 'Peajes reales', 'Peajes aplicados', 'Peaje es estimado', 'Combustible', 'Comida', 'Costo transportista',
      'Pago al chofer', 'Otros gastos', 'Costos directos', 'Margen bruto', 'Margen %', 'Fotos guía', 'Fotos entrega', 'Demostración',
      'Descripción', 'Observaciones', 'Creado', 'Creado por', 'Actualizado', 'Actualizado por'];
    const filas = ordenarViajes(lista, 'fecha-asc').map(v => {
      const c = C.calcularViaje(v);
      const a = S.adj.porViaje.get(v.id) || { guia: 0, entrega: 0 };
      return [v.codigo, v.fecha, ETQ.estado[v.estado], v.cliente, v.sitio, v.localidad, v.direccion, v.origen, v.destino, v.contacto,
        v.rutaNombre, v.camionNombre, ETQ.modalidad[v.modalidad], v.km, ETQ.formaCobro[v.formaCobro], v.tarifa,
        v.tarifaRef ? `${v.tarifaRef.nombre} (${v.tarifaRef.monto})` : 'Manual', v.tarifaRef ? ETQ.iva[v.tarifaRef.ivaTratamiento] : '',
        v.netoConfirmado, c.ingresoBase, c.cobrosAdicionales, c.ingresoNeto, c.ivaPct, c.iva, c.totalConIva,
        v.peajesEstimados, v.peajesReales, c.peajes, c.peajesEsEstimado, c.combustible, c.comida, c.costoTransportista,
        c.costoChofer, c.otrosGastos, c.costosDirectos, c.margenBruto, c.margenPct === null ? null : Math.round(c.margenPct * 10) / 10,
        a.guia, a.entrega, v.demo, v.descripcion, v.notas, v.creado, nombreUsuario(v.creadoPor), v.actualizado, nombreUsuario(v.actualizadoPor)];
    });
    descargarBlob(new Blob([generarCSV(enc, filas)], { type: 'text/csv;charset=utf-8' }), `viajes-${slug(etiqueta)}-${marcaTiempoArchivo()}.csv`);
    toast(`CSV de viajes descargado (${filas.length} filas).`);
  }

  function exportarCSVGastos(lista, etiqueta) {
    const enc = ['Código', 'Fecha', 'Estado', 'Sitio u obra', 'Localidad', 'Modalidad', 'Tipo de gasto', 'Concepto', 'Monto', 'Observación', 'Cuenta en resultados'];
    const filas = [];
    ordenarViajes(lista, 'fecha-asc').forEach(v => {
      const c = C.calcularViaje(v);
      const cuenta = v.estado === 'realizado' ? 'Sí' : v.estado === 'planificado' ? 'Solo en resultado estimado' : 'No (cancelado)';
      const base = [v.codigo, v.fecha, ETQ.estado[v.estado], v.sitio, v.localidad, ETQ.modalidad[v.modalidad]];
      if (c.peajes || c.peajesFuente !== 'ninguno') filas.push(base.concat(['Peajes', 'Peajes', c.peajes, c.peajesEsEstimado ? 'Estimado' : 'Real', cuenta]));
      if (c.combustible) filas.push(base.concat(['Combustible', 'Combustible', c.combustible, '', cuenta]));
      if (c.comida) filas.push(base.concat(['Comida', 'Comida', c.comida, '', cuenta]));
      if (v.modalidad === 'tercerizado') {
        filas.push(base.concat(['Transportista', 'Transportista tercero', c.costoTransportista,
          v.transportista.modo === 'km' ? `${v.km} km × ${v.transportista.tarifaKm}` : 'Monto fijo', cuenta]));
      }
      if (c.costoChofer) {
        filas.push(base.concat(['Chofer', 'Pago al chofer', c.costoChofer,
          v.chofer.modo === 'km' ? `${v.km} km × ${v.chofer.tarifaKm}` : 'Monto fijo', cuenta]));
      }
      v.otrosGastos.forEach(g => filas.push(base.concat(['Otro gasto', g.concepto, g.monto, '', cuenta])));
    });
    if (!filas.length) { toast('No hay gastos en el período para exportar.', 'aviso'); return; }
    descargarBlob(new Blob([generarCSV(enc, filas)], { type: 'text/csv;charset=utf-8' }), `gastos-${slug(etiqueta)}-${marcaTiempoArchivo()}.csv`);
    toast(`CSV de gastos descargado (${filas.length} filas).`);
  }

  /* =======================================================================
     8i. Respaldo e importación
     ======================================================================= */
  function vistaRespaldo() {
    const admin = esAdmin();
    const reales = S.viajes.filter(v => !v.demo).length;
    const demo = S.viajes.length - reales;
    const ult = S.cfg.ultimoRespaldo;
    const cola = Nube.estadoCola();
    const zonaImportacion = h('div', { class: 'zona-restauracion' });
    const dato = (etq, valor) => h('div', { class: 'dato' }, h('dt', null, etq), h('dd', null, valor));

    const btnDescargar = boton({
      texto: 'Descargar copia (.json)', icono: 'descargar', clase: 'btn btn-primario',
      onClick: () => {
        const d = Nube.datos();
        const copia = {
          app: DB.APP_ID, formato: DB.FORMATO_RESPALDO, versionApp: APP_VERSION, exportado: new Date().toISOString(),
          datos: { viajes: d.viajes, rutas: d.rutas, camiones: d.camiones, tarifas: d.tarifas, adjuntos: d.adjuntos }
        };
        const json = JSON.stringify(copia);
        descargarBlob(new Blob([json], { type: 'application/json' }), `copia-gestion-transporte-${marcaTiempoArchivo()}.json`);
        guardarPreferenciaLocal('ultimoRespaldo', new Date().toISOString());
        construirEstado();
        toast(`Copia descargada (${tamanoLegible(json.length)}).`);
        renderizar({ silencioso: true });
      }
    });

    const inputArchivo = h('input', { type: 'file', id: 'resp-archivo', accept: '.json,application/json', class: 'visualmente-oculto entrada-archivo' });
    inputArchivo.addEventListener('change', async () => {
      const archivo = inputArchivo.files && inputArchivo.files[0];
      inputArchivo.value = '';
      if (!archivo) return;
      let obj = null;
      let error = null;
      try {
        if (archivo.size > 200 * 1024 * 1024) throw new Error('El archivo supera 200 MB.');
        obj = JSON.parse(await archivo.text());
      } catch (err) {
        error = err instanceof SyntaxError ? 'El archivo no es un JSON válido.' : err.message;
      }
      const validado = error ? { ok: false, errores: [error], avisos: [], datos: null, resumen: null } : DB.validarRespaldo(obj);
      S.restauracion = { nombre: archivo.name, validado };
      pintarImportacion();
    });

    function pintarImportacion() {
      if (!S.restauracion) { vaciar(zonaImportacion); return; }
      const { nombre, validado: val, resultado } = S.restauracion;
      if (resultado) {
        reemplazar(zonaImportacion, h('div', { class: 'aviso aviso-ok', role: 'status' }, icono('ok'),
          h('div', null,
            h('p', null, h('strong', null, 'Importación completa. '),
              `${resultado.viajesAgregados} viaje(s) agregados, ${resultado.viajesActualizados} actualizados, ${resultado.viajesSinCambio} sin cambios, ${resultado.catalogoAgregados} registro(s) de catálogo y ${resultado.adjuntosAgregados} foto(s).`),
            resultado.renumerados.length ? h('p', null, `Se asignaron códigos nuevos a ${resultado.renumerados.length} viaje(s): ${resultado.renumerados.map(x => `${x.anterior || 'sin código'} → ${x.nuevo}`).join(', ')}.`) : null)));
        return;
      }
      if (!val.ok) {
        reemplazar(zonaImportacion, h('div', { class: 'aviso aviso-error', role: 'alert' }, icono('alerta'),
          h('div', null, h('p', null, h('strong', null, `No se puede importar "${nombre}".`)),
            h('ul', null, val.errores.map(e => h('li', null, e))))));
        return;
      }
      const rs = val.resumen;
      const btnImportar = boton({ texto: 'Importar y combinar', icono: 'subir', clase: 'btn btn-primario', onClick: importar });
      const avisos = val.avisos.slice(0, 15);
      reemplazar(zonaImportacion, h('div', { class: 'tarjeta vista-previa', 'aria-labelledby': 'resp-previa' },
        h('h3', { id: 'resp-previa' }, `Vista previa: ${nombre}`),
        h('dl', { class: 'datos datos-compactos' },
          dato('Creado', rs.exportado ? fechaHora(rs.exportado) : '—'),
          dato('Viajes', `${rs.viajes}${rs.viajesDemo ? ` (${rs.viajesDemo} de demostración)` : ''}`),
          dato('Fechas', rs.desde ? `${fechaCorta(rs.desde)} al ${fechaCorta(rs.hasta)}` : '—'),
          dato('Rutas', String(rs.rutas)),
          dato('Tipos de camión', String(rs.camiones)),
          dato('Tarifas', String(rs.tarifas)),
          dato('Fotos incluidas', `${rs.adjuntos} (${tamanoLegible(rs.bytesAdjuntos)})`)),
        avisos.length ? h('div', { class: 'aviso aviso-suave' }, icono('info'), h('div', null,
          h('p', null, h('strong', null, 'Avisos de la validación')),
          h('ul', null, avisos.map(a => h('li', null, a))),
          val.avisos.length > avisos.length ? h('p', null, `y ${val.avisos.length - avisos.length} aviso(s) más.`) : null)) : null,
        h('p', { class: 'texto-suave' }, 'Se agregan los registros nuevos. Si un registro ya existe, se conserva el modificado más recientemente. Nada se borra.'),
        h('div', { class: 'grupo-botones' },
          h('button', { type: 'button', class: 'btn btn-secundario', onclick: () => { S.restauracion = null; pintarImportacion(); } }, 'Cancelar'),
          btnImportar)));

      async function importar() {
        const ok = await confirmar({
          titulo: 'Importar datos',
          mensaje: `Se combinarán ${rs.viajes} viaje(s) del archivo con los datos compartidos de todos los usuarios.`,
          textoConfirmar: 'Importar'
        });
        if (!ok) return;
        btnImportar.disabled = true;
        try {
          const resultado = await Nube.importar(val.datos);
          construirEstado();
          S.restauracion = { nombre, validado: val, resultado };
          toast('Importación completa.');
          renderizar();
        } catch (err) {
          toast(mensajeError(err, 'No se pudo importar'), 'error');
          btnImportar.disabled = false;
        }
      }
    }
    pintarImportacion();
    if (S.restauracion && S.restauracion.resultado) S.restauracion = null;

    return {
      titulo: 'Respaldo',
      nodo: h('div', null,
        cabeceraVista('Respaldo', { subtitulo: 'Los datos oficiales están en la Google Sheet y las fotos en Google Drive del administrador. Google guarda el historial de versiones de la planilla (Archivo → Historial de versiones).' }),
        h('section', { class: 'tarjeta', 'aria-labelledby': 'resp-estado' },
          h('h2', { id: 'resp-estado' }, 'Estado de los datos'),
          h('dl', { class: 'datos datos-compactos' },
            dato('Viajes', `${reales} real(es)${demo ? ` + ${demo} de demostración` : ''}`),
            dato('Rutas frecuentes', String(S.rutas.length)),
            dato('Tipos de camión', String(S.camiones.length)),
            dato('Tarifas', String(S.tarifas.length)),
            dato('Fotos', `${S.adj.total} (${tamanoLegible(S.adj.bytes)})`),
            dato('Pendientes en este dispositivo', String(cola.total)),
            dato('Última copia descargada aquí', ult ? fechaHora(ult) : 'Nunca')),
          h('div', { class: 'grupo-botones' }, btnDescargar),
          h('p', { class: 'texto-suave' }, 'La copia .json trae viajes, rutas, camiones, tarifas y la referencia de las fotos (las imágenes quedan en Drive). Sirve como respaldo extra o para mover datos a otra planilla.')),
        admin ? h('section', { class: 'tarjeta', 'aria-labelledby': 'resp-importar' },
          h('h2', { id: 'resp-importar' }, 'Importar datos'),
          h('p', { class: 'texto-suave' }, 'Para cargar planillas históricas o una copia anterior. Primero verás una vista previa; nada cambia hasta que confirmes.'),
          h('div', { class: 'fotos-agregar' }, inputArchivo,
            h('label', { for: 'resp-archivo', class: 'btn btn-secundario' }, icono('subir'), h('span', null, 'Elegir archivo (.json)'))),
          zonaImportacion) : null,
        h('section', { class: 'tarjeta', 'aria-labelledby': 'resp-csv' },
          h('h2', { id: 'resp-csv' }, 'Exportar a planilla'),
          h('p', { class: 'texto-suave' }, 'Los CSV de viajes y gastos se generan desde Informes, según el período elegido. También puedes abrir directamente la Google Sheet.'),
          enlaceBoton({ texto: 'Ir a Informes', href: '#/informes', icono: 'informes', clase: 'btn btn-secundario' })))
    };
  }

  /* =======================================================================
     8j. Ajustes
     ======================================================================= */
  async function vistaAjustes() {
    const admin = esAdmin();
    const ses = Nube.sesion();
    let estimado = null;
    let persistente = null;
    let local = null;
    try { if (navigator.storage && navigator.storage.estimate) estimado = await navigator.storage.estimate(); } catch (err) { estimado = null; }
    try { if (navigator.storage && navigator.storage.persisted) persistente = await navigator.storage.persisted(); } catch (err) { persistente = null; }
    try { local = await DB.estimarUso(); } catch (err) { local = null; }
    const seccion = (id, titulo, ...contenido) => h('section', { class: 'tarjeta', 'aria-labelledby': id }, h('h2', { id }, titulo), contenido);
    const dato = (etq, valor) => h('div', { class: 'dato' }, h('dt', null, etq), h('dd', null, valor));

    // Cuenta
    const inActual = h('input', { type: 'password', id: 'aj-clave-actual', autocomplete: 'current-password', required: true });
    const inNueva = h('input', { type: 'password', id: 'aj-clave-nueva', autocomplete: 'new-password', required: true, minlength: 8, 'aria-describedby': 'aj-clave-ayuda' });
    const inRepetir = h('input', { type: 'password', id: 'aj-clave-repetir', autocomplete: 'new-password', required: true });
    const errClave = h('p', { class: 'error', role: 'alert', hidden: true });
    const btnClave = h('button', { type: 'submit', class: 'btn btn-secundario' }, 'Cambiar clave');
    const formClave = h('form', { class: 'form-ajuste', novalidate: true },
      h('div', { class: 'rejilla-campos' },
        h('div', { class: 'campo completo' }, h('label', { for: 'aj-clave-actual' }, 'Clave actual'), inActual),
        h('div', { class: 'campo' }, h('label', { for: 'aj-clave-nueva' }, 'Clave nueva'), inNueva,
          h('p', { class: 'ayuda', id: 'aj-clave-ayuda' }, 'Mínimo 8 caracteres.')),
        h('div', { class: 'campo' }, h('label', { for: 'aj-clave-repetir' }, 'Repite la clave nueva'), inRepetir)),
      errClave,
      h('div', { class: 'grupo-botones' }, btnClave));
    formClave.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fallo = msg => { errClave.textContent = msg; errClave.hidden = false; };
      errClave.hidden = true;
      if (!inActual.value || !inNueva.value) return fallo('Completa la clave actual y la nueva.');
      if (inNueva.value.length < 8) return fallo('La clave nueva debe tener al menos 8 caracteres.');
      if (inNueva.value !== inRepetir.value) return fallo('Las claves nuevas no coinciden.');
      btnClave.disabled = true;
      try {
        await Nube.cambiarClave(inActual.value, inNueva.value);
        formClave.reset();
        toast('Clave actualizada.');
      } catch (err) {
        fallo(mensajeError(err, 'No se pudo cambiar'));
      } finally {
        btnClave.disabled = false;
      }
    });

    // Ajustes compartidos (administrador)
    const inNombre = h('input', { type: 'text', id: 'aj-nombre', maxlength: 40, required: true, value: S.cfg.nombreApp || NOMBRE_POR_DEFECTO, disabled: !admin, 'aria-describedby': 'aj-nombre-ayuda' });
    const inIva = h('input', { type: 'text', id: 'aj-iva', inputmode: 'decimal', maxlength: 6, value: decimalParaInput(S.cfg.ivaPct), disabled: !admin });
    const chkIva = h('input', { type: 'checkbox', id: 'aj-iva-defecto', checked: S.cfg.ivaPorDefecto !== false, disabled: !admin });
    const inChofer = h('input', { type: 'text', id: 'aj-chofer', inputmode: 'numeric', maxlength: 12, value: montoParaInput(S.cfg.choferTarifaKm), disabled: !admin, 'aria-describedby': 'aj-chofer-ayuda' });
    const errComp = h('p', { class: 'error', role: 'alert', hidden: true });
    const formComp = h('form', { class: 'form-ajuste', novalidate: true },
      h('div', { class: 'rejilla-campos' },
        h('div', { class: 'campo completo' }, h('label', { for: 'aj-nombre' }, 'Nombre de la aplicación'), inNombre,
          h('p', { class: 'ayuda', id: 'aj-nombre-ayuda' }, 'Identidad provisoria. El nombre del ícono instalado se define en manifest.json.')),
        h('div', { class: 'campo' }, h('label', { for: 'aj-iva' }, 'IVA (%)'),
          h('div', { class: 'entrada-compuesta' }, inIva, h('span', { class: 'sufijo', 'aria-hidden': 'true' }, '%'))),
        h('div', { class: 'campo' }, h('label', { for: 'aj-chofer' }, 'Pago sugerido al chofer por km'),
          h('div', { class: 'entrada-compuesta' }, h('span', { class: 'prefijo', 'aria-hidden': 'true' }, '$'), inChofer),
          h('p', { class: 'ayuda', id: 'aj-chofer-ayuda' }, 'Se propone en viajes con camión propio; editable en cada viaje.')),
        h('div', { class: 'campo campo-check completo' }, h('div', { class: 'check' }, chkIva, h('label', { for: 'aj-iva-defecto' }, 'Aplicar IVA por defecto en viajes nuevos')))),
      errComp,
      admin ? h('div', { class: 'grupo-botones' }, h('button', { type: 'submit', class: 'btn btn-primario' }, 'Guardar ajustes')) : null);
    formComp.addEventListener('submit', async ev => {
      ev.preventDefault();
      errComp.hidden = true;
      const iva = C.parsearDecimal(inIva.value);
      const chofer = C.parsearMonto(inChofer.value);
      const nombre = inNombre.value.trim();
      const fallo = msg => { errComp.textContent = msg; errComp.hidden = false; };
      if (!nombre) return fallo('Escribe un nombre para la aplicación.');
      if (iva.error || iva.valor === null || iva.valor > 100) return fallo(iva.error || 'El IVA debe estar entre 0 y 100.');
      if (chofer.error || chofer.valor === null) return fallo(chofer.error || 'Indica el pago sugerido al chofer por km.');
      try {
        await Nube.guardarConfig({ nombreApp: nombre, ivaPct: iva.valor, ivaPorDefecto: chkIva.checked, choferTarifaKm: chofer.valor });
        construirEstado();
        toast('Ajustes guardados para todos los usuarios. Los viajes ya registrados no cambian.');
      } catch (err) {
        fallo(mensajeError(err, 'No se pudieron guardar'));
      }
    });

    // Tema (solo este dispositivo)
    const selTema = h('select', { id: 'aj-tema' },
      h('option', { value: 'auto' }, 'Automático (según el sistema)'),
      h('option', { value: 'claro' }, 'Claro'),
      h('option', { value: 'oscuro' }, 'Oscuro'));
    selTema.value = S.cfg.tema || 'auto';
    selTema.addEventListener('change', () => {
      guardarPreferenciaLocal('tema', selTema.value);
      construirEstado();
      aplicarTema(selTema.value);
      toast('Tema actualizado en este dispositivo.');
    });

    // Demostración (administrador)
    const demo = cantidadDemo();
    const accionDemo = !admin ? null : (demo.viajes || demo.rutas)
      ? boton({ texto: 'Eliminar datos de demostración', icono: 'eliminar', clase: 'btn btn-peligro-suave', onClick: eliminarDemoConConfirmacion })
      : boton({
        texto: 'Cargar datos de demostración', icono: 'nuevo', clase: 'btn btn-secundario',
        onClick: async () => {
          const ok = await confirmar({
            titulo: 'Cargar datos de demostración',
            mensaje: 'Se agregarán 6 viajes y 2 rutas marcados como demostración, visibles para todos los usuarios, y se sumarán a los totales hasta que los elimines.',
            textoConfirmar: 'Cargar demostración'
          });
          if (!ok) return;
          try {
            await Nube.cargarDemo();
            construirEstado();
            toast('Datos de demostración cargados.');
            renderizar();
          } catch (err) {
            toast(mensajeError(err, 'No se pudieron cargar'), 'error');
          }
        }
      });

    // Autocomprobación
    const zonaPruebas = h('div', { class: 'zona-pruebas', 'aria-live': 'polite' });
    const correrPruebas = () => {
      const res = C.autocomprobacion();
      const fallas = res.filter(r => !r.ok);
      reemplazar(zonaPruebas,
        h('p', { class: fallas.length ? 'neg' : 'pos' }, h('strong', null,
          fallas.length ? `${fallas.length} de ${res.length} comprobaciones fallaron.` : `${res.length} de ${res.length} comprobaciones correctas.`)),
        h('ul', { class: 'lista-pruebas' }, res.map(r => h('li', { class: r.ok ? 'ok' : 'falla' },
          icono(r.ok ? 'ok' : 'alerta'),
          h('span', null, r.nombre),
          h('span', { class: 'prueba-valor' }, r.ok ? String(r.obtenido) : `esperado ${r.esperado}, obtenido ${r.obtenido}`)))));
    };

    // Almacenamiento y conexión
    const sync = Nube.estadoSync();
    const cola = Nube.estadoCola();
    let servidor = Nube.url();
    try { servidor = new URL(Nube.url()).host; } catch (err) { /* se muestra tal cual */ }
    const usoTexto = estimado && C.esNumero(estimado.usage) ? `${tamanoLegible(estimado.usage)} usados en este dispositivo` : 'El navegador no informa el uso.';
    const btnPersistir = persistente === false && navigator.storage && navigator.storage.persist
      ? boton({
        texto: 'Solicitar almacenamiento persistente', clase: 'btn btn-secundario',
        onClick: async () => {
          let ok = false;
          try { ok = await navigator.storage.persist(); } catch (err) { ok = false; }
          toast(ok ? 'El navegador concedió almacenamiento persistente.' : 'El navegador no lo concedió. Instalar la app ayuda a conservar los pendientes.', ok ? 'ok' : 'aviso');
          if (ok) renderizar({ silencioso: true });
        }
      }) : null;

    const btnActualizar = boton({
      texto: 'Buscar actualización de la app', icono: 'recargar', clase: 'btn btn-secundario',
      onClick: async () => {
        if (!S.sw.registro) { toast('El modo sin conexión no está activo en esta dirección.', 'aviso'); return; }
        try {
          await S.sw.registro.update();
          setTimeout(() => {
            if (S.sw.esperando) toast('Hay una nueva versión lista. Usa "Actualizar ahora".', 'aviso');
            else toast('Ya tienes la versión más reciente.');
          }, 1500);
        } catch (err) {
          toast('No se pudo buscar actualizaciones. Revisa la conexión.', 'aviso');
        }
      }
    });

    return {
      titulo: 'Ajustes',
      nodo: h('div', { class: 'ajustes' },
        cabeceraVista('Ajustes'),
        seccion('aj-s-cuenta', 'Tu cuenta',
          h('dl', { class: 'datos datos-compactos' },
            dato('Nombre', ses.usuario.nombre || ses.usuario.usuario),
            dato('Usuario', ses.usuario.usuario),
            dato('Rol', ETQ.rol[ses.usuario.rol] || ses.usuario.rol)),
          formClave,
          h('div', { class: 'grupo-botones separado' }, boton({ texto: 'Cerrar sesión', clase: 'btn btn-peligro-suave', onClick: cerrarSesionUI }))),
        seccion('aj-s-comp', 'Ajustes compartidos',
          admin ? h('p', { class: 'texto-suave' }, 'Aplican a todos los usuarios.') : h('p', { class: 'texto-suave' }, 'Solo un administrador puede cambiarlos.'),
          formComp),
        seccion('aj-s-tema', 'Apariencia (este dispositivo)', h('div', { class: 'campo' }, h('label', { for: 'aj-tema' }, 'Tema'), selTema)),
        admin ? seccion('aj-s-demo', 'Datos de demostración',
          h('p', null, (demo.viajes || demo.rutas)
            ? `Hay ${demo.viajes} viaje(s) y ${demo.rutas} ruta(s) de demostración, visibles para todos. Se identifican con la etiqueta "Demo" y se incluyen en los totales.`
            : 'No hay datos de demostración cargados.'),
          h('div', { class: 'grupo-botones' }, accionDemo)) : null,
        seccion('aj-s-pruebas', 'Autocomprobación de cálculos',
          h('p', { class: 'texto-suave' }, 'Verifica las fórmulas con casos conocidos, incluido el de la reunión: 1.000 km a $1.650 con transportista a $1.440 → margen $210.000.'),
          h('div', { class: 'grupo-botones' }, boton({ texto: 'Ejecutar autocomprobación', icono: 'ok', clase: 'btn btn-secundario', onClick: correrPruebas })),
          zonaPruebas),
        seccion('aj-s-conexion', 'Conexión y este dispositivo',
          h('dl', { class: 'datos datos-compactos' },
            dato('Servidor', servidor || '—'),
            dato('Última actualización', sync.ultima ? fechaHora(sync.ultima) : 'Nunca'),
            dato('Pendientes de envío', String(cola.total)),
            dato('Fotos guardadas aquí', local ? String(local.imagenes) : '—'),
            dato('Uso', usoTexto),
            dato('Persistencia', persistente === true ? 'Persistente' : persistente === false ? 'No persistente' : 'Sin dato')),
          h('p', { class: 'texto-suave' }, 'Este dispositivo guarda una copia para abrir rápido y trabajar sin señal. Los cambios hechos sin conexión se envían solos al volver la señal.'),
          h('div', { class: 'grupo-botones' },
            boton({ texto: 'Ver sincronización', icono: 'recargar', clase: 'btn btn-secundario', onClick: abrirDialogoSync }),
            btnPersistir)),
        seccion('aj-s-instalar', 'Instalar en el teléfono', bloqueInstalar()),
        seccion('aj-s-version', 'Versión',
          h('p', null, `Versión ${APP_VERSION}. `, S.sw.registro ? 'La app abre sin conexión.' : 'El modo sin conexión se activa al abrir la app desde https.'),
          h('div', { class: 'grupo-botones' }, btnActualizar)))
    };
  }

  /* =======================================================================
     8j-bis. Instalar la app en el teléfono
     Android/Chrome: usa el diálogo nativo (crea una app instalada, WebAPK).
     iPhone/Safari: no hay diálogo; se muestran los pasos.
     ======================================================================= */
  function appInstalada() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function esIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  async function instalarApp() {
    const ev = S.instalar;
    if (!ev) return;
    try {
      await ev.prompt();
      const r = await ev.userChoice;
      if (r && r.outcome === 'accepted') S.instalar = null;
    } catch (err) { /* el navegador ya no permite el diálogo */ }
    renderizar({ silencioso: true });
  }
  function bloqueInstalar() {
    if (appInstalada()) return h('p', null, 'La app está instalada en este dispositivo.');
    if (S.instalar) {
      return h('div', null,
        h('p', null, 'Instálala para abrirla desde el ícono, a pantalla completa y sin conexión.'),
        h('div', { class: 'grupo-botones' }, boton({ texto: 'Instalar app', icono: 'descargar', clase: 'btn btn-primario', onClick: instalarApp })));
    }
    if (esIOS()) {
      return h('ol', { class: 'pasos-instalar' },
        h('li', null, 'Abre esta dirección en Safari.'),
        h('li', null, 'Toca Compartir (el cuadrado con la flecha hacia arriba).'),
        h('li', null, 'Elige "Agregar a inicio" y confirma.'));
    }
    return h('ol', { class: 'pasos-instalar' },
      h('li', null, 'Abre esta dirección en Chrome.'),
      h('li', null, 'Toca el menú ⋮ (arriba a la derecha).'),
      h('li', null, 'Elige "Instalar app" o "Agregar a la pantalla principal".'));
  }

  /* =======================================================================
     8k. Más (menú móvil)
     ======================================================================= */
  function vistaMas() {
    const items = [
      { ruta: '/rutas', texto: 'Rutas frecuentes', desc: 'Km y peajes sugeridos por ruta', icono: 'rutas' },
      { ruta: '/tarifas', texto: 'Camiones y tarifas', desc: 'Tipos de camión, capacidad y tarifas vigentes', icono: 'tarifas' },
      { ruta: '/respaldo', texto: 'Respaldo', desc: 'Copia de los datos e importación', icono: 'respaldo' },
      { ruta: '/ajustes', texto: 'Ajustes', desc: 'Cuenta, clave, IVA, pago al chofer y tema', icono: 'ajustes' }
    ];
    const ses = Nube.sesion();
    return {
      titulo: 'Más',
      nodo: h('div', null,
        cabeceraVista('Más opciones', { subtitulo: ses ? `Sesión de ${ses.usuario.nombre || ses.usuario.usuario}` : '' }),
        h('ul', { class: 'menu-mas' }, items.map(i => h('li', null,
          h('a', { href: `#${i.ruta}`, class: 'menu-mas-enlace' }, icono(i.icono),
            h('span', { class: 'menu-mas-texto' }, h('strong', null, i.texto), h('span', null, i.desc)),
            icono('derecha'))))),
        h('div', { class: 'grupo-botones separado' },
          S.instalar && !appInstalada() ? boton({ texto: 'Instalar app', icono: 'descargar', clase: 'btn btn-primario', onClick: instalarApp }) : null,
          boton({ texto: 'Estado de sincronización', icono: 'recargar', clase: 'btn btn-secundario', onClick: abrirDialogoSync }),
          boton({ texto: 'Cerrar sesión', clase: 'btn btn-peligro-suave', onClick: cerrarSesionUI })))
    };
  }

  /* =======================================================================
     11. Service worker: modo sin conexión y actualización controlada
     ======================================================================= */
  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(reg => {
      S.sw.registro = reg;
      const marcarEsperando = () => {
        if (reg.waiting && navigator.serviceWorker.controller) {
          S.sw.esperando = true;
          actualizarAvisosGlobales();
        }
      };
      marcarEsperando();
      reg.addEventListener('updatefound', () => {
        const nuevo = reg.installing;
        if (!nuevo) return;
        nuevo.addEventListener('statechange', () => { if (nuevo.state === 'installed') marcarEsperando(); });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {
      S.sw.registro = null;
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (S.sw.actualizando) location.reload();
    });
  }

  async function aplicarActualizacion() {
    const reg = S.sw.registro;
    if (!reg || !reg.waiting) { location.reload(); return; }
    if (S.form && S.form.guardarBorrador && S.form.guardarBorrador.pendiente()) await S.form.guardarBorrador.ahora();
    S.sw.actualizando = true;
    reg.waiting.postMessage({ tipo: 'SKIP_WAITING' });
  }

  /* =======================================================================
     12. Arranque
     ======================================================================= */
  function errorFatal(err) {
    reemplazar($('#contenido'), h('div', { class: 'tarjeta error-fatal' },
      h('h1', { class: 'vista-titulo', tabindex: '-1' }, 'No se pudo iniciar la aplicación'),
      h('p', null, err && err.message ? err.message : String(err)),
      h('p', { class: 'texto-suave' }, 'Revisa que el navegador permita guardar datos (no uses modo privado) y recarga la página.'),
      h('button', { type: 'button', class: 'btn btn-primario', onclick: () => location.reload() }, 'Recargar')));
  }

  async function iniciar() {
    aplicarTema(preferenciasLocales().tema);
    construirNavegacion();
    try {
      await Nube.iniciar();
    } catch (err) {
      errorFatal(err);
      return;
    }
    construirEstado();
    const refrescoDiferido = debounce(refrescarSiCorresponde, 250);
    Nube.on('datos', () => { construirEstado(); refrescoDiferido(); });
    Nube.on('cola', () => { construirEstado(); refrescoDiferido(); });
    Nube.on('estado', () => { actualizarIndicadorSync(); actualizarAvisosGlobales(); });
    Nube.on('sesion', ses => {
      actualizarUsuarioUI();
      if (!ses && !S.cerrandoSesion) {
        detenerSondeo();
        S.form = null;
        toast('Tu sesión terminó. Ingresa nuevamente; los cambios pendientes se conservan.', 'aviso', { duracion: 10000 });
        renderizar();
      }
    });
    window.addEventListener('beforeinstallprompt', ev => {
      S.instalar = ev;
      if (location.hash === '#/mas' || location.hash === '#/ajustes') refrescarSiCorresponde();
    });
    window.addEventListener('appinstalled', () => {
      S.instalar = null;
      toast('App instalada. Ábrela desde el ícono "Transporte".');
    });
    window.addEventListener('hashchange', () => renderizar());
    window.addEventListener('online', () => { actualizarAvisosGlobales(); actualizarIndicadorSync(); revisarCambios(); });
    window.addEventListener('offline', () => { actualizarAvisosGlobales(); actualizarIndicadorSync(); });
    window.addEventListener('db-version-cambiada', () => {
      toast('La app se actualizó en otra pestaña. Recarga para continuar.', 'aviso', { duracion: 20000, accion: { texto: 'Recargar', fn: () => location.reload() } });
    });
    const guardarPendiente = () => {
      if (S.form && S.form.guardarBorrador && S.form.guardarBorrador.pendiente()) S.form.guardarBorrador.ahora();
    };
    window.addEventListener('pagehide', guardarPendiente);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') guardarPendiente();
      else revisarCambios();
    });
    document.addEventListener('focusout', () => { if (S.refrescoPendiente) setTimeout(refrescarSiCorresponde, 400); });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => aplicarTema(S.cfg.tema));
    await renderizar();
    if (Nube.sesion()) arrancarTrasSesion();
    registrarServiceWorker();
    const fallas = C.autocomprobacion().filter(r => !r.ok);
    if (fallas.length) toast(`Atención: ${fallas.length} comprobación(es) de cálculo fallaron. Revisa Ajustes.`, 'error');
  }

  iniciar();
})();
