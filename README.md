# Gestión de Transporte

App web instalable (PWA) para registrar viajes de transporte y ver, por viaje y por mes, cuánto se cobra, cuánto cuesta y cuánto margen queda. Sirve para controlar la operación actual (hoy mayormente tercerizada) y para juntar datos que después ayuden a decidir la compra de un camión propio.

**Versión 2**: la usan varias personas a la vez (pensada para unas 5), con los datos en una **Google Sheet**. Se instala en el celular como app y sigue funcionando sin señal.

```
Celulares / PC (PWA en GitHub Pages)          Google (cuenta del dueño)
┌──────────────────────────────┐   HTTPS    ┌──────────────────────────────┐
│ index.html · app.js · api.js │ ─────────▶ │ Apps Script (Aplicación web) │
│ copia local + cola sin señal │ ◀───────── │ Codigo.gs + Calculos.gs      │
│ (IndexedDB)                  │   JSON     ├──────────────────────────────┤
└──────────────────────────────┘            │ Google Sheet: Viajes, Rutas, │
                                            │ Camiones, Tarifas, Usuarios… │
                                            │ Google Drive: fotos (privada)│
                                            └──────────────────────────────┘
```

## Estructura

```
gestion-transporte/
├── index.html, styles.css      Estructura y estilos (mobile first, claro/oscuro, impresión)
├── config.js                   ← API_URL de Apps Script (lo único que se edita al desplegar)
├── calculos.js                 Reglas de negocio puras (las mismas en el celular y en el servidor)
├── db.js                       IndexedDB local: copia de los datos, cola sin señal, fotos, borradores
├── api.js                      Conexión con Apps Script: sesión, sincronización, cola, conflictos
├── app.js                      Interfaz: vistas, formularios, informes, CSV, instalación, service worker
├── sw.js                       Service worker: caché versionada y actualización controlada
├── manifest.json, icon-*.png, apple-touch-icon.png
├── apps-script/
│   ├── Codigo.gs               Backend (pegar en el editor de Apps Script de la planilla)
│   ├── Calculos.gs             Copia EXACTA de calculos.js
│   └── appsscript.json         Manifiesto del proyecto de Apps Script
└── tests/
    ├── calculos.test.js        Pruebas de cálculo (Node, sin dependencias)
    ├── gas-simulador.js        Simula SpreadsheetApp, DriveApp, LockService, etc. para correr el Codigo.gs real
    ├── backend.test.js         Pruebas del backend
    ├── servidor-prueba.js      Backend local para probar la app sin Google
    └── e2e.py                  Pruebas end-to-end multiusuario (Playwright)
```

## Puesta en marcha (una vez)

### 1. Planilla y Apps Script

1. Con la cuenta de Google que será **dueña de los datos** (idealmente una de la empresa, no personal), crea una Google Sheet vacía. Por ejemplo, "Gestión de Transporte · Datos".
2. En la planilla, abre *Extensiones → Apps Script*.
3. Reemplaza el contenido de `Código.gs` por el de **`apps-script/Codigo.gs`**.
4. Agrega un archivo con el **+** junto a "Archivos" → **Apps Script** (en versiones anteriores del editor se llamaba "Secuencia de comandos"). Llámalo `Calculos`, sin extensión, porque el editor agrega `.gs` solo. Borra lo que trae y pega **`apps-script/Calculos.gs`**. El orden de los archivos en la lista no importa.
5. En *Configuración del proyecto* (engranaje), activa "Mostrar el archivo de manifiesto appsscript.json". Luego pega **`apps-script/appsscript.json`**, que fija la zona horaria America/Santiago y el tipo de publicación.
6. Guarda y vuelve a la planilla. Recárgala: aparece el menú **Transporte**.
7. *Transporte → 1. Configurar hojas (primera vez)*. Google pedirá autorización. Como el script es tuyo y no está publicado, aparece "Google no verificó esta app": entra a *Configuración avanzada → Ir a … (no seguro)* y acepta. Este paso:
   - crea las hojas (Viajes, Adjuntos, Rutas, Camiones, Tarifas, Config, Usuarios, Registro), con sus formatos y protección con advertencia;
   - crea la carpeta privada de fotos "Gestión de Transporte · Fotos" en el Drive de esa cuenta;
   - carga el catálogo de camiones y tarifas de la reunión y los ajustes por defecto (IVA 19 %, chofer $200/km).
8. Al terminar, pide crear el **primer usuario admin** (clave de 8 caracteres o más). Los demás se crean con *Transporte → Crear o reemplazar usuario*.

### 2. Publicar el backend

1. En Apps Script: *Implementar → Nueva implementación → tipo **Aplicación web***.
2. **Ejecutar como: Yo**. **Quién tiene acceso: Cualquier persona**. La planilla no queda pública: solo se entra con usuario y clave de la hoja Usuarios, y la planilla y las fotos siguen siendo privadas de la cuenta dueña.
   Si la cuenta es de Google Workspace y no aparece "Cualquier persona", el administrador del dominio tiene restringida esa opción.
3. Copia la URL que termina en **`/exec`**. Para probarla, ábrela en una **ventana de incógnito**: debe responder `{"ok":true,"app":"gestion-transporte",…}`. Si la abres en un navegador con varias cuentas de Google conectadas, puede salir "No se pudo abrir el archivo en este momento". Es un problema conocido de Google y no afecta a la app, que llama al backend sin las cookies de Google.

### 3. Conectar la app

Edita `config.js` (en esta entrega ya viene con la URL del backend publicado):

```js
window.CONFIG_APP = {
  API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
  INTERVALO_SYNC_SEG: 45
};
```

### 4. Publicar en GitHub Pages

1. Sube el contenido de `gestion-transporte/` a la raíz del repositorio. Las carpetas `apps-script/` y `tests/` pueden ir: no se descargan al celular.
2. *Settings → Pages → Deploy from a branch → `main` / `(root)`*.
3. La app queda en `https://<usuario>.github.io/<repo>/`. Tiene que ser HTTPS: el login usa `crypto.subtle`, que solo funciona en HTTPS o en localhost.
4. **No subas** `importar-planillas-marzo-2026.json`: tiene nombres y teléfonos de clientes.

## Cómo publicar cambios

**App (GitHub Pages)**: cada vez que cambies algo, sube la versión en **dos** lugares, con el mismo valor:
- `sw.js` → `const VERSION = '2.0.2';`
- `app.js` → `const APP_VERSION = '2.0.2';`

Si `sw.js` no cambia, los celulares siguen usando la versión guardada. Con el cambio, aparece "Hay una nueva versión disponible · Actualizar ahora", la app se recarga y se borra la caché anterior. La sesión y los pendientes se conservan.

**Backend (Apps Script)**: **guardar NO basta.** La URL `/exec` sigue ejecutando la versión anterior hasta que publiques una nueva:

> *Implementar → Administrar implementaciones → lápiz ✏️ → Versión: **Nueva versión** → Implementar.*

Así la URL `/exec` no cambia. Si en cambio creas una *Nueva implementación*, la URL cambia y hay que actualizar `config.js`.

**Si cambias `calculos.js`**, copia el archivo completo a `Calculos.gs` en Apps Script y publica una nueva versión. La prueba `node tests/calculos.test.js` falla si los dos archivos no son idénticos.

## Usuarios y roles

| | usuario | admin |
|---|---|---|
| Ver todo (inicio, viajes, informes, CSV, descargar copia) | ✔ | ✔ |
| Crear, editar y eliminar viajes y fotos (de cualquier usuario) | ✔ | ✔ |
| Crear y editar rutas frecuentes | ✔ | ✔ |
| Camiones, tarifas, ajustes compartidos (IVA, pago chofer $/km) | — | ✔ |
| Importar datos y cargar o eliminar la demostración | — | ✔ |

Los usuarios se administran **desde la planilla**, en el menú *Transporte*: crear o reemplazar, restablecer la clave, activar o desactivar, y cerrar todas las sesiones. Cada persona puede cambiar su clave en *Ajustes*.

- La sesión dura 30 días. Desactivar un usuario o cambiar su clave cierra sus sesiones al instante.
- Tras 5 claves incorrectas, el usuario queda bloqueado 15 minutos.
- Las claves no se guardan. En la hoja Usuarios queda solo una sal y un hash, y la clave no viaja en texto plano.
- Cada viaje registra quién lo creó y quién lo modificó por última vez. La hoja **Registro** guarda cada operación.

## Cómo funciona en línea

- **Datos compartidos**: todo vive en la planilla. Cada celular guarda una copia local para abrir rápido y consultar sin señal.
- **Cambios de otros**: con la app abierta, se revisa cada 45 s (`INTERVALO_SYNC_SEG`) si hubo cambios, y además al volver a la app. El indicador de arriba muestra *Sincronizado / Pendientes / Sin conexión / Error*. Al tocarlo se ve el detalle y el botón "Actualizar ahora".
- **Guardar sin señal**: los viajes y sus fotos quedan en una cola en el teléfono, marcados como "Sin enviar", y se envían solos al volver la señal. El código `V-AAAA-NNNN` lo asigna el servidor, así que se ve "Código por asignar" hasta que llega. Eliminar y editar catálogos requieren conexión.
- **Dos personas editan lo mismo**: cada registro tiene un número de versión. Quien guarda segundo recibe un aviso de **conflicto** con las dos versiones lado a lado y elige "Guardar mi versión" o "Descartar mis cambios". Nunca se pisa en silencio.
- **Reintentos**: cada envío lleva un identificador de operación, así que un reintento por mala señal no duplica viajes.
- **Escrituras simultáneas**: se ordenan con `LockService`. Se probó con 5 usuarios guardando al mismo tiempo: 5 viajes, 5 códigos distintos.
- **Fotos**: la app las optimiza a JPEG de 1.600 px como máximo y las guarda en la carpeta privada de Drive. La hoja Adjuntos guarda la referencia. Se ven a través del backend (no son públicas). Hay un máximo de 12 por categoría y viaje.
- **No edites la hoja Viajes a mano.** Tiene protección con advertencia. Si igual lo haces, los otros ven el cambio al reabrir la app o con "Actualizar ahora". Las columnas "(calc.)" son informativas y se recalculan al guardar desde la app.
- **Cerrar sesión** borra del teléfono la copia local. Si quedan pendientes sin enviar, la app avisa antes.

## Instalar en el celular ("como APK")

**Android (recomendado)**: abre la URL de GitHub Pages en **Chrome**, entra con tu usuario y toca **Más → Instalar app**. También sirve *Ajustes → Instalar en el teléfono* o el menú ⋮ → *Instalar app*. Chrome genera e instala un APK firmado por Google (WebAPK): queda en el cajón de apps con su ícono, abre a pantalla completa, funciona sin señal y se actualiza sola al publicar cambios. No hace falta Play Store ni permitir orígenes desconocidos.

**iPhone**: Safari → Compartir → *Agregar a inicio*. La app muestra estos pasos en *Ajustes*.

**Archivo .apk para enviar por WhatsApp o subir a Play Store (opcional)**:
1. Con la app ya publicada en HTTPS, entra a <https://www.pwabuilder.com>, pega la URL y elige *Package for stores → Android*.
2. Descarga el paquete: trae un `.apk` para instalar directo, un `.aab` para Play Store, la llave de firma (**guárdala**: sin ella no se puede actualizar la app) y un `assetlinks.json`.
3. Sin `assetlinks.json` la app funciona igual, pero muestra una barra con la URL arriba. Para quitarla, el archivo debe quedar en `https://<dominio>/.well-known/assetlinks.json`, en la **raíz del dominio**. En un sitio de proyecto (`usuario.github.io/repo/`) eso exige un repositorio `usuario.github.io` o un dominio propio, con un archivo `.nojekyll` para que GitHub Pages publique la carpeta `.well-known`.
4. Este .apk es un envoltorio de la misma app web (TWA): las actualizaciones siguen llegando desde GitHub Pages sin reinstalar.

## Probar sin Google

`tests/servidor-prueba.js` ejecuta el **Codigo.gs real** sobre una planilla simulada en memoria:

```bash
node tests/servidor-prueba.js --puerto 8787 --demo \
  --usuario admin:admin:clave-admin-1 --usuario ana:usuario:clave-ana-123 \
  --estado /tmp/datos-prueba.json          # opcional: conserva los datos entre reinicios
# en config.js: API_URL: 'http://127.0.0.1:8787/exec'
python3 -m http.server 8080               # abrir http://localhost:8080
```

`--latencia 1500` simula la demora típica de Apps Script.

## Pruebas

```bash
node tests/calculos.test.js     # 53 pruebas: fórmulas, parseo, validación y Calculos.gs == calculos.js
node tests/backend.test.js      # 58 pruebas del Codigo.gs real sobre el simulador (55 sin el archivo histórico)
python3 tests/e2e.py            # 60 pruebas end-to-end (58 sin el archivo histórico; requiere playwright y pillow)
```

- **Backend**: login y bloqueo, permisos por rol, conflicto de versión, idempotencia, correlativos únicos, fotos en Drive, importación, protección contra fórmulas en celdas y crecimiento de la hoja más allá de su tamaño.
- **E2E**: levanta su propio backend y 5 usuarios, y cubre:
  - caso de la reunión y pago al chofer;
  - 5 guardados simultáneos y un conflicto resuelto;
  - trabajo sin señal con foto y actualización del service worker;
  - revisión de todas las vistas en móvil y escritorio: sin errores de consola, sin scroll horizontal y controles con nombre accesible.
- **Importación histórica**: las pruebas la incluyen si encuentran `../datos-historicos/importar-planillas-marzo-2026.json` o la ruta indicada en `ARCHIVO_HISTORICO`. Si no, la omiten.

## Fórmulas (`calculos.js`)

Todas las vistas y el servidor usan `calcularViaje()` y `resumirPeriodo()`.

1. `ingresoBase = km × tarifa` (cobro por km) o `= tarifa` (cobro fijo).
2. `ingresoNeto = ingresoBase + cobrosAdicionales` (sobreestadía, vuelta, etc.).
3. `IVA = ingresoNeto × ivaPct / 100`, solo si está activado. Se muestra aparte y **no** suma al ingreso ni al margen.
4. **Transportista** (solo tercerizados): `km × tarifaKm` o monto fijo.
5. **Pago al chofer**: `km × $/km`, un monto fijo o nada. En camión **propio** se sugiere `km × $200` (ajustable en *Ajustes*). En tercerizado se sugiere "sin pago", porque el chofer lo paga el transportista. Siempre se puede cambiar.
6. Peajes: el real si se ingresó (aunque sea $0); si no, el estimado, marcado **ESTIMADO**.
7. `costosDirectos = peajes + combustible + comida + transportista + chofer + otrosGastos`.
8. `margenBruto = ingresoNeto − costosDirectos`. `margen% = margenBruto / ingresoNeto × 100` (sin dato si el ingreso es 0).
9. Período: solo cuentan los **realizados**. `resultadoEstimado = margen realizados + margen planificados`. Los cancelados se cuentan, pero no suman.

Caso de la reunión: 1.000 km × $1.650 − 1.000 km × $1.440 = **$210.000**. Pedregoso (propio, 775 km): el chofer suma $155.000 y el margen queda en **$298.520**. Las 4 planillas de marzo 2026 dan **$1.307.900**, igual que "Total utilidad viaje". La autocomprobación corre al abrir la app y está en *Ajustes*.

## La planilla por dentro

- **Viajes**: una fila por viaje con encabezados legibles. Incluye las columnas *Chofer: modo / $ por km / monto fijo*, y *Otros gastos*, *Cobros adicionales* y *Tarifa de catálogo* en JSON. Al final van las columnas calculadas *(calc.)*, la versión, quién creó y modificó, y la última operación.
- **Adjuntos**: fotos (ID del archivo en Drive, viaje y categoría). **Rutas, Camiones, Tarifas**: catálogos con versión.
- **Config**: clave y valor (JSON). **Usuarios**: usuario, nombre, rol, activo, sal, hash y último acceso. **Registro**: auditoría.
- El backend busca las columnas **por nombre de encabezado**, así que puedes reordenarlas o agregar otras tuyas. No cambies los nombres existentes.
- Los textos que empiezan con `= + - @` se guardan con apóstrofo, para que no se ejecuten como fórmula. Las fechas se guardan como texto `AAAA-MM-DD`, para que Sheets no las convierta.

## Límites de Apps Script (cuenta gmail gratuita)

- Cada operación tarda de 1 a 3 s. La app no se bloquea: guarda primero en el teléfono y envía en segundo plano.
- Hay un máximo de 30 ejecuciones simultáneas por usuario dueño, de sobra para 5 personas.
- Las propiedades del script admiten **50.000 lecturas o escrituras al día** (500.000 con Google Workspace). Cada revisión de cambios usa unas 2. Con 5 personas con la app abierta todo el día quedan unas 8.000. Si se suman más usuarios, sube `INTERVALO_SYNC_SEG` en `config.js`.
- Para miles de viajes por año, la planilla funciona bien. Si se llega a decenas de miles, conviene archivar años anteriores en otra hoja.

## Supuestos

1. **IVA 19 %**, configurable. Se aplica por defecto a viajes nuevos, se muestra aparte y no afecta el margen.
2. **6.000 kg, $1.650/km neto**: la planilla Antofagasta dice "Valor NETO" $2.273.700 = 1.378 km × $1.650.
3. **6.000 kg, vuelta en Santiago, $90.000** neto más IVA, según la reunión.
4. **1.700 kg, $1.440/km**: cargado tal como se informó, pero **por confirmar** (ver pendientes).
5. **1.700 kg, vuelta en Santiago, $70.000**: **IVA por confirmar**. Los viajes que la usan quedan marcados hasta que un admin confirme la tarifa como neta.
6. **Chofer $200/km**: sale de la planilla Pedregoso ("Chofer" = 775 km × $200 = $155.000). Solo se sugiere en camión propio.
7. Las tarifas rigen desde el 22-09-2026. Se pueden usar en viajes anteriores, con aviso.
8. Un viaje nuevo parte como "Realizado", con fecha de hoy y modalidad "Tercerizado".
9. Los números van en formato chileno: "1.000" es mil y "12,5" es doce coma cinco.
10. Cualquier usuario puede editar o eliminar viajes de otros, porque es un equipo chico. Todo queda en el Registro.

## Pendientes de negocio (no resueltos en la app)

1. **Inicio de actividades**: falta saber si el camión debe estar a nombre de la empresa o si basta un contrato de arriendo. Hay que averiguarlo; la app no entrega conclusiones legales.
2. **Tarifa $1.440/km del camión 1.700 kg**: en marzo el camión chico se cobró cerca de **$1.200/km** (Pedregoso $930.000 / 775 km; Coquimbo $600.000 / 510 km). Además, $1.440 es lo que **cobra el transportista** por el de 6.000 kg. ¿Es tarifa al cliente o costo?
3. **IVA de la tarifa de $70.000** (1.700 kg, vuelta en Santiago).
4. **Capacidad del camión chico**: una planilla dice 1.700 kg y otra 1.750 kg.
5. **Planilla Pedregoso**: "OTROS" $155.000 es igual a "Chofer" $155.000. ¿Es un duplicado o el remolque? En la importación se registraron los dos, para cuadrar con la utilidad de la planilla. Si es un duplicado, basta con borrar el otro gasto: el margen de ese viaje sube en $155.000.
6. **Planilla Coquimbo**: los $400.000 de "OTROS" se interpretaron como costo del transportista.
7. **Chofer**: ¿$200/km es fijo para todo viaje propio o depende del camión o la ruta? Sueldos, bonos y leyes sociales siguen fuera de la app.
8. **Fecha que manda para el mes**: las planillas tienen solicitud, carga y entrega. La app usa una sola fecha.
9. **Viajes cancelados con costo** (falso flete): hoy no suman. Si ocurre, conviene registrarlo como realizado, con su cobro y su costo.
10. **Evaluación de compra del camión**: el margen de viajes propios no incluye costos fijos (mantención, seguros, permisos, depreciación, financiamiento), ni los km en vacío.
11. **¿Todos los usuarios deben ver márgenes y tarifas?** Hoy sí. Si los choferes van a usar la app, conviene definir un rol que solo registre viajes.
12. **Cuenta dueña de la planilla**: si se usa una cuenta personal y esa persona se va, los datos se van con ella. Mejor una cuenta de la empresa.

## Limitaciones

- La primera vez hay que entrar con conexión. Después, la app abre y se puede registrar sin señal.
- **iPhone**: Safari puede borrar datos de sitios **no instalados** tras 7 días sin uso. Instala la app. Los datos oficiales están en la planilla; en riesgo quedan solo los pendientes no enviados.
- HEIC solo se lee si el navegador lo soporta (Safari sí). Tomar la foto desde la app entrega JPEG.
- *Respaldo → Descargar copia* baja los datos en JSON **sin las fotos**, que quedan en Drive. La planilla misma también es el respaldo: *Archivo → Hacer una copia*.
- Fuera de alcance: GPS, portal de clientes, facturación, sueldos, contabilidad oficial y requisitos legales.

## Datos históricos (opcional)

`importar-planillas-marzo-2026.json` trae los 4 viajes de las planillas preliminares (`H-2026-0001` a `0004`). En Pedregoso (camión propio), el chofer va en el campo "Pago al chofer": 775 km × $200. Un admin lo carga en *Respaldo → Importar datos → Importar y combinar*, y reimportarlo no duplica. Cada viaje explica en sus notas de dónde salió cada dato.

**No lo subas al repositorio público:** tiene nombres de clientes y teléfonos.
