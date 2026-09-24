/* =========================================================================
   config.js — Configuración de esta instalación (editar al desplegar)
   -------------------------------------------------------------------------
   API_URL: URL de la Aplicación web de Google Apps Script. Termina en /exec.
            Se obtiene en Apps Script → Implementar → Administrar
            implementaciones. Para probar sin Google, usar el backend local:
            'http://127.0.0.1:8787/exec' (node tests/servidor-prueba.js).
   Si cambias este archivo en GitHub Pages, sube también VERSION en sw.js y
   APP_VERSION en app.js para que los celulares tomen el cambio.
   ========================================================================= */
window.CONFIG_APP = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzVx7hcgS5IR6yOtQ7CTxXtduYOxbjBNeoumFrTSeXYKOxIkcAuv0zIXBYyKyRVxuik3g/exec',
  // Cada cuántos segundos se revisa si otro usuario hizo cambios (con la app abierta).
  INTERVALO_SYNC_SEG: 45
};
