/* =========================================================================
   db.js — Almacenamiento LOCAL del dispositivo (IndexedDB)
   -------------------------------------------------------------------------
   La fuente oficial de los datos es la Google Sheet (ver api.js). En el
   dispositivo solo se guarda:
   - cache:      copia de los últimos datos descargados (abre rápido y sin señal)
   - cola:       cambios hechos sin conexión, pendientes de envío (incluye fotos)
   - imagenes:   fotos ya descargadas, para no volver a pedirlas
   - borradores: formularios sin guardar
   Todo se borra al cerrar sesión.
   También incluye validarRespaldo(), función pura para revisar un archivo
   JSON antes de importarlo.
   ========================================================================= */
(function (raiz) {
  'use strict';

  const C = raiz.Calculos || (typeof require === 'function' ? require('./calculos.js') : null);

  const NOMBRE_DB = 'gestion-transporte-local';
  const VERSION_DB = 1;
  const APP_ID = 'gestion-transporte';
  const FORMATO_RESPALDO = 2;
  const MAX_IMAGENES = 300;

  const MIGRACIONES = {
    1(db) {
      db.createObjectStore('cache', { keyPath: 'clave' });
      db.createObjectStore('cola', { keyPath: 'id' });
      db.createObjectStore('imagenes', { keyPath: 'id' });
      db.createObjectStore('borradores', { keyPath: 'clave' });
    }
    // 2(db, tx) { ... } ← futuras versiones: agregar aquí y subir VERSION_DB.
  };

  let dbPromesa = null;

  function abrir() {
    if (dbPromesa) return dbPromesa;
    dbPromesa = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('Este navegador no permite guardar datos locales (IndexedDB no disponible).'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(NOMBRE_DB, VERSION_DB);
      } catch (err) {
        reject(new Error('No se pudo abrir el almacenamiento local. Revisa si el navegador está en modo privado.'));
        return;
      }
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        for (let v = ev.oldVersion + 1; v <= VERSION_DB; v++) {
          if (typeof MIGRACIONES[v] === 'function') MIGRACIONES[v](db, req.transaction);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromesa = null;
          if (typeof raiz.dispatchEvent === 'function' && typeof CustomEvent === 'function') raiz.dispatchEvent(new CustomEvent('db-version-cambiada'));
        };
        resolve(db);
      };
      req.onerror = () => { dbPromesa = null; reject(req.error || new Error('No se pudo abrir el almacenamiento local.')); };
      req.onblocked = () => { dbPromesa = null; reject(new Error('Hay otra pestaña abierta con una versión anterior de la app. Ciérrala y recarga.')); };
    });
    return dbPromesa;
  }

  function prom(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function finTx(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = (ev) => reject((ev && ev.target && ev.target.error) || tx.error || new Error('Error al guardar en el dispositivo.'));
      tx.onabort = () => reject(tx.error || new Error('La operación local fue cancelada.'));
    });
  }

  async function obtenerTodos(store) {
    const db = await abrir();
    return prom(db.transaction(store).objectStore(store).getAll());
  }
  async function obtener(store, clave) {
    const db = await abrir();
    return prom(db.transaction(store).objectStore(store).get(clave));
  }
  async function guardar(store, obj) {
    const db = await abrir();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    await finTx(tx);
    return obj;
  }
  async function eliminar(store, clave) {
    const db = await abrir();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(clave);
    await finTx(tx);
  }

  /* ---------- Caché de datos ---------- */
  const leerCache = clave => obtener('cache', clave);
  const escribirCache = (clave, valor) => guardar('cache', { clave, valor, guardado: new Date().toISOString() });

  /* ---------- Cola de envío ---------- */
  async function listarCola() {
    const items = await obtenerTodos('cola');
    return items.sort((a, b) => a.orden - b.orden);
  }
  const guardarEnCola = item => guardar('cola', item);
  const quitarDeCola = id => eliminar('cola', id);

  /* ---------- Imágenes descargadas ---------- */
  async function leerImagen(id) {
    const r = await obtener('imagenes', id);
    return r ? r.blob : null;
  }
  async function guardarImagen(id, blob) {
    await guardar('imagenes', { id, blob, guardado: Date.now() });
    const db = await abrir();
    const n = await prom(db.transaction('imagenes').objectStore('imagenes').count());
    if (n <= MAX_IMAGENES) return;
    const todas = await obtenerTodos('imagenes');
    todas.sort((a, b) => a.guardado - b.guardado).slice(0, n - MAX_IMAGENES).forEach(x => { eliminar('imagenes', x.id); });
  }

  /* ---------- Borradores ---------- */
  const guardarBorrador = (clave, datos) => guardar('borradores', { clave, datos, guardado: new Date().toISOString() });
  const leerBorrador = clave => obtener('borradores', clave);
  const eliminarBorrador = clave => eliminar('borradores', clave);

  /** Borra todo lo local (al cerrar sesión o cambiar de usuario). */
  async function limpiarTodo() {
    const db = await abrir();
    const tx = db.transaction(['cache', 'cola', 'imagenes', 'borradores'], 'readwrite');
    ['cache', 'cola', 'imagenes', 'borradores'].forEach(s => tx.objectStore(s).clear());
    await finTx(tx);
  }

  async function estimarUso() {
    const db = await abrir();
    const contar = s => prom(db.transaction(s).objectStore(s).count());
    return { cola: await contar('cola'), imagenes: await contar('imagenes'), borradores: await contar('borradores') };
  }

  /* =======================================================================
     Validación de un respaldo antes de importarlo (función pura)
     Acepta el formato 1 (versión local de la app, con fotos en base64) y el
     formato 2 (copia descargada desde la app en línea).
     ======================================================================= */
  const txt = v => (typeof v === 'string' ? v : '');

  function validarRespaldo(obj) {
    const errores = [];
    const avisos = [];
    if (!obj || typeof obj !== 'object') {
      return { ok: false, errores: ['El archivo no contiene un objeto JSON válido.'], avisos, datos: null, resumen: null };
    }
    if (obj.app !== APP_ID) errores.push('El archivo no es un respaldo de Gestión de Transporte.');
    if (!C.esNumero(obj.formato)) errores.push('El respaldo no indica su formato.');
    else if (obj.formato > FORMATO_RESPALDO) errores.push('El respaldo fue creado con una versión más nueva de la app. Actualiza la app antes de importar.');
    const d = obj.datos;
    if (!d || typeof d !== 'object') errores.push('El respaldo no contiene la sección "datos".');
    if (errores.length) return { ok: false, errores, avisos, datos: null, resumen: null };

    const lista = (k) => {
      if (d[k] === undefined) return [];
      if (!Array.isArray(d[k])) { errores.push(`La sección "${k}" no es una lista.`); return []; }
      return d[k].filter(x => x && typeof x === 'object');
    };
    const unicos = (arr, etiqueta) => {
      const vistos = new Set();
      return arr.filter(x => {
        if (vistos.has(x.id)) { avisos.push(`${etiqueta} con identificador repetido (${x.id}); se conserva el primero.`); return false; }
        vistos.add(x.id);
        return true;
      });
    };
    const viajes = unicos(lista('viajes').filter(v => typeof v.id === 'string' && v.id).map(C.normalizarViaje), 'Viaje');
    const rutas = unicos(lista('rutas').filter(r => typeof r.id === 'string' && r.id).map(C.normalizarRuta), 'Ruta');
    const camiones = unicos(lista('camiones').filter(c => typeof c.id === 'string' && c.id).map(C.normalizarCamion), 'Tipo de camión');
    const tarifas = unicos(lista('tarifas').filter(t => typeof t.id === 'string' && t.id).map(C.normalizarTarifa), 'Tarifa');

    const idsViajes = new Set(viajes.map(v => v.id));
    const adjuntos = [];
    let bytesAdjuntos = 0;
    let fotosEnDrive = 0;
    lista('adjuntos').forEach(a => {
      if (typeof a.id !== 'string' || !a.id) { avisos.push('Se omitió una foto sin identificador.'); return; }
      if (!idsViajes.has(a.viajeId)) { avisos.push(`Se omitió la foto "${txt(a.nombre) || a.id}" porque su viaje no está en el archivo.`); return; }
      if (typeof a.dataUrl !== 'string') { fotosEnDrive += 1; return; }
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(a.dataUrl)) { avisos.push(`Se omitió la foto "${txt(a.nombre) || a.id}" por formato no válido.`); return; }
      const tamano = Math.floor((a.dataUrl.length - a.dataUrl.indexOf(',') - 1) * 3 / 4);
      bytesAdjuntos += tamano;
      adjuntos.push({
        id: a.id, viajeId: a.viajeId, categoria: a.categoria === 'guia' ? 'guia' : 'entrega',
        nombre: txt(a.nombre) || 'imagen.jpg', ancho: C.esNumero(a.ancho) ? a.ancho : null, alto: C.esNumero(a.alto) ? a.alto : null,
        creado: txt(a.creado), dataUrl: a.dataUrl
      });
    });
    if (fotosEnDrive) avisos.push(`${fotosEnDrive} foto(s) están en Google Drive y no vienen dentro del archivo; no se copian.`);
    const idsCamiones = new Set(camiones.map(c => c.id));
    tarifas.forEach(t => { if (!idsCamiones.has(t.camionId)) avisos.push(`La tarifa "${t.nombre}" apunta a un tipo de camión que no está en el archivo.`); });
    const sinFecha = viajes.filter(v => !v.fecha).length;
    if (sinFecha) avisos.push(`${sinFecha} viaje(s) no tienen fecha válida y el servidor los rechazará.`);
    const fechas = viajes.map(v => v.fecha).filter(Boolean).sort();
    return {
      ok: errores.length === 0,
      errores,
      avisos,
      datos: { viajes, rutas, camiones, tarifas, adjuntos },
      resumen: {
        exportado: txt(obj.exportado), versionApp: txt(obj.versionApp), viajes: viajes.length,
        viajesDemo: viajes.filter(v => v.demo).length, rutas: rutas.length, camiones: camiones.length, tarifas: tarifas.length,
        adjuntos: adjuntos.length, bytesAdjuntos, desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || ''
      }
    };
  }

  const DB = {
    NOMBRE_DB, VERSION_DB, APP_ID, FORMATO_RESPALDO,
    abrir, leerCache, escribirCache,
    listarCola, guardarEnCola, quitarDeCola,
    leerImagen, guardarImagen,
    guardarBorrador, leerBorrador, eliminarBorrador,
    limpiarTodo, estimarUso, validarRespaldo
  };

  raiz.DB = DB;
  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})(typeof self !== 'undefined' ? self : globalThis);
