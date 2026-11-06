package com.freeplayer.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.ContentObserver;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.util.Size;
import android.view.Window;
import android.view.WindowManager;
import android.view.WindowInsetsController;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Escaneo TOTAL de música del dispositivo.
 *
 * scan()        → lista todas las canciones de MediaStore (memoria interna,
 *                 externa y tarjeta SD) con sus metadatos + carpeta + álbum.
 * readChunk()   → devuelve un trozo del archivo en base64 para que la app
 *                 web lo reproduzca sin copiar nada (lectura bajo demanda).
 * getArtwork()  → carátula de un ALBÚM ya reducida (~320 px, JPEG): una sola
 *                 petición por álbum en lugar de leer cada archivo.
 * index()       → índice ligero id → carpeta/álbum (migración de datos).
 * setStatusBar()→ pinta la barra de estado con el color del tema y devuelve
 *                 su altura en px para que el contenido no quede debajo.
 *
 * Permisos: "media" = READ_MEDIA_AUDIO en Android 13+,
 *           "storage" = READ_EXTERNAL_STORAGE en Android 12 o anterior.
 */
@CapacitorPlugin(
    name = "AudioScanner",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_MEDIA_AUDIO }, alias = "media"),
        @Permission(strings = { Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "storage")
    }
)
public class AudioScannerPlugin extends Plugin {

    private static final String ALIAS_MEDIA = "media";
    private static final String ALIAS_STORAGE = "storage";

    private static final int CHUNK = 256 * 1024;      // 256 KB por lectura
    private static final int MAX_CHUNK = 1024 * 1024;
    private static final long MIN_SIZE = 32 * 1024;   // ignora archivos de < 32 KB
    private static final int ART_MAX = 320;           // lado máximo de carátula
    private static final int ART_QUALITY = 82;        // JPEG

    private PluginCall pendingCall;
    private String pendingAction;

    // Observador de MediaStore: avisa a la web en cuanto entra o sale una
    // canción, para que la biblioteca se actualice sin pulsar "Escanear".
    private ContentObserver libraryObserver;
    private Handler observerHandler;
    private Runnable pendingLibraryEvent;

    @Override
    public void load() {
        startLibraryObserver();
    }

    @Override
    protected void handleOnDestroy() {
        stopLibraryObserver();
        super.handleOnDestroy();
    }

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? ALIAS_MEDIA : ALIAS_STORAGE;
    }

    // --------------------------------------------------------
    // Aviso de cambios en la biblioteca del teléfono
    // --------------------------------------------------------
    private void startLibraryObserver() {
        if (libraryObserver != null) return;
        try {
            observerHandler = new Handler(Looper.getMainLooper());
            libraryObserver = new ContentObserver(observerHandler) {
                @Override
                public void onChange(boolean selfChange) {
                    onChange(selfChange, null);
                }

                @Override
                public void onChange(boolean selfChange, Uri uri) {
                    scheduleLibraryEvent();
                }
            };
            ContentResolver cr = getContext().getContentResolver();
            cr.registerContentObserver(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, libraryObserver);
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    for (String vol : MediaStore.getExternalVolumeNames(getContext())) {
                        cr.registerContentObserver(
                            MediaStore.Audio.Media.getContentUri(vol), true, libraryObserver);
                    }
                } catch (Exception ignored) {
                    // con el URI por defecto ya se reciben los avisos
                }
            }
        } catch (Exception e) {
            libraryObserver = null;
            observerHandler = null;
        }
    }

    private void stopLibraryObserver() {
        if (observerHandler != null && pendingLibraryEvent != null) {
            observerHandler.removeCallbacks(pendingLibraryEvent);
        }
        pendingLibraryEvent = null;
        if (libraryObserver != null) {
            try {
                getContext().getContentResolver()
                    .unregisterContentObserver(libraryObserver);
            } catch (Exception ignored) {
                // ya estaba desregistrado
            }
            libraryObserver = null;
        }
        observerHandler = null;
    }

    /**
     * MediaStore avisa varias veces por una sola copia (archivo, escaneo,
     * metadatos). Se espera 1,2 s y se manda UN solo evento a la web.
     */
    private void scheduleLibraryEvent() {
        if (observerHandler == null) return;
        if (pendingLibraryEvent != null) {
            observerHandler.removeCallbacks(pendingLibraryEvent);
        }
        pendingLibraryEvent = () -> {
            pendingLibraryEvent = null;
            JSObject out = new JSObject();
            out.put("at", System.currentTimeMillis());
            notifyListeners("libraryChanged", out);
        };
        observerHandler.postDelayed(pendingLibraryEvent, 1200);
    }

    // --------------------------------------------------------
    // Permisos
    // --------------------------------------------------------
    private void withPermission(PluginCall call, String action) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            run(action, call);
            return;
        }
        pendingCall = call;
        pendingAction = action;
        requestPermissionForAlias(alias(), call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        PluginCall target = pendingCall != null ? pendingCall : call;
        String action = pendingAction;
        pendingCall = null;
        pendingAction = null;

        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            target.reject("Permiso de audio denegado", "E_PERM");
            return;
        }
        if (action != null) run(action, target);
    }

    private void run(String action, PluginCall call) {
        if ("scan".equals(action)) doScan(call);
        else if ("missing".equals(action)) doMissing(call);
        else if ("read".equals(action)) doRead(call);
        else if ("art".equals(action)) doArtwork(call);
        else if ("index".equals(action)) doIndex(call);
        else call.reject("Acción desconocida", "E_ACTION");
    }

    // --------------------------------------------------------
    // scan()
    // --------------------------------------------------------
    @PluginMethod
    public void scan(PluginCall call) {
        withPermission(call, "scan");
    }

    // --------------------------------------------------------
    // index() — id → carpeta/álbum (consulta muy ligera)
    // --------------------------------------------------------
    @PluginMethod
    public void index(PluginCall call) {
        withPermission(call, "index");
    }

    private void doScan(PluginCall call) {
        JSArray tracks = queryTracks(null);
        JSObject out = new JSObject();
        out.put("tracks", tracks);
        out.put("count", tracks.length());
        call.resolve(out);
    }

    // --------------------------------------------------------
    // missing(ids) — solo las pistas que aún no están guardadas
    // --------------------------------------------------------
    @PluginMethod
    public void missing(PluginCall call) {
        withPermission(call, "missing");
    }

    private void doMissing(PluginCall call) {
        Set<Long> known = new HashSet<>();
        JSArray ids = call.getArray("ids");
        if (ids != null) {
            for (int i = 0; i < ids.length(); i++) {
                Object v = ids.opt(i);
                if (v == null) continue;
                try {
                    known.add(Long.parseLong(String.valueOf(v).trim()));
                } catch (NumberFormatException ignored) {
                    // id no válido: se ignora
                }
            }
        }
        JSArray tracks = queryTracks(known);
        JSObject out = new JSObject();
        out.put("tracks", tracks);
        out.put("count", tracks.length());
        call.resolve(out);
    }

    /**
     * Consulta de canciones. Con exclude != null se saltan esos ids: la
     * detección automática solo trae lo nuevo en lugar de 6000 canciones.
     */
    private JSArray queryTracks(Set<Long> exclude) {
        ContentResolver cr = getContext().getContentResolver();
        JSArray tracks = new JSArray();

        // Todos los volúmenes visibles: interna (emulada) y tarjeta SD.
        List<Uri> uris = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                for (String vol : MediaStore.getExternalVolumeNames(getContext())) {
                    uris.add(MediaStore.Audio.Media.getContentUri(vol));
                }
            } catch (Exception ignored) {
                // sin nombres de volumen: se usa el por defecto
            }
        }
        if (uris.isEmpty()) uris.add(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI);

        String[] proj = new String[] {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.ALBUM_ID,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.DATE_MODIFIED
        };

        String selection = MediaStore.Audio.Media.SIZE + " >= " + MIN_SIZE;
        String order = MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC";

        for (Uri uri : uris) {
            Cursor c = null;
            try {
                c = cr.query(uri, proj, selection, null, order);
                if (c == null) continue;

                int iId = c.getColumnIndex(MediaStore.Audio.Media._ID);
                int iTitle = c.getColumnIndex(MediaStore.Audio.Media.TITLE);
                int iArtist = c.getColumnIndex(MediaStore.Audio.Media.ARTIST);
                int iAlbum = c.getColumnIndex(MediaStore.Audio.Media.ALBUM);
                int iAlbumId = c.getColumnIndex(MediaStore.Audio.Media.ALBUM_ID);
                int iDur = c.getColumnIndex(MediaStore.Audio.Media.DURATION);
                int iSize = c.getColumnIndex(MediaStore.Audio.Media.SIZE);
                int iData = c.getColumnIndex(MediaStore.Audio.Media.DATA);
                int iMime = c.getColumnIndex(MediaStore.Audio.Media.MIME_TYPE);
                int iMod = c.getColumnIndex(MediaStore.Audio.Media.DATE_MODIFIED);

                while (c.moveToNext()) {
                    long id = iId >= 0 ? c.getLong(iId) : -1;
                    if (id < 0) continue;
                    if (exclude != null && exclude.contains(id)) continue;

                    String path = iData >= 0 ? c.getString(iData) : null;
                    String title = iTitle >= 0 ? c.getString(iTitle) : null;
                    if (title == null || title.trim().isEmpty()) title = fileName(path);
                    if (title == null || title.trim().isEmpty()) continue;

                    long size = iSize >= 0 ? c.getLong(iSize) : 0;
                    long dur = iDur >= 0 ? c.getLong(iDur) : 0;
                    String mime = iMime >= 0 ? c.getString(iMime) : null;

                    JSObject o = new JSObject();
                    o.put("id", id);
                    o.put("uri", ContentUris.withAppendedId(uri, id).toString());
                    o.put("title", title.trim());
                    o.put("artist", clean(iArtist >= 0 ? c.getString(iArtist) : null));
                    o.put("album", clean(iAlbum >= 0 ? c.getString(iAlbum) : null));
                    o.put("duration", dur);              // milisegundos
                    o.put("size", size);
                    o.put("path", path == null ? "" : path);
                    o.put("folder", folderOf(path));     // carpeta contenedora
                    // álbum de MediaStore: sirve para agrupar y pedir UNA
                    // carátula compartida por álbum
                    o.put("albumId", iAlbumId >= 0 && !c.isNull(iAlbumId)
                        ? c.getLong(iAlbumId) : null);
                    o.put("ext", extOf(path, mime));
                    // Fecha de modificación real del archivo (segundos → ms).
                    // Es la que se muestra y ordena en la biblioteca.
                    o.put("modifiedAt", iMod >= 0 && !c.isNull(iMod)
                        ? c.getLong(iMod) * 1000L : 0L);
                    tracks.put(o);
                }
            } catch (Exception e) {
                // Un volumen no consultable no debe romper el escaneo completo.
            } finally {
                closeQuietly(c);
            }
        }

        return tracks;
    }

    // --------------------------------------------------------
    // index() — solo id → carpeta/álbum (una consulta rápida)
    // --------------------------------------------------------
    private void doIndex(PluginCall call) {
        ContentResolver cr = getContext().getContentResolver();
        JSArray rows = new JSArray();
        Cursor c = null;
        try {
            String[] proj = new String[] {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DATA,
                MediaStore.Audio.Media.ALBUM_ID,
                MediaStore.Audio.Media.DATE_MODIFIED
            };
            c = cr.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, proj,
                MediaStore.Audio.Media.SIZE + " >= " + MIN_SIZE, null, null);
            if (c != null) {
                int iId = c.getColumnIndex(MediaStore.Audio.Media._ID);
                int iData = c.getColumnIndex(MediaStore.Audio.Media.DATA);
                int iAlbumId = c.getColumnIndex(MediaStore.Audio.Media.ALBUM_ID);
                int iMod = c.getColumnIndex(MediaStore.Audio.Media.DATE_MODIFIED);
                while (c.moveToNext()) {
                    long id = iId >= 0 ? c.getLong(iId) : -1;
                    if (id < 0) continue;
                    JSObject o = new JSObject();
                    o.put("id", id);
                    o.put("folder", folderOf(iData >= 0 ? c.getString(iData) : null));
                    if (iAlbumId >= 0 && !c.isNull(iAlbumId)) o.put("albumId", c.getLong(iAlbumId));
                    o.put("modifiedAt", iMod >= 0 && !c.isNull(iMod)
                        ? c.getLong(iMod) * 1000L : 0L);
                    rows.put(o);
                }
            }
        } catch (Exception ignored) {
            // sin índice: la app sigue funcionando sin agrupar por carpetas
        } finally {
            closeQuietly(c);
        }
        JSObject out = new JSObject();
        out.put("rows", rows);
        call.resolve(out);
    }

    // --------------------------------------------------------
    // getArtwork() — carátula de un álbum, ya reducida
    // --------------------------------------------------------
    @PluginMethod
    public void getArtwork(PluginCall call) {
        // No se pide el permiso aquí (se lanzan muchas llamadas a la vez):
        // si aún no está concedido se rechaza y la app lo intentará en el
        // próximo arranque, cuando el escaneo ya haya pedido el permiso.
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            call.reject("Permiso de audio pendiente", "E_PERM");
            return;
        }
        withPermission(call, "art");
    }

    private void doArtwork(PluginCall call) {
        Double albumId = call.getDouble("albumId");
        if (albumId == null || albumId < 0) {
            call.resolve(new JSObject());   // sin álbum → sin carátula
            return;
        }

        Bitmap bmp = loadAlbumThumb(getContext().getContentResolver(), albumId.longValue());
        if (bmp == null) {
            call.resolve(new JSObject());
            return;
        }
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, ART_QUALITY, bos);
            JSObject out = new JSObject();
            out.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            out.put("mime", "image/jpeg");
            call.resolve(out);
        } catch (Exception e) {
            call.resolve(new JSObject());
        } finally {
            bmp.recycle();
        }
    }

    /**
     * getArtworks() — carátulas de VARIOS álbumes en UNA sola llamada.
     *
     * Cada petición al puente tiene un coste fijo (serialización + cola de
     * mensajes del WebView). Con cientos de álbumes, pedirlos de uno en uno
     * era la mayor parte del tiempo del escaneo de carátulas; aquí se
     * devuelven lotes (la web manda ~24 ids y recibe ~24 JPEG reducidos).
     *
     *  entrada: { ids: [albumId, …] }
     *  salida:  { items: [ { id, data, mime }, … ] }  (solo los que tienen)
     */
    @PluginMethod
    public void getArtworks(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            call.reject("Permiso de audio pendiente", "E_PERM");
            return;
        }
        JSArray ids = call.getArray("ids");
        JSArray items = new JSArray();
        if (ids != null) {
            ContentResolver cr = getContext().getContentResolver();
            for (int i = 0; i < ids.length(); i++) {
                long albumId;
                try {
                    albumId = (long) ids.getDouble(i);
                } catch (Exception e) {
                    continue;   // entrada rara: se salta
                }
                if (albumId < 0) continue;

                Bitmap bmp = loadAlbumThumb(cr, albumId);
                if (bmp == null) continue;   // ese álbum no tiene portada
                try {
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, ART_QUALITY, bos);
                    JSObject it = new JSObject();
                    it.put("id", albumId);
                    it.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                    it.put("mime", "image/jpeg");
                    items.put(it);
                } catch (Exception ignored) {
                    // sin memoria para esa imagen: se sigue con la siguiente
                } finally {
                    bmp.recycle();
                }
            }
        }
        JSObject out = new JSObject();
        out.put("items", items);
        call.resolve(out);
    }

    /**
     * Carátula de un álbum ya reducida a ART_MAX px (null si no tiene).
     * Compartida por getArtwork() y getArtworks().
     */
    private Bitmap loadAlbumThumb(ContentResolver cr, long albumId) {
        Uri artUri = ContentUris.withAppendedId(
            Uri.parse("content://media/external/audio/albumart"), albumId);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                return cr.loadThumbnail(artUri, new Size(ART_MAX, ART_MAX), null);
            }
            InputStream in = cr.openInputStream(artUri);
            if (in == null) return null;

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeStream(in, null, bounds);
            closeQuietly(in);

            int sample = 1;
            int biggest = Math.max(bounds.outWidth, bounds.outHeight);
            while (biggest / (sample * 2) >= ART_MAX) sample *= 2;

            in = cr.openInputStream(artUri);
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = Math.max(1, sample);
            Bitmap bmp = BitmapFactory.decodeStream(in, null, opts);
            closeQuietly(in);
            return bmp;
        } catch (Exception ignored) {
            return null;   // álbum sin carátula: no es un error
        }
    }

    // --------------------------------------------------------
    // getArtworksByFile() — carátula INCORPORADA en cada archivo
    //
    // MediaStore da la portada del ÁLBÚM, y como muchas canciones de una
    // misma carpeta comparten álbum (mil nightcore con el mismo "álbum")
    // TODAS acababan mostrando la misma miniatura. Aquí se lee la
    // carátula que lleva DENTRO cada archivo (ID3 APIC / MP4 covr /
    // FLAC PICTURE / OGG METADATA_BLOCK_PICTURE), leyendo SOLO la
    // cabecera: nunca la canción entera.
    //
    //  entrada: { files: [{ uri: 'content://…' }], maxPx: 512 }
    //  salida:  { items: [{ uri, data (b64), mime }] }  (solo los que tienen)
    //
    // maxPx reduce la carátula ANTES de mandarla a la web: una portada de
    // 1500 px tarda en decodificarse y ocupa sitio en cada fila; a 384 px
    // se ve perfecta en una miniatura y llega en milisegundos. Para la
    // canción que suena se pide más grande (1024) para que se vea nítida
    // en el reproductor y en la notificación.
    // --------------------------------------------------------
    /** Cota de seguridad: no se carga en memoria nada mayor que esto. */
    private static final int MAX_ART_BLOCK = 12 * 1024 * 1024;   // 12 MB
    /**
     * Tamaño máximo de una carátula que se devuelve a la web. Más de eso
     * sería un JSON gigante que en gama baja deja la app parada; una
     * carátula normal son 30–800 KB, así que 4 MB es un techo holgado.
     */
    private static final int MAX_ART_ITEM = 4 * 1024 * 1024;     // 4 MB
    /** En OGG se escanea la cabecera (los comentarios Vorbis van al principio). */
    private static final int OGG_SCAN = 1024 * 1024;             // 1 MB

    private static final class Art {
        byte[] data;
        String mime;
    }

    @PluginMethod
    public void getArtworksByFile(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            call.reject("Permiso de audio pendiente", "E_PERM");
            return;
        }
        JSArray files = call.getArray("files");
        JSArray items = new JSArray();
        int maxPx = call.getInt("maxPx", 1024);
        if (maxPx <= 0) maxPx = 1024;
        if (maxPx > 1600) maxPx = 1600;
        if (files != null) {
            ContentResolver cr = getContext().getContentResolver();
            int n = files.length();
            String[] uris = new String[n];
            for (int i = 0; i < n; i++) {
                String uri = null;
                try {
                    uri = files.getJSONObject(i).getString("uri");
                } catch (Exception ignored) {
                    // entrada rara: se salta
                }
                uris[i] = (uri == null || uri.isEmpty()) ? null : uri;
            }

            // Lectura EN PARALELO: leer la cabecera de cada archivo es lo que
            // dominaba el tiempo. Con 3 hilos una biblioteca de 5000 canciones
            // baja de ~1 minuto a unos segundos, sin tocar el hilo de la app.
            final Art[] arts = new Art[n];
            final int fMaxPx = maxPx;
            int threads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
            ExecutorService pool = Executors.newFixedThreadPool(threads);
            try {
                for (int i = 0; i < n; i++) {
                    final int idx = i;
                    final String u = uris[i];
                    if (u == null) continue;
                    pool.submit(() -> arts[idx] = artForUri(cr, u, fMaxPx));
                }
                pool.shutdown();
                pool.awaitTermination(120, TimeUnit.SECONDS);
            } catch (Throwable t) {
                pool.shutdownNow();
            }

            for (int i = 0; i < n; i++) {
                Art art = arts[i];
                if (art == null || art.data == null || art.data.length == 0) continue;
                JSObject it = new JSObject();
                it.put("uri", uris[i]);
                it.put("mime", art.mime);
                it.put("data", Base64.encodeToString(art.data, Base64.NO_WRAP));
                items.put(it);
            }
        }
        JSObject out = new JSObject();
        out.put("items", items);
        call.resolve(out);
    }

    /** Lee la carátula de un archivo y la deja reducida (se usa en paralelo). */
    private Art artForUri(ContentResolver cr, String uri, int maxPx) {
        try {
            InputStream in = cr.openInputStream(Uri.parse(uri));
            if (in == null) return null;
            Art art;
            try {
                art = readEmbeddedArt(in);
            } finally {
                closeQuietly(in);
            }
            if (art == null || art.data == null || art.data.length == 0
                    || art.data.length > MAX_ART_ITEM) {
                return null;
            }
            byte[] small = shrinkArt(art.data, maxPx);
            if (small != null) {
                art.data = small;
                art.mime = "image/jpeg";
            }
            return art;
        } catch (Throwable t) {
            return null;   // archivo ilegible o formato no soportado
        }
    }

    /**
     * Reduce una carátula a maxPx de lado y la devuelve como JPEG ligero.
     * Devuelve null si no merece la pena (ya es pequeña) o si la imagen no
     * se puede decodificar (en ese caso se usa el original).
     */
    private static byte[] shrinkArt(byte[] src, int maxPx) {
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(src, 0, src.length, probe);
            int w = probe.outWidth;
            int h = probe.outHeight;
            if (w <= 0 || h <= 0) return null;
            int side = Math.max(w, h);
            // Ya es pequeña en píxeles y en bytes: se manda tal cual.
            if (side <= maxPx && src.length <= 96 * 1024) return null;

            // inSampleSize evita decodificar la imagen completa en memoria.
            int sample = 1;
            while (side / (sample * 2) >= maxPx) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeByteArray(src, 0, src.length, opts);
            if (bmp == null) return null;

            int bw = bmp.getWidth();
            int bh = bmp.getHeight();
            int big = Math.max(bw, bh);
            if (big > maxPx) {
                float scale = maxPx / (float) big;
                Bitmap scaled = Bitmap.createScaledBitmap(bmp,
                    Math.max(1, Math.round(bw * scale)),
                    Math.max(1, Math.round(bh * scale)), true);
                if (scaled != bmp) bmp.recycle();
                bmp = scaled;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            // Para miniaturas pequeñas se comprime algo más: pesan menos en
            // memoria sin que se note en pantalla.
            bmp.compress(Bitmap.CompressFormat.JPEG, maxPx <= 192 ? 78 : 84, bos);
            bmp.recycle();
            byte[] out = bos.toByteArray();
            return (out.length > 0 && out.length < src.length) ? out : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** Detecta el formato por la firma y extrae la carátula incrustada. */
    private static Art readEmbeddedArt(InputStream in) {
        try {
            BufferedInputStream bin = new BufferedInputStream(in, 64 * 1024);
            // Se hace una MARCA antes de mirar la firma: cada parser tiene
            // que leer desde el byte 0 (si no, arranca desplazado 12 bytes
            // y no encuentra la carátula).
            bin.mark(64);
            byte[] head = new byte[12];
            int n = readFully(bin, head);
            if (n < 12) return null;
            bin.reset();

            if (head[0] == 'I' && head[1] == 'D' && head[2] == '3') {
                return artFromId3(bin);                          // MP3 (ID3v2)
            }
            if (head[0] == 'f' && head[1] == 'L' && head[2] == 'a' && head[3] == 'C') {
                return artFromFlac(bin);                          // FLAC
            }
            if (head[0] == 'O' && head[1] == 'g' && head[2] == 'g' && head[3] == 'S') {
                return artFromOgg(bin);                           // OGG/Opus
            }
            if (head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p') {
                return artFromMp4(bin);                           // MP4/M4A
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------- ID3v2 (MP3) ----------------
    private static Art artFromId3(BufferedInputStream in) {
        try {
            byte[] hdr = new byte[10];                 // cabecera ID3 completa
            if (readFully(in, hdr) < 10) return null;
            int version = hdr[3] & 0xFF;
            if (version < 3 || version > 4) return null;
            boolean synchsafe = version >= 4;          // v2.4: tamaños synchsafe
            int tagSize = synchsafeSize(hdr, 6);
            if (tagSize <= 0 || tagSize > MAX_ART_BLOCK) return null;

            byte[] tag = new byte[tagSize];            // la cabecera entera (con la carátula dentro)
            if (readFully(in, tag) < tagSize) return null;

            int pos = 0;
            while (pos + 10 <= tag.length) {
                if ((tag[pos] & 0xFF) == 0) break;     // relleno final del tag
                String fid = new String(tag, pos, 4, StandardCharsets.ISO_8859_1);
                int size = synchsafe
                    ? synchsafeSize(tag, pos + 4)
                    : beInt(tag, pos + 4);
                pos += 10;
                if (size <= 0 || pos + size > tag.length) break;
                if (fid.equals("APIC") || fid.equals("PIC")) {
                    return parseApic(tag, pos, size, fid.equals("PIC"));
                }
                pos += size;
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Contenido de un frame APIC/PIC: codificación, MIME, descripción, imagen. */
    private static Art parseApic(byte[] b, int off, int len, boolean v22) {
        int p = off;
        int end = off + len;
        if (p >= end) return null;
        int enc = b[p++] & 0xFF;                        // 0=ISO-8859-1 1=UTF-16 2=UTF-16BE 3=UTF-8
        String mime;
        if (v22) {                                      // ID3v2.2: 3 letras (JPG/PNG)
            if (p + 3 > end) return null;
            String fmt = new String(b, p, 3, StandardCharsets.ISO_8859_1).trim().toUpperCase();
            p += 3;
            mime = "PNG".equals(fmt) ? "image/png" : "image/jpeg";
        } else {
            int z = indexOf0(b, p, end);                // MIME terminado en 0
            if (z < 0) return null;
            mime = new String(b, p, z - p, StandardCharsets.ISO_8859_1).trim().toLowerCase();
            p = z + 1;
            if (!mime.startsWith("image/")) mime = "image/jpeg";
        }
        if (p >= end) return null;
        p++;                                            // tipo de pictura (1 byte)
        // descripción: termina en 0 (ISO/UTF-8) o en 00 00 (UTF-16)
        if (enc == 1 || enc == 2) {
            while (p + 1 < end && !(b[p] == 0 && b[p + 1] == 0)) p += 2;
            p += 2;
        } else {
            int z = indexOf0(b, p, end);
            p = z < 0 ? end : z + 1;
        }
        if (p >= end) return null;
        Art a = new Art();
        a.data = Arrays.copyOfRange(b, p, end);
        a.mime = mime;
        return a;
    }

    // ---------------- FLAC ----------------
    private static Art artFromFlac(BufferedInputStream in) {
        try {
            byte[] sig = new byte[4];                   // "fLaC"
            if (readFully(in, sig) < 4) return null;
            while (true) {
                byte[] h = new byte[4];
                if (readFully(in, h) < 4) return null;
                int type = h[0] & 0x7F;
                boolean last = (h[0] & 0x80) != 0;
                int size = ((h[1] & 0xFF) << 16) | ((h[2] & 0xFF) << 8) | (h[3] & 0xFF);
                if (type == 6) {                        // bloque PICTURE
                    if (size <= 0 || size > MAX_ART_BLOCK) return null;
                    byte[] blk = new byte[size];
                    if (readFully(in, blk) < size) return null;
                    return parsePictureBlock(blk);
                }
                if (size > 0) skipFully(in, size);
                if (last) return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Bloque PICTURE (FLAC y también el contenido de METADATA_BLOCK_PICTURE). */
    private static Art parsePictureBlock(byte[] b) {
        try {
            int p = 4;                                  // tipo de imagen
            int mimeLen = beInt(b, p); p += 4;
            if (mimeLen < 0 || p + mimeLen > b.length) return null;
            String mime = new String(b, p, mimeLen, StandardCharsets.ISO_8859_1).trim().toLowerCase();
            p += mimeLen;
            int descLen = beInt(b, p); p += 4;
            if (descLen < 0 || p + descLen > b.length) return null;
            p += descLen;
            p += 16;                                    // ancho, alto, profundidad, colores
            int dataLen = beInt(b, p); p += 4;
            if (dataLen <= 0 || p + dataLen > b.length) return null;
            Art a = new Art();
            a.data = Arrays.copyOfRange(b, p, p + dataLen);
            a.mime = mime.isEmpty() ? "image/jpeg" : mime;
            return a;
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------- OGG / Opus ----------------
    private static Art artFromOgg(BufferedInputStream in) {
        try {
            byte[] buf = new byte[OGG_SCAN];
            int total = 0;
            while (total < buf.length) {
                int r = in.read(buf, total, buf.length - total);
                if (r < 0) break;
                total += r;
            }
            // los comentarios Vorbis van en la cabecera: se busca la clave
            String head = new String(buf, 0, total, StandardCharsets.ISO_8859_1);
            String key = "METADATA_BLOCK_PICTURE=";
            int at = head.indexOf(key);
            if (at < 0) return null;
            // el valor es base64 (A-Z a-z 0-9 + / =) hasta el fin del comentario
            int p = at + key.length();
            int q = p;
            while (q < head.length()) {
                char c = head.charAt(q);
                boolean b64 = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=';
                if (!b64) break;
                q++;
            }
            if (q <= p) return null;
            byte[] blk = Base64.decode(head.substring(p, q), Base64.DEFAULT);
            return parsePictureBlock(blk);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------- MP4 / M4A ----------------
    private static Art artFromMp4(BufferedInputStream in) {
        try {
            // se recorren los átomos de nivel superior; el `mdat` (la canción)
            // puede pesar decenas de MB, así que se SALTA sin cargarlo
            while (true) {
                byte[] h = new byte[8];
                if (readFully(in, h) < 8) return null;
                long size = beInt(h, 0) & 0xFFFFFFFFL;
                String type = new String(h, 4, 4, StandardCharsets.ISO_8859_1);
                long content = size - 8;
                if (size == 1) {                        // átomo extendido (64 bits)
                    byte[] ext = new byte[8];
                    if (readFully(in, ext) < 8) return null;
                    size = beLong(ext, 0);
                    content = size - 16;
                }
                if (content <= 0) return null;
                if (type.equals("moov")) {
                    if (content > MAX_ART_BLOCK) return null;
                    byte[] moov = new byte[(int) content];
                    if (readFully(in, moov) < content) return null;
                    return artFromMoov(moov);
                }
                skipFully(in, content);
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** Dentro de moov: udta → meta → ilst → ©covr → data. */
    private static Art artFromMoov(byte[] moov) {
        byte[] udta = findAtom(moov, 0, moov.length, "udta");
        if (udta == null) return null;
        byte[] meta = findAtom(udta, 0, udta.length, "meta");
        if (meta == null) return null;
        byte[] ilst = findAtom(meta, 4, meta.length, "ilst");   // meta: 4 bytes de version/flags
        if (ilst == null) return null;
        byte[] covr = findAtom(ilst, 0, ilst.length, "\u00A9covr");
        if (covr == null) return null;
        byte[] data = findAtom(covr, 0, covr.length, "data");
        if (data == null || data.length <= 8) return null;
        int typeInd = beInt(data, 0);                  // 13=JPEG 14=PNG
        Art a = new Art();
        a.data = Arrays.copyOfRange(data, 8, data.length);
        a.mime = typeInd == 14 ? "image/png" : "image/jpeg";
        return a;
    }

    /** Primer átomo hijo con ese nombre dentro de buf[off..end); su CONTENIDO. */
    private static byte[] findAtom(byte[] buf, int off, int end, String name) {
        int pos = off;
        while (pos + 8 <= end) {
            int size = beInt(buf, pos);
            String type = new String(buf, pos + 4, 4, StandardCharsets.ISO_8859_1);
            if (size < 8 || pos + size > end) return null;
            if (type.equals(name)) {
                return Arrays.copyOfRange(buf, pos + 8, pos + size);
            }
            pos += size;
        }
        return null;
    }

    // ---------------- utilidades de lectura ----------------
    private static int readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int r = in.read(b, off, b.length - off);
            if (r < 0) break;
            off += r;
        }
        return off;
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        long left = n;
        while (left > 0) {
            long s = in.skip(left);
            if (s <= 0) {
                if (in.read() < 0) return;              // fin de archivo
                s = 1;
            }
            left -= s;
        }
    }

    private static int synchsafeSize(byte[] b, int off) {
        return ((b[off] & 0x7F) << 21) | ((b[off + 1] & 0x7F) << 14)
            | ((b[off + 2] & 0x7F) << 7) | (b[off + 3] & 0x7F);
    }

    private static int beInt(byte[] b, int off) {
        return ((b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16)
            | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF);
    }

    private static long beLong(byte[] b, int off) {
        return ((long) beInt(b, off) << 32) | (beInt(b, off + 4) & 0xFFFFFFFFL);
    }

    private static int indexOf0(byte[] b, int from, int end) {
        for (int i = from; i < end; i++) {
            if (b[i] == 0) return i;
        }
        return -1;
    }

    // --------------------------------------------------------
    // stageAudio() — deja el archivo listo para SONAR (sin decodificar)
    //
    // El reproductor web reproduce con un <audio> apuntando al servidor
    // local del APK. Un content:// no lleva extensión y el navegador no
    // siempre acierta el tipo; así que aquí se copia UNA vez a la caché
    // (con su extensión) y se devuelve la ruta. Se conservan solo las 3
    // copias más recientes (la que suena, la siguiente y margen): no crece.
    //
    //  entrada: { uri: 'content://…', ext: 'mp3' }
    //  salida:  { path: '/data/.../cache/fp_audio/a12.mp3' }
    // --------------------------------------------------------
    private static final int STAGE_KEEP = 4;
    private static final AtomicInteger STAGE_SEQ = new AtomicInteger(1);
    private static final Object STAGE_LOCK = new Object();

    @PluginMethod
    public void stageAudio(PluginCall call) {
        String uri = call.getString("uri");
        String ext = call.getString("ext", "mp3");
        if (uri == null || uri.isEmpty()) {
            call.reject("Falta la uri del audio");
            return;
        }
        if (ext == null || !ext.matches("[A-Za-z0-9]{1,8}")) ext = "mp3";

        try {
            File dir = new File(getContext().getCacheDir(), "fp_audio");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Sin espacio para preparar el audio");
                return;
            }
            File out = new File(dir, "a" + STAGE_SEQ.getAndIncrement() + "." + ext);
            InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri));
            if (in == null) {
                call.reject("No se pudo abrir el archivo");
                return;
            }
            try (FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buf = new byte[256 * 1024];
                int r;
                while ((r = in.read(buf)) > 0) fos.write(buf, 0, r);
            } finally {
                closeQuietly(in);
            }

            // Limpieza: solo las STAGE_KEEP copias más recientes.
            synchronized (STAGE_LOCK) {
                File[] all = dir.listFiles();
                if (all != null && all.length > STAGE_KEEP) {
                    Arrays.sort(all, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
                    for (int i = 0; i < all.length - STAGE_KEEP; i++) {
                        if (!all[i].equals(out)) all[i].delete();
                    }
                }
            }

            JSObject res = new JSObject();
            res.put("path", out.getAbsolutePath());
            res.put("size", out.length());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("No se pudo preparar el audio: " + e.getMessage());
        }
    }

    // --------------------------------------------------------
    // setStatusBar() — color del tema + altura de la barra
    // Los métodos de plugin corren en hilo propio, así que la UI se
    // toca SIEMPRE desde el hilo principal.
    // --------------------------------------------------------
    @PluginMethod
    public void setStatusBar(PluginCall call) {
        String color = call.getString("color", "#0f0f10");
        boolean light = call.getBoolean("light", false);
        int height = statusBarHeight();

        AppCompatActivity act = getActivity();
        if (act == null) {
            JSObject out = new JSObject();
            out.put("height", height);
            call.resolve(out);
            return;
        }

        act.runOnUiThread(() -> {
            try {
                Window w = act.getWindow();
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.setStatusBarColor(parseColor(color));
                WindowInsetsController ctrl = w.getDecorView().getWindowInsetsController();
                if (ctrl != null) {
                    ctrl.setSystemBarsAppearance(
                        light ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                }
            } catch (Exception ignored) {
                // el color no se pudo aplicar: no rompe la app
            }

            JSObject out = new JSObject();
            out.put("height", height);
            call.resolve(out);
        });
    }

    private int statusBarHeight() {
        try {
            android.content.res.Resources res = getContext().getResources();
            int resId = res.getIdentifier("status_bar_height", "dimen", "android");
            if (resId > 0) return res.getDimensionPixelSize(resId);
        } catch (Exception ignored) {
            // sin altura conocida: la app usa el margen de pantalla segura
        }
        return 0;
    }

    private static int parseColor(String s) {
        try {
            return Color.parseColor(s == null ? "#0f0f10" : s.trim());
        } catch (Exception e) {
            return Color.parseColor("#0f0f10");
        }
    }

    // --------------------------------------------------------
    // readChunk()
    // --------------------------------------------------------
    @PluginMethod
    public void readChunk(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || !uriStr.startsWith("content://media/")) {
            call.reject("URI no válida", "E_URI");
            return;
        }
        withPermission(call, "read");
    }

    private void doRead(PluginCall call) {
        String uriStr = call.getString("uri");
        Double offsetD = call.getDouble("offset");
        Integer lengthI = call.getInt("length");

        if (uriStr == null || offsetD == null) {
            call.reject("Faltan parámetros", "E_PARAM");
            return;
        }

        long offset = Math.max(0L, offsetD.longValue());
        int length = lengthI == null ? CHUNK : Math.min(Math.max(lengthI, 1), MAX_CHUNK);

        ParcelFileDescriptor pfd = null;
        FileInputStream fis = null;
        try {
            Uri uri = Uri.parse(uriStr);
            if (!"media".equals(uri.getAuthority())) {
                call.reject("URI no válida", "E_URI");
                return;
            }

            pfd = getContext().getContentResolver().openFileDescriptor(uri, "r");
            if (pfd == null) {
                call.reject("No se pudo abrir el archivo", "E_OPEN");
                return;
            }

            fis = new FileInputStream(pfd.getFileDescriptor());
            FileChannel ch = fis.getChannel();

            ByteBuffer buf = ByteBuffer.allocate(length);
            int read = ch.read(buf, offset);            // lectura posicional (sin mover el resto)

            JSObject out = new JSObject();
            if (read <= 0) {
                out.put("data", "");
                out.put("eof", true);
                out.put("read", 0);
            } else {
                byte[] bytes = Arrays.copyOf(buf.array(), read);
                out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                out.put("eof", read < length);
                out.put("read", read);
            }
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Lectura fallida: " + e.getMessage(), "E_READ", e);
        } finally {
            closeQuietly(fis);
            closeQuietly(pfd);
        }
    }

    // --------------------------------------------------------
    // Utilidades
    // --------------------------------------------------------
    private static String clean(String s) {
        if (s == null) return "";
        s = s.trim();
        if (s.isEmpty() || s.equalsIgnoreCase("<unknown>")) return "";
        return s;
    }

    /** Carpeta (directorio) que contiene el archivo. */
    private static String folderOf(String path) {
        if (path == null) return "";
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        return slash > 0 ? path.substring(0, slash) : "";
    }

    private static String fileName(String path) {
        if (path == null) return "";
        int slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        String name = slash >= 0 ? path.substring(slash + 1) : path;
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static String extOf(String path, String mime) {
        if (path != null) {
            int dot = path.lastIndexOf('.');
            if (dot > 0 && dot < path.length() - 1) {
                String e = path.substring(dot + 1).toLowerCase(Locale.US);
                if (e.length() <= 5) return e;
            }
        }
        if (mime == null) return "audio";
        String m = mime.toLowerCase(Locale.US);
        if (m.equals("audio/mpeg") || m.equals("audio/mp3")) return "mp3";
        if (m.equals("audio/mp4") || m.equals("audio/x-m4a") || m.equals("audio/m4a")) return "m4a";
        if (m.equals("audio/flac")) return "flac";
        if (m.equals("audio/wav") || m.equals("audio/x-wav") || m.equals("audio/wave")) return "wav";
        if (m.equals("audio/ogg") || m.equals("audio/opus") || m.equals("audio/ogg; codecs=opus")) return "ogg";
        if (m.equals("audio/aac")) return "aac";
        if (m.equals("audio/amr")) return "amr";
        if (m.equals("audio/3gpp")) return "3gp";
        if (m.startsWith("audio/")) return m.substring(6);
        return "audio";
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Exception ignored) {
            // ya cerrado: no importa
        }
    }

    private static void closeQuietly(ParcelFileDescriptor p) {
        if (p == null) return;
        try {
            p.close();
        } catch (Exception ignored) {
            // ya cerrado: no importa
        }
    }
}
