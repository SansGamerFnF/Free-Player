# Free Player

Reproductor de música local para Android, hecho como **PWA** y empaquetado como APK con **Capacitor**.
Sin cuentas, sin anuncios y sin subir nada a Internet: la música, las carátulas, las listas y los ajustes se quedan en el teléfono.

**Versión actual:** `0.3-c` (beta) · versionCode 16 · [descargar APK](../../releases/latest)

---

## Características

- **Biblioteca local** desde MediaStore, con búsqueda, carpetas, orden por título / artista / álbum / fecha y contador de canciones.
- **Detección automática de canciones nuevas**: al copiar o descargar música, un `ContentObserver` nativo avisa y la app la añade sola, colocada por su fecha real. No hace falta pulsar «Escanear el teléfono».
- **Reproductor a pantalla completa**: carátula, barra de progreso, título, artista • álbum, calidad del archivo, volumen, refuerzo (boost) y controles.
- **Volumen real del teléfono**: el deslizador mueve el volumen multimedia del sistema (`STREAM_MUSIC`); el boost es propio de la app.
- **Cola de reproducción**, favoritos, listas, aleatorio y repetición.
- **Notificación, pantalla de bloqueo y widget** con controles y barra de progreso que sí mueve la canción (incluido el gesto de arrastre).
- **Ecualizador** con presets, **velocidad y tono**, y **temporizador de sueño**.
- **Formatos**: MP3, M4A/AAC, FLAC, OGG/Opus y WAV; los que el navegador no reproduce se convierten con **FFmpeg** (WASM).
- **Funciona sin conexión** (service worker) y sin telemetría.

## Instalación de la APK

1. Descarga `Free-Player-0.3-c.apk` desde [Releases](../../releases).
2. Permite instalar apps de origen desconocido para el explorador o el gestor de archivos.
3. Abre el APK e instala.
4. Al primer arranque, concede el permiso de **música y audio** para que la biblioteca se llene.

Requisitos: **Android 7.0 o superior** (minSdk 24).

> La APK publicada está firmada con la clave de depuración de Android, pensada para probar e instalar manualmente. No está preparada para Google Play (para eso hace falta una clave de publicación propia).

## Compilar desde el código

Requisitos: **Node.js 18+**, **JDK 21**, **Android SDK** con compileSdk 35 y el wrapper de Gradle incluido.

```bash
npm install
node build-www.mjs          # genera www/ con solo lo necesario
npx cap sync android        # copia www/ y los plugins al proyecto Android
cd android
./gradlew assembleDebug     # en Windows: gradlew.bat assembleDebug
```

La APK sale en `android/app/build/outputs/apk/debug/app-debug.apk`.

Para probar la PWA en el ordenador:

```bash
npm start                   # http://localhost:8087
```

## Estructura del proyecto

| Ruta | Qué contiene |
| --- | --- |
| `index.html` | Interfaz completa (biblioteca, reproductor, menús, modales). |
| `css/style.css` | Estilos, tema oscuro y transiciones. |
| `js/app.js` | Lógica: biblioteca, cola, listas, eventos y pintado de pantallas. |
| `js/audio-engine.js` | Motor de audio, Web Audio, ecualizador y boost. |
| `js/native.js` | Puente con los plugins nativos del APK (escaneo, carátulas, volumen, archivos). |
| `js/media-bridge.js` | Notificación, pantalla de bloqueo y widget. |
| `js/db.js` | IndexedDB: pistas, carátulas, listas y ajustes. |
| `ffmpeg/` | Núcleo de FFmpeg en WebAssembly para formatos no soportados. |
| `android/` | Proyecto Android (Capacitor, servicio de reproducción, plugins Java). |
| `build-www.mjs` | Genera `www/` con los archivos de producción. |
| `CAMBIOS.md` | Registro de versiones (espejo de `js/changelog.js`). |

## Versiones

La versión actual es **0.3-c (build 16)**. El detalle de cada entrega está en [CAMBIOS.md](CAMBIOS.md) y en las notas de [Releases](../../releases). Dentro de la app se puede abrir el registro tocando la versión en **Acerca de**.

## Licencia

[MIT](https://opensource.org/licenses/MIT). Puedes usar, modificar y compartir el código citando la licencia.
