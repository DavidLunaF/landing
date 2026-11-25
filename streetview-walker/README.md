# Street View Walker

Abre Google Maps en modo Street View con Playwright, hace una captura, avanza un paso y repite.

## Instalación

```bash
cd streetview-walker
npm install
npx playwright install chromium
```

## Uso

```bash
# Por defecto: empieza en el Silo de Santa Olalla (Toledo), 20 pasos, con ventana visible
node walker.js

# Cualquier otro lugar por nombre
node walker.js --lugar "Silo de Santa Olalla del Cala, Huelva"

# Gran Vía, mirando al oeste, 50 pasos
node walker.js --lat 40.4203 --lng -3.7058 --heading 270 --steps 50

# Sin ventana y más espera para conexiones lentas
node walker.js --headless --delay 4000
```

### Modo manual (tú navegas, el script captura)

```bash
node walker.js --manual
```

Se abre Google Maps. Entra en Street View donde quieras y pulsa **↑** para avanzar:
cada pulsación espera a que se mueva, deja cargar la imagen y guarda una captura.
Cierra la ventana (o Ctrl+C en la terminal) para terminar.

- `--settle 3000` si las capturas salen borrosas (da más tiempo a cargar).
- `--no-clean` para que salga la interfaz de Maps en las capturas.
- Las cookies se recuerdan en la carpeta `.perfil`, así no hay que aceptarlas cada vez.

`node walker.js --help` muestra todas las opciones.

## Resultado

- `capturas/paso_0000.png`, `paso_0001.png`, …
- `capturas/recorrido.json`: coordenadas, rumbo y URL de cada captura.

## Cómo funciona

1. Si se da `--lugar`, lo busca en Google Maps y toma sus coordenadas.
   Después abre `google.com/maps/@?api=1&map_action=pano&viewpoint=LAT,LNG` (Street View más cercano a ese punto).
2. Acepta el aviso de cookies si sale.
3. Espera al panorama, oculta la interfaz (`--no-clean` para dejarla) y captura.
4. Avanza con la flecha ↑ (o, si no se mueve, con un clic en la flecha del suelo).
5. Si se queda atascado (fin de calle), gira y vuelve a intentarlo.

## Notas

- Depende del HTML de Google Maps, que cambia a menudo; si deja de ocultar algo o deja de avanzar, hay que ajustar los selectores de `CLEAN_CSS` o `stepForward`.
- Automatizar Google Maps va contra sus Términos de Servicio. Para uso serio o a gran escala usa la
  [Street View Static API](https://developers.google.com/maps/documentation/streetview) (de pago, con clave).
