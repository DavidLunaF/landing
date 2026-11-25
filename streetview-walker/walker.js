#!/usr/bin/env node
// Street View Walker: abre Google Maps en Street View, captura y avanza.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------- Argumentos ----------
function parseArgs(argv) {
  const a = {
    lugar: 'Silo de Santa Olalla, Toledo',  // se busca en Google Maps
    lat: null, lng: null,
    heading: 0, pitch: 0, fov: 90,
    steps: 20, delay: 2500,
    out: 'capturas', width: 1280, height: 800,
    headless: false, clean: true,
    manual: false, settle: 1500, perfil: '.perfil',
  };
  for (let i = 2; i < argv.length; i++) {
    const [k, vInline] = argv[i].replace(/^--/, '').split('=');
    const v = vInline ?? argv[i + 1];
    const take = () => { if (vInline === undefined) i++; return v; };
    switch (k) {
      case 'lugar': case 'place': a.lugar = take(); break;
      case 'lat': a.lat = +take(); a.lugar = null; break;
      case 'lng': a.lng = +take(); a.lugar = null; break;
      case 'heading': a.heading = +take(); break;
      case 'pitch': a.pitch = +take(); break;
      case 'fov': a.fov = +take(); break;
      case 'steps': a.steps = +take(); break;
      case 'delay': a.delay = +take(); break;
      case 'out': a.out = take(); break;
      case 'width': a.width = +take(); break;
      case 'height': a.height = +take(); break;
      case 'headless': a.headless = true; break;
      case 'no-clean': a.clean = false; break;
      case 'manual': a.manual = true; break;
      case 'settle': a.settle = +take(); break;
      case 'perfil': a.perfil = take(); break;
      case 'help': case 'h':
        console.log(`Uso: node walker.js [opciones]
  --lugar "TEXTO"     Lugar a buscar en Google Maps (por defecto "Silo de Santa Olalla, Toledo")
  --lat N --lng N     Coordenadas de inicio (en vez de --lugar)
  --heading N         Dirección inicial en grados (0 = norte)
  --pitch N           Inclinación (-90..90)
  --fov N             Campo de visión (10..100)
  --steps N           Número de pasos (por defecto 20)
  --delay MS          Espera tras cada paso para que cargue (por defecto 2500)
  --out DIR           Carpeta de salida (por defecto ./capturas)
  --width/--height    Tamaño de la ventana
  --headless          Sin ventana visible
  --no-clean          No ocultar la interfaz de Maps en las capturas

Modo manual (tú navegas, el script captura al pulsar la flecha arriba):
  --manual            Abre Google Maps; cada vez que pulses ↑ en Street View, hace una captura
  --settle MS         Espera extra tras moverse antes de capturar (por defecto 1500)
  --perfil DIR        Carpeta donde se guardan cookies/sesión del navegador (por defecto .perfil)`);
        process.exit(0);
    }
  }
  return a;
}

// Extrae lat, lng, heading y pitch de una URL de Street View:
// .../@40.41,-3.70,3a,75y,90h,95t/...
function parseView(url) {
  const m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+),3a(?:,([\d.]+)y)?(?:,([\d.]+)h)?(?:,([\d.]+)t)?/);
  if (!m) return null;
  return {
    lat: +m[1], lng: +m[2],
    fov: m[3] ? +m[3] : null,
    heading: m[4] ? +m[4] : null,
    pitch: m[5] ? +m[5] - 90 : null,   // Maps usa 90t = horizonte
  };
}

const CLEAN_CSS = `
  #titlecard, #omnibox-container, #omnibox, .app-viewcard-strip, #minimap,
  .scene-footer-container, #watermark, .widget-scene-imagery-render ~ div[role="button"],
  #image-header, .Hk4XGb, .gb_Ad, header, [aria-label*="Google apps"], [jsaction*="titlecard"],
  .scene-footer, #runway-expand-button, .widget-titlecard, .app-bottom-content-anchor,
  button[aria-label*="Zoom"], button[aria-label*="Ampliar"], button[aria-label*="Reducir"],
  .widget-compass, #compass, .id-compass { display: none !important; }
`;

async function acceptConsent(page) {
  // Pantalla de cookies de Google (UE). Puede estar en consent.google.com.
  const labels = ['Aceptar todo', 'Accept all', 'Rechazar todo', 'Reject all', 'Tout accepter', 'Alle akzeptieren'];
  for (const l of labels) {
    const btn = page.getByRole('button', { name: l }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    }
  }
  return false;
}

async function findPlace(page, query) {
  // Busca el lugar en Google Maps y devuelve sus coordenadas.
  await page.goto('https://www.google.com/maps/search/' + encodeURIComponent(query), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptConsent(page);
  const coordsFromUrl = () => {
    const u = page.url();
    const exact = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);   // coordenadas exactas del sitio
    if (exact) return { lat: +exact[1], lng: +exact[2] };
    return null;
  };
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const c = coordsFromUrl();
    if (c) return c;
    // Si sale una lista de resultados, abrir el primero.
    const first = page.locator('a.hfpxzc, div[role="feed"] a[href*="/maps/place/"]').first();
    if (await first.isVisible().catch(() => false)) await first.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  // Último recurso: el centro del mapa (@lat,lng,zoom).
  const m = page.url().match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}

async function waitForPano(page, timeout = 30000) {
  // El panorama se dibuja en un <canvas>; esperamos a que exista y a que la URL sea de Street View.
  await page.waitForFunction(
    () => /,3a/.test(location.href) && !!document.querySelector('canvas'),
    null, { timeout }
  );
}

async function stepForward(page, a) {
  const before = parseView(page.url());
  // Foco en el panorama y flecha arriba = avanzar en Street View.
  await page.mouse.move(a.width / 2, a.height * 0.6);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(a.delay);
  let after = parseView(page.url());
  const moved = before && after && (before.lat !== after.lat || before.lng !== after.lng);
  if (moved) return { moved: true, view: after };

  // Plan B: clic en la flecha de navegación del suelo (parte baja-centro).
  await page.mouse.click(a.width / 2, a.height * 0.78);
  await page.waitForTimeout(a.delay);
  after = parseView(page.url());
  const moved2 = before && after && (before.lat !== after.lat || before.lng !== after.lng);
  return { moved: !!moved2, view: after };
}

async function turn(page, degrees, a) {
  // Girar arrastrando el panorama (aprox. 1px ≈ 0.1-0.2º, depende del fov).
  const x = a.width / 2, y = a.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - degrees * 5, y, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

// ---------- Modo manual ----------
async function manualMode(a) {
  const outDir = path.resolve(a.out);
  fs.mkdirSync(outDir, { recursive: true });

  // Perfil persistente: las cookies aceptadas y la sesión se recuerdan entre ejecuciones.
  const context = await chromium.launchPersistentContext(path.resolve(a.perfil), {
    headless: false,
    viewport: null,               // usa el tamaño real de la ventana
    locale: 'es-ES',
    args: ['--start-maximized', '--use-gl=angle', '--enable-webgl'],
  });

  const log = [];
  let n = 0;
  let queue = Promise.resolve();
  const samePos = (x, y) => x && y && x.lat === y.lat && x.lng === y.lng;

  async function capture(page, urlBefore) {
    const before = parseView(urlBefore);
    // Esperar a que cambie la posición (hasta 6 s) y a que cargue la imagen.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && samePos(before, parseView(page.url()))) {
      await page.waitForTimeout(150);
    }
    const moved = !samePos(before, parseView(page.url()));
    await page.waitForTimeout(a.settle);

    let style = null;
    if (a.clean) style = await page.addStyleTag({ content: CLEAN_CSS }).catch(() => null);
    await page.waitForTimeout(100);
    const file = path.join(outDir, `paso_${String(n).padStart(4, '0')}.png`);
    await page.screenshot({ path: file });
    if (style) await style.evaluate(el => el.remove()).catch(() => {});

    const view = parseView(page.url());
    log.push({ paso: n, archivo: path.basename(file), avanzo: moved, ...view, url: page.url(), hora: new Date().toISOString() });
    fs.writeFileSync(path.join(outDir, 'recorrido.json'), JSON.stringify(log, null, 2));
    console.log(`[${n}]`, view ? `${view.lat}, ${view.lng} rumbo ${view.heading}º` : '', moved ? '' : '(no se movió)', '→', path.basename(file));
    n++;
  }

  // La página llama a esta función cuando pulsas ↑ estando en Street View.
  await context.exposeBinding('__svArrowUp', ({ page }, urlBefore, enStreetView) => {
    if (!enStreetView) {
      console.log('↑ detectada, pero no estás en Street View (la URL no tiene ",3a"):', urlBefore.slice(0, 120));
      return;
    }
    console.log('↑ detectada en Street View, esperando a que avance...');
    queue = queue.then(() => capture(page, urlBefore)).catch(e => console.error('Error al capturar:', e.message));
  });
  const listener = () => {
    if (window.__svListener) return;
    window.__svListener = true;
    window.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' && !e.repeat) window.__svArrowUp(location.href, /,3a/.test(location.href));
    }, true);
  };
  await context.addInitScript(listener);

  const page = context.pages()[0] || await context.newPage();
  const start = (a.lat != null && a.lng != null)
    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${a.lat},${a.lng}&heading=${a.heading}`
    : 'https://www.google.com/maps';
  await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.error(e.message));
  for (const p of context.pages()) await p.evaluate(listener).catch(() => {});
  context.on('page', p => console.log('Pestaña nueva abierta:', p.url() || '(cargando)'));
  console.log('Página abierta:', page.url());

  console.log('Modo manual listo.');
  console.log('  1. Entra en Street View donde quieras (el silo, etc.).');
  console.log('  2. Pulsa ↑ para avanzar: cada pulsación hace una captura en', outDir);
  console.log('  3. Cierra la ventana del navegador (o Ctrl+C aquí) para terminar.');

  const finish = async () => {
    await queue.catch(() => {});
    console.log(`Listo: ${log.length} capturas en ${outDir}`);
    process.exit(0);
  };
  process.on('SIGINT', async () => { await queue.catch(() => {}); await context.close().catch(() => {}); finish(); });
  context.on('close', finish);
}

(async () => {
  const a = parseArgs(process.argv);
  if (a.manual) return manualMode(a);
  const outDir = path.resolve(a.out);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: a.headless, args: ['--use-gl=angle', '--enable-webgl'] });
  const context = await browser.newContext({ viewport: { width: a.width, height: a.height }, locale: 'es-ES' });
  const page = await context.newPage();

  if (a.lugar) {
    console.log('Buscando en Google Maps:', a.lugar);
    const c = await findPlace(page, a.lugar);
    if (!c) {
      console.error('No se encontró el lugar. Prueba con otro texto o usa --lat/--lng.');
      await browser.close(); process.exit(1);
    }
    console.log(`Encontrado en ${c.lat}, ${c.lng}`);
    a.lat = c.lat; a.lng = c.lng;
  }

  const startUrl = `https://www.google.com/maps/@?api=1&map_action=pano` +
    `&viewpoint=${a.lat},${a.lng}&heading=${a.heading}&pitch=${a.pitch}&fov=${a.fov}`;
  console.log('Abriendo', startUrl);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await acceptConsent(page)) console.log('Cookies aceptadas');

  try {
    await waitForPano(page);
  } catch {
    console.error('No se encontró Street View en ese punto. Prueba con otras coordenadas (en una calle).');
    await page.screenshot({ path: path.join(outDir, 'error.png') });
    await browser.close();
    process.exit(1);
  }
  await page.waitForTimeout(3000); // dejar que cargue la imagen
  if (a.clean) await page.addStyleTag({ content: CLEAN_CSS });

  const log = [];
  let stuck = 0;
  for (let i = 0; i <= a.steps; i++) {
    const file = path.join(outDir, `paso_${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: file });
    const view = parseView(page.url());
    log.push({ paso: i, archivo: path.basename(file), ...view, url: page.url(), hora: new Date().toISOString() });
    console.log(`[${i}/${a.steps}]`, view ? `${view.lat}, ${view.lng} rumbo ${view.heading}º` : '', '→', path.basename(file));
    fs.writeFileSync(path.join(outDir, 'recorrido.json'), JSON.stringify(log, null, 2));
    if (i === a.steps) break;

    const r = await stepForward(page, a);
    if (!r.moved) {
      stuck++;
      console.log('  No se pudo avanzar; girando para buscar camino...');
      await turn(page, 45 * stuck, a);
      if (stuck >= 6) { console.log('Atascado, fin del recorrido.'); break; }
    } else {
      stuck = 0;
    }
  }

  console.log(`Listo: ${log.length} capturas en ${outDir}`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
