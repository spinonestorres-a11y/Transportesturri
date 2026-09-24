/* =========================================================================
   Codigo.gs — Backend de Gestión de Transporte (Google Apps Script)
   -------------------------------------------------------------------------
   - Script vinculado a la Google Sheet (Extensiones → Apps Script).
   - Se publica como Aplicación web: Ejecutar como "Yo", acceso "Cualquier
     persona". La seguridad la dan los usuarios y sesiones de la hoja Usuarios.
   - Requiere Calculos.gs (copia exacta de calculos.js de la app): las mismas
     reglas validan y calculan en el celular y en el servidor.
   - Escrituras serializadas con LockService. Cada registro tiene "version":
     si dos personas editan lo mismo, la segunda recibe "conflicto" en vez de
     pisar los datos. Los correlativos los asigna el servidor.
   - Fotos: carpeta privada de Google Drive; la hoja Adjuntos guarda la
     referencia. Se leen a través de este script (no son públicas).
   - Menú "Transporte" en la planilla: configurar hojas y administrar usuarios.
   IMPORTANTE: después de cambiar este código, guardar NO basta. Implementar →
   Administrar implementaciones → lápiz → Versión: Nueva versión → Implementar.
   ========================================================================= */

const APP_ID = 'gestion-transporte';
const VERSION_BACKEND = '2.0.0';
const ZONA_HORARIA = 'America/Santiago';
const SESION_DIAS = 30;
const MAX_INTENTOS_LOGIN = 5;
const MINUTOS_BLOQUEO = 15;
const MAX_FOTOS_CATEGORIA = 12;
const MAX_BYTES_FOTO = 8 * 1024 * 1024;
const RONDAS_HASH = 50;
const SAL_CLIENTE = 'gestion-transporte'; // Debe coincidir con api.js
const NOMBRE_CARPETA = 'Gestión de Transporte · Fotos';
const CONFIG_DEFECTO = { nombreApp: 'Gestión de Transporte', ivaPct: 19, ivaPorDefecto: true, choferTarifaKm: 200 };

/* Definición de hojas: [encabezado, ruta en el objeto, tipo]
   Tipos: t texto · f fecha AAAA-MM-DD (texto) · n número · b booleano ·
   j JSON · c calculado (solo se escribe, informativo para quien mira la hoja). */
const TABLAS = {
  viajes: {
    hoja: 'Viajes', clave: 'id', protegida: true,
    columnas: [
      ['ID', 'id', 't'], ['Código', 'codigo', 't'], ['Fecha', 'fecha', 'f'], ['Estado', 'estado', 't'],
      ['Cliente', 'cliente', 't'], ['Sitio u obra', 'sitio', 't'], ['Localidad', 'localidad', 't'],
      ['Dirección', 'direccion', 't'], ['Origen', 'origen', 't'], ['Destino', 'destino', 't'],
      ['Contacto en sitio', 'contacto', 't'], ['ID camión', 'camionId', 't'], ['Tipo de camión', 'camionNombre', 't'],
      ['Modalidad', 'modalidad', 't'], ['Km cobrables', 'km', 'n'], ['Forma de cobro', 'formaCobro', 't'],
      ['Tarifa neta', 'tarifa', 'n'], ['Neto confirmado', 'netoConfirmado', 'b'], ['Aplica IVA', 'aplicaIva', 'b'],
      ['IVA %', 'ivaPct', 'n'], ['Peajes estimados', 'peajesEstimados', 'n'], ['Peajes reales', 'peajesReales', 'n'],
      ['Combustible', 'combustible', 'n'], ['Comida', 'comida', 'n'],
      ['Chofer: modo', 'chofer.modo', 't'], ['Chofer: $ por km', 'chofer.tarifaKm', 'n'], ['Chofer: monto fijo', 'chofer.monto', 'n'],
      ['Transportista: modo', 'transportista.modo', 't'], ['Transportista: $ por km', 'transportista.tarifaKm', 'n'],
      ['Transportista: monto fijo', 'transportista.montoFijo', 'n'],
      ['Otros gastos (JSON)', 'otrosGastos', 'j'], ['Cobros adicionales (JSON)', 'cobrosAdicionales', 'j'],
      ['Tarifa de catálogo (JSON)', 'tarifaRef', 'j'], ['ID ruta', 'rutaId', 't'], ['Ruta', 'rutaNombre', 't'],
      ['Descripción', 'descripcion', 't'], ['Observaciones', 'notas', 't'], ['Demo', 'demo', 'b'],
      ['Ingreso neto (calc.)', '_calc.ingresoNeto', 'c'], ['IVA (calc.)', '_calc.iva', 'c'],
      ['Total con IVA (calc.)', '_calc.totalConIva', 'c'], ['Costos directos (calc.)', '_calc.costosDirectos', 'c'],
      ['Margen bruto (calc.)', '_calc.margenBruto', 'c'], ['Margen % (calc.)', '_calc.margenPct', 'c'],
      ['Versión', 'version', 'n'], ['Creado', 'creado', 't'], ['Creado por', 'creadoPor', 't'],
      ['Actualizado', 'actualizado', 't'], ['Actualizado por', 'actualizadoPor', 't'], ['Última operación', 'ultimaOperacion', 't']
    ]
  },
  adjuntos: {
    hoja: 'Adjuntos', clave: 'id', protegida: true,
    columnas: [
      ['ID', 'id', 't'], ['ID viaje', 'viajeId', 't'], ['Categoría', 'categoria', 't'], ['Nombre', 'nombre', 't'],
      ['Tipo', 'tipo', 't'], ['Tamaño (bytes)', 'tamano', 'n'], ['Ancho', 'ancho', 'n'], ['Alto', 'alto', 'n'],
      ['ID archivo Drive', 'archivoId', 't'], ['Creado', 'creado', 't'], ['Creado por', 'creadoPor', 't']
    ]
  },
  rutas: {
    hoja: 'Rutas', clave: 'id', protegida: true,
    columnas: [
      ['ID', 'id', 't'], ['Nombre', 'nombre', 't'], ['Origen', 'origen', 't'], ['Destino', 'destino', 't'],
      ['Localidad', 'localidad', 't'], ['Km', 'km', 'n'], ['Peajes estimados', 'peajes', 'n'], ['Vigencia', 'vigencia', 'f'],
      ['Notas', 'notas', 't'], ['Demo', 'demo', 'b'], ['Versión', 'version', 'n'], ['Creado', 'creado', 't'],
      ['Actualizado', 'actualizado', 't'], ['Actualizado por', 'actualizadoPor', 't']
    ]
  },
  camiones: {
    hoja: 'Camiones', clave: 'id', protegida: true,
    columnas: [
      ['ID', 'id', 't'], ['Nombre', 'nombre', 't'], ['Capacidad (kg)', 'capacidadKg', 'n'], ['Activo', 'activo', 'b'],
      ['Notas', 'notas', 't'], ['Versión', 'version', 'n'], ['Creado', 'creado', 't'],
      ['Actualizado', 'actualizado', 't'], ['Actualizado por', 'actualizadoPor', 't']
    ]
  },
  tarifas: {
    hoja: 'Tarifas', clave: 'id', protegida: true,
    columnas: [
      ['ID', 'id', 't'], ['ID camión', 'camionId', 't'], ['Nombre', 'nombre', 't'], ['Modalidad', 'modalidad', 't'],
      ['Monto', 'monto', 'n'], ['IVA', 'ivaTratamiento', 't'], ['Vigente desde', 'vigenciaDesde', 'f'],
      ['Vigente hasta', 'vigenciaHasta', 'f'], ['Activa', 'activa', 'b'], ['Notas', 'notas', 't'], ['Versión', 'version', 'n'],
      ['Creado', 'creado', 't'], ['Actualizado', 'actualizado', 't'], ['Actualizado por', 'actualizadoPor', 't']
    ]
  },
  config: {
    hoja: 'Config', clave: 'clave', protegida: true,
    columnas: [['Clave', 'clave', 't'], ['Valor (JSON)', 'valor', 'j'], ['Actualizado', 'actualizado', 't'], ['Actualizado por', 'actualizadoPor', 't']]
  },
  usuarios: {
    hoja: 'Usuarios', clave: 'usuario', protegida: true,
    columnas: [
      ['Usuario', 'usuario', 't'], ['Nombre', 'nombre', 't'], ['Rol', 'rol', 't'], ['Activo', 'activo', 'b'],
      ['Sal', 'sal', 't'], ['Hash', 'hash', 't'], ['Creado', 'creado', 't'], ['Último acceso', 'ultimoAcceso', 't']
    ]
  },
  registro: {
    hoja: 'Registro', clave: 'fecha', protegida: true,
    columnas: [['Fecha', 'fecha', 't'], ['Usuario', 'usuario', 't'], ['Acción', 'accion', 't'], ['Tabla', 'tabla', 't'], ['ID', 'id', 't'], ['Detalle', 'detalle', 't']]
  }
};

/* =========================================================================
   Entrada HTTP
   ========================================================================= */
function doGet() {
  return responder_({ ok: true, app: APP_ID, version: VERSION_BACKEND, mensaje: 'Backend activo. La app usa POST.' });
}

function doPost(e) {
  let pedido;
  try {
    pedido = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return responder_({ error: 'formato', mensaje: 'Solicitud no válida.' });
  }
  try {
    return responder_(Object.assign({ ok: true }, ejecutar_(pedido)));
  } catch (err) {
    if (err && err.esApp) return responder_({ error: err.codigo, mensaje: err.message, datos: err.datos || null });
    console.error(err && err.stack ? err.stack : err);
    return responder_({ error: 'interno', mensaje: 'Error interno del servidor: ' + (err && err.message ? err.message : String(err)) });
  }
}

function responder_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorApp_(codigo, mensaje, datos) {
  const e = new Error(mensaje);
  e.esApp = true;
  e.codigo = codigo;
  e.datos = datos;
  return e;
}

const ACCIONES = {
  ping: { publica: true, fn: function () { return { app: APP_ID, version: VERSION_BACKEND }; } },
  login: { publica: true, fn: accionLogin_ },
  logout: { fn: accionLogout_ },
  cambiarClave: { fn: accionCambiarClave_ },
  datos: { fn: accionDatos_ },
  revision: { fn: function () { return { revision: revisionActual_() }; } },
  guardarViaje: { escritura: true, fn: accionGuardarViaje_ },
  eliminarViaje: { escritura: true, fn: accionEliminarViaje_ },
  guardarRegistro: { escritura: true, fn: accionGuardarRegistro_ },
  eliminarRegistro: { escritura: true, fn: accionEliminarRegistro_ },
  confirmarViajesTarifa: { escritura: true, admin: true, fn: accionConfirmarViajesTarifa_ },
  guardarConfig: { escritura: true, admin: true, fn: accionGuardarConfig_ },
  subirAdjunto: { escritura: true, preparar: prepararAdjunto_, fn: accionSubirAdjunto_ },
  obtenerAdjunto: { fn: accionObtenerAdjunto_ },
  eliminarAdjunto: { escritura: true, fn: accionEliminarAdjunto_ },
  importar: { escritura: true, admin: true, fn: accionImportar_ },
  cargarDemo: { escritura: true, admin: true, fn: accionCargarDemo_ },
  eliminarDemo: { escritura: true, admin: true, fn: accionEliminarDemo_ }
};

function ejecutar_(p) {
  const def = ACCIONES[p && p.accion];
  if (!def) throw errorApp_('accion', 'Acción desconocida.');
  const ses = def.publica ? null : validarSesion_(p.token);
  if (def.admin && ses.rol !== 'admin') throw errorApp_('permiso', 'Solo un administrador puede hacer esto.');
  if (!def.escritura) return def.fn(p, ses);
  const ctx = def.preparar ? def.preparar(p, ses) : null; // trabajo lento fuera del bloqueo (p. ej. Drive)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(28000)) {
    if (ctx && ctx.alFallar) ctx.alFallar();
    throw errorApp_('ocupado', 'El servidor está ocupado. Intenta de nuevo en unos segundos.');
  }
  try {
    const r = def.fn(p, ses, ctx);
    r.revision = incrementarRevision_();
    SpreadsheetApp.flush();
    return r;
  } catch (err) {
    if (ctx && ctx.alFallar) ctx.alFallar();
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/* =========================================================================
   Utilidades de hojas
   ========================================================================= */
function C_() {
  if (typeof Calculos === 'undefined') throw errorApp_('configuracion', 'Falta el archivo Calculos.gs en el proyecto de Apps Script.');
  return Calculos;
}

function libro_() {
  const activo = SpreadsheetApp.getActiveSpreadsheet();
  if (activo) return activo;
  const id = PropertiesService.getScriptProperties().getProperty('spreadsheetId');
  if (!id) throw errorApp_('configuracion', 'El script no está vinculado a una planilla. Ejecuta "Configurar hojas".');
  return SpreadsheetApp.openById(id);
}

function hoja_(nombre) {
  const h = libro_().getSheetByName(nombre);
  if (!h) throw errorApp_('configuracion', 'Falta la hoja "' + nombre + '". Ejecuta Transporte → Configurar hojas.');
  return h;
}

function leerRuta_(obj, ruta) {
  return ruta.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
}

function escribirRuta_(obj, ruta, valor) {
  const partes = ruta.split('.');
  let o = obj;
  for (let i = 0; i < partes.length - 1; i++) {
    if (o[partes[i]] == null || typeof o[partes[i]] !== 'object') o[partes[i]] = {};
    o = o[partes[i]];
  }
  o[partes[partes.length - 1]] = valor;
}

function deCelda_(tipo, v) {
  if (tipo === 't') {
    if (v === '' || v == null) return '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  if (tipo === 'f') {
    if (v instanceof Date) return Utilities.formatDate(v, ZONA_HORARIA, 'yyyy-MM-dd');
    return v == null ? '' : String(v).trim();
  }
  if (tipo === 'n') {
    if (v === '' || v == null) return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  if (tipo === 'b') return v === true || v === 'TRUE' || v === 'true' || v === 'VERDADERO';
  if (tipo === 'j') {
    if (v === '' || v == null) return null;
    try { return JSON.parse(String(v)); } catch (err) { return null; }
  }
  return v;
}

function aCelda_(tipo, v) {
  if (tipo === 't' || tipo === 'f') {
    const s = v == null ? '' : String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s; // evita que un texto se interprete como fórmula
  }
  if (tipo === 'n' || tipo === 'c') return (typeof v === 'number' && isFinite(v)) ? v : '';
  if (tipo === 'b') return !!v;
  if (tipo === 'j') {
    if (v == null) return '';
    const s = JSON.stringify(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }
  return v == null ? '' : v;
}

/** Lee una hoja completa como objetos. Las columnas se ubican por encabezado. */
function tabla_(clave) {
  const def = TABLAS[clave];
  const h = hoja_(def.hoja);
  const valores = h.getDataRange().getValues();
  const encabezados = (valores[0] || []).map(function (x) { return String(x).trim(); });
  const indice = {};
  encabezados.forEach(function (e, i) { if (e && indice[e] === undefined) indice[e] = i; });
  const filas = [];
  for (let r = 1; r < valores.length; r++) {
    const bruto = valores[r];
    const obj = {};
    def.columnas.forEach(function (col) {
      if (col[2] === 'c') return;
      const i = indice[col[0]];
      escribirRuta_(obj, col[1], deCelda_(col[2], i === undefined ? '' : bruto[i]));
    });
    if (!obj[def.clave]) continue; // fila vacía
    filas.push({ obj: obj, numero: r + 1, bruto: bruto });
  }
  return {
    def: def, hoja: h, encabezados: encabezados, indice: indice, filas: filas,
    buscar: function (id) {
      for (let i = 0; i < filas.length; i++) if (filas[i].obj[def.clave] === id) return filas[i];
      return null;
    }
  };
}

/** Escribe (actualiza o agrega) una fila. Conserva columnas extra agregadas a mano. */
function escribirFila_(t, obj, existente) {
  const ancho = t.encabezados.length;
  const fila = existente ? existente.bruto.slice(0, ancho) : [];
  while (fila.length < ancho) fila.push('');
  const formatos = [];
  for (let i = 0; i < ancho; i++) formatos.push('General');
  t.def.columnas.forEach(function (col) {
    const i = t.indice[col[0]];
    if (i === undefined) return;
    fila[i] = aCelda_(col[2], leerRuta_(obj, col[1]));
    formatos[i] = (col[2] === 't' || col[2] === 'f' || col[2] === 'j') ? '@' : 'General';
  });
  let numero;
  if (existente) {
    numero = existente.numero;
  } else {
    numero = Math.max(t.hoja.getLastRow(), 1) + 1;
    if (numero > t.hoja.getMaxRows()) t.hoja.insertRowsAfter(t.hoja.getMaxRows(), 50);
  }
  const rango = t.hoja.getRange(numero, 1, 1, ancho);
  rango.setNumberFormats([formatos]);
  rango.setValues([fila]);
  const limpio = JSON.parse(JSON.stringify(obj));
  if (existente) {
    existente.obj = limpio;
    existente.bruto = fila;
  } else {
    t.filas.push({ obj: limpio, numero: numero, bruto: fila });
  }
}

/** Elimina filas (de abajo hacia arriba para no desplazar números). */
function eliminarFilas_(t, entradas) {
  entradas.map(function (e) { return e.numero; }).sort(function (a, b) { return b - a; })
    .forEach(function (n) { t.hoja.deleteRow(n); });
}

function ahora_() { return new Date().toISOString(); }
function hoy_() { return Utilities.formatDate(new Date(), ZONA_HORARIA, 'yyyy-MM-dd'); }

/** Auditoría: agrega una fila al final de "Registro" sin leer toda la hoja. */
function registrar_(usuario, accion, tabla, id, detalle) {
  try {
    const h = hoja_(TABLAS.registro.hoja);
    const ancho = Math.max(h.getLastColumn(), TABLAS.registro.columnas.length);
    const enc = h.getRange(1, 1, 1, ancho).getValues()[0].map(function (x) { return String(x).trim(); });
    const obj = { fecha: ahora_(), usuario: usuario, accion: accion, tabla: tabla, id: id || '', detalle: String(detalle || '').slice(0, 500) };
    const fila = enc.map(function () { return ''; });
    const formatos = enc.map(function () { return '@'; });
    TABLAS.registro.columnas.forEach(function (c) {
      const i = enc.indexOf(c[0]);
      if (i !== -1) fila[i] = aCelda_('t', obj[c[1]]);
    });
    const n = Math.max(h.getLastRow(), 1) + 1;
    if (n > h.getMaxRows()) h.insertRowsAfter(h.getMaxRows(), 200);
    const rango = h.getRange(n, 1, 1, enc.length);
    rango.setNumberFormats([formatos]);
    rango.setValues([fila]);
  } catch (err) {
    console.warn('No se pudo escribir el registro: ' + err);
  }
}

function props_() { return PropertiesService.getScriptProperties(); }

function revisionActual_() { return Number(props_().getProperty('revision') || 0); }
function incrementarRevision_() {
  const r = revisionActual_() + 1;
  props_().setProperty('revision', String(r));
  return r;
}

/* =========================================================================
   Usuarios y sesiones
   ========================================================================= */
function bytesAHex_(bytes) {
  return bytes.map(function (b) { const v = b < 0 ? b + 256 : b; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}
function sha256Hex_(texto) {
  return bytesAHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8));
}
/** Mismo cálculo que hace la app en el celular antes de enviar la clave. */
function hashCliente_(usuario, clave) {
  return sha256Hex_(SAL_CLIENTE + '|' + String(usuario).trim().toLowerCase() + '|' + clave);
}
function hashClave_(sal, claveHash) {
  let h = String(claveHash || '');
  for (let i = 0; i < RONDAS_HASH; i++) h = sha256Hex_(sal + ':' + h);
  return h;
}
function normalizarUsuario_(u) { return String(u || '').trim().toLowerCase(); }

function accionLogin_(p) {
  const usuario = normalizarUsuario_(p.usuario);
  if (!usuario || !p.claveHash) throw errorApp_('credenciales', 'Ingresa usuario y clave.');
  const cache = CacheService.getScriptCache();
  const claveIntentos = 'intentos_' + usuario;
  const intentos = Number(cache.get(claveIntentos) || 0);
  if (intentos >= MAX_INTENTOS_LOGIN) {
    throw errorApp_('bloqueado', 'Demasiados intentos fallidos. Espera ' + MINUTOS_BLOQUEO + ' minutos e inténtalo de nuevo.');
  }
  const t = tabla_('usuarios');
  const fila = t.buscar(usuario);
  const u = fila && fila.obj;
  if (!u || !u.activo || !u.hash || hashClave_(u.sal, p.claveHash) !== u.hash) {
    cache.put(claveIntentos, String(intentos + 1), MINUTOS_BLOQUEO * 60);
    throw errorApp_('credenciales', 'Usuario o clave incorrectos.');
  }
  cache.remove(claveIntentos);
  limpiarSesionesVencidas_();
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props_().setProperty('ses_' + token, JSON.stringify({ u: usuario, r: u.rol, n: u.nombre, exp: Date.now() + SESION_DIAS * 864e5 }));
  try {
    const i = t.indice['Último acceso'];
    if (i !== undefined) t.hoja.getRange(fila.numero, i + 1).setValue(ahora_());
  } catch (err) { /* no crítico */ }
  return { token: token, usuario: { usuario: usuario, nombre: u.nombre, rol: u.rol } };
}

function validarSesion_(token) {
  if (!token) throw errorApp_('sesion', 'Inicia sesión para continuar.');
  const bruto = props_().getProperty('ses_' + token);
  if (!bruto) throw errorApp_('sesion', 'Tu sesión expiró o fue cerrada. Inicia sesión nuevamente.');
  const s = JSON.parse(bruto);
  if (s.exp < Date.now()) {
    props_().deleteProperty('ses_' + token);
    throw errorApp_('sesion', 'Tu sesión expiró. Inicia sesión nuevamente.');
  }
  return { usuario: s.u, rol: s.r, nombre: s.n, token: token };
}

function accionLogout_(p, ses) {
  props_().deleteProperty('ses_' + ses.token);
  return { cerrada: true };
}

function accionCambiarClave_(p, ses) {
  if (!p.claveNuevaHash || String(p.claveNuevaHash).length !== 64) throw errorApp_('validacion', 'Clave nueva no válida.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(28000)) throw errorApp_('ocupado', 'El servidor está ocupado. Intenta de nuevo.');
  try {
    const t = tabla_('usuarios');
    const fila = t.buscar(ses.usuario);
    if (!fila || hashClave_(fila.obj.sal, p.claveActualHash) !== fila.obj.hash) throw errorApp_('credenciales', 'La clave actual no es correcta.');
    const sal = Utilities.getUuid();
    fila.obj.sal = sal;
    fila.obj.hash = hashClave_(sal, p.claveNuevaHash);
    escribirFila_(t, fila.obj, fila);
    registrar_(ses.usuario, 'cambiar clave', 'Usuarios', ses.usuario, '');
    return { cambiada: true };
  } finally {
    lock.releaseLock();
  }
}

function limpiarSesionesVencidas_() {
  const todas = props_().getProperties();
  const ahora = Date.now();
  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('ses_') !== 0) return;
    try { if (JSON.parse(todas[k]).exp < ahora) props_().deleteProperty(k); } catch (err) { props_().deleteProperty(k); }
  });
}

function cerrarSesiones_(usuario) {
  const todas = props_().getProperties();
  let n = 0;
  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('ses_') !== 0) return;
    try {
      if (!usuario || JSON.parse(todas[k]).u === usuario) { props_().deleteProperty(k); n++; }
    } catch (err) { props_().deleteProperty(k); }
  });
  return n;
}

/** Crea o reemplaza un usuario (lo usan el menú y las pruebas). */
function crearUsuario_(usuario, nombre, rol, clave) {
  const u = normalizarUsuario_(usuario);
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new Error('Usuario no válido: usa 3 a 30 letras minúsculas, números, punto o guion, sin espacios.');
  if (['admin', 'usuario'].indexOf(rol) === -1) throw new Error('El rol debe ser "admin" o "usuario".');
  if (!clave || String(clave).length < 8) throw new Error('La clave debe tener al menos 8 caracteres.');
  const lock = LockService.getScriptLock();
  lock.waitLock(28000);
  try {
    const t = tabla_('usuarios');
    const fila = t.buscar(u);
    const sal = Utilities.getUuid();
    const obj = {
      usuario: u, nombre: String(nombre || u).trim(), rol: rol, activo: true,
      sal: sal, hash: hashClave_(sal, hashCliente_(u, clave)),
      creado: fila ? fila.obj.creado : ahora_(), ultimoAcceso: fila ? fila.obj.ultimoAcceso : ''
    };
    escribirFila_(t, obj, fila);
    if (fila) cerrarSesiones_(u);
    return obj;
  } finally {
    lock.releaseLock();
  }
}

function activarUsuario_(usuario, activo) {
  const u = normalizarUsuario_(usuario);
  const t = tabla_('usuarios');
  const fila = t.buscar(u);
  if (!fila) throw new Error('No existe el usuario "' + u + '".');
  fila.obj.activo = !!activo;
  escribirFila_(t, fila.obj, fila);
  if (!activo) cerrarSesiones_(u);
  return fila.obj;
}

/* =========================================================================
   Lectura de datos
   ========================================================================= */
function limpiarViaje_(o) {
  const v = JSON.parse(JSON.stringify(o));
  delete v._calc;
  delete v.ultimaOperacion;
  return v;
}

function leerConfig_() {
  const cfg = Object.assign({}, CONFIG_DEFECTO);
  tabla_('config').filas.forEach(function (f) { if (f.obj.valor !== null && f.obj.valor !== undefined) cfg[f.obj.clave] = f.obj.valor; });
  return cfg;
}

function accionDatos_() {
  return {
    revision: revisionActual_(),
    hora: ahora_(),
    viajes: tabla_('viajes').filas.map(function (f) { return limpiarViaje_(f.obj); }),
    adjuntos: tabla_('adjuntos').filas.map(function (f) { return f.obj; }),
    rutas: tabla_('rutas').filas.map(function (f) { return f.obj; }),
    camiones: tabla_('camiones').filas.map(function (f) { return f.obj; }),
    tarifas: tabla_('tarifas').filas.map(function (f) { return f.obj; }),
    config: leerConfig_(),
    usuarios: tabla_('usuarios').filas.filter(function (f) { return f.obj.activo; })
      .map(function (f) { return { usuario: f.obj.usuario, nombre: f.obj.nombre }; })
  };
}

/* =========================================================================
   Viajes
   ========================================================================= */
function siguienteCodigo_(t) {
  const anio = Utilities.formatDate(new Date(), ZONA_HORARIA, 'yyyy');
  const prefijo = 'V-' + anio + '-';
  let maximo = Number(props_().getProperty('secuencia-' + anio) || 0);
  t.filas.forEach(function (f) {
    const m = /^V-(\d{4})-(\d+)$/.exec(f.obj.codigo || '');
    if (m && m[1] === anio) maximo = Math.max(maximo, parseInt(m[2], 10));
  });
  const sig = maximo + 1;
  props_().setProperty('secuencia-' + anio, String(sig));
  return prefijo + ('0000' + sig).slice(-Math.max(4, String(sig).length));
}

function prepararViajeParaHoja_(v) {
  const c = C_().calcularViaje(v);
  v._calc = {
    ingresoNeto: c.ingresoNeto, iva: c.iva, totalConIva: c.totalConIva, costosDirectos: c.costosDirectos,
    margenBruto: c.margenBruto, margenPct: c.margenPct === null ? null : Math.round(c.margenPct * 10) / 10
  };
  return v;
}

function accionGuardarViaje_(p, ses) {
  const C = C_();
  const entrada = p.viaje || {};
  if (!entrada.id) throw errorApp_('validacion', 'Falta el identificador del viaje.');
  const t = tabla_('viajes');
  const existente = t.buscar(entrada.id);
  // Reintento de una operación ya aplicada (p. ej. se cortó la señal al recibir la respuesta).
  if (p.opId && existente && existente.obj.ultimaOperacion === p.opId) {
    return { viaje: limpiarViaje_(existente.obj), repetido: true };
  }
  const v = C.normalizarViaje(entrada);
  const errores = C.validarViaje(v);
  const claves = Object.keys(errores);
  if (claves.length) throw errorApp_('validacion', 'Datos no válidos: ' + claves.map(function (k) { return errores[k]; }).join(' '), { errores: errores });
  const ahora = ahora_();
  const base = p.versionBase === undefined || p.versionBase === null ? null : Number(p.versionBase);
  if (existente) {
    if (base === null) throw errorApp_('duplicado', 'Ya existe un viaje con ese identificador.');
    if (Number(existente.obj.version || 0) !== base) {
      throw errorApp_('conflicto', (existente.obj.actualizadoPor || 'Otro usuario') + ' modificó este viaje mientras lo editabas.',
        { actual: limpiarViaje_(existente.obj) });
    }
    v.codigo = existente.obj.codigo;
    v.creado = existente.obj.creado;
    v.creadoPor = existente.obj.creadoPor;
    v.demo = !!existente.obj.demo;
    v.version = Number(existente.obj.version || 0) + 1;
  } else {
    if (base !== null) throw errorApp_('noExiste', 'Este viaje ya no existe: otro usuario lo eliminó.');
    v.codigo = siguienteCodigo_(t);
    v.creado = ahora;
    v.creadoPor = ses.usuario;
    v.demo = false;
    v.version = 1;
  }
  v.actualizado = ahora;
  v.actualizadoPor = ses.usuario;
  v.ultimaOperacion = p.opId || '';
  escribirFila_(t, prepararViajeParaHoja_(v), existente);
  let ruta = null;
  if (p.rutaActualizada && p.rutaActualizada.id) {
    const tr = tabla_('rutas');
    const fr = tr.buscar(p.rutaActualizada.id);
    if (fr) {
      const r = fr.obj;
      r.km = C.esNumero(p.rutaActualizada.km) ? p.rutaActualizada.km : r.km;
      r.peajes = C.esNumero(p.rutaActualizada.peajes) ? p.rutaActualizada.peajes : r.peajes;
      r.vigencia = hoy_();
      r.version = Number(r.version || 0) + 1;
      r.actualizado = ahora;
      r.actualizadoPor = ses.usuario;
      escribirFila_(tr, r, fr);
      ruta = fr.obj;
    }
  }
  registrar_(ses.usuario, existente ? 'editar' : 'crear', 'Viajes', v.id, v.codigo);
  return { viaje: limpiarViaje_(v), ruta: ruta };
}

function accionEliminarViaje_(p, ses) {
  const t = tabla_('viajes');
  const fila = t.buscar(p.id);
  if (!fila) return { eliminado: false, yaNoExistia: true };
  if (p.versionBase !== undefined && p.versionBase !== null && Number(fila.obj.version || 0) !== Number(p.versionBase)) {
    throw errorApp_('conflicto', (fila.obj.actualizadoPor || 'Otro usuario') + ' modificó este viaje. Revisa los cambios antes de eliminarlo.',
      { actual: limpiarViaje_(fila.obj) });
  }
  const ta = tabla_('adjuntos');
  const fotos = ta.filas.filter(function (f) { return f.obj.viajeId === p.id; });
  fotos.forEach(function (f) { enviarAPapelera_(f.obj.archivoId); });
  eliminarFilas_(ta, fotos);
  eliminarFilas_(t, [fila]);
  registrar_(ses.usuario, 'eliminar', 'Viajes', p.id, fila.obj.codigo + ' (' + fotos.length + ' fotos)');
  return { eliminado: true, id: p.id, fotosEliminadas: fotos.map(function (f) { return f.obj.id; }) };
}

/* =========================================================================
   Catálogos: rutas, camiones y tarifas
   ========================================================================= */
const REGISTROS = {
  rutas: { tabla: 'rutas', normalizar: 'normalizarRuta', admin: false, etiqueta: 'La ruta' },
  camiones: { tabla: 'camiones', normalizar: 'normalizarCamion', admin: true, etiqueta: 'El tipo de camión' },
  tarifas: { tabla: 'tarifas', normalizar: 'normalizarTarifa', admin: true, etiqueta: 'La tarifa' }
};

function validarRegistro_(tabla, r, t) {
  if (!String(r.nombre || '').trim()) throw errorApp_('validacion', 'El nombre es obligatorio.');
  const mismo = function (a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); };
  if (tabla === 'rutas' || tabla === 'camiones') {
    const dup = t.filas.some(function (f) { return f.obj.id !== r.id && mismo(f.obj.nombre, r.nombre); });
    if (dup) throw errorApp_('validacion', 'Ya existe un registro con el nombre "' + r.nombre + '".');
  }
  if (tabla === 'rutas' && !r.vigencia) r.vigencia = hoy_();
  if (tabla === 'tarifas') {
    if (!tabla_('camiones').buscar(r.camionId)) throw errorApp_('validacion', 'El tipo de camión de la tarifa no existe.');
    if (!r.vigenciaDesde) throw errorApp_('validacion', 'Indica desde cuándo rige la tarifa.');
    if (r.vigenciaHasta && r.vigenciaHasta < r.vigenciaDesde) throw errorApp_('validacion', '"Vigente hasta" debe ser igual o posterior a "vigente desde".');
  }
}

function accionGuardarRegistro_(p, ses) {
  const m = REGISTROS[p.tabla];
  if (!m) throw errorApp_('validacion', 'Tabla no válida.');
  if (m.admin && ses.rol !== 'admin') throw errorApp_('permiso', 'Solo un administrador puede modificar camiones y tarifas.');
  const C = C_();
  const t = tabla_(m.tabla);
  const r = C[m.normalizar](p.registro || {});
  validarRegistro_(p.tabla, r, t);
  const existente = t.buscar(r.id);
  const base = p.versionBase === undefined || p.versionBase === null ? null : Number(p.versionBase);
  const ahora = ahora_();
  if (existente) {
    if (base !== null && Number(existente.obj.version || 0) !== base) {
      throw errorApp_('conflicto', (existente.obj.actualizadoPor || 'Otro usuario') + ' modificó este registro. Recarga para ver sus cambios.', { actual: existente.obj });
    }
    r.version = Number(existente.obj.version || 0) + 1;
    r.creado = existente.obj.creado;
    if ('demo' in existente.obj) r.demo = !!existente.obj.demo;
  } else {
    if (base !== null) throw errorApp_('noExiste', m.etiqueta + ' ya no existe: otro usuario lo eliminó.');
    r.version = 1;
    r.creado = ahora;
    if ('demo' in r) r.demo = false;
  }
  r.actualizado = ahora;
  r.actualizadoPor = ses.usuario;
  escribirFila_(t, r, existente);
  registrar_(ses.usuario, existente ? 'editar' : 'crear', t.def.hoja, r.id, r.nombre);
  return { tabla: p.tabla, registro: r };
}

function accionEliminarRegistro_(p, ses) {
  const m = REGISTROS[p.tabla];
  if (!m) throw errorApp_('validacion', 'Tabla no válida.');
  if (m.admin && ses.rol !== 'admin') throw errorApp_('permiso', 'Solo un administrador puede eliminar camiones y tarifas.');
  const t = tabla_(m.tabla);
  const fila = t.buscar(p.id);
  if (!fila) return { eliminado: false, yaNoExistia: true, tabla: p.tabla, id: p.id };
  const eliminadas = [];
  if (p.tabla === 'camiones') {
    const usos = tabla_('viajes').filas.filter(function (f) { return f.obj.camionId === p.id; }).length;
    if (usos) throw errorApp_('enUso', '"' + fila.obj.nombre + '" está en ' + usos + ' viaje(s). Márcalo como inactivo en vez de eliminarlo.', { usos: usos });
    const tt = tabla_('tarifas');
    const suyas = tt.filas.filter(function (f) { return f.obj.camionId === p.id; });
    suyas.forEach(function (f) { eliminadas.push(f.obj.id); });
    eliminarFilas_(tt, suyas);
  }
  eliminarFilas_(t, [fila]);
  registrar_(ses.usuario, 'eliminar', t.def.hoja, p.id, fila.obj.nombre);
  return { eliminado: true, tabla: p.tabla, id: p.id, tarifasEliminadas: eliminadas };
}

function accionConfirmarViajesTarifa_(p, ses) {
  const t = tabla_('viajes');
  const ahora = ahora_();
  const actualizados = [];
  t.filas.forEach(function (f) {
    const v = f.obj;
    if (!v.tarifaRef || v.tarifaRef.id !== p.tarifaId || v.netoConfirmado) return;
    v.netoConfirmado = true;
    v.tarifaRef.ivaTratamiento = 'neto';
    v.version = Number(v.version || 0) + 1;
    v.actualizado = ahora;
    v.actualizadoPor = ses.usuario;
    escribirFila_(t, prepararViajeParaHoja_(v), f);
    actualizados.push(limpiarViaje_(f.obj));
  });
  registrar_(ses.usuario, 'confirmar IVA', 'Viajes', p.tarifaId, actualizados.length + ' viaje(s)');
  return { viajes: actualizados };
}

function accionGuardarConfig_(p, ses) {
  const valores = p.valores || {};
  const limpio = {};
  Object.keys(valores).forEach(function (k) {
    const v = valores[k];
    if (k === 'nombreApp') {
      const s = String(v || '').trim();
      if (!s || s.length > 40) throw errorApp_('validacion', 'El nombre debe tener entre 1 y 40 caracteres.');
      limpio[k] = s;
    } else if (k === 'ivaPct') {
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 100) throw errorApp_('validacion', 'El IVA debe estar entre 0 y 100.');
      limpio[k] = v;
    } else if (k === 'ivaPorDefecto') {
      limpio[k] = !!v;
    } else if (k === 'choferTarifaKm') {
      if (typeof v !== 'number' || !isFinite(v) || v < 0) throw errorApp_('validacion', 'El pago al chofer por km no puede ser negativo.');
      limpio[k] = Math.round(v);
    } else {
      throw errorApp_('validacion', 'Ajuste desconocido: ' + k);
    }
  });
  const t = tabla_('config');
  Object.keys(limpio).forEach(function (k) {
    escribirFila_(t, { clave: k, valor: limpio[k], actualizado: ahora_(), actualizadoPor: ses.usuario }, t.buscar(k));
  });
  registrar_(ses.usuario, 'ajustes', 'Config', Object.keys(limpio).join(', '), JSON.stringify(limpio));
  return { config: leerConfig_() };
}

/* =========================================================================
   Fotos (Google Drive)
   ========================================================================= */
function carpeta_() {
  const id = props_().getProperty('carpetaId');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* se recrea */ }
  }
  const c = DriveApp.createFolder(NOMBRE_CARPETA);
  props_().setProperty('carpetaId', c.getId());
  return c;
}

function enviarAPapelera_(archivoId) {
  if (!archivoId) return;
  try { DriveApp.getFileById(archivoId).setTrashed(true); } catch (err) { console.warn('No se pudo borrar el archivo ' + archivoId); }
}

const TIPOS_FOTO = ['image/jpeg', 'image/png', 'image/webp'];

function prepararAdjunto_(p) {
  const a = p.adjunto || {};
  if (!a.id || !a.viajeId) throw errorApp_('validacion', 'Foto sin identificador o sin viaje.');
  if (['guia', 'entrega'].indexOf(a.categoria) === -1) throw errorApp_('validacion', 'Categoría de foto no válida.');
  if (TIPOS_FOTO.indexOf(a.tipo) === -1) throw errorApp_('validacion', 'Tipo de imagen no permitido.');
  const bytes = Utilities.base64Decode(String(p.datos || ''));
  if (!bytes.length) throw errorApp_('validacion', 'La foto está vacía.');
  if (bytes.length > MAX_BYTES_FOTO) throw errorApp_('validacion', 'La foto supera 8 MB.');
  const archivo = carpeta_().createFile(Utilities.newBlob(bytes, a.tipo, a.id + '.jpg'));
  return { archivo: archivo, tamano: bytes.length, alFallar: function () { archivo.setTrashed(true); } };
}

function accionSubirAdjunto_(p, ses, ctx) {
  const a = p.adjunto;
  const ta = tabla_('adjuntos');
  const ya = ta.buscar(a.id);
  if (ya) { ctx.archivo.setTrashed(true); return { adjunto: ya.obj, repetido: true }; }
  const viaje = tabla_('viajes').buscar(a.viajeId);
  if (!viaje) throw errorApp_('noExiste', 'El viaje de esta foto ya no existe.');
  const n = ta.filas.filter(function (f) { return f.obj.viajeId === a.viajeId && f.obj.categoria === a.categoria; }).length;
  if (n >= MAX_FOTOS_CATEGORIA) throw errorApp_('validacion', 'Ya hay ' + MAX_FOTOS_CATEGORIA + ' fotos en esta categoría.');
  ctx.archivo.setName(viaje.obj.codigo + '-' + (a.categoria === 'guia' ? 'guia' : 'entrega') + '-' + String(a.id).slice(0, 8) + '.jpg');
  const obj = {
    id: a.id, viajeId: a.viajeId, categoria: a.categoria, nombre: String(a.nombre || 'foto.jpg').slice(0, 120),
    tipo: a.tipo, tamano: ctx.tamano, ancho: C_().esNumero(a.ancho) ? a.ancho : null, alto: C_().esNumero(a.alto) ? a.alto : null,
    archivoId: ctx.archivo.getId(), creado: ahora_(), creadoPor: ses.usuario
  };
  escribirFila_(ta, obj, null);
  registrar_(ses.usuario, 'subir foto', 'Adjuntos', a.id, viaje.obj.codigo + ' · ' + a.categoria);
  return { adjunto: obj };
}

function accionObtenerAdjunto_(p) {
  const f = tabla_('adjuntos').buscar(p.id);
  if (!f) throw errorApp_('noExiste', 'La foto ya no existe.');
  let blob;
  try { blob = DriveApp.getFileById(f.obj.archivoId).getBlob(); } catch (err) { throw errorApp_('noExiste', 'No se encontró el archivo de la foto en Drive.'); }
  return { id: p.id, tipo: f.obj.tipo, datos: Utilities.base64Encode(blob.getBytes()) };
}

function accionEliminarAdjunto_(p, ses) {
  const ta = tabla_('adjuntos');
  const f = ta.buscar(p.id);
  if (!f) return { eliminado: false, yaNoExistia: true, id: p.id };
  enviarAPapelera_(f.obj.archivoId);
  eliminarFilas_(ta, [f]);
  registrar_(ses.usuario, 'eliminar foto', 'Adjuntos', p.id, f.obj.viajeId);
  return { eliminado: true, id: p.id };
}

/* =========================================================================
   Importación (combinar), demostración
   ========================================================================= */
function accionImportar_(p, ses) {
  const C = C_();
  const d = p.datos || {};
  const ahora = ahora_();
  const res = { viajesAgregados: 0, viajesActualizados: 0, viajesSinCambio: 0, catalogoAgregados: 0, adjuntosAgregados: 0, renumerados: [] };
  const combinar = function (clave, normalizar, lista) {
    const t = tabla_(clave);
    (lista || []).forEach(function (x) {
      const r = C[normalizar](x);
      const ex = t.buscar(r.id);
      if (ex && !(String(r.actualizado || '') > String(ex.obj.actualizado || ''))) return;
      r.version = ex ? Number(ex.obj.version || 0) + 1 : 1;
      r.creado = ex ? ex.obj.creado : (r.creado || ahora);
      r.actualizado = r.actualizado || ahora;
      r.actualizadoPor = ses.usuario;
      escribirFila_(t, r, ex);
      if (!ex) res.catalogoAgregados++;
    });
  };
  combinar('camiones', 'normalizarCamion', d.camiones);
  combinar('tarifas', 'normalizarTarifa', d.tarifas);
  combinar('rutas', 'normalizarRuta', d.rutas);
  const tv = tabla_('viajes');
  (d.viajes || []).forEach(function (x) {
    const v = C.normalizarViaje(x);
    const ex = tv.buscar(v.id);
    if (ex && !(String(v.actualizado || '') > String(ex.obj.actualizado || ''))) { res.viajesSinCambio++; return; }
    if (ex) {
      v.codigo = ex.obj.codigo;
      v.version = Number(ex.obj.version || 0) + 1;
      v.creado = ex.obj.creado;
      v.creadoPor = ex.obj.creadoPor;
      res.viajesActualizados++;
    } else {
      const choca = !v.codigo || tv.filas.some(function (f) { return f.obj.codigo === v.codigo; });
      if (choca) {
        const anterior = v.codigo;
        v.codigo = siguienteCodigo_(tv);
        res.renumerados.push({ id: v.id, anterior: anterior, nuevo: v.codigo });
      }
      v.version = 1;
      v.creado = v.creado || ahora;
      v.creadoPor = v.creadoPor || ses.usuario;
      res.viajesAgregados++;
    }
    v.actualizado = v.actualizado || ahora;
    v.actualizadoPor = ses.usuario;
    v.ultimaOperacion = '';
    escribirFila_(tv, prepararViajeParaHoja_(v), ex);
  });
  const ta = tabla_('adjuntos');
  (d.adjuntos || []).forEach(function (a) {
    if (!a || !a.id || ta.buscar(a.id) || !tv.buscar(a.viajeId) || typeof a.dataUrl !== 'string') return;
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(a.dataUrl);
    if (!m) return;
    const bytes = Utilities.base64Decode(m[2]);
    const archivo = carpeta_().createFile(Utilities.newBlob(bytes, m[1], a.id + '.jpg'));
    escribirFila_(ta, {
      id: a.id, viajeId: a.viajeId, categoria: a.categoria === 'guia' ? 'guia' : 'entrega', nombre: String(a.nombre || 'foto.jpg'),
      tipo: m[1], tamano: bytes.length, ancho: a.ancho || null, alto: a.alto || null, archivoId: archivo.getId(),
      creado: a.creado || ahora, creadoPor: ses.usuario
    }, null);
    res.adjuntosAgregados++;
  });
  registrar_(ses.usuario, 'importar', 'Viajes', '', JSON.stringify(res));
  return { resultado: res };
}

function accionCargarDemo_(p, ses) {
  const C = C_();
  const demo = C.datosDemo(hoy_());
  const ahora = ahora_();
  const tc = tabla_('camiones');
  C.CATALOGO_INICIAL.camiones.forEach(function (c) {
    if (!tc.buscar(c.id)) escribirFila_(tc, Object.assign(C.normalizarCamion(c), { version: 1, creado: ahora, actualizado: ahora, actualizadoPor: ses.usuario }), null);
  });
  const tr = tabla_('rutas');
  demo.rutas.forEach(function (r) {
    const ex = tr.buscar(r.id);
    escribirFila_(tr, Object.assign(r, { version: ex ? Number(ex.obj.version || 0) + 1 : 1, creado: ahora, actualizado: ahora, actualizadoPor: ses.usuario }), ex);
  });
  const tv = tabla_('viajes');
  demo.viajes.forEach(function (v) {
    const ex = tv.buscar(v.id);
    Object.assign(v, { version: ex ? Number(ex.obj.version || 0) + 1 : 1, creado: ahora, creadoPor: ses.usuario, actualizado: ahora, actualizadoPor: ses.usuario, ultimaOperacion: '' });
    escribirFila_(tv, prepararViajeParaHoja_(v), ex);
  });
  registrar_(ses.usuario, 'cargar demo', 'Viajes', '', demo.viajes.length + ' viajes');
  return { viajes: demo.viajes.length, rutas: demo.rutas.length };
}

function accionEliminarDemo_(p, ses) {
  const tv = tabla_('viajes');
  const demos = tv.filas.filter(function (f) { return f.obj.demo; });
  const ids = demos.map(function (f) { return f.obj.id; });
  const ta = tabla_('adjuntos');
  const fotos = ta.filas.filter(function (f) { return ids.indexOf(f.obj.viajeId) !== -1; });
  fotos.forEach(function (f) { enviarAPapelera_(f.obj.archivoId); });
  eliminarFilas_(ta, fotos);
  eliminarFilas_(tv, demos);
  const tr = tabla_('rutas');
  const rutas = tr.filas.filter(function (f) { return f.obj.demo; });
  eliminarFilas_(tr, rutas);
  registrar_(ses.usuario, 'eliminar demo', 'Viajes', '', demos.length + ' viajes, ' + rutas.length + ' rutas');
  return { viajes: demos.length, rutas: rutas.length };
}

/* =========================================================================
   Configuración inicial y menú de la planilla
   ========================================================================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Transporte')
    .addItem('1. Configurar hojas (primera vez)', 'configurarHojas')
    .addSeparator()
    .addItem('Crear o reemplazar usuario', 'menuCrearUsuario')
    .addItem('Restablecer clave de un usuario', 'menuRestablecerClave')
    .addItem('Activar o desactivar usuario', 'menuActivarUsuario')
    .addItem('Cerrar todas las sesiones', 'menuCerrarSesiones')
    .addToUi();
}

/** Crea las hojas que falten, sus encabezados y formatos, la carpeta de fotos y el catálogo inicial. */
function configurarHojas_() {
  const ss = libro_();
  props_().setProperty('spreadsheetId', ss.getId());
  const creadas = [];
  Object.keys(TABLAS).forEach(function (k) {
    const def = TABLAS[k];
    let h = ss.getSheetByName(def.hoja);
    if (!h) { h = ss.insertSheet(def.hoja); creadas.push(def.hoja); }
    const esperados = def.columnas.map(function (c) { return c[0]; });
    if (h.getLastRow() === 0) {
      h.getRange(1, 1, 1, esperados.length).setValues([esperados]).setFontWeight('bold');
      h.setFrozenRows(1);
    } else {
      const actuales = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map(String);
      const faltan = esperados.filter(function (e) { return actuales.indexOf(e) === -1; });
      if (faltan.length) h.getRange(1, actuales.length + 1, 1, faltan.length).setValues([faltan]).setFontWeight('bold');
    }
    const enc = h.getRange(1, 1, 1, h.getLastColumn()).getValues()[0].map(String);
    def.columnas.forEach(function (c) {
      if (c[2] !== 't' && c[2] !== 'f' && c[2] !== 'j') return;
      const i = enc.indexOf(c[0]);
      if (i !== -1 && h.getMaxRows() > 1) h.getRange(2, i + 1, h.getMaxRows() - 1, 1).setNumberFormat('@');
    });
    if (def.protegida && creadas.indexOf(def.hoja) !== -1) {
      h.protect().setDescription('Datos de la app Gestión de Transporte: edítalos desde la app.').setWarningOnly(true);
    }
  });
  carpeta_();
  const ahora = ahora_();
  const C = C_();
  const tc = tabla_('camiones');
  if (!tc.filas.length) {
    C.CATALOGO_INICIAL.camiones.forEach(function (c) {
      escribirFila_(tc, Object.assign(C.normalizarCamion(c), { version: 1, creado: ahora, actualizado: ahora, actualizadoPor: 'configuración' }), null);
    });
    const tt = tabla_('tarifas');
    C.CATALOGO_INICIAL.tarifas.forEach(function (t) {
      escribirFila_(tt, Object.assign(C.normalizarTarifa(t), { version: 1, creado: ahora, actualizado: ahora, actualizadoPor: 'configuración' }), null);
    });
  }
  const tcfg = tabla_('config');
  Object.keys(CONFIG_DEFECTO).forEach(function (k) {
    if (!tcfg.buscar(k)) escribirFila_(tcfg, { clave: k, valor: CONFIG_DEFECTO[k], actualizado: ahora, actualizadoPor: 'configuración' }, null);
  });
  const hoja1 = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (hoja1 && hoja1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(hoja1);
  incrementarRevision_();
  return { creadas: creadas, usuarios: tabla_('usuarios').filas.length };
}

function configurarHojas() {
  const ui = SpreadsheetApp.getUi();
  const r = configurarHojas_();
  ui.alert('Configuración lista', (r.creadas.length ? 'Hojas creadas: ' + r.creadas.join(', ') + '.\n' : 'Las hojas ya existían; se revisaron encabezados y formatos.\n') +
    'Carpeta de fotos en tu Google Drive: "' + NOMBRE_CARPETA + '".', ui.ButtonSet.OK);
  if (!r.usuarios) {
    ui.alert('Crea el primer usuario', 'A continuación crea el primer usuario con rol "admin".', ui.ButtonSet.OK);
    menuCrearUsuario();
  }
}

function pedir_(ui, titulo, texto) {
  const r = ui.prompt(titulo, texto, ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  return r.getResponseText().trim();
}

function menuCrearUsuario() {
  const ui = SpreadsheetApp.getUi();
  const usuario = pedir_(ui, 'Crear usuario (1/4)', 'Nombre de usuario, sin espacios (ej.: esteban):');
  if (usuario === null) return;
  const nombre = pedir_(ui, 'Crear usuario (2/4)', 'Nombre para mostrar (ej.: Esteban Torres):');
  if (nombre === null) return;
  const rol = pedir_(ui, 'Crear usuario (3/4)', 'Rol: escribe "admin" (administra camiones, tarifas y ajustes) o "usuario" (registra viajes):');
  if (rol === null) return;
  const clave = pedir_(ui, 'Crear usuario (4/4)', 'Clave inicial (mínimo 8 caracteres). La persona puede cambiarla en Ajustes:');
  if (clave === null) return;
  try {
    crearUsuario_(usuario, nombre, String(rol).toLowerCase(), clave);
    ui.alert('Usuario "' + normalizarUsuario_(usuario) + '" listo. Entrégale su clave por un canal privado.');
  } catch (err) {
    ui.alert('No se pudo crear: ' + err.message);
  }
}

function menuRestablecerClave() {
  const ui = SpreadsheetApp.getUi();
  const usuario = pedir_(ui, 'Restablecer clave', 'Usuario:');
  if (usuario === null) return;
  const fila = tabla_('usuarios').buscar(normalizarUsuario_(usuario));
  if (!fila) { ui.alert('No existe ese usuario.'); return; }
  const clave = pedir_(ui, 'Restablecer clave', 'Nueva clave (mínimo 8 caracteres):');
  if (clave === null) return;
  try {
    crearUsuario_(fila.obj.usuario, fila.obj.nombre, fila.obj.rol, clave);
    ui.alert('Clave actualizada. Sus sesiones abiertas se cerraron.');
  } catch (err) {
    ui.alert('No se pudo actualizar: ' + err.message);
  }
}

function menuActivarUsuario() {
  const ui = SpreadsheetApp.getUi();
  const usuario = pedir_(ui, 'Activar o desactivar', 'Usuario:');
  if (usuario === null) return;
  const fila = tabla_('usuarios').buscar(normalizarUsuario_(usuario));
  if (!fila) { ui.alert('No existe ese usuario.'); return; }
  const r = ui.alert('Usuario ' + fila.obj.usuario, fila.obj.activo ? '¿Desactivarlo? No podrá ingresar y se cerrarán sus sesiones.' : '¿Activarlo nuevamente?', ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  activarUsuario_(fila.obj.usuario, !fila.obj.activo);
  ui.alert('Listo.');
}

function menuCerrarSesiones() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Cerrar todas las sesiones', 'Todos deberán ingresar de nuevo. ¿Continuar?', ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  ui.alert('Se cerraron ' + cerrarSesiones_(null) + ' sesión(es).');
}
