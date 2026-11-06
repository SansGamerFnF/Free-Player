// ============================================================
// Free Player — registro de versiones (lo que se ve al tocar la
// versión dentro de "Acerca de").
//
// NORMA: cada vez que se hacen cambios en el proyecto se sube la
// versión: versionCode +1 y versionName en android/app/build.gradle,
// los textos "Versión …" de index.html, una entrada NUEVA AQUÍ
// ARIBA (la más reciente la primera) y su espejo en CAMBIOS.md.
// ============================================================

export const CHANGELOG = [
  {
    version: '0.3-c',
    code: 16,
    items: [
      'Arreglado: una canción recién añadida aparecía al principio de las del 2025 hasta reiniciar. Ahora se guarda con la fecha real del archivo y se coloca en su sitio (entre las recientes) al momento.',
      'Detección automática de canciones nuevas: al copiar o descargar música, la app la añade sola a la biblioteca sin pulsar “Escanear el teléfono” y avisa con un mensaje.',
      'La biblioteca se comprueba al arrancar y al volver a primer plano, por si el aviso del teléfono llegó con la app cerrada o en segundo plano.',
      'Los datos de las canciones ya guardadas (fecha, carpeta, álbum, título) se actualizan en cada comprobación si cambiaron en el teléfono.',
      'La barra de progreso de la notificación y de la pantalla de bloqueo ya mueve la canción: antes se podía arrastrar pero no hacía nada.',
      'Optimización general: los menús ya no desenfocan toda la pantalla (costaba frames en el teléfono), las listas largas siguen pintando solo lo visible y se eliminaron unas 300 líneas de código de carátulas que ya no se usaban.',
    ],
  },
  {
    version: '0.3-b',
    code: 15,
    items: [
      'Reproductor a pantalla completa rediseñado: carátula grande con marco del color del tema, progreso con la parte escuchada en sólido, título, artista • álbum y calidad, y controles con el botón de reproducir cuadrado y blanco.',
      'Controles de volumen y refuerzo (boost) dentro del reproductor, en el hueco central.',
      'El volumen del reproductor es ahora el volumen multimedia REAL del teléfono: si el sistema está al 15 %, la app muestra 15 %, y los botones físicos lo cambian en ambos sitios.',
      'Reproductor a 60 fps: el fondo difuminado ya no usa un filtro a pantalla completa y, mientras está abierto, se pausan la marquesina del título y las animaciones de la lista que quedan tapadas. Medido: 16,8 ms por frame, sin tirones.',
      'Barra inferior del reproductor con cinco iconos: minimizar, temporizador de sueño, cola, favorito y menú.',
      'El icono de la nota musical ahora abre la cola de reproducción (antes abría “Añadir a playlist”).',
      'La cola muestra el total: “6134 en cola · 289:32:55”, y el botón para vaciarla pasa a “Limpiar” en rojo suave.',
      'Arreglado: al cambiar varios ajustes seguidos (EQ, velocidad, tono, refuerzo, crossfade…) se perdían todos menos el último al reiniciar la app.',
      'Limpieza interna de temporizadores y código sin uso para que el desplazamiento y el audio vayan más finos.',
    ],
  },
  {
    version: '0.2n-b',
    code: 14,
    items: [
      'Cabecera de la biblioteca en una sola línea: “6134 canciones” ya no se parte en dos y el selector de orden queda compacto.',
      'La opción larga pasa a llamarse “Modificación” y el botón ↑/↓ cabe junto al selector.',
      'En pantallas estrechas se oculta la etiqueta “Orden:” para dejar sitio al contador.',
    ],
  },
  {
    version: '0.2m-b',
    code: 13,
    items: [
      'Arreglado: al seleccionar una canción ya no se pausa sola. El servicio de reproducción y el reproductor del WebView pedían el foco de audio a la vez, y el segundo dejaba en pausa al primero.',
      '“Añadidas” ahora es “Fecha de modificación”: se usa la fecha real del archivo, no la de haberlo añadido a la biblioteca.',
      'Botón ↑/↓ junto al orden: ascendente o descendente en título, artista, álbum y fecha de modificación.',
      'En “Info” de cada canción se muestra la fecha de modificación real.',
      'La precarga del siguiente tema se hace en los últimos 20 segundos, no al empezar: evita el microcorte con la pantalla apagada.',
      'La fecha de modificación se completa sola en las canciones que ya tenías escaneadas.',
    ],
  },
  {
    version: '0.2l-b',
    code: 12,
    items: [
      'Al soltar el dedo después de un deslizamiento rápido, las miniaturas de lo que tienes en pantalla se cargan primero.',
      'Las carátulas de las filas que ya pasaron se descartan de la cola: no se leen archivos que no vas a ver y el audio no compite con ese trabajo.',
      'La ventana sigue en ~30-40 miniaturas y las que salen se liberan solas.',
    ],
  },
  {
    version: '0.2k',
    code: 11,
    items: [
      'Al deslizar rápido ya no se leen carátulas de canciones que pasaron de largo: solo se cargan las que están cerca de la pantalla. Eso quita el microcorte que se notaba en el audio.',
      'La ventana sigue siendo de ~30-40 miniaturas: las que salen se liberan y las nuevas se leen al llegar.',
      'Si una fila cambia de carátula (álbum → propia), ya no queda ninguna URL vieja colgada en la lista.',
      'Texto arreglado: se quitó el doble codificado que mostraba acentos raros en algunos botones y separadores.',
      'El service worker ahora sirve los archivos nuevos al instante (red primero) y solo usa la caché sin conexión; al actualizar la APK ya no se queda con el JavaScript viejo.',
      'Miniaturas nítidas a 384 px y carátula de la canción sonando fijada para el reproductor, la mini barra y la notificación.',
    ],
  },
  {
    version: '0.2j',
    code: 10,
    items: [
      'Miniaturas como en un reproductor normal: se mantienen ~30-40 alrededor de lo que ves; al deslizar, las que salen de pantalla se liberan y se leen las nuevas.',
      'Miniaturas con más resolución en la lista (384 px): se ven nítidas, no borrosas.',
      'Lectura en tandas de 16 con margen de 700 px: las filas que vas a ver ya están cargadas.',
      'Solo memoria: nada se guarda en el almacenamiento interno, ni carátulas ni base de datos.',
      'La carátula de la canción que suena nunca se libera (reproductor, mini barra y notificación siempre la tienen).',
      'Menos trabajo por miniatura: el APK la entrega ya reducida y la app solo crea la URL al mostrarla.',
    ],
  },
  {
    version: '0.2i',
    code: 9,
    items: [
      'Miniaturas al instante: se leen y pintan todas apenas aparecen en pantalla, como en cualquier reproductor.',
      'Miniaturas más rápidas y ligeras: el APK las entrega ya reducidas (384 px), sin decodificar portadas gigantes por cada fila.',
      'Sigue sin usar el almacenamiento interno: las carátulas solo viven en memoria mientras usas la app.',
      'Eliminado el pequeño tirón al reproducir: la carátula ya no se reenvía cada 4 segundos.',
      'El copiado del siguiente tema espera a que el actual esté sonando estable (antes competía con el audio al arrancar).',
      'Caché de carátulas y de notificación limitada para que la memoria no crezca con miles de canciones.',
      'Si una miniatura se libera para ahorrar memoria, se vuelve a leer al regresar a esa fila (nunca queda en blanco).',
      'Carátula nítida en el reproductor y la notificación: la miniatura se relee en alta definición al sonar.',
    ],
  },
  {
    version: '0.2h',
    code: 8,
    items: [
      'Reproducción en streaming: la música arranca al instante y ya no se traba (antes se decodificaba la canción entera en segundo plano).',
      'Cambio de canción casi instantáneo: la siguiente se prepara sola.',
      'Menos memoria: cada canción ya no ocupa 100–200 MB de RAM.',
      'Carátulas sin caché en disco: se leen del archivo y se liberan cientos de MB del almacenamiento.',
      'Widget horizontal estilo captura: carátula de fondo, título, artista y 3 botones planos.',
      'El tema de color ya pinta todo el reproductor (fondo, botón de play y controles).',
      'Interfaz más ligera: el progreso se refresca 4 veces por segundo en vez de 60.',
    ],
  },
  {
    version: '0.2g',
    code: 7,
    items: [
      'Las carátulas aparecen ya en la primera carga (antes tocaba esperar a un segundo pintado).',
      'Mucho más rápidas: se leen varias a la vez y las pequeñas ya no se recodifican.',
      'Arreglado el lector de carátulas incrustadas (arrancaba desplazado y no las encontraba).',
      'Las carátulas incrustadas se guardan reducidas: no ocupan cientos de MB.',
    ],
  },
  {
    version: '0.2f',
    code: 6,
    items: [
      'La música ya no se para al salir de la app: sigue sonando en segundo plano.',
      'Cada canción muestra su propia miniatura (las que llevan la misma imagen comparten una sola copia).',
      'Arranca antes: lectura de 1 MB por trozo y menos esperas; además ya no aparece el aviso "Leyendo desde tu teléfono".',
      'Menos tirones: mientras suena la música, las carátulas cargan con menor prioridad.',
      'Widget rediseñado (carátula grande, título, artista y controles) y arreglado el estado del widget.',
    ],
  },
  {
    version: '0.2e',
    code: 5,
    items: [
      'Las carátulas se cargan mucho más rápido: el teléfono devuelve muchas portadas de una sola vez y se guardan en paralelo mientras escanea.',
      'Se piden solo las que faltan (las ya guardadas no se vuelven a descargar).',
    ],
  },
  {
    version: '0.2d',
    code: 4,
    items: [
      'Al tocar la versión en "Acerca de" se abre el registro de cambios.',
      'Notificación de reproducción en segundo plano con controles (bandeja, pantalla de bloqueo, Bluetooth).',
      'Widget de pantalla de inicio: carátula, título/artista y botones anterior/play-pausa/siguiente.',
      'La música empieza a sonar al instante (lectura del archivo en paralelo) y la siguiente canción ya viene precargada.',
      'Carátulas con respaldo: si el sistema no da la portada del álbum, se lee la incrustada en el archivo.',
      'No se muestran canciones de 30 s o menos (tonos y avisos) en biblioteca, búsqueda y carpetas.',
      'Va fluido en gama baja: listas con pintado diferido, sin desenfoque en la cabecera y caché de carátulas limitada.',
      'Control de volumen junto al sound boost.',
      'Icono del launcher en todos los tamaños.',
    ],
  },
  {
    version: '0.2c',
    code: 3,
    items: [
      'Escaneo por lotes con miniaturas compartidas por álbum (la biblioteca no ocupa cientos de MB).',
      'Lista paginada (60 canciones a la vez): no se cae con más de 5000 canciones.',
      'Vista agrupada por carpeta/ubicación.',
      'Sound boost 100–200 % con limitador.',
      'Sin muro de errores en pantalla; la barra de estado ya no se solapa con la app.',
    ],
  },
  {
    version: '0.2b',
    code: 2,
    items: [
      'Primera APK empaquetada con Capacitor.',
    ],
  },
  {
    version: '0.1',
    code: 1,
    items: [
      'Versión inicial de la PWA.',
    ],
  },
];
