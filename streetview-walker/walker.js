#!/usr/bin/env node
// Street View Walker: abre Google Maps en Street View, captura y avanza.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------- Argumentos ----------
function parseArgs(argv) {
  const a = {
    lat: 40.4168, lng: -3.7038,   // Puerta del Sol, Madrid
    heading: 0, pitch: 0, fov: 90,
    steps: 20, delay: 2500,
    out: 'capturas', width: 1280, height: 800,
    headless: false, clean: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const [k, vInline] = argv[i].replace(/^--/, '').split('=');
    const v = vInline ?? argv[i + 1];
    const take = () => { if (vInline === undefined) i++; return v; };
    switch (k) {
      case 'lat': a.lat = +take(); break;
      case 'lng': a.lng = +take(); break;
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
      case 'help': case 'h':
        console.log(`Uso: node walker.js [opciones]
  --lat N --lng N     Punto de inicio (por defecto Puerta del Sol)
  --heading N         Dirección inicial en grados (0 = norte)
  --pitch N           Inclinación (-90..90)
  --fov N             Campo de visión (10..100)
  --steps N           Número de pasos (por defecto 20)
  --delay MS          Espera tras cada paso para que cargue (por defecto 2500)
  --out DIR           Carpeta de salida (por defecto ./capturas)
  --width/--height    Tamaño de la ventana
  --headless          Sin ventana visible
  --no-clean          No ocultar la interfaz de Maps en las capturas`);
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

(async () => {
  const a = parseArgs(process.argv);
  const outDir = path.resolve(a.out);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: a.headless, args: ['--use-gl=angle', '--enable-webgl'] });
  const context = await browser.newContext({ viewport: { width: a.width, height: a.height }, locale: 'es-ES' });
  const page = await context.newPage();

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
