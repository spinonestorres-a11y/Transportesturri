/* =========================================================================
   servidor-prueba.js — Backend local que ejecuta el Codigo.gs real
   -------------------------------------------------------------------------
   Sirve para probar la app sin Google: responde en /exec igual que la
   Aplicación web de Apps Script (POST text/plain con JSON, CORS abierto).

   Uso:
     node tests/servidor-prueba.js [--puerto 8787] [--estado prueba.json]
                                   [--usuario admin:admin:clave-admin-1]
                                   [--usuario ana:usuario:clave-ana-123]
                                   [--latencia 300] [--demo]
   --usuario  nombre:rol:clave (repetible). Si no se indica ninguno se crea
              admin / clave-admin-1.
   --estado   guarda los datos en un archivo JSON entre reinicios.
   --latencia agrega una demora en ms para simular la red de Apps Script.
   Luego en config.js: API_URL: 'http://127.0.0.1:8787/exec'
   ========================================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const { crearEntorno } = require('./gas-simulador');

const args = process.argv.slice(2);
const opcion = (nombre, defecto) => { const i = args.indexOf(nombre); return i === -1 ? defecto : args[i + 1]; };
const puerto = Number(opcion('--puerto', 8787));
const archivoEstado = opcion('--estado', null);
const latencia = Number(opcion('--latencia', 0));
const usuarios = args.map((a, i) => (a === '--usuario' ? args[i + 1] : null)).filter(Boolean);

const env = crearEntorno();
if (archivoEstado && fs.existsSync(archivoEstado)) {
  env.importar(JSON.parse(fs.readFileSync(archivoEstado, 'utf8')));
  console.log(`Estado cargado desde ${archivoEstado}`);
} else {
  env.gas('configurarHojas_')();
}
(usuarios.length ? usuarios : ['admin:admin:clave-admin-1']).forEach(u => {
  const [nombre, rol, clave] = u.split(':');
  env.gas('crearUsuario_')(nombre, nombre, rol, clave);
});
if (args.includes('--demo')) {
  const ses = env.llamar('login', { usuario: 'admin', claveHash: require('crypto').createHash('sha256').update('gestion-transporte|admin|clave-admin-1').digest('hex') });
  if (ses.token) env.llamar('cargarDemo', {}, ses.token);
}
const guardar = () => { if (archivoEstado) fs.writeFileSync(archivoEstado, JSON.stringify(env.exportar())); };
guardar();

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
let atendidas = 0;

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (!req.url.startsWith('/exec')) { res.writeHead(404, cors); res.end('No encontrado'); return; }
  let cuerpo = '';
  req.on('data', d => { cuerpo += d; });
  req.on('end', () => {
    setTimeout(() => {
      try {
        const salida = req.method === 'POST'
          ? env.gas('doPost')({ postData: { contents: cuerpo, type: req.headers['content-type'] || 'text/plain' } })
          : env.gas('doGet')({});
        atendidas += 1;
        if (req.method === 'POST') guardar();
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
        res.end(salida.getContent());
      } catch (err) {
        res.writeHead(500, cors);
        res.end(JSON.stringify({ error: 'interno', mensaje: String(err) }));
      }
    }, latencia);
  });
}).listen(puerto, '127.0.0.1', () => {
  console.log(`Backend de prueba en http://127.0.0.1:${puerto}/exec (latencia ${latencia} ms)`);
});

process.on('SIGTERM', () => { console.log(`Solicitudes atendidas: ${atendidas}`); process.exit(0); });
