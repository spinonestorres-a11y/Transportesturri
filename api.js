/* =========================================================================
   api.js — Conexión con el backend (Google Apps Script + Google Sheets)
   -------------------------------------------------------------------------
   Nube.* es la única puerta a los datos compartidos:
   - Sesión: login con usuario y clave (la clave viaja como hash SHA-256).
   - Datos: se descargan completos y se guardan en el dispositivo (db.js),
     así la app abre al instante y se puede consultar sin señal.
   - Cambios de otros usuarios: se revisa un número de "revisión" cada
     INTERVALO_SYNC_SEG segundos; si cambió, se descargan los datos.
   - Viajes y fotos pasan por una COLA local: primero se guardan en el
     teléfono y luego se envían. Sin señal quedan "pendientes" y se envían
     solos al volver la conexión. Cada envío lleva un identificador de
     operación para que un reintento no duplique nada.
   - Conflictos: si otro usuario cambió el mismo viaje, el envío queda en
     "conflicto" y el usuario elige qué versión conservar.
   Todas las peticiones son POST con Content-Type text/plain (sin preflight
   CORS, requisito de Apps Script).
   ========================================================================= */
(function (raiz) {
  'use strict';

  const L = raiz.DB;
  const CFG = raiz.CONFIG_APP || {};
  const URL_API = String(CFG.API_URL || '').trim();
  const CLAVE_SESION = 'gt-sesion';
  const SAL_CLIENTE = 'gestion-transporte'; // Debe coincidir con Codigo.gs

  /* ---------- Eventos ---------- */
  const oyentes = {};
  function on(evento, fn) { (oyentes[evento] = oyentes[evento] || []).push(fn); }
  function emitir(evento, dato) { (oyentes[evento] || []).forEach(fn => { try { fn(dato); } catch (err) { console.error(err); } }); }

  /* ---------- Errores ---------- */
  class ErrorApi extends Error {
    constructor(mensaje, codigo, datos, red) {
      super(mensaje);
      this.codigo = codigo;
      this.datos = datos || null;
      this.red = !!red;
    }
  }

  /* ---------- Utilidades ---------- */
  const uuid = () => (raiz.Calculos ? raiz.Calculos.generarId() : String(Date.now()) + Math.random());
  let secuencia = 0;
  const siguienteOrden = () => Date.now() * 1000 + (secuencia++ % 1000);

  function leerLocal(clave) {
    try { return JSON.parse(localStorage.getItem(clave) || 'null'); } catch (err) { return null; }
  }
  function escribirLocal(clave, valor) {
    try {
      if (valor === null) localStorage.removeItem(clave);
      else localStorage.setItem(clave, JSON.stringify(valor));
    } catch (err) { /* almacenamiento bloqueado: la sesión dura solo esta pestaña */ }
  }

  async function sha256Hex(texto) {
    if (!raiz.crypto || !raiz.crypto.subtle) throw new ErrorApi('Este navegador no permite cifrar la clave. Abre la app desde https.', 'navegador');
    const buf = await raiz.crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  const hashClave = (usuario, clave) => sha256Hex(`${SAL_CLIENTE}|${String(usuario).trim().toLowerCase()}|${clave}`);

  function blobABase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error || new Error('No se pudo leer la foto.'));
      fr.readAsDataURL(blob);
    });
  }
  function base64ABlob(b64, tipo) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: tipo || 'image/jpeg' });
  }

  /* ---------- Estado ---------- */
  let sesion = leerLocal(CLAVE_SESION);
  const vacio = () => ({ revision: -1, hora: '', viajes: [], adjuntos: [], rutas: [], camiones: [], tarifas: [], config: {}, usuarios: [] });
  let datos = vacio();
  let cola = [];
  const sync = { ultima: null, error: null, sincronizando: false, promesa: null };

  const configurada = () => /^https?:\/\/\S+$/.test(URL_API);

  /* ---------- Llamada al backend ----------
     Apps Script a veces responde mal sin que haya un problema real: tarda
     mucho al "despertar", devuelve 404 en la redirección a googleusercontent o
     convierte el POST en GET (llega la respuesta de doGet). Esas fallas son
     transitorias: las consultas y el login se reintentan solos. Las escrituras
     no se repiten aquí (podrían aplicarse dos veces); los viajes y fotos ya se
     reintentan desde la cola con su identificador de operación. */
  const ACCIONES_REPETIBLES = ['ping', 'login', 'logout', 'revision', 'datos', 'obtenerAdjunto'];
  const esperar = ms => new Promise(r => setTimeout(r, ms));

  async function llamar(accion, cuerpo = {}, opciones = {}) {
    const intentos = opciones.intentos || (ACCIONES_REPETIBLES.indexOf(accion) !== -1 ? 3 : 1);
    let ultimo = null;
    let timeouts = 0;
    for (let i = 0; i < intentos; i++) {
      if (i > 0) {
        await esperar(1500 * i);
        if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      }
      try {
        return await llamarUnaVez(accion, cuerpo, opciones);
      } catch (err) {
        ultimo = err;
        if (!err.transitorio) throw err;
        // Una espera larga ya costó mucho: se reintenta a lo más una vez tras un timeout.
        if (err.timeout && ++timeouts > 1) break;
      }
    }
    throw ultimo;
  }

  function errorTransitorio(mensaje, extra) {
    const e = new ErrorApi(mensaje, 'red', null, true);
    e.transitorio = true;
    return Object.assign(e, extra || {});
  }

  async function llamarUnaVez(accion, cuerpo, opciones) {
    if (!configurada()) throw new ErrorApi('Falta configurar la dirección del servidor (API_URL en config.js).', 'configuracion');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ErrorApi('Sin conexión a internet.', 'red', null, true);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const temporizador = ctrl ? setTimeout(() => ctrl.abort(), opciones.timeout || 45000) : null;
    let resp;
    try {
      resp = await fetch(URL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ accion, token: sesion ? sesion.token : null }, cuerpo)),
        signal: ctrl ? ctrl.signal : undefined,
        redirect: 'follow',
        cache: 'no-store'
      });
    } catch (err) {
      const abortado = err && err.name === 'AbortError';
      throw errorTransitorio(abortado ? 'El servidor tardó demasiado en responder.' : 'No se pudo conectar con el servidor.', { timeout: abortado });
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
    if (!resp.ok) throw errorTransitorio(`El servidor de Google respondió con error ${resp.status}.`);
    let json;
    try {
      json = await resp.json();
    } catch (err) {
      const e = new ErrorApi('Respuesta no válida del servidor. Revisa la URL de config.js y que la implementación de Apps Script tenga acceso "Cualquier persona".', 'formato');
      e.transitorio = true;
      throw e;
    }
    // Google convirtió el POST en GET: la respuesta es la de doGet, no la de la acción pedida.
    if (accion !== 'ping' && json && json.app && /La app usa POST/.test(json.mensaje || '')) {
      throw errorTransitorio('Google no entregó la solicitud completa.');
    }
    if (json.error) {
      if (json.error === 'sesion') {
        sesion = null;
        escribirLocal(CLAVE_SESION, null);
        emitir('sesion', null);
      }
      throw new ErrorApi(json.mensaje || 'Error del servidor.', json.error, json.datos);
    }
    return json;
  }

  /* ---------- Sesión ---------- */
  async function iniciarSesion(usuario, clave) {
    const u = String(usuario || '').trim().toLowerCase();
    const r = await llamar('login', { usuario: u, claveHash: await hashClave(u, clave) });
    const anterior = leerLocal('gt-ultimo-usuario');
    if (anterior && anterior !== r.usuario.usuario) {
      await L.limpiarTodo();
      datos = vacio();
      cola = [];
    }
    sesion = { token: r.token, usuario: r.usuario };
    escribirLocal(CLAVE_SESION, sesion);
    escribirLocal('gt-ultimo-usuario', r.usuario.usuario);
    emitir('sesion', sesion);
    return sesion;
  }

  async function cerrarSesion() {
    try { if (sesion) await llamar('logout', {}, { timeout: 8000 }); } catch (err) { /* se cierra igual en el dispositivo */ }
    sesion = null;
    escribirLocal(CLAVE_SESION, null);
    escribirLocal('gt-ultimo-usuario', null);
    await L.limpiarTodo();
    datos = vacio();
    cola = [];
    emitir('sesion', null);
  }

  async function cambiarClave(actual, nueva) {
    const u = sesion.usuario.usuario;
    return llamar('cambiarClave', { claveActualHash: await hashClave(u, actual), claveNuevaHash: await hashClave(u, nueva) });
  }

  /* ---------- Datos ---------- */
  function normalizar(d) {
    const x = Object.assign(vacio(), d || {});
    ['viajes', 'adjuntos', 'rutas', 'camiones', 'tarifas', 'usuarios'].forEach(k => { if (!Array.isArray(x[k])) x[k] = []; });
    if (!x.config || typeof x.config !== 'object') x.config = {};
    delete x.ok;
    return x;
  }

  async function iniciar() {
    await L.abrir();
    const c = await L.leerCache('datos');
    if (c && c.valor) {
      datos = normalizar(c.valor);
      sync.ultima = c.guardado || null;
    }
    cola = await L.listarCola();
  }

  function sincronizar() {
    if (sync.promesa) return sync.promesa;
    sync.sincronizando = true;
    emitir('estado');
    sync.promesa = (async () => {
      try {
        const r = await llamar('datos', {}, { timeout: 60000 });
        datos = normalizar(r);
        await L.escribirCache('datos', datos);
        sync.ultima = new Date().toISOString();
        sync.error = null;
        emitir('datos');
        return true;
      } catch (err) {
        sync.error = err;
        throw err;
      } finally {
        sync.sincronizando = false;
        sync.promesa = null;
        emitir('estado');
      }
    })();
    return sync.promesa;
  }

  /** Revisa si otro usuario cambió algo; si es así, descarga los datos. */
  async function comprobarCambios() {
    const r = await llamar('revision', {}, { timeout: 20000 });
    if (r.revision !== datos.revision) return sincronizar();
    sync.ultima = new Date().toISOString();
    sync.error = null;
    emitir('estado');
    return false;
  }

  function reemplazarEn(lista, reg) {
    const i = lista.findIndex(x => x.id === reg.id);
    if (i === -1) lista.push(reg); else lista[i] = reg;
  }

  /** Aplica en local lo que devolvió una escritura, sin descargar todo de nuevo. */
  async function aplicar(cambios, revision) {
    ['viajes', 'adjuntos', 'rutas', 'camiones', 'tarifas'].forEach(t => {
      (cambios[t] || []).forEach(reg => reemplazarEn(datos[t], reg));
    });
    const eliminar = cambios.eliminar || {};
    Object.keys(eliminar).forEach(t => {
      const ids = new Set(eliminar[t] || []);
      if (ids.size && Array.isArray(datos[t])) datos[t] = datos[t].filter(x => !ids.has(x.id));
    });
    if (cambios.config) datos.config = cambios.config;
    let desfasado = false;
    if (typeof revision === 'number') {
      if (revision === datos.revision + 1) datos.revision = revision;
      else desfasado = true; // hubo cambios de otros usuarios entre medio
    }
    await L.escribirCache('datos', datos);
    emitir('datos');
    if (desfasado) sincronizar().catch(() => {});
  }

  /* ---------- Cola de envío ---------- */
  async function persistirItem(item) {
    const copia = Object.assign({}, item);
    delete copia.enProceso;
    await L.guardarEnCola(copia);
  }
  async function quitar(id) {
    cola = cola.filter(i => i.id !== id);
    await L.quitarDeCola(id);
  }

  /** Encola un viaje (nuevo o editado) con sus fotos nuevas y eliminadas. Devuelve el id del ítem del viaje. */
  async function encolarViaje({ viaje, versionBase, rutaActualizada, adjuntosNuevos = [], adjuntosEliminar = [] }) {
    const items = [];
    let principal = cola.find(i => i.tipo === 'viaje' && i.viajeId === viaje.id);
    if (principal) {
      principal.datos.viaje = viaje;
      if (rutaActualizada) principal.datos.rutaActualizada = rutaActualizada;
      if (principal.estado !== 'conflicto') { principal.estado = 'pendiente'; principal.mensaje = ''; }
      if (principal.enProceso) { principal.modificado = true; principal.opId = uuid(); }
      items.push(principal);
    } else {
      principal = {
        id: uuid(), opId: uuid(), orden: siguienteOrden(), tipo: 'viaje', viajeId: viaje.id, estado: 'pendiente', intentos: 0,
        creado: new Date().toISOString(), datos: { viaje, versionBase: versionBase === undefined ? null : versionBase, rutaActualizada: rutaActualizada || null }
      };
      cola.push(principal);
      items.push(principal);
    }
    adjuntosNuevos.forEach(a => {
      const it = { id: uuid(), orden: siguienteOrden(), tipo: 'adjunto', viajeId: viaje.id, estado: 'pendiente', intentos: 0, creado: new Date().toISOString(), datos: { adjunto: Object.assign({}, a, { viajeId: viaje.id }) } };
      cola.push(it);
      items.push(it);
    });
    for (const idAdj of adjuntosEliminar) {
      const subida = cola.find(i => i.tipo === 'adjunto' && i.datos.adjunto.id === idAdj);
      if (subida) { await quitar(subida.id); continue; }
      const it = { id: uuid(), orden: siguienteOrden(), tipo: 'eliminarAdjunto', viajeId: viaje.id, estado: 'pendiente', intentos: 0, creado: new Date().toISOString(), datos: { id: idAdj } };
      cola.push(it);
      items.push(it);
    }
    for (const it of items) await persistirItem(it);
    emitir('cola');
    return { id: principal.id, ids: items.map(i => i.id) };
  }

  /** Encola fotos nuevas o eliminadas de un viaje ya guardado (vista de detalle). */
  async function encolarFotos(viajeId, adjuntosNuevos, adjuntosEliminar) {
    const items = [];
    (adjuntosNuevos || []).forEach(a => items.push({ id: uuid(), orden: siguienteOrden(), tipo: 'adjunto', viajeId, estado: 'pendiente', intentos: 0, creado: new Date().toISOString(), datos: { adjunto: Object.assign({}, a, { viajeId }) } }));
    for (const idAdj of adjuntosEliminar || []) {
      const subida = cola.find(i => i.tipo === 'adjunto' && i.datos.adjunto.id === idAdj);
      if (subida) { await quitar(subida.id); continue; }
      items.push({ id: uuid(), orden: siguienteOrden(), tipo: 'eliminarAdjunto', viajeId, estado: 'pendiente', intentos: 0, creado: new Date().toISOString(), datos: { id: idAdj } });
    }
    cola.push(...items);
    for (const it of items) await persistirItem(it);
    emitir('cola');
  }

  let procesando = null;
  let repetir = false;

  function procesarCola() {
    if (procesando) { repetir = true; return procesando; }
    procesando = (async () => {
      do { repetir = false; await ejecutarCola(); } while (repetir);
    })().finally(() => { procesando = null; emitir('cola'); });
    return procesando;
  }

  async function ejecutarCola() {
    if (!sesion || !configurada() || !cola.length) return;
    const bloqueados = new Set();
    for (const item of cola.slice().sort((a, b) => a.orden - b.orden)) {
      if (!cola.includes(item)) continue;
      if (item.estado === 'conflicto' || item.estado === 'error') { bloqueados.add(item.viajeId); continue; }
      if (bloqueados.has(item.viajeId)) continue; // las fotos esperan a su viaje
      try {
        await procesarItem(item);
      } catch (err) {
        if (err.red || err.codigo === 'ocupado') { sync.error = err; emitir('estado'); return; }
        if (err.codigo === 'sesion') return;
        item.intentos += 1;
        item.estado = err.codigo === 'conflicto' ? 'conflicto' : 'error';
        item.codigoError = err.codigo;
        item.mensaje = err.message;
        item.actual = err.datos && err.datos.actual ? err.datos.actual : null;
        await persistirItem(item);
        bloqueados.add(item.viajeId);
        emitir('cola');
      }
    }
  }

  async function procesarItem(item) {
    item.enProceso = true;
    try {
      if (item.tipo === 'viaje') {
        const r = await llamar('guardarViaje', {
          viaje: item.datos.viaje, versionBase: item.datos.versionBase, rutaActualizada: item.datos.rutaActualizada, opId: item.opId
        });
        if (item.modificado) {
          // Se editó de nuevo mientras viajaba: queda pendiente sobre la versión recién guardada.
          item.modificado = false;
          item.datos.versionBase = r.viaje.version;
          item.datos.viaje = Object.assign({}, item.datos.viaje, { codigo: r.viaje.codigo });
          await persistirItem(item);
        } else {
          await quitar(item.id);
        }
        await aplicar({ viajes: [r.viaje], rutas: r.ruta ? [r.ruta] : [] }, r.revision);
      } else if (item.tipo === 'adjunto') {
        const a = item.datos.adjunto;
        const r = await llamar('subirAdjunto', {
          adjunto: { id: a.id, viajeId: a.viajeId, categoria: a.categoria, nombre: a.nombre, tipo: a.tipo || 'image/jpeg', ancho: a.ancho, alto: a.alto },
          datos: await blobABase64(a.blob)
        }, { timeout: 120000 });
        try { await L.guardarImagen(a.id, a.blob); } catch (err) { /* caché opcional */ }
        await quitar(item.id);
        await aplicar({ adjuntos: [r.adjunto] }, r.revision);
      } else if (item.tipo === 'eliminarAdjunto') {
        const r = await llamar('eliminarAdjunto', { id: item.datos.id });
        await quitar(item.id);
        await aplicar({ eliminar: { adjuntos: [item.datos.id] } }, r.revision);
      }
    } finally {
      item.enProceso = false;
    }
  }

  /**
   * Guarda un viaje: lo encola y lo intenta enviar de inmediato.
   * Resultado: { estado: 'enviado' | 'pendiente' | 'conflicto' | 'error', viaje, itemId, mensaje, actual }
   */
  async function guardarViaje(opciones) {
    const encolado = await encolarViaje(opciones);
    const itemId = encolado.id;
    await procesarCola();
    const item = cola.find(i => i.id === itemId);
    const guardado = datos.viajes.find(v => v.id === opciones.viaje.id);
    if (!item) return { estado: 'enviado', viaje: guardado, itemId };
    if (item.estado === 'conflicto') return { estado: 'conflicto', itemId, actual: item.actual, mensaje: item.mensaje };
    if (item.estado === 'error') return { estado: 'error', itemId, ids: encolado.ids, mensaje: item.mensaje, codigo: item.codigoError };
    return { estado: 'pendiente', itemId, viaje: guardado };
  }

  /** Conflicto: "mio" reenvía mi versión sobre la del otro usuario; "suyo" descarta mis cambios. */
  async function resolverConflicto(itemId, opcion) {
    const item = cola.find(i => i.id === itemId);
    if (!item) return;
    if (opcion === 'mio') {
      if (item.actual) {
        item.datos.versionBase = item.actual.version;
        item.datos.viaje = Object.assign({}, item.datos.viaje, { codigo: item.actual.codigo });
      }
      item.estado = 'pendiente';
      item.mensaje = '';
      item.actual = null;
      item.opId = uuid();
      await persistirItem(item);
      emitir('cola');
      await procesarCola();
    } else {
      await descartar(itemId);
      try { await sincronizar(); } catch (err) { /* sin conexión: se verá después */ }
    }
  }

  /** Descarta un ítem de la cola. Si era la creación de un viaje, descarta también sus fotos. */
  async function descartar(itemId) {
    const item = cola.find(i => i.id === itemId);
    if (!item) return;
    await quitar(itemId);
    if (item.tipo === 'viaje' && item.datos.versionBase === null) {
      for (const otro of cola.filter(i => i.viajeId === item.viajeId)) await quitar(otro.id);
    }
    emitir('cola');
    emitir('datos');
  }

  /** Quita varios ítems (p. ej. lo encolado por un guardado que el servidor rechazó). */
  async function descartarVarios(ids) {
    for (const id of ids || []) await quitar(id);
    emitir('cola');
    emitir('datos');
  }

  async function reintentar(itemId) {
    const item = cola.find(i => i.id === itemId);
    if (!item) return;
    item.estado = 'pendiente';
    item.mensaje = '';
    await persistirItem(item);
    emitir('cola');
    return procesarCola();
  }

  /* ---------- Operaciones en línea (requieren conexión) ---------- */
  async function eliminarViaje(id, versionBase) {
    const soloLocal = !datos.viajes.some(v => v.id === id);
    if (!soloLocal) {
      const r = await llamar('eliminarViaje', { id, versionBase });
      await aplicar({ eliminar: { viajes: [id], adjuntos: r.fotosEliminadas || [] } }, r.revision);
    }
    for (const it of cola.filter(i => i.viajeId === id)) await quitar(it.id);
    emitir('cola');
    emitir('datos');
  }

  async function guardarRegistro(tabla, registro, versionBase) {
    const r = await llamar('guardarRegistro', { tabla, registro, versionBase: versionBase === undefined ? null : versionBase });
    await aplicar({ [tabla]: [r.registro] }, r.revision);
    return r.registro;
  }

  async function eliminarRegistro(tabla, id) {
    const r = await llamar('eliminarRegistro', { tabla, id });
    await aplicar({ eliminar: { [tabla]: [id], tarifas: r.tarifasEliminadas || [] } }, r.revision);
    return r;
  }

  async function guardarConfig(valores) {
    const r = await llamar('guardarConfig', { valores });
    await aplicar({ config: r.config }, r.revision);
    return r.config;
  }

  async function confirmarViajesTarifa(tarifaId) {
    const r = await llamar('confirmarViajesTarifa', { tarifaId });
    await aplicar({ viajes: r.viajes }, r.revision);
    return r.viajes.length;
  }

  async function importar(datosImportar) {
    const r = await llamar('importar', { datos: datosImportar }, { timeout: 180000 });
    await sincronizar();
    return r.resultado;
  }

  async function cargarDemo() { const r = await llamar('cargarDemo'); await sincronizar(); return r; }
  async function eliminarDemo() { const r = await llamar('eliminarDemo'); await sincronizar(); return r; }

  /* ---------- Fotos ---------- */
  const descargas = new Map();
  async function blobAdjunto(meta) {
    if (meta.blob) return meta.blob;
    const local = await L.leerImagen(meta.id);
    if (local) return local;
    if (descargas.has(meta.id)) return descargas.get(meta.id);
    const p = (async () => {
      const r = await llamar('obtenerAdjunto', { id: meta.id }, { timeout: 60000 });
      const blob = base64ABlob(r.datos, r.tipo);
      try { await L.guardarImagen(meta.id, blob); } catch (err) { /* caché opcional */ }
      return blob;
    })();
    descargas.set(meta.id, p);
    try { return await p; } finally { descargas.delete(meta.id); }
  }

  /* ---------- Vista combinada: servidor + cambios locales pendientes ---------- */
  function vista() {
    const viajes = datos.viajes.slice();
    cola.filter(i => i.tipo === 'viaje').forEach(it => {
      const v = Object.assign({}, it.datos.viaje, { _pendiente: it.estado, _itemId: it.id, _mensaje: it.mensaje || '' });
      const i = viajes.findIndex(x => x.id === v.id);
      if (i === -1) viajes.push(v);
      else { v.version = viajes[i].version; v.creadoPor = viajes[i].creadoPor; v.creado = viajes[i].creado; viajes[i] = v; }
    });
    const quitados = new Set(cola.filter(i => i.tipo === 'eliminarAdjunto').map(i => i.datos.id));
    const adjuntos = datos.adjuntos.filter(a => !quitados.has(a.id));
    cola.filter(i => i.tipo === 'adjunto').forEach(it => adjuntos.push(Object.assign({}, it.datos.adjunto, { _pendiente: it.estado, _itemId: it.id })));
    return Object.assign({}, datos, { viajes, adjuntos });
  }

  function estadoCola() {
    return {
      total: cola.length,
      pendientes: cola.filter(i => i.estado === 'pendiente').length,
      conflictos: cola.filter(i => i.estado === 'conflicto').length,
      errores: cola.filter(i => i.estado === 'error').length,
      items: cola.slice().sort((a, b) => a.orden - b.orden)
    };
  }

  raiz.Nube = {
    ErrorApi, on, configurada, url: () => URL_API,
    sesion: () => sesion, esAdmin: () => !!(sesion && sesion.usuario && sesion.usuario.rol === 'admin'),
    iniciarSesion, cerrarSesion, cambiarClave, hashClave,
    iniciar, sincronizar, comprobarCambios, datos: () => datos, vista, estadoSync: () => Object.assign({}, sync),
    guardarViaje, encolarFotos, procesarCola, estadoCola, resolverConflicto, descartar, descartarVarios, reintentar,
    eliminarViaje, guardarRegistro, eliminarRegistro, guardarConfig, confirmarViajesTarifa, importar, cargarDemo, eliminarDemo,
    blobAdjunto, leerLocal, escribirLocal
  };
})(typeof self !== 'undefined' ? self : globalThis);
