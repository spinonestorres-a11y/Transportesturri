/* Pruebas de reglas de cálculo. Ejecutar: node tests/calculos.test.js
   Usa la misma autocomprobación que la app (Ajustes → Autocomprobación)
   y agrega verificaciones de validación. Sale con código 1 si algo falla. */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'calculos.js'));

let fallas = 0;
function reportar(nombre, ok, esperado, obtenido) {
  if (ok) console.log(`  ✔ ${nombre}`);
  else {
    fallas += 1;
    console.log(`  ✘ ${nombre} — esperado ${JSON.stringify(esperado)}, obtenido ${JSON.stringify(obtenido)}`);
  }
}

console.log('Autocomprobación compartida con la app:');
for (const r of C.autocomprobacion()) reportar(r.nombre, r.ok, r.esperado, r.obtenido);

console.log('\nValidaciones adicionales:');
const base = {
  fecha: '2026-09-22', estado: 'realizado', sitio: 'Obra Norte', localidad: 'Sector Norte',
  camionId: 'cam-6000kg', modalidad: 'propio', formaCobro: 'km', km: 100, tarifa: 1650
};
const ok = C.validarViaje(C.normalizarViaje(base));
reportar('Viaje completo es válido', Object.keys(ok).length === 0, {}, ok);

const sinSitio = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { sitio: '  ' })));
reportar('Sitio obligatorio', 'sitio' in sinSitio, 'error sitio', sinSitio);

const kmCero = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { km: 0 })));
reportar('Cobro por km exige km > 0', 'km' in kmCero, 'error km', kmCero);

const fijaSinKm = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { formaCobro: 'fija', km: null, tarifa: 90000 })));
reportar('Tarifa fija no exige km', !('km' in fijaSinKm), 'sin error km', fijaSinKm);

const negativo = C.validarViaje(Object.assign(C.normalizarViaje(base), { combustible: -1 }));
reportar('Combustible negativo rechazado', 'combustible' in negativo, 'error combustible', negativo);

const terceroSinTarifa = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { modalidad: 'tercerizado' })));
reportar('Tercerizado exige tarifa del transportista', 'transportista.tarifaKm' in terceroSinTarifa, 'error', terceroSinTarifa);

const fechaMala = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { fecha: '2026-13-01' })));
reportar('Fecha inválida rechazada', 'fecha' in fechaMala, 'error fecha', fechaMala);

const norm = C.normalizarViaje({ tarifaRef: { ivaTratamiento: 'pendiente', monto: 70000 } });
reportar('Tarifa con IVA pendiente queda por confirmar', norm.netoConfirmado === false, false, norm.netoConfirmado);

console.log('\nParidad con las planillas del cliente (marzo 2026, columna "Total utilidad viaje"):');
const planillas = [
  {
    nombre: 'Antofagasta (1.378 km × $1.650 + extra $100.000 − transportista 1.378 × $1.440)',
    esperado: 389380,
    viaje: { km: 1378, formaCobro: 'km', tarifa: 1650, modalidad: 'tercerizado',
      transportista: { modo: 'km', tarifaKm: 1440 }, cobrosAdicionales: [{ concepto: 'Sobreestadía', monto: 100000 }] }
  },
  {
    nombre: 'Antofagasta–Ollagüe (fijo $2.800.000 − transportista $2.100.000 − otros $280.000)',
    esperado: 420000,
    viaje: { km: 1800, formaCobro: 'fija', tarifa: 2800000, modalidad: 'tercerizado',
      transportista: { modo: 'fijo', montoFijo: 2100000 }, otrosGastos: [{ concepto: 'Otros', monto: 280000 }] }
  },
  {
    nombre: 'Pedregoso–Lonquimay (fijo $930.000, propio, combustible, peajes, comida, otros y chofer)',
    esperado: 298520, // planilla: 298.519,57 (combustible con decimales; la app redondea a pesos)
    viaje: { km: 775, formaCobro: 'fija', tarifa: 930000, modalidad: 'propio',
      combustible: 268000, peajesReales: 43700, comida: 9780,
      chofer: { modo: 'km', tarifaKm: 200 },
      otrosGastos: [{ concepto: 'Otros', monto: 155000 }] }
  },
  {
    nombre: 'Punta Palmera–Coquimbo (fijo $600.000 − $400.000)',
    esperado: 200000,
    viaje: { km: 510, formaCobro: 'fija', tarifa: 600000, modalidad: 'tercerizado',
      transportista: { modo: 'fijo', montoFijo: 400000 } }
  }
];
planillas.forEach(p => {
  const c = C.calcularViaje(C.normalizarViaje(Object.assign({}, base, p.viaje)));
  reportar(p.nombre, c.margenBruto === p.esperado, p.esperado, c.margenBruto);
});

console.log('\nPago al chofer y modelo:');
const sinChofer = C.normalizarViaje({ km: 10 });
reportar('Viaje antiguo sin chofer queda "sin pago"', sinChofer.chofer.modo === 'ninguno', 'ninguno', sinChofer.chofer.modo);
const chSinTarifa = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { chofer: { modo: 'km' } })));
reportar('Chofer por km exige tarifa', 'chofer.tarifaKm' in chSinTarifa, 'error', chSinTarifa);
const chKmSinKm = C.validarViaje(C.normalizarViaje(Object.assign({}, base, { formaCobro: 'fija', tarifa: 90000, km: null, chofer: { modo: 'km', tarifaKm: 200 } })));
reportar('Chofer por km exige km > 0', 'km' in chKmSinKm, 'error km', chKmSinKm);
const demo = C.datosDemo('2026-09-22');
const resDemo = C.resumirPeriodo(demo.viajes.filter(v => v.fecha >= '2026-09-01' && v.fecha <= '2026-09-30'));
reportar('Demo sept: margen realizados $272.400', resDemo.realizados.margenBruto === 272400, 272400, resDemo.realizados.margenBruto);
reportar('Demo sept: resultado estimado $344.900', resDemo.resultadoEstimado === 344900, 344900, resDemo.resultadoEstimado);

console.log('\nCopia para Apps Script:');
const fs = require('fs');
const gs = path.join(__dirname, '..', 'apps-script', 'Calculos.gs');
const iguales = fs.existsSync(gs) && fs.readFileSync(gs, 'utf8') === fs.readFileSync(path.join(__dirname, '..', 'calculos.js'), 'utf8');
reportar('apps-script/Calculos.gs es idéntico a calculos.js', iguales, 'idénticos', iguales ? 'idénticos' : 'distintos o falta el archivo');

const ids = new Set(Array.from({ length: 2000 }, () => C.generarId()));
reportar('2.000 identificadores sin colisiones', ids.size === 2000, 2000, ids.size);

console.log(fallas === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallas} prueba(s) fallaron.`);
process.exit(fallas === 0 ? 0 : 1);
