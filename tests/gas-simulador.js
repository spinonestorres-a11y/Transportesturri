/* =========================================================================
   gas-simulador.js — Simulador mínimo de Google Apps Script para pruebas
   -------------------------------------------------------------------------
   Ejecuta el Codigo.gs y Calculos.gs REALES dentro de un contexto de Node con
   versiones en memoria de SpreadsheetApp, DriveApp, LockService,
   PropertiesService, CacheService, Utilities y ContentService.
   Imita comportamientos de Sheets que suelen causar errores:
   - Textos con forma de fecha o número se convierten, salvo formato "@".
   - Un texto que empieza con "=" se trata como fórmula (queda marcado).
   - getRange fuera de las filas máximas lanza error.
   No reemplaza probar en Google: sirve para validar la lógica.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..', 'apps-script');

function crearEntorno(opciones = {}) {
  const zona = opciones.zona || 'America/Santiago';
  const filasMaximas = opciones.filasMaximas || 1000;
  const estado = {
    hojas: [],
    props: new Map(),
    cache: new Map(),
    archivos: new Map(),
    carpetas: new Map(),
    respuestasUi: [],
    alertas: []
  };

  /* ---------- Conversión de celdas al estilo Sheets ---------- */
  function convertir(v, formato) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') return v;
    if (v.startsWith("'")) return v.slice(1);
    if (formato === '@') return v;
    if (v === '') return '';
    if (v.startsWith('=')) return `#FÓRMULA:${v}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const [a, m, d] = v.split('-').map(Number); return new Date(a, m - 1, d); }
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(v)) return new Date(v);
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'TRUE') return true;
    if (v === 'FALSE') return false;
    return v;
  }

  class Rango {
    constructor(hoja, fila, col, nf, nc) {
      if (fila < 1 || col < 1 || nf < 1 || nc < 1) throw new Error('Rango no válido.');
      if (fila + nf - 1 > hoja.maxFilas) throw new Error(`Las coordenadas del rango están fuera de las dimensiones de la hoja (${fila + nf - 1} > ${hoja.maxFilas}).`);
      Object.assign(this, { hoja, fila, col, nf, nc });
    }
    getValues() {
      const out = [];
      for (let r = 0; r < this.nf; r++) {
        const fila = this.hoja.celdas[this.fila - 1 + r] || [];
        const f = [];
        for (let c = 0; c < this.nc; c++) {
          const v = fila[this.col - 1 + c];
          f.push(v === undefined ? '' : (v instanceof Date ? new Date(v.getTime()) : v));
        }
        out.push(f);
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(vals) {
      if (vals.length !== this.nf || vals.some(f => f.length !== this.nc)) throw new Error('Las dimensiones de los datos no coinciden con el rango.');
      vals.forEach((f, r) => f.forEach((v, c) => this.hoja.escribir(this.fila + r, this.col + c, v)));
      return this;
    }
    setValue(v) { this.hoja.escribir(this.fila, this.col, v); return this; }
    setNumberFormat(fmt) {
      for (let r = 0; r < this.nf; r++) for (let c = 0; c < this.nc; c++) this.hoja.formatos.set(`${this.fila + r},${this.col + c}`, fmt);
      return this;
    }
    setNumberFormats(fmts) {
      fmts.forEach((f, r) => f.forEach((fmt, c) => this.hoja.formatos.set(`${this.fila + r},${this.col + c}`, fmt)));
      return this;
    }
    setFontWeight() { return this; }
  }

  class Hoja {
    constructor(nombre) {
      this.nombre = nombre;
      this.celdas = [];
      this.formatos = new Map();
      this.maxFilas = filasMaximas;
    }
    getName() { return this.nombre; }
    escribir(f, c, v) {
      if (f > this.maxFilas) throw new Error('Fila fuera de la hoja.');
      while (this.celdas.length < f) this.celdas.push([]);
      const fila = this.celdas[f - 1];
      while (fila.length < c) fila.push('');
      fila[c - 1] = convertir(v, this.formatos.get(`${f},${c}`));
    }
    getRange(f, c, nf = 1, nc = 1) { return new Rango(this, f, c, nf, nc); }
    getLastRow() {
      for (let r = this.celdas.length; r >= 1; r--) if ((this.celdas[r - 1] || []).some(v => v !== '' && v !== undefined)) return r;
      return 0;
    }
    getLastColumn() {
      let max = 0;
      this.celdas.forEach(f => { for (let c = f.length; c >= 1; c--) if (f[c - 1] !== '' && f[c - 1] !== undefined) { max = Math.max(max, c); break; } });
      return max;
    }
    getMaxRows() { return this.maxFilas; }
    insertRowsAfter(despues, n) { this.maxFilas += n; }
    getDataRange() { return new Rango(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
    appendRow(fila) { const n = this.getLastRow() + 1; if (n > this.maxFilas) this.maxFilas = n; fila.forEach((v, i) => this.escribir(n, i + 1, v)); return this; }
    deleteRow(n) {
      this.celdas.splice(n - 1, 1);
      const nuevos = new Map();
      this.formatos.forEach((fmt, k) => {
        const [f, c] = k.split(',').map(Number);
        if (f < n) nuevos.set(k, fmt); else if (f > n) nuevos.set(`${f - 1},${c}`, fmt);
      });
      this.formatos = nuevos;
    }
    setFrozenRows() { return this; }
    protect() { const p = { setDescription: () => p, setWarningOnly: () => p }; return p; }
  }

  const libro = {
    getId: () => 'libro-prueba',
    getSheetByName: n => estado.hojas.find(h => h.nombre === n) || null,
    insertSheet: n => { const h = new Hoja(n); estado.hojas.push(h); return h; },
    getSheets: () => estado.hojas.slice(),
    deleteSheet: h => { estado.hojas = estado.hojas.filter(x => x !== h); }
  };

  const ui = {
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    Button: { OK: 'OK', YES: 'YES', CANCEL: 'CANCEL', NO: 'NO' },
    createMenu: () => { const m = { addItem: () => m, addSeparator: () => m, addToUi: () => m }; return m; },
    alert: (a, b) => { estado.alertas.push(b || a); return estado.respuestasUi.length ? estado.respuestasUi.shift() : 'YES'; },
    prompt: () => { const r = estado.respuestasUi.shift(); return { getSelectedButton: () => (r === null ? 'CANCEL' : 'OK'), getResponseText: () => r || '' }; }
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => libro,
    openById: () => libro,
    flush: () => {},
    getUi: () => ui
  };

  /* ---------- Drive ---------- */
  function crearBlob(bytes, tipo, nombre) {
    const b = { bytes: bytes.slice(), tipo, nombre };
    return { getBytes: () => b.bytes.slice(), getContentType: () => b.tipo, getName: () => b.nombre, setName: n => { b.nombre = n; }, _b: b };
  }
  function crearArchivo(blob) {
    const id = 'archivo-' + crypto.randomBytes(6).toString('hex');
    const a = { id, nombre: blob.getName(), tipo: blob.getContentType(), bytes: blob.getBytes(), papelera: false };
    estado.archivos.set(id, a);
    return envolverArchivo(a);
  }
  function envolverArchivo(a) {
    return {
      getId: () => a.id, getName: () => a.nombre, setName: n => { a.nombre = n; },
      setTrashed: t => { a.papelera = !!t; }, isTrashed: () => a.papelera,
      getBlob: () => crearBlob(a.bytes, a.tipo, a.nombre)
    };
  }
  const DriveApp = {
    createFolder: nombre => {
      const id = 'carpeta-' + crypto.randomBytes(4).toString('hex');
      estado.carpetas.set(id, { id, nombre });
      return { getId: () => id, createFile: crearArchivo };
    },
    getFolderById: id => {
      if (!estado.carpetas.has(id)) throw new Error('Carpeta no encontrada');
      return { getId: () => id, createFile: crearArchivo };
    },
    getFileById: id => {
      const a = estado.archivos.get(id);
      if (!a) throw new Error('Archivo no encontrado');
      return envolverArchivo(a);
    }
  };

  /* ---------- Servicios varios ---------- */
  const firmado = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    getUuid: () => crypto.randomUUID(),
    computeDigest: (alg, texto) => firmado(crypto.createHash(alg).update(String(texto), 'utf8').digest()),
    base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
    base64Decode: s => firmado(Buffer.from(String(s), 'base64')),
    newBlob: (bytes, tipo, nombre) => crearBlob(bytes, tipo, nombre),
    sleep: () => {},
    formatDate: (fecha, tz, formato) => {
      const p = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: tz || zona, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(fecha).forEach(x => { p[x.type] = x.value; });
      return formato.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
    }
  };
  const almacenProps = {
    getProperty: k => (estado.props.has(k) ? estado.props.get(k) : null),
    setProperty: (k, v) => { estado.props.set(k, String(v)); return almacenProps; },
    deleteProperty: k => { estado.props.delete(k); return almacenProps; },
    getProperties: () => Object.fromEntries(estado.props),
    getKeys: () => Array.from(estado.props.keys())
  };
  const PropertiesService = { getScriptProperties: () => almacenProps };
  const cache = {
    get: k => { const e = estado.cache.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
    put: (k, v, seg) => { estado.cache.set(k, { v: String(v), exp: Date.now() + (seg || 600) * 1000 }); },
    remove: k => { estado.cache.delete(k); }
  };
  const CacheService = { getScriptCache: () => cache };
  let bloqueado = false;
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => { if (bloqueado) return false; bloqueado = true; return true; },
      waitLock: () => { if (bloqueado) throw new Error('Bloqueo ocupado'); bloqueado = true; },
      releaseLock: () => { bloqueado = false; },
      hasLock: () => bloqueado
    })
  };
  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s })
  };
  const registroConsola = [];
  const consola = {
    log: (...a) => registroConsola.push(['log', a.join(' ')]),
    warn: (...a) => registroConsola.push(['warn', a.join(' ')]),
    error: (...a) => registroConsola.push(['error', a.join(' ')])
  };

  const contexto = vm.createContext({
    SpreadsheetApp, DriveApp, Utilities, PropertiesService, CacheService, LockService, ContentService,
    Session: { getScriptTimeZone: () => zona }, Logger: { log: consola.log }, console: consola,
    Date, Math, JSON, Intl
  });
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'Calculos.gs'), 'utf8'), contexto, { filename: 'Calculos.gs' });
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'Codigo.gs'), 'utf8'), contexto, { filename: 'Codigo.gs' });

  const gas = nombre => vm.runInContext(nombre, contexto);

  /** Llama a doPost como lo haría la app y devuelve el JSON. */
  function llamar(accion, datos = {}, token = null) {
    const cuerpo = JSON.stringify(Object.assign({ accion, token }, datos));
    return JSON.parse(gas('doPost')({ postData: { contents: cuerpo, type: 'text/plain' } }).getContent());
  }

  /* ---------- Persistencia opcional (servidor de prueba) ---------- */
  function exportar() {
    const ser = v => (v instanceof Date ? { $fecha: v.toISOString() } : v);
    return {
      hojas: estado.hojas.map(h => ({ nombre: h.nombre, maxFilas: h.maxFilas, celdas: h.celdas.map(f => f.map(ser)), formatos: Array.from(h.formatos) })),
      props: Array.from(estado.props),
      carpetas: Array.from(estado.carpetas),
      archivos: Array.from(estado.archivos.values()).map(a => Object.assign({}, a, { bytes: Buffer.from(a.bytes.map(b => b & 255)).toString('base64') }))
    };
  }
  function importar(d) {
    const des = v => (v && typeof v === 'object' && v.$fecha ? new Date(v.$fecha) : v);
    estado.hojas = d.hojas.map(x => { const h = new Hoja(x.nombre); h.maxFilas = x.maxFilas; h.celdas = x.celdas.map(f => f.map(des)); h.formatos = new Map(x.formatos); return h; });
    estado.props = new Map(d.props);
    estado.carpetas = new Map(d.carpetas);
    estado.archivos = new Map(d.archivos.map(a => [a.id, Object.assign({}, a, { bytes: firmado(Buffer.from(a.bytes, 'base64')) })]));
  }

  return { gas, llamar, estado, registroConsola, exportar, importar, libro };
}

module.exports = { crearEntorno };
