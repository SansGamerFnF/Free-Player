package com.freeplayer.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Puente entre la web (reproductor con Web Audio) y el lado nativo.
 *
 * update()      → actualiza a la vez: notificación en primer plano, MediaSession
 *                 (lockscreen/controles de sistema/bluetooth) y el widget de la
 *                 pantalla de inicio. Es idempotente: se puede llamar muchas
 *                 veces por segundo (posición del progreso) sin reiniciar el
 *                 servicio ni re-lanzar la notificación (solo actualiza).
 *                 Cada destino se ejecuta con try/catch PROPIO: si el servicio
 *                 no puede arrancar (Android 12+), el widget y la sesión se
 *                 repintan igualmente (el widget ya no depende del servicio).
 * hide()        → quita la notificación, para el servicio y suelta la sesión.
 * requestPermission() → Android 13+: pide POST_NOTIFICATIONS y devuelve
 *                 { granted: boolean }.
 *
 * Evento "action" → cuando el usuario pulsa un botón de la notificación, el
 * lockscreen, bluetooth o el widget, la web recibe e.action con uno de:
 * play | pause | toggle | next | prev | stop. El nativo NUNCA para el audio:
 * solo emite el evento y la web es quien actúa.
 *
 * CÓMO LLEGAN LOS BOTONES EXTERNOS A LA WEB (robustez):
 *  - Si el proceso está vivo (lo normal mientras suena la música, porque el
 *    servicio en primer plano mantiene el proceso), los receivers y la
 *    MediaSession llaman a dispatchExternalAction() que usa una referencia
 *    estática al plugin cargado → notifyListeners("action", ..., true).
 *  - El tercer argumento true es "retainUntilConsumed": si la web todavía no
 *    ha registrado su listener (arranque en frío), Capacitor RETIENE el evento
 *    y lo entrega en cuanto la web llama a addListener('action', ...).
 *  - Si el proceso no está vivo (widget con la app cerrada), el receiver
 *    arranca MainActivity con el extra "fp_action"; Capacitor entrega ese
 *    Intent a handleOnNewIntent() del plugin (incluso en el arranque en frío:
 *    BridgeActivity llama a onNewIntent(getIntent()) tras crear el puente).
 */
@CapacitorPlugin(
    name = "MediaBridge",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class MediaBridgePlugin extends Plugin {

    /** Tag de logcat para diagnosticar en dispositivo: `adb logcat -s FreePlayer`. */
    private static final String TAG = "FreePlayer";

    /** Extra del Intent con el que se reenvía una acción externa (widget/app muerta). */
    public static final String EXTRA_ACTION = "fp_action";

    /** Lado máx. de la carátula que se guarda en disco para el widget (px). */
    private static final int ART_FILE_MAX = 320;

    /** Referencia estática al plugin cargado (proceso compartido con servicio/receivers). */
    private static volatile MediaBridgePlugin instance;

    /** Para pasar al hilo principal desde cualquier hilo. */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    // --------------------------------------------------------
    // Acciones externas (notificación/widget/lockscreen/bluetooth)
    // --------------------------------------------------------

    /**
     * Reenvía una acción a la web. Devuelve false si no hay plugin cargado
     * (proceso sin Activity), para que el caller pueda arrancar la app.
     */
    public static boolean dispatchExternalAction(String action) {
        MediaBridgePlugin p = instance;
        String a = normalizeAction(action);
        Log.d(TAG, "Acción externa: " + action + " → " + a
            + (p == null ? " (sin plugin: se re-lanzará la app)" : " (entregada a la web)"));
        if (p == null || a == null) return false;

        JSObject data = new JSObject();
        data.put("action", a);
        // retainUntilConsumed=true: si la web aún no escucha, se guarda el
        // evento y se entrega en cuanto registra su listener.
        p.notifyListeners("action", data, true);
        return true;
    }

    /**
     * La barra de progreso de la notificación / lockscreen pide saltar a un
     * punto (ACTION_SEEK_TO). Se reenvía a la web con la posición en ms.
     */
    public static boolean dispatchSeek(long positionMs) {
        MediaBridgePlugin p = instance;
        Log.d(TAG, "Seek externo: " + positionMs + " ms"
            + (p == null ? " (sin plugin)" : " (entregado a la web)"));
        if (p == null) return false;

        JSObject data = new JSObject();
        data.put("action", "seek");
        data.put("position", Math.max(0L, positionMs));
        p.notifyListeners("action", data, true);
        return true;
    }

    private static String normalizeAction(String a) {
        if (a == null) return null;
        switch (a) {
            case "play":
            case "pause":
            case "toggle":
            case "next":
            case "prev":
            case "stop":
                return a;
            default:
                return null;
        }
    }

    /**
     * Acciones llegadas por Intent (widget/app muerta). Capacitor llama a esto
     * tanto en el arranque en frío (BridgeActivity → onNewIntent(getIntent()))
     * como cuando entra un Intent nuevo con la Activity viva (singleTask).
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(EXTRA_ACTION);
        if (action == null) return;
        // Se quita el extra para no re-procesarlo si el mismo Intent vuelve a
        // atravesar el camino (p. ej. otra llamada a onNewIntent).
        intent.removeExtra(EXTRA_ACTION);
        dispatchExternalAction(action);
    }

    // --------------------------------------------------------
    // update()
    // --------------------------------------------------------
    @PluginMethod
    public void update(PluginCall call) {
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        Double dur = call.getDouble("duration");
        Double pos = call.getDouble("position");
        boolean playing = call.getBoolean("playing", false);
        String artwork = call.getString("artwork"); // base64 JPEG sin "data:"; null = sin cambio

        Context ctx = getContext();
        if (ctx == null) {
            call.reject("Contexto no disponible", "E_CTX");
            return;
        }
        final Context app = ctx.getApplicationContext();
        final String fTitle = title;
        final String fArtist = artist;
        final String fAlbum = album;
        final long fDuration = dur == null ? 0L : Math.max(0L, dur.longValue());
        final long fPosition = pos == null ? 0L : Math.max(0L, pos.longValue());
        final boolean fPlaying = playing;
        final String fArtwork = artwork;

        // Los métodos de plugin corren en hilo propio: todo lo que toque el
        // servicio, la sesión, el widget o el sistema se hace SIEMPRE en el
        // hilo principal.
        MAIN.post(() -> {
            // Cada bloque va con su propio try/catch: UN fallo (p. ej.
            // Android 12+ prohibiendo startForegroundService desde segundo
            // plano) NUNCA debe impedir que el resto se ejecute. Antes, si el
            // servicio reventaba, el widget no se repintaba y se quedaba en
            // "Sin reproducción" aunque hubiera música sonando.
            Log.d(TAG, "update: titulo='" + fTitle + "' artista='" + fArtist
                + "' playing=" + fPlaying + " pos=" + fPosition
                + " artwork=" + (fArtwork == null ? "sin cambio"
                    : (fArtwork.isEmpty() ? "vacio" : fArtwork.length() + " b64")));

            // 1) Estado en el almacén (base de todo: widget, sesión y notificación)
            boolean artChanged = false;
            try {
                artChanged = PlaybackStateStore.set(app, fTitle, fArtist, fAlbum,
                    fDuration, fPosition, fPlaying, fArtwork);
            } catch (Throwable t) {
                Log.e(TAG, "update: fallo al guardar el estado", t);
            }

            // 2) Carátula a disco: el widget la lee del archivo, así que se
            //    guarda AQUÍ también (no solo desde el servicio) para que el
            //    widget tenga portada aunque el servicio no pueda arrancar.
            try {
                if (artChanged) saveArtworkForWidget(app, fArtwork);
            } catch (Throwable t) {
                Log.e(TAG, "update: fallo al guardar la carátula", t);
            }

            // 3) Widget: repintado INDEPENDIENTE del servicio (paso clave)
            try {
                PlayerWidgetProvider.pushAllIfChanged(app);
            } catch (Throwable t) {
                Log.e(TAG, "update: fallo al repintar el widget", t);
            }

            // 4) Servicio (notificación en primer plano + MediaSession):
            //    "best effort": si no puede arrancar, la música de la web y el
            //    widget siguen funcionando igual.
            try {
                PlaybackService.requestUpdate(app);
            } catch (Throwable t) {
                Log.e(TAG, "update: fallo al arrancar el servicio", t);
            }

            call.resolve();
        });
    }

    /**
     * Guarda la carátula recibida (base64) en el archivo interno que usa el
     * widget. Solo se llama cuando la carátula cambió, para no decodificar en
     * cada tick de posición.
     */
    private void saveArtworkForWidget(Context app, String artwork) {
        if (artwork == null) return;                 // sin cambio: no tocar nada
        String clean = artwork.trim();
        if (clean.isEmpty()) {                        // limpieza explícita
            ArtUtils.deleteArtFile(app);
            return;
        }
        Bitmap bmp = ArtUtils.decodeBase64(clean, ART_FILE_MAX);
        if (bmp != null) {
            ArtUtils.saveJpeg(app, bmp, ArtUtils.ART_FILE);
            bmp.recycle();
            Log.d(TAG, "update: carátula guardada en disco para el widget");
        }
    }

    // --------------------------------------------------------
    // hide()
    // --------------------------------------------------------
    @PluginMethod
    public void hide(PluginCall call) {
        Context ctx = getContext();
        final Context app = ctx != null ? ctx.getApplicationContext() : null;
        MAIN.post(() -> {
            Log.d(TAG, "hide: se detiene notificación, servicio y sesión");
            if (app != null) PlaybackService.stopAll(app);
            call.resolve();
        });
    }

    // --------------------------------------------------------
    // requestPermission() — POST_NOTIFICATIONS (Android 13+)
    // --------------------------------------------------------
    @PluginMethod
    public void requestPermission(PluginCall call) {
        JSObject out = new JSObject();

        // En Android 12 o anterior no hace falta ningún permiso
        if (Build.VERSION.SDK_INT < 33) {
            out.put("granted", true);
            call.resolve(out);
            return;
        }

        Context ctx = getContext();
        if (ctx != null
            && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            out.put("granted", true);
            call.resolve(out);
            return;
        }

        // Se pide con el flujo de permisos de Capacitor (alias "notifications"
        // declarado en la anotación del plugin). Si el sistema ya no puede
        // mostrar el diálogo (denegado "para siempre"), el callback llega
        // igualmente y se responde granted: false.
        requestPermissionForAlias("notifications", call, "notificationsPermissionCallback");
    }

    @PermissionCallback
    private void notificationsPermissionCallback(PluginCall call) {
        boolean granted = getPermissionState("notifications") == PermissionState.GRANTED;
        JSObject out = new JSObject();
        out.put("granted", granted);
        call.resolve(out);
    }
}
