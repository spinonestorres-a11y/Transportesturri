/* Pruebas del backend (Codigo.gs real) sobre el simulador de Apps Script.
   Ejecutar: node tests/backend.test.js */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { crearEntorno } = require('./gas-simulador');
const C = require(path.join(__dirname, '..', 'calculos.js'));

let fallas = 0;
let total = 0;
function ok(nombre, cond, detalle) {
  total += 1;
  if (cond) console.log(`  ✔ ${nombre}`);
  else { fallas += 1; console.log(`  ✘ ${nombre}${detalle !== undefined ? ` — ${JSON.stringify(detalle).slice(0, 300)}` : ''}`); }
}
const hashCliente = (u, clave) => crypto.createHash('sha256').update(`gestion-transporte|${u}|${clave}`).digest('hex');

const env = crearEntorno({ filasMaximas: 20 });
const { gas, llamar, estado } = env;

console.log('Configuración inicial:');
const conf = gas('configurarHojas_')();
const nombresHojas = estado.hojas.map(h => h.nombre);
ok('Crea las 8 hojas', ['Viajes', 'Adjuntos', 'Rutas', 'Camiones', 'Tarifas', 'Config', 'Usuarios', 'Registro'].every(n => nombresHojas.includes(n)), nombresHojas);
ok('Informa que no hay usuarios', conf.usuarios === 0);
gas('crearUsuario_')('admin', 'Administrador', 'admin', 'clave-admin-1');
['ana', 'beto', 'carla', 'dani', 'eli'].forEach(u => gas('crearUsuario_')(u, u.toUpperCase(), 'usuario', `clave-${u}-123`));
ok('Usuarios creados con hash (sin clave en texto)', !JSON.stringify(env.exportar().hojas).includes('clave-ana-123'));
ok('Segunda configuración no duplica catálogo', (gas('configurarHojas_')(), true) && estado.hojas.find(h => h.nombre === 'Camiones').getLastRow() === 3);
ok('Rechaza usuario con espacios', (() => { try { gas('crearUsuario_')('mal usuario', 'x', 'usuario', '12345678'); return false; } catch (e) { return true; } })());

console.log('\nSesiones:');
ok('ping sin sesión', llamar('ping').ok === true);
ok('datos sin sesión → error sesion', llamar('datos').error === 'sesion');
const malo = llamar('login', { usuario: 'ana', claveHash: hashCliente('ana', 'otra') });
ok('Clave incorrecta → credenciales', malo.error === 'credenciales');
for (let i = 0; i < 5; i++) llamar('login', { usuario: 'eli', claveHash: 'x' });
ok('Tras 5 intentos fallidos queda bloqueado', llamar('login', { usuario: 'eli', claveHash: hashCliente('eli', 'clave-eli-123') }).error === 'bloqueado');
const sesiones = {};
['admin', 'ana', 'beto', 'carla', 'dani'].forEach(u => {
  const r = llamar('login', { usuario: u.toUpperCase(), claveHash: hashCliente(u, u === 'admin' ? 'clave-admin-1' : `clave-${u}-123`) });
  sesiones[u] = r.token;
});
ok('Login correcto (usuario sin distinguir mayúsculas)', Object.values(sesiones).every(t => typeof t === 'string' && t.length === 64));
const datos0 = llamar('datos', {}, sesiones.ana);
ok('datos entrega catálogo inicial', datos0.camiones.length === 2 && datos0.tarifas.length === 4 && datos0.config.choferTarifaKm === 200, datos0.camiones);
ok('datos no expone hashes de usuarios', !JSON.stringify(datos0.usuarios).includes('hash') && datos0.usuarios.length === 6);
const rev0 = llamar('revision', {}, sesiones.ana).revision;

console.log('\nViajes y concurrencia:');
const base = {
  fecha: '2026-09-22', estado: 'realizado', sitio: 'Obra Norte', localidad: 'Sector Norte', camionId: 'cam-6000kg',
  camionNombre: 'Camión 6.000 kg', modalidad: 'tercerizado', formaCobro: 'km', km: 1000, tarifa: 1650,
  transportista: { modo: 'km', tarifaKm: 1440 }, contacto: '56 9 4779 9585', notas: '=HYPERLINK("http://x")', aplicaIva: true, ivaPct: 19
};
const usuarios5 = ['admin', 'ana', 'beto', 'carla', 'dani'];
const creados = usuarios5.map(u => llamar('guardarViaje', { viaje: Object.assign({}, base, { id: crypto.randomUUID(), sitio: `Obra de ${u}` }), versionBase: null, opId: crypto.randomUUID() }, sesiones[u]));
const codigos = creados.map(r => r.viaje && r.viaje.codigo);
ok('5 usuarios crean viajes: códigos únicos y correlativos', new Set(codigos).size === 5 && codigos.every(c => /^V-\d{4}-000[1-5]$/.test(c)), codigos);
ok('creadoPor corresponde a cada usuario', creados.every((r, i) => r.viaje.creadoPor === usuarios5[i]));
const v1 = creados[1].viaje;
const hojaV = estado.hojas.find(h => h.nombre === 'Viajes');
const enc = hojaV.celdas[0];
const filaV1 = hojaV.celdas.find(f => f[0] === v1.id);
ok('Fecha guardada como texto (no convertida a fecha)', filaV1[enc.indexOf('Fecha')] === '2026-09-22', filaV1[enc.indexOf('Fecha')]);
ok('Teléfono queda como texto', filaV1[enc.indexOf('Contacto en sitio')] === '56 9 4779 9585');
ok('Texto que empieza con "=" no se vuelve fórmula', filaV1[enc.indexOf('Observaciones')] === '=HYPERLINK("http://x")', filaV1[enc.indexOf('Observaciones')]);
ok('Columna calculada de margen = Calculos (210.000)', filaV1[enc.indexOf('Margen bruto (calc.)')] === 210000);
ok('Revisión aumenta con cada escritura', creados[4].revision === rev0 + 5, [rev0, creados[4].revision]);

const edA = llamar('guardarViaje', { viaje: Object.assign({}, v1, { comida: 5000 }), versionBase: 1, opId: crypto.randomUUID() }, sesiones.ana);
ok('Edición con versión correcta → versión 2', edA.viaje && edA.viaje.version === 2 && edA.viaje.codigo === v1.codigo, edA);
const edB = llamar('guardarViaje', { viaje: Object.assign({}, v1, { comida: 9000 }), versionBase: 1, opId: crypto.randomUUID() }, sesiones.beto);
ok('Edición con versión vieja → conflicto con datos actuales', edB.error === 'conflicto' && edB.datos.actual.comida === 5000 && edB.datos.actual.actualizadoPor === 'ana', edB);
const op = crypto.randomUUID();
const r1 = llamar('guardarViaje', { viaje: Object.assign({}, edA.viaje, { comida: 6000 }), versionBase: 2, opId: op }, sesiones.beto);
const r2 = llamar('guardarViaje', { viaje: Object.assign({}, edA.viaje, { comida: 6000 }), versionBase: 2, opId: op }, sesiones.beto);
ok('Reintento con la misma operación no duplica ni da conflicto', r1.viaje.version === 3 && r2.repetido === true && r2.viaje.version === 3, [r1.viaje && r1.viaje.version, r2]);
ok('Crear con id existente sin operación → duplicado', llamar('guardarViaje', { viaje: v1, versionBase: null }, sesiones.carla).error === 'duplicado');
ok('Datos inválidos → validacion', llamar('guardarViaje', { viaje: Object.assign({}, base, { id: crypto.randomUUID(), sitio: '' }) }, sesiones.carla).error === 'validacion');
const conChofer = llamar('guardarViaje', {
  viaje: Object.assign({}, base, { id: crypto.randomUUID(), modalidad: 'propio', formaCobro: 'fija', tarifa: 930000, km: 775, combustible: 268000, peajesReales: 43700, comida: 9780, chofer: { modo: 'km', tarifaKm: 200 }, otrosGastos: [{ id: 'g1', concepto: 'Otros', monto: 155000 }], notas: '' }),
  opId: crypto.randomUUID()
}, sesiones.dani);
const filaCh = hojaV.celdas.find(f => f[0] === conChofer.viaje.id);
ok('Pago al chofer se guarda y calcula (Pedregoso = 298.520)', conChofer.viaje.chofer.modo === 'km' && filaCh[enc.indexOf('Margen bruto (calc.)')] === 298520, filaCh && filaCh[enc.indexOf('Margen bruto (calc.)')]);

console.log('\nPermisos y catálogos:');
ok('Usuario no puede crear tarifas', llamar('guardarRegistro', { tabla: 'tarifas', registro: { camionId: 'cam-6000kg', nombre: 'x', modalidad: 'km', monto: 1, vigenciaDesde: '2026-09-22' } }, sesiones.ana).error === 'permiso');
ok('Usuario no puede cambiar ajustes', llamar('guardarConfig', { valores: { ivaPct: 10 } }, sesiones.ana).error === 'permiso');
const ruta = llamar('guardarRegistro', { tabla: 'rutas', registro: { nombre: 'Ruta A', km: 120, peajes: 7800, vigencia: '2026-09-22' } }, sesiones.ana);
ok('Usuario puede crear rutas', ruta.registro && ruta.registro.version === 1);
ok('Nombre de ruta repetido rechazado', llamar('guardarRegistro', { tabla: 'rutas', registro: { nombre: 'ruta a' } }, sesiones.beto).error === 'validacion');
const conRuta = llamar('guardarViaje', {
  viaje: Object.assign({}, base, { id: crypto.randomUUID(), rutaId: ruta.registro.id, km: 135, notas: '' }), opId: crypto.randomUUID(),
  rutaActualizada: { id: ruta.registro.id, km: 135, peajes: 8000 }
}, sesiones.ana);
ok('Guardar viaje puede actualizar la ruta (km 135, versión 2)', conRuta.ruta && conRuta.ruta.km === 135 && conRuta.ruta.version === 2, conRuta.ruta);
const cfg = llamar('guardarConfig', { valores: { choferTarifaKm: 250, nombreApp: 'Transportes ET' } }, sesiones.admin);
ok('Admin cambia ajustes compartidos', cfg.config.choferTarifaKm === 250 && cfg.config.nombreApp === 'Transportes ET');
ok('Camión en uso no se puede eliminar', llamar('eliminarRegistro', { tabla: 'camiones', id: 'cam-6000kg' }, sesiones.admin).error === 'enUso');
const nuevoCam = llamar('guardarRegistro', { tabla: 'camiones', registro: { nombre: 'Camión prueba', capacidadKg: 3000 } }, sesiones.admin);
llamar('guardarRegistro', { tabla: 'tarifas', registro: { camionId: nuevoCam.registro.id, nombre: 'Km', modalidad: 'km', monto: 1000, vigenciaDesde: '2026-09-22', ivaTratamiento: 'neto' } }, sesiones.admin);
const elimCam = llamar('eliminarRegistro', { tabla: 'camiones', id: nuevoCam.registro.id }, sesiones.admin);
ok('Eliminar camión sin viajes elimina también sus tarifas', elimCam.eliminado && elimCam.tarifasEliminadas.length === 1);
const pend = llamar('guardarViaje', {
  viaje: Object.assign({}, base, { id: crypto.randomUUID(), camionId: 'cam-1700kg', formaCobro: 'fija', tarifa: 70000, km: 50, modalidad: 'propio', notas: '',
    tarifaRef: { id: 'tar-1700-stgo', nombre: 'Vuelta en Santiago', modalidad: 'fija', monto: 70000, ivaTratamiento: 'pendiente' }, netoConfirmado: false }),
  opId: crypto.randomUUID()
}, sesiones.beto);
const conf2 = llamar('confirmarViajesTarifa', { tarifaId: 'tar-1700-stgo' }, sesiones.admin);
ok('Confirmar IVA de tarifa actualiza viajes pendientes', conf2.viajes.length === 1 && conf2.viajes[0].netoConfirmado === true && conf2.viajes[0].version === 2, conf2);

console.log('\nFotos en Drive:');
const bytes = crypto.randomBytes(3000);
const b64 = bytes.toString('base64');
const meta = { id: crypto.randomUUID(), viajeId: v1.id, categoria: 'guia', nombre: 'guia.jpg', tipo: 'image/jpeg', ancho: 1600, alto: 1067 };
const sub = llamar('subirAdjunto', { adjunto: meta, datos: b64 }, sesiones.carla);
ok('Sube foto: fila en Adjuntos y archivo en Drive', sub.adjunto && estado.archivos.has(sub.adjunto.archivoId) && sub.adjunto.tamano === 3000, sub);
ok('Nombre del archivo en Drive incluye el código del viaje', estado.archivos.get(sub.adjunto.archivoId).nombre.startsWith(v1.codigo));
const rep = llamar('subirAdjunto', { adjunto: meta, datos: b64 }, sesiones.carla);
const papelera = Array.from(estado.archivos.values()).filter(a => a.papelera).length;
ok('Reintento de la misma foto no duplica (el archivo extra va a la papelera)', rep.repetido === true && papelera === 1);
const bajada = llamar('obtenerAdjunto', { id: meta.id }, sesiones.dani);
ok('Otro usuario descarga la misma foto', Buffer.from(bajada.datos, 'base64').equals(bytes));
ok('Tipo de archivo no permitido', llamar('subirAdjunto', { adjunto: Object.assign({}, meta, { id: 'x1', tipo: 'application/pdf' }), datos: b64 }, sesiones.carla).error === 'validacion');
ok('Foto de viaje inexistente → noExiste y archivo a papelera',
  llamar('subirAdjunto', { adjunto: Object.assign({}, meta, { id: 'x2', viajeId: 'no-existe' }), datos: b64 }, sesiones.carla).error === 'noExiste' &&
  Array.from(estado.archivos.values()).filter(a => a.papelera).length === 2);
const elimV = llamar('eliminarViaje', { id: v1.id, versionBase: 1 }, sesiones.ana);
ok('Eliminar con versión vieja → conflicto', elimV.error === 'conflicto');
const elimOk = llamar('eliminarViaje', { id: v1.id, versionBase: 3 }, sesiones.ana);
ok('Eliminar viaje borra sus fotos (papelera)', elimOk.eliminado && elimOk.fotosEliminadas.length === 1 && estado.archivos.get(sub.adjunto.archivoId).papelera);
ok('Eliminar dos veces es seguro', llamar('eliminarViaje', { id: v1.id }, sesiones.ana).yaNoExistia === true);

console.log('\nImportación, demostración y capacidad:');
// El archivo histórico tiene datos reales del cliente y no va en el repositorio.
// Ruta: variable ARCHIVO_HISTORICO o ../datos-historicos/ junto a la carpeta del proyecto.
const rutaHist = process.env.ARCHIVO_HISTORICO || path.join(__dirname, '..', '..', 'datos-historicos', 'importar-planillas-marzo-2026.json');
if (fs.existsSync(rutaHist)) {
  const hist = JSON.parse(fs.readFileSync(rutaHist, 'utf8'));
  const imp = llamar('importar', { datos: hist.datos }, sesiones.admin);
  ok('Importa las 4 planillas', imp.resultado && imp.resultado.viajesAgregados === 4, imp);
  const datos1 = llamar('datos', {}, sesiones.ana);
  const margenMarzo = datos1.viajes.filter(v => v.fecha.startsWith('2026-03')).reduce((s, v) => s + C.calcularViaje(v).margenBruto, 0);
  ok('Margen de marzo importado = $1.307.900 (igual a las planillas)', margenMarzo === 1307900, margenMarzo);
  ok('Reimportar no duplica', llamar('importar', { datos: hist.datos }, sesiones.admin).resultado.viajesSinCambio === 4);
  ok('Usuario no puede importar', llamar('importar', { datos: hist.datos }, sesiones.ana).error === 'permiso');
} else {
  console.log('  (omitidas 4 pruebas de importación: no se encontró ' + rutaHist + ')');
  ok('Usuario no puede importar', llamar('importar', { datos: { viajes: [] } }, sesiones.ana).error === 'permiso');
}
const demo = llamar('cargarDemo', {}, sesiones.admin);
ok('Cargar demostración', demo.viajes === 6 && demo.rutas === 2);
const sinDemo = llamar('eliminarDemo', {}, sesiones.admin);
ok('Eliminar demostración', sinDemo.viajes === 6 && sinDemo.rutas === 2);
let errCap = null;
for (let i = 0; i < 25 && !errCap; i++) {
  const r = llamar('guardarViaje', { viaje: Object.assign({}, base, { id: crypto.randomUUID(), notas: '' }), opId: crypto.randomUUID() }, sesiones.beto);
  if (r.error) errCap = r;
}
ok('Agrega filas más allá del máximo de la hoja (inserta filas)', errCap === null, errCap);
const datos2 = llamar('datos', {}, sesiones.beto);
ok('datos después de muchas escrituras: códigos siguen únicos', new Set(datos2.viajes.map(v => v.codigo)).size === datos2.viajes.length);
ok('Registro de auditoría con filas', estado.hojas.find(h => h.nombre === 'Registro').getLastRow() > 30);

console.log('\nClaves y usuarios:');
const cambio = llamar('cambiarClave', { claveActualHash: hashCliente('dani', 'clave-dani-123'), claveNuevaHash: hashCliente('dani', 'nueva-clave-99') }, sesiones.dani);
ok('Cambiar clave', cambio.cambiada === true);
ok('Login con clave nueva', typeof llamar('login', { usuario: 'dani', claveHash: hashCliente('dani', 'nueva-clave-99') }).token === 'string');
gas('activarUsuario_')('carla', false);
ok('Desactivar usuario cierra sus sesiones', llamar('datos', {}, sesiones.carla).error === 'sesion');
ok('Usuario desactivado no puede ingresar', llamar('login', { usuario: 'carla', claveHash: hashCliente('carla', 'clave-carla-123') }).error === 'credenciales');
ok('Logout invalida el token', llamar('logout', {}, sesiones.beto).ok && llamar('datos', {}, sesiones.beto).error === 'sesion');
ok('Sin errores internos en consola del servidor', !env.registroConsola.some(([t]) => t === 'error'), env.registroConsola.filter(([t]) => t === 'error'));

console.log(fallas ? `\n${fallas} de ${total} prueba(s) fallaron.` : `\n${total} pruebas de backend pasaron.`);
process.exit(fallas ? 1 : 0);
