"""Pruebas end-to-end de la versión en línea (Playwright + Chromium + backend simulado).

Levanta automáticamente:
  - el backend local (tests/servidor-prueba.js, que ejecuta el Codigo.gs real) en :8787
  - una copia de la app con config.js apuntando a ese backend, servida en :8766
Uso (desde la carpeta del proyecto):
    pip install playwright pillow && python3 -m playwright install chromium
    python3 tests/e2e.py
Cubre: login y roles, demostración, caso de la reunión, pago al chofer, 5 usuarios
guardando a la vez, conflicto de edición, trabajo sin señal con fotos, fotos entre
usuarios, sesión expirada, importación histórica, CSV, confirmación de tarifas,
accesibilidad básica, IDs duplicados, app sin conexión, actualización del service
worker y cierre de sesión.
"""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time, urllib.request, hashlib
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix='gt-e2e-')
APP = os.path.join(TMP, 'app')
API = 'http://127.0.0.1:8787/exec'
BASE = 'http://127.0.0.1:8766/'
HIST = os.environ.get('ARCHIVO_HISTORICO', os.path.join(os.path.dirname(RAIZ), 'datos-historicos', 'importar-planillas-marzo-2026.json'))
USUARIOS = {'admin': ('admin', 'clave-admin-1'), 'ana': ('usuario', 'clave-ana-123'), 'beto': ('usuario', 'clave-beto-123'),
            'carla': ('usuario', 'clave-carla-123'), 'dani': ('usuario', 'clave-dani-123')}
resultados, errores_consola = [], []


def check(nombre, cond, detalle=''):
    resultados.append((nombre, bool(cond), detalle))
    print(('PASS ' if cond else 'FAIL ') + nombre + (f'  [{detalle}]' if detalle and not cond else ''), flush=True)


# ---------- Preparación: copia de la app, backend y servidor estático ----------
shutil.copytree(RAIZ, APP, ignore=shutil.ignore_patterns('tests', 'apps-script', '*.md', '.git'))
cfg = open(os.path.join(APP, 'config.js'), encoding='utf-8').read()
cfg = re.sub(r"API_URL: '[^']*'", f"API_URL: '{API}'", cfg, count=1).replace('INTERVALO_SYNC_SEG: 45', 'INTERVALO_SYNC_SEG: 15')
assert f"API_URL: '{API}'" in cfg, 'No se pudo apuntar config.js al backend de prueba'
open(os.path.join(APP, 'config.js'), 'w', encoding='utf-8').write(cfg)
args = ['node', os.path.join(RAIZ, 'tests', 'servidor-prueba.js'), '--puerto', '8787', '--latencia', '120']
for u, (rol, clave) in USUARIOS.items():
    args += ['--usuario', f'{u}:{rol}:{clave}']
backend = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
estatico = ThreadingHTTPServer(('127.0.0.1', 8766), partial(SimpleHTTPRequestHandler, directory=APP))
SimpleHTTPRequestHandler.log_message = lambda *a: None
threading.Thread(target=estatico.serve_forever, daemon=True).start()
time.sleep(1.5)

im = Image.new('RGB', (3000, 2000), (200, 210, 190)); d = ImageDraw.Draw(im)
for i in range(0, 3000, 100): d.line([(i, 0), (i, 2000)], fill=(90, 90, 90), width=3)
FOTO = os.path.join(TMP, 'guia.png'); im.save(FOTO)
FOTO2 = os.path.join(TMP, 'entrega.jpg'); Image.new('RGB', (800, 600), (180, 140, 100)).save(FOTO2, quality=85)


def api(accion, token=None, **datos):
    cuerpo = json.dumps(dict(datos, accion=accion, token=token)).encode()
    req = urllib.request.Request(API, data=cuerpo, headers={'Content-Type': 'text/plain'})
    return json.loads(urllib.request.urlopen(req).read())


def token_de(usuario):
    h = hashlib.sha256(f'gestion-transporte|{usuario}|{USUARIOS[usuario][1]}'.encode()).hexdigest()
    return api('login', usuario=usuario, claveHash=h)['token']


def nuevo_contexto(b, movil=False):
    ctx = b.new_context(viewport={'width': 390, 'height': 844} if movil else {'width': 1280, 'height': 900},
                        locale='es-CL', timezone_id='America/Santiago', accept_downloads=True)
    pg = ctx.new_page()
    pg.on('console', lambda m: errores_consola.append(f"{m.type}: {m.text} [{(m.location or {}).get('url', '')}] en {pg.url}") if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errores_consola.append(f'pageerror: {e}'))
    return ctx, pg


def login(pg, usuario, clave=None):
    pg.goto(BASE)
    pg.wait_for_selector('#login-usuario')
    pg.fill('#login-usuario', usuario)
    pg.fill('#login-clave', clave or USUARIOS[usuario][1])
    pg.click('button:has-text("Ingresar")')
    pg.wait_for_selector('.kpis, .vacio', timeout=15000)


def ir(pg, ruta):
    pg.evaluate(f"location.hash = '#/{ruta}'")
    pg.wait_for_timeout(400)


def sincronizar(pg):
    pg.evaluate("Nube.sincronizar().then(() => true)")
    pg.wait_for_timeout(500)


def dlg(pg, texto):
    pg.locator('dialog[open] button', has_text=texto).first.click()


def kpi(pg, etq):
    return pg.locator('.kpi', has=pg.locator('.kpi-etiqueta', has_text=etq)).locator('.kpi-valor').inner_text()


def llenar(pg, sitio, km, camion='cam-6000kg', modalidad='tercerizado', tarifa_t='1.440', localidad='Sector Prueba'):
    pg.wait_for_selector('#f-sitio')
    pg.select_option('#f-camionId', camion)
    pg.fill('#f-sitio', sitio)
    pg.fill('#f-localidad', localidad)
    pg.check(f'#f-modalidad-{modalidad}')
    pg.fill('#f-km', km)
    if modalidad == 'tercerizado':
        pg.check('#f-transportistaModo-km')
        pg.fill('#f-transportistaTarifaKm', tarifa_t)


def esperar_detalle(pg):
    pg.wait_for_url(re.compile(r'#/viajes/[0-9a-f-]{36}$'), timeout=15000)
    pg.wait_for_selector('.desglose')


def calidad_vista(pg, nombre):
    dup = pg.evaluate("() => { const ids=[...document.querySelectorAll('[id]')].map(e=>e.id); return ids.filter((x,i)=>ids.indexOf(x)!==i); }")
    malos = pg.evaluate("""() => {
      const m = [];
      document.querySelectorAll('button, a[href]').forEach(el => {
        if (el.closest('[hidden]') || (el.offsetParent === null && getComputedStyle(el).position !== 'fixed')) return;
        if (!(el.getAttribute('aria-label') || el.textContent || '').trim()) m.push(el.outerHTML.slice(0, 80));
      });
      document.querySelectorAll('input:not([type=hidden]), select, textarea').forEach(el => {
        if (!(el.id && document.querySelector(`label[for="${el.id}"]`)) && !el.getAttribute('aria-label')) m.push('sin etiqueta: ' + el.outerHTML.slice(0, 80));
      });
      return m; }""")
    sx = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check(f'{nombre}: sin IDs duplicados, controles con nombre y sin scroll horizontal', not dup and not malos and sx <= 0, f'{dup} {malos[:3]} sx={sx}')


try:
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---------- A. Login, roles y demostración ----------
        ctxA, adm = nuevo_contexto(b)
        adm.goto(BASE)
        adm.wait_for_selector('#login-usuario')
        adm.fill('#login-usuario', 'admin'); adm.fill('#login-clave', 'mala-clave'); adm.click('button:has-text("Ingresar")')
        adm.wait_for_selector('.login .error:not([hidden])')
        check('Clave incorrecta muestra error', 'incorrectos' in adm.locator('.login .error').inner_text())
        login(adm, 'admin')
        check('Admin entra y ve el inicio vacío', adm.locator('.vacio').count() == 1)
        check('Indicador de sincronización visible', 'Sincronizado' in adm.locator('#sync-lateral').inner_text())
        ir(adm, 'ajustes')
        adm.click('button:has-text("Cargar datos de demostración")'); dlg(adm, 'Cargar demostración')
        adm.wait_for_selector('.aviso-demo', timeout=10000)
        ir(adm, 'inicio'); adm.wait_for_selector('.kpis')
        check('Demo: ingresos netos $1.810.000', kpi(adm, 'Ingresos netos') == '$1.810.000', kpi(adm, 'Ingresos netos'))
        check('Demo: margen bruto $272.400 (incluye pago al chofer)', kpi(adm, 'Margen bruto') == '$272.400', kpi(adm, 'Margen bruto'))
        check('Demo: resultado estimado $344.900', kpi(adm, 'Resultado estimado') == '$344.900')
        ir(adm, 'ajustes'); adm.click('button:has-text("Ejecutar autocomprobación")')
        txt = adm.locator('.zona-pruebas p').first.inner_text()
        check('Autocomprobación sin fallas', 'correctas' in txt and 'fallaron' not in txt, txt)

        # ---------- B. Caso de la reunión y validaciones ----------
        ir(adm, 'viajes/nuevo')
        adm.wait_for_selector('#f-sitio')
        adm.fill('#f-km', '-5'); adm.click('button:has-text("Guardar viaje")'); adm.wait_for_timeout(300)
        check('Validación: sitio obligatorio y km negativo', 'sitio' in adm.locator('#f-sitio-error').inner_text().lower() and 'negativ' in adm.locator('#f-km-error').inner_text().lower())
        llenar(adm, 'Obra Validación', '1.000')
        check('Tarifa sugerida 6.000 kg = 1.650', adm.input_value('#f-tarifa') == '1.650')
        check('Tercerizado: chofer "sin pago" por defecto', adm.is_checked('#f-choferModo-ninguno'))
        check('Resumen en vivo: margen $210.000', adm.locator('.brs-valor').inner_text() == '$210.000')
        adm.evaluate("() => { const f = document.querySelector('form.form-viaje'); f.requestSubmit(); f.requestSubmit(); }")
        esperar_detalle(adm)
        codigo1 = adm.locator('h1').inner_text().split(' · ')[0]
        check('Guardado en el servidor con código V-AAAA-0001', re.match(r'V-\d{4}-0001$', codigo1) is not None, codigo1)
        check('Detalle: margen $210.000', adm.locator('.desglose-margen td').first.inner_text() == '$210.000')
        tok_admin = token_de('admin')
        serv = api('datos', tok_admin)
        check('Doble envío no duplica en la planilla', len([v for v in serv['viajes'] if v['sitio'] == 'Obra Validación']) == 1)
        url_v1 = adm.url

        # ---------- C. Pago al chofer (camión propio) ----------
        ir(adm, 'viajes/nuevo')
        llenar(adm, 'Pedregoso prueba', '775', camion='cam-1700kg', modalidad='propio', localidad='Lonquimay')
        check('Camión propio sugiere chofer por km a $200', adm.is_checked('#f-choferModo-km') and adm.input_value('#f-choferTarifaKm') == '200')
        adm.select_option('#f-tarifaId', '')
        adm.check('#f-formaCobro-fija'); adm.fill('#f-tarifa', '930.000')
        adm.fill('#f-peajesReales', '43.700'); adm.fill('#f-combustible', '268.000'); adm.fill('#f-comida', '9.780')
        adm.click('button:has-text("Agregar gasto")')
        adm.locator('input[data-lista="otrosGastos"][data-campo="concepto"]').fill('Otros')
        adm.locator('input[data-lista="otrosGastos"][data-campo="monto"]').fill('155.000')
        check('Resumen: margen Pedregoso $298.520', adm.locator('.brs-valor').inner_text() == '$298.520', adm.locator('.brs-valor').inner_text())
        adm.click('button:has-text("Guardar viaje")'); esperar_detalle(adm)
        txt = adm.locator('.desglose').inner_text()
        check('Detalle muestra "Pago al chofer" 775 km × $200 = $155.000', 'Pago al chofer' in txt and '$155.000' in txt and '775 km × $200' in txt)
        fila = [v for v in api('datos', tok_admin)['viajes'] if v['sitio'] == 'Pedregoso prueba'][0]
        check('La planilla guarda el chofer (modo km, $200)', fila['chofer']['modo'] == 'km' and fila['chofer']['tarifaKm'] == 200, fila['chofer'])

        # ---------- D. 5 usuarios guardando a la vez ----------
        sesiones = {'admin': (ctxA, adm)}
        for u in ['ana', 'beto', 'carla', 'dani']:
            c, pg = nuevo_contexto(b)
            login(pg, u)
            sesiones[u] = (c, pg)
        for u, (c, pg) in sesiones.items():
            ir(pg, 'viajes/nuevo')
            llenar(pg, f'Obra simultánea {u}', '100')
        for u, (c, pg) in sesiones.items():
            pg.evaluate("document.querySelector('form.form-viaje').requestSubmit()")
        codigos = {}
        for u, (c, pg) in sesiones.items():
            esperar_detalle(pg)
            codigos[u] = pg.locator('h1').inner_text().split(' · ')[0]
        check('5 usuarios guardan a la vez: 5 códigos distintos', len(set(codigos.values())) == 5 and all(re.match(r'V-\d{4}-\d{4}$', c) for c in codigos.values()), codigos)
        for u, (c, pg) in sesiones.items():
            sincronizar(pg); ir(pg, 'viajes'); pg.fill('#fv-buscar', 'simultánea'); pg.wait_for_timeout(400)
        vistos = {u: pg.locator('.lista-viajes > li').count() for u, (c, pg) in sesiones.items()}
        check('Cada usuario ve los 5 viajes de todos', all(n == 5 for n in vistos.values()), vistos)

        # ---------- E. Conflicto de edición ----------
        ana, beto = sesiones['ana'][1], sesiones['beto'][1]
        id_v1 = url_v1.split('/')[-1]
        for pg in (ana, beto):
            sincronizar(pg); ir(pg, f'viajes/{id_v1}/editar'); pg.wait_for_selector('#f-comida')
        ana.fill('#f-comida', '5.000'); ana.click('button:has-text("Guardar viaje")'); esperar_detalle(ana)
        beto.fill('#f-comida', '9.000'); beto.click('button:has-text("Guardar viaje")')
        beto.wait_for_selector('dialog[open]:has-text("Otro usuario modificó este viaje")', timeout=15000)
        check('Segundo en guardar recibe aviso de conflicto con ambas versiones', beto.locator('dialog[open] .tabla-conflicto').count() == 1)
        dlg(beto, 'Guardar mi versión')
        beto.wait_for_selector('.toast:has-text("Se guardó tu versión")', timeout=15000)
        v_srv = [v for v in api('datos', tok_admin)['viajes'] if v['id'] == id_v1][0]
        check('Tras resolver: queda la versión elegida (comida 9.000, versión 3, por beto)', v_srv['comida'] == 9000 and v_srv['version'] == 3 and v_srv['actualizadoPor'] == 'beto', {k: v_srv[k] for k in ('comida', 'version', 'actualizadoPor')})
        sincronizar(ana); ir(ana, f'viajes/{id_v1}')
        check('El otro usuario ve el cambio tras sincronizar', '$9.000' in ana.locator('.desglose').inner_text())

        # ---------- F. Sin señal: viaje + foto quedan en cola y se envían solos ----------
        carla_ctx, carla = sesiones['carla']
        carla_ctx.set_offline(True)
        ir(carla, 'viajes/nuevo')
        llenar(carla, 'Faena sin señal', '320', localidad='Ollagüe')
        carla.set_input_files('input[id^="fotos-guia"]', FOTO)
        carla.wait_for_selector('.foto-miniatura', timeout=10000)
        carla.click('button:has-text("Guardar viaje")')
        esperar_detalle(carla)
        check('Sin señal: se guarda en el teléfono como pendiente', 'Pendiente de envío' in carla.locator('.detalle-insignias').inner_text() and carla.locator('h1').inner_text().startswith('Viaje por enviar'))
        check('Indicador muestra pendientes sin señal', 'pendiente' in carla.locator('#sync-lateral').inner_text().lower())
        carla_ctx.set_offline(False)
        carla.wait_for_function("document.querySelector('h1') && /^V-\\d{4}-\\d{4}/.test(document.querySelector('h1').textContent)", timeout=20000)
        carla.wait_for_function("Nube.estadoCola().total === 0", timeout=20000)
        check('Al volver la señal se envía solo y recibe código', True)
        srv = api('datos', tok_admin)
        v_off = [v for v in srv['viajes'] if v['sitio'] == 'Faena sin señal']
        check('El viaje y su foto quedaron en la planilla', len(v_off) == 1 and len([a for a in srv['adjuntos'] if a['viajeId'] == v_off[0]['id']]) == 1)
        sincronizar(adm); ir(adm, f"viajes/{v_off[0]['id']}")
        adm.wait_for_selector('.foto-miniatura img', timeout=15000); adm.wait_for_timeout(500)
        ancho = adm.evaluate("document.querySelector('.foto-miniatura img').naturalWidth")
        check('Otro usuario ve la foto (optimizada a 1.600 px)', ancho == 1600, ancho)

        # ---------- G. Fotos: agregar y eliminar en línea ----------
        adm.set_input_files('input[id^="fotos-entrega"]', FOTO2)
        adm.wait_for_function("Nube.estadoCola().total === 0 && document.querySelectorAll('.foto-miniatura img').length === 2", timeout=15000)
        check('Foto agregada desde el detalle llega al servidor', len([a for a in api('datos', tok_admin)['adjuntos'] if a['viajeId'] == v_off[0]['id']]) == 2)
        adm.locator('button[aria-label^="Eliminar Entrega de materiales"]').click(); dlg(adm, 'Eliminar foto')
        adm.wait_for_function("Nube.estadoCola().total === 0", timeout=15000); adm.wait_for_timeout(300)
        check('Foto eliminada en el servidor', len([a for a in api('datos', tok_admin)['adjuntos'] if a['viajeId'] == v_off[0]['id']]) == 1)

        # ---------- H. Roles ----------
        ir(ana, 'tarifas')
        check('Usuario no ve botones para editar tarifas', ana.locator('button:has-text("Nueva tarifa")').count() == 0 and ana.locator('.aviso:has-text("Solo los administradores")').count() == 1)
        ir(ana, 'ajustes')
        check('Usuario ve ajustes compartidos deshabilitados', ana.is_disabled('#aj-iva') and ana.locator('button:has-text("Guardar ajustes")').count() == 0)
        ir(ana, 'respaldo')
        check('Usuario no ve la importación', ana.locator('#resp-importar').count() == 0)
        ir(ana, 'rutas')
        ana.click('.vista-acciones button:has-text("Nueva ruta")')
        ana.fill('dialog[open] input[name="nombre"]', 'Ruta de Ana'); ana.fill('dialog[open] input[name="km"]', '120'); ana.fill('dialog[open] input[name="peajes"]', '7.800')
        dlg(ana, 'Guardar'); ana.wait_for_timeout(800)
        check('Usuario sí puede crear rutas', any(r['nombre'] == 'Ruta de Ana' for r in api('datos', tok_admin)['rutas']))

        # ---------- I. Sesión cerrada desde el servidor ----------
        dani_ctx, dani = sesiones['dani']
        tok_dani = dani.evaluate("Nube.sesion().token")
        api('logout', tok_dani)
        dani.evaluate("Nube.comprobarCambios().catch(() => null)")
        dani.wait_for_selector('#login-usuario', timeout=10000)
        check('Sesión cerrada en el servidor → vuelve al login con aviso', dani.locator('.toast:has-text("sesión terminó")').count() == 1)

        # ---------- J. Importación histórica y paridad ----------
        if os.path.exists(HIST):
            ir(adm, 'respaldo')
            adm.set_input_files('#resp-archivo', HIST)
            adm.wait_for_selector('.vista-previa')
            adm.click('.vista-previa button:has-text("Importar y combinar")'); dlg(adm, 'Importar')
            adm.wait_for_selector('.aviso-ok', timeout=20000)
            check('Importa las 4 planillas', '4 viaje(s) agregados' in adm.locator('.aviso-ok').inner_text(), adm.locator('.aviso-ok').inner_text())
            ir(adm, 'informes'); adm.click('.segmento:has-text("Rango")')
            adm.fill('input[type=date] >> nth=0', '2026-03-01'); adm.fill('input[type=date] >> nth=1', '2026-03-31')
            adm.locator('input[type=date] >> nth=1').dispatch_event('change'); adm.wait_for_timeout(500)
            margen = adm.locator('.stat', has=adm.locator('.stat-etq', has_text='Margen bruto')).locator('.stat-valor').inner_text()
            check('Marzo 2026 importado: margen $1.307.900 (igual a las planillas)', margen == '$1.307.900', margen)
        else:
            print(f'OMITIDA importación histórica: no se encontró {HIST} (define ARCHIVO_HISTORICO para incluirla)')

        # ---------- K. CSV con pago al chofer ----------
        ir(adm, 'informes'); adm.click('.segmento:has-text("Todo")')
        with adm.expect_download() as dl:
            adm.click('button:has-text("CSV de viajes")')
        csv = open(dl.value.path(), encoding='utf-8', newline='').read()
        check('CSV de viajes incluye columna "Pago al chofer" y el valor 155000', 'Pago al chofer' in csv.split('\r\n')[0] and ';155000;' in csv)
        with adm.expect_download() as dl:
            adm.click('button:has-text("CSV de gastos")')
        csvg = open(dl.value.path(), encoding='utf-8', newline='').read()
        check('CSV de gastos incluye filas de chofer', ';Chofer;Pago al chofer;155000;' in csvg)

        # ---------- L. Confirmar IVA de una tarifa ----------
        ir(adm, 'inicio')
        antes = adm.locator('.alertas li', has_text='tarifa por confirmar').count()
        ir(adm, 'tarifas')
        adm.click('button[aria-label="Editar tarifa Vuelta en Santiago de Camión 1.700 kg"]')
        adm.select_option('dialog[open] select[name="ivaTratamiento"]', 'neto'); dlg(adm, 'Guardar')
        adm.wait_for_selector('dialog[open]:has-text("Confirmar viajes anteriores")', timeout=10000)
        dlg(adm, 'Marcar como confirmados'); adm.wait_for_timeout(1000)
        ir(adm, 'inicio')
        check('Confirmar tarifa limpia la alerta de IVA para todos', antes == 1 and adm.locator('.alertas li', has_text='tarifa por confirmar').count() == 0)

        # ---------- M. Calidad de cada vista (admin y usuario, móvil) ----------
        ctxM, mov = nuevo_contexto(b, movil=True)
        login(mov, 'ana')
        for ruta in ['inicio', 'viajes', 'viajes/nuevo', 'rutas', 'tarifas', 'informes', 'respaldo', 'ajustes', 'mas']:
            ir(mov, ruta); mov.wait_for_timeout(300); calidad_vista(mov, f'Móvil (usuario) {ruta}')
        for ruta in ['inicio', 'tarifas', 'respaldo', 'ajustes']:
            ir(adm, ruta); adm.wait_for_timeout(300); calidad_vista(adm, f'Escritorio (admin) {ruta}')

        # Instalar en el teléfono: pasos cuando no hay diálogo; botón cuando Chrome lo ofrece
        ir(mov, 'ajustes')
        check('Ajustes muestra cómo instalar la app', 'Instalar app' in mov.locator('.pasos-instalar').inner_text())
        ir(mov, 'mas')
        mov.evaluate("""() => { const e = new Event('beforeinstallprompt');
            e.prompt = () => { window.__instalo = true; return Promise.resolve(); };
            e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); }""")
        mov.wait_for_selector('button:has-text("Instalar app")', timeout=5000)
        mov.click('button:has-text("Instalar app")'); mov.wait_for_timeout(500)
        check('Botón "Instalar app" abre el diálogo del navegador y desaparece', mov.evaluate('window.__instalo === true') and mov.locator('button:has-text("Instalar app")').count() == 0)

        # ---------- N. App sin conexión (service worker + caché local) ----------
        mov.goto(BASE); mov.wait_for_selector('.kpis', timeout=15000)
        mov.evaluate("navigator.serviceWorker.ready.then(() => true)")
        for _ in range(30):
            if mov.evaluate("!!navigator.serviceWorker.controller"): break
            mov.wait_for_timeout(200)
        ctxM.set_offline(True)
        mov.reload(); mov.wait_for_selector('.kpis', timeout=15000)
        check('Sin conexión: la app abre con los datos guardados en el teléfono', mov.locator('h1').inner_text() == 'Inicio' and mov.locator('.aviso-offline').count() == 1)
        ir(mov, 'viajes/' + id_v1)
        check('Sin conexión: se puede consultar el detalle', '$9.000' in mov.locator('.desglose').inner_text())
        mov.click('.vista-acciones button:has-text("Eliminar")'); dlg(mov, 'Eliminar viaje'); mov.wait_for_timeout(500)
        check('Sin conexión: eliminar pide conexión y no borra', mov.locator('.toast-error:has-text("conexión")').count() == 1)
        ctxM.set_offline(False)
        ir(mov, 'inicio'); mov.wait_for_selector('.kpis', timeout=15000)

        # ---------- O. Actualización del service worker ----------
        sw = os.path.join(APP, 'sw.js')
        orig = open(sw, encoding='utf-8').read()
        nuevo_sw = re.sub(r"const VERSION = '[^']+';", "const VERSION = '9.9.9-prueba';", orig, count=1)
        assert nuevo_sw != orig, 'No se encontró VERSION en sw.js'
        open(sw, 'w', encoding='utf-8').write(nuevo_sw)
        mov.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        mov.wait_for_selector('.aviso-actualizacion', timeout=15000)
        with mov.expect_navigation(timeout=15000):
            mov.click('button:has-text("Actualizar ahora")')
        mov.wait_for_selector('.kpis', timeout=15000); mov.wait_for_timeout(800)
        check('Actualización: caché nueva y la anterior eliminada, sesión intacta', mov.evaluate("caches.keys()") == ['gestion-transporte-9.9.9-prueba'] and mov.locator('#login-usuario').count() == 0)

        # ---------- P. Cerrar sesión ----------
        ir(mov, 'mas'); mov.click('button:has-text("Cerrar sesión")')
        mov.wait_for_selector('#login-usuario', timeout=10000)
        local = mov.evaluate("DB.leerCache('datos').then(x => !!x)")
        check('Cerrar sesión vuelve al login y borra los datos del teléfono', local is False)

        # ---------- Capturas ----------
        ctxS, cap = nuevo_contexto(b, movil=True)
        login(cap, 'admin')
        cap.screenshot(path=os.path.join(TMP, 'movil-inicio.png'), full_page=True)
        ir(cap, 'viajes/nuevo'); cap.wait_for_selector('#f-sitio')
        cap.screenshot(path=os.path.join(TMP, 'movil-form.png'))
        b.close()
finally:
    backend.terminate()
    estatico.shutdown()

fallas = [r for r in resultados if not r[1]]
print(f'\n{len(resultados) - len(fallas)}/{len(resultados)} pruebas OK · archivos en {TMP}')
print('Consola del navegador (errores/advertencias):', errores_consola or 'ninguno')
sys.exit(1 if fallas or errores_consola else 0)
