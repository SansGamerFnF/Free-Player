# Free Player — registro de versiones

**Norma:** cada vez que se hacen cambios en el proyecto, se sube la versión.

- `android/app/build.gradle` → `versionCode` (+1) y `versionName`
- `index.html` → texto "Versión …" del splash y del "Acerca de"
- `js/changelog.js` → entrada NUEVA arriba del todo (es lo que se ve en la app
  tocando la versión en "Acerca de")

Este archivo es el espejo legible de `js/changelog.js`.

## 0.3-c (versionCode 16) — beta
- **Arreglado el orden al añadir una canción**: se guardaba sin su fecha de modificación y quedaba al principio de las de 2025 hasta reiniciar. Ahora se importa con la fecha real del archivo y aparece en su sitio (entre las recientes) al instante.
- **Canciones nuevas sin pulsar “Escanear”**: un observador de MediaStore en el APK avisa cuando entra una canción y la app la añade sola, con un aviso (“✓ 1 canción nueva”).
- **Comprobación al arrancar y al volver a primer plano**: si el aviso del teléfono llegó con la app cerrada, se recupera al abrirla. La consulta nativa pide solo las pistas que faltan, así que con 6000 canciones sigue siendo instantánea.
- **Metadatos siempre al día**: al comprobar la biblioteca se refrescan fecha, carpeta, álbum y título de las canciones que ya estaban, si cambiaron en el teléfono.
- **Barra de la notificación arreglada**: arrastrar el progreso en la notificación o en la pantalla de bloqueo ya mueve la canción de verdad (antes solo se dibujaba la barra).
- **Optimización general**: fuera el `backdrop-filter` de los menús (desenfocar toda la pantalla costaba frames), las listas largas siguen usando `content-visibility` y se eliminaron unas 300 líneas de código de carátulas que ya no se llamaba.

## 0.3-b (versionCode 15) — beta
- **Reproductor a pantalla completa rediseñado** (estilo Retro Music): carátula grande con marco grueso del color del tema, barra de progreso con la parte escuchada en color sólido, y debajo título, artista • álbum y calidad (formato • kb/s • kHz).
- **Volumen y boost en el reproductor**: dos controles discretos en el hueco central, sincronizados con Ajustes.
- **Volumen real del teléfono**: el control ya no es una ganancia interna. Lee y cambia `STREAM_MUSIC`, así que si el sistema está al 15 % la app muestra 15 %, y los botones físicos se reflejan al instante.
- **Reproductor a 60 fps**: el fondo desenfocado se genera una vez como miniatura de 40 px ampliada; mientras el reproductor está abierto se pausan la marquesina del título y las animaciones de la lista que quedan tapadas. Medido: **16,8 ms por frame** (antes ~44 ms, unos 22 fps).
- **Controles nuevos**: botón de reproducir cuadrado y blanco con icono oscuro; repetir, anterior, siguiente y aleatorio repartidos a los lados.
- **Barra inferior de cinco iconos**: minimizar, temporizador de sueño, **cola**, favorito y menú.
- **La nota musical es la cola**: se quitó el botón “Añadir a playlist” del reproductor. Ese icono abre ahora la cola de reproducción, como en tu captura.
- **Cola con duración**: la cabecera muestra “6134 en cola · 289:32:55” y el botón para vaciarla pasa a “Limpiar”, en rojo suave.
- **Ajustes que sí persisten**: al cambiar varios seguidos (EQ, velocidad, tono, refuerzo, crossfade…) antes solo se guardaba el último. Ahora cada ajuste tiene su propio temporizador y todos sobreviven al reinicio.
- **Limpieza interna**: fuera temporizadores y variables que ya no se usaban; el desplazamiento y el audio van más finos.

## 0.2n-b (versionCode 14) — beta
- **Cabecera en una línea**: el contador de canciones ya no se parte en dos líneas y los controles (Carpetas, orden y ↑/↓) caben en pantallas de ~450 px.
- **Selector compacto**: la opción pasa a “Modificación” y el desplegable se limita a 108 px con puntos suspensivos.
- **Móvil estrecho**: por debajo de 430 px se oculta la etiqueta “Orden:” y el contador conserva su sitio.

## 0.2m-b (versionCode 13) — beta
- **Ya no se pausa al elegir canción**: el servicio nativo pedía el foco de audio al mismo tiempo que el `<audio>` del WebView. Android le quitaba el foco a Chromium y este pausaba la reproducción (~0,5 s después de empezar). Ahora el foco lo gestiona solo el reproductor del WebView y el servicio se limita a la notificación, la MediaSession y el wake lock.
- **“Añadidas” → “Fecha de modificación”**: se lee `DATE_MODIFIED` de MediaStore (fecha real del archivo) y se completa sola en las canciones ya escaneadas mediante el índice ligero.
- **Orden ascendente/descendente**: nuevo botón ↑/↓ junto al selector; se guarda la preferencia. Afecta a título, artista, álbum y fecha de modificación.
- **Info**: la ficha de la canción muestra “Modificada” con fecha y hora reales.
- **Precarga más discreta**: el siguiente tema se prepara en los últimos 20 s, no a los 1,5 s de empezar. Ese copiado de varios MB era el que podía provocar el microcorte con la pantalla apagada.

## 0.2l-b (versionCode 12) — beta
- **Prioridad al soltar el dedo**: tras un deslizamiento rápido, la cola de miniaturas se rehace con lo que está en pantalla. Las carátulas visibles se leen en la primera tanda y las filas que ya pasaron se descartan.
- **Menos disco y menos cortes**: ya no se leen archivos de canciones que no vas a ver; el audio deja de competir con esas lecturas.
- **Ventana de ~30-40 miniaturas**: se mantiene el liberado automático de las que salen de pantalla.
- **Marcador `-b`**: indica que la versión sigue en beta.

## 0.2k (versionCode 11)
- **Adiós al microcorte al deslizar**: si la cola de miniaturas es larga (deslizamiento rápido), antes de leer cada tanda se descartan las canciones que ya salieron de la pantalla. Ya no se gasta disco leyendo archivos que no vas a ver, así el audio no compite con esas lecturas.
- **Ventana de ~30-40 miniaturas**: se mantiene el comportamiento de 0.2j; las que salen se liberan tras 5 s de gracia y las nuevas se leen con 700 px de margen.
- **Sin URLs viejas**: al liberar una carátula se limpian también las imágenes que apuntaban a esa URL aunque su fila hubiera cambiado de clave (álbum → canción propia).
- **Texto reparado**: se revirtió el doble codificado que mostraba acentos raros en botones y separadores. Ahora “📁 Carpetas”, “⋯” y los acentos se ven bien.
- **Service worker red-primero**: tras instalar una APK nueva se ve el JavaScript nuevo en el acto; la caché queda solo como respaldo sin conexión.
- **Sin tocar el almacenamiento**: las carátulas siguen viviendo únicamente en memoria; nada se escribe en el teléfono.

## 0.2j (versionCode 10)
- **Ventana de miniaturas deslizante**: se mantienen en memoria ~30-40 carátulas alrededor de lo que estás viendo. Al deslizar, las que salen de pantalla se liberan (tras 5 s de gracia, para no recargarlas si subes y bajas) y se leen las nuevas. Es el comportamiento de un reproductor normal.
- **Más resolución en la lista**: las miniaturas se piden a 384 px (antes 144 px, que se veían borrosas en pantallas de alta densidad).
- **Carga por tandas de 16** con 700 px de margen de precarga por encima y por debajo: las filas que vas a ver ya están listas al llegar.
- **Solo memoria**: no se escribe nada en el almacenamiento interno (ni IndexedDB ni archivos). Las carátulas se crean como URL de objeto al mostrarse y se revocan al salir de la ventana.
- **La carátula que suena está fijada**: nunca se libera aunque su fila ya no se vea, porque la usan el reproductor, la mini barra, el fondo y la notificación.
- **Limpieza de la ventana**: una pasada cada pocos segundos mide qué miniaturas siguen cerca de la pantalla y libera el resto; hay un tope de seguridad para el scroll muy rápido.
- **Lectura nativa en paralelo**: `getArtworksByFile` reparte los archivos entre 3–4 hilos, así una tanda de 16 se resuelve en pocos milisegundos sin bloquear la interfaz.

## 0.2i (versionCode 9)
- **Miniaturas al instante**: al entrar en pantalla se leen y pintan todas en tandas de 12, sin espera inicial (antes había un retardo de 90 ms por tanda y tandas de 8). El margen de precarga sube a 600 px, así las filas siguientes ya están listas al hacer scroll.
- **Miniaturas ligeras**: el APK entrega la carátula ya reducida a 384 px (JPEG) en lugar de mandar la portada original de hasta 4 MB. Se decodifica con `inSampleSize`, así no se carga en memoria la imagen completa de cada canción.
- **Sin caché en el almacenamiento**: las carátulas siguen viviendo solo en memoria (session). Nada se guarda en el almacenamiento interno.
- **Fuera el micro-corte periódico**: la carátula solo se envía al servicio Android cuando cambia (canción nueva o imagen recién leída). Antes viajaba un base64 de ~100 KB cada 4 s por el puente nativo y eso producía el pequeño tirón.
- **Prefetch sin competir con el audio**: la preparación del siguiente tema espera 1,5 s desde que empieza a sonar el actual (antes 0,3 s), de modo que la copia no coincide con el arranque de la reproducción.
- **Memoria acotada**: la caché de carátulas (500), la de base64 para la notificación (40) y la de miniaturas reducidas se limitan para no crecer con miles de canciones. Las filas cuya miniatura se libera vuelven a leerla al regresar a ellas (el observador sigue activo), así nunca se quedan en blanco.
- **Carátula nítida al sonar**: la miniatura de 384 px se relee a 1024 px para el reproductor, la notificación y el widget.

## 0.2h (versionCode 8)
- **Reproducción en streaming**: la canción suena desde el archivo directamente (el APK deja una copia lista en su caché con extensión y el servidor local la sirve con rangos). Ya no se decodifica la canción entera: antes cada tema ocupaba 100–200 MB de RAM y se procesaba con SoundTouch en JavaScript, y eso era lo que trababa el sonido (sobre todo en el reproductor) y demoraba el cambio de pista.
- **Cambio de canción instantáneo**: al empezar una canción se prepara la siguiente en segundo plano (copia rápida, sin decodificar); pulsar siguiente es casi inmediato. La búsqueda en la barra también es instantánea (rangos).
- **Carátulas sin caché pesada**: ya no se guardan en IndexedDB. Se leen del propio archivo de cada canción cuando su miniatura entra en pantalla (lazy + IntersectionObserver), en tandas de 8, y viven solo en memoria. Se ejecuta una limpieza única que libera las carátulas antiguas (cientos de MB).
- **Widget horizontal** como la captura: carátula de fondo completa, degradado para legibilidad, título (2 líneas) y artista centrados, y 3 botones planos (anterior / play-pausa / siguiente). 4x2 celdas.
- **Temas completos**: el color de acento ahora tiñe el fondo del reproductor, el botón de play, los controles, la barra mini y las filas en reproducción; antes solo se notaba en la barra de progreso.
- **Interfaz más ligera**: el progreso se actualiza 4 veces por segundo por temporizador (antes 60 veces por segundo con requestAnimationFrame), menos trabajo de DOM en gama baja.

## 0.2g (versionCode 7)
- Las carátulas aparecen ya en la primera carga: al llegar cada imagen se pinta al instante en sus filas (antes la fila seguía apuntando a la clave del álbum y solo se veía al re-renderizar, como una "doble carga").
- Lectura mucho más rápida: los parsers de carátulas incrustadas ahora arrancan desde el byte 0 (un fallo de marcador hacía que no las encontraran), se piden varias tandas a la vez (3 lectores en paralelo; 1 si hay música sonando) y las imágenes pequeñas ya no se recodifican.
- Las carátulas incrustadas se guardan reducidas a 384 px, así no ocupan cientos de MB.
- Tope de 4 MB por carátula al pasar por el puente nativo (evita bloqueos en gama baja con imágenes gigantes).

## 0.2f (versionCode 6)
- La música ya no se para al salir de la app (se quitó la pausa automática al ocultar; el servicio nativo mantiene la reproducción).
- Cada canción muestra su propia miniatura: primer pase leyendo la carátula incrustada de cada archivo (por lotes de 24, con deduplicación por huella SHA-1), y el álbum de MediaStore solo para las que no tienen.
- Arranque más rápido: trozos de lectura de 1 MB, precarga de la siguiente canción a 0,3 s y sin el aviso "Leyendo desde tu teléfono".
- Menos tirones de sonido: mientras hay música sonando, el trabajo de carátulas cede CPU (1 worker + pausas) y las imágenes de la lista se cargan con `loading=lazy`.
- Widget rediseñado (carátula grande, título, artista, controles) y arreglo del estado "Sin reproducción".

## 0.2e (versionCode 5)
- Las carátulas se cargan mucho más rápido: el teléfono devuelve muchas portadas de una sola vez (`getArtworks`, lotes de 24) y se guardan en paralelo mientras escanea.
- Se piden solo las que faltan (las ya guardadas no se vuelven a descargar).
- Degrada al método uno-a-uno si el APK no soporta lotes.

## 0.2d (versionCode 4)
- Al tocar la versión en "Acerca de" se abre el registro de cambios.
- Notificación de reproducción en segundo plano con controles (bandeja, pantalla de bloqueo, Bluetooth).
- Widget de pantalla de inicio: carátula, título/artista y botones anterior/play-pausa/siguiente.
- La música empieza a sonar al instante (lectura del archivo en paralelo) y la siguiente canción ya viene precargada.
- Carátulas con respaldo: si el sistema no da la portada del álbum, se lee la incrustada en el archivo.
- No se muestran canciones de 30 s o menos (tonos y avisos) en biblioteca, búsqueda y carpetas.
- Va fluido en gama baja: listas con pintado diferido, sin desenfoque en la cabecera y caché de carátulas limitada.
- Control de volumen junto al sound boost.
- Pantalla completa con carátula grande.
- Icono del launcher en todos los tamaños + color de fondo adaptativo.

## 0.2c (versionCode 3)
- Escaneo por lotes con miniaturas compartidas por álbum (la biblioteca no ocupa cientos de MB).
- Lista paginada (60 canciones a la vez): no se cae con más de 5000 canciones.
- Vista agrupada por carpeta/ubicación.
- Sound boost 100–200 % con limitador.
- Sin muro de errores en pantalla; la barra de estado ya no se solapa con la app.

## 0.2b (versionCode 2)
- Primera APK empaquetada con Capacitor.

## 0.1 (versionCode 1)
- Versión inicial de la PWA.
