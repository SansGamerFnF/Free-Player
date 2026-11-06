package com.freeplayer.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.util.Log;
import android.widget.RemoteViews;

import java.io.File;

/**
 * Widget de la pantalla de inicio (horizontal, como la captura de
 * referencia): la carátula ocupa todo el fondo con un degradado oscuro,
 * encima el título (2 líneas), el artista y una fila de 3 botones planos:
 * anterior / play-pausa / siguiente.
 *
 * - updatePeriodMillis es 0 en el XML: el widget SOLO se actualiza cuando la
 *   web llama a MediaBridge.update() (o hide()), que repinta desde el plugin
 *   vía pushAllIfChanged() — SIN depender de que el servicio en primer plano
 *   pueda arrancar (ese acoplamiento era lo que dejaba el widget parado en
 *   "Sin reproducción").
 * - pushAllIfChanged() compara una firma de lo visible (título, artista,
 *   estado, carátula en disco) y solo hace el IPC de RemoteViews cuando algo
 *   cambió: update() llega cada segundo con la posición y el widget no muestra
 *   progreso, así que no hay que repintar en cada tick.
 * - Los botones usan PendingIntents a MediaActionReceiver: con la app viva el
 *   evento "action" va directo a la web; con la app cerrada se arranca
 *   MainActivity con el extra "fp_action".
 * - Si no hay carátula se usa el icono de la app (@mipmap/ic_launcher).
 *
 * Diagnóstico en dispositivo: logcat con filtro "FreePlayer".
 */
public class PlayerWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "FreePlayer";

    // Códigos de PendingIntent: los de notificación y widget deben ser
    // distintos porque la igualdad de PendingIntents ignora los extras.
    private static final int REQ_PREV = 201;
    private static final int REQ_TOGGLE = 202;
    private static final int REQ_NEXT = 203;
    private static final int REQ_OPEN = 204;

    /** px de la carátula del widget (4x2: se ve grande en pantallas 3x). */
    private static final int ART_MAX = 512;

    /** Firma de lo que ya se pintó (solo se toca desde el hilo principal). */
    private static String lastPushedSig;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        // El launcher pide un repintado (arranque, cambio de proveedor, etc.)
        Log.d(TAG, "Widget: onUpdate del launcher (" + appWidgetIds.length + " widgets)");
        render(ctx, appWidgetManager, appWidgetIds);
    }

    @Override
    public void onEnabled(Context ctx) {
        // Primer widget colocado
        pushAll(ctx);
    }

    /**
     * Actualiza TODOS los widgets colocados con el estado actual del almacén.
     * Debe llamarse desde el hilo principal (RemoteViews + decodificación).
     * Pintado COMPLETO, siempre (sin filtros): es la vía "segura".
     */
    static void pushAll(Context ctx) {
        if (ctx == null) return;
        try {
            Context app = ctx.getApplicationContext();
            AppWidgetManager awm = AppWidgetManager.getInstance(app);
            if (awm == null) return;
            int[] ids = awm.getAppWidgetIds(new ComponentName(app, PlayerWidgetProvider.class));
            if (ids == null || ids.length == 0) {
                Log.d(TAG, "Widget: sin widgets colocados, nada que pintar");
                return;
            }
            render(app, awm, ids);
        } catch (Throwable t) {
            // un launcher raro no debe tumbar la reproducción
            Log.e(TAG, "Widget: fallo en pushAll", t);
        }
    }

    /**
     * Repinta SOLO si cambió algo visible desde la última vez. Pensado para
     * llamarse en CADA update() de la web (uno por segundo con la posición):
     * la comprobación es barata (snapshot + stat del archivo de carátula) y
     * evita un IPC de RemoteViews por tick.
     *
     * CLAVE: es independiente del servicio en primer plano. Si
     * startForegroundService() falla (Android 12+) o el servicio revienta,
     * el widget SEGUIRÁ actualizándose con esta llamada directa del plugin.
     */
    static void pushAllIfChanged(Context ctx) {
        if (ctx == null) return;
        try {
            Context app = ctx.getApplicationContext();
            String sig = visibleSignature(app);
            if (sig.equals(lastPushedSig)) return;   // nada visible cambió
            lastPushedSig = sig;
            pushAll(app);
        } catch (Throwable t) {
            Log.e(TAG, "Widget: fallo en pushAllIfChanged", t);
        }
    }

    /** Firma de lo que el usuario VE en el widget (sin posición). */
    private static String visibleSignature(Context ctx) {
        PlaybackStateStore.Snapshot s = PlaybackStateStore.snapshot(ctx);
        // La carátula vive en disco: si cambia (o aparece/desaparece) hay que
        // repintar aunque el título sea el mismo (p. ej. la web manda primero
        // los metadatos y la carátula llega después).
        long artMod = 0L;
        try {
            File f = new File(ctx.getFilesDir(), ArtUtils.ART_FILE);
            if (f.exists()) artMod = f.lastModified();
        } catch (Exception ignored) { /* sin stat: firma sin carátula */ }
        return s.title + "\u0001" + s.artist + "\u0001" + s.playing + "\u0001"
            + s.hasContent + "\u0001" + artMod;
    }

    private static void render(Context ctx, AppWidgetManager awm, int[] ids) {
        try {
            awm.updateAppWidget(ids, buildViews(ctx));
            Log.d(TAG, "Widget: repintado correcto (" + ids.length + " widgets)");
        } catch (Throwable t) {
            // fallo al repintar: el próximo update() lo reintenta
            Log.e(TAG, "Widget: error al repintar", t);
        }
    }

    /** Construye las RemoteViews del widget desde el almacén. */
    private static RemoteViews buildViews(Context ctx) {
        PlaybackStateStore.Snapshot s = PlaybackStateStore.snapshot(ctx);
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.freeplayer_widget);

        String title = s.title == null || s.title.isEmpty()
            ? ctx.getString(R.string.app_name) : s.title;
        String artist = s.artist == null ? "" : s.artist;
        if (artist.isEmpty() && !s.hasContent) artist = ctx.getString(R.string.fp_widget_idle);

        rv.setTextViewText(R.id.fp_title, title);
        rv.setTextViewText(R.id.fp_artist, artist);

        // Carátula: la guardada en disco, o el icono de la app como placeholder
        Bitmap art = ArtUtils.loadFile(ctx, ArtUtils.ART_FILE, ART_MAX);
        if (art != null) {
            rv.setImageViewBitmap(R.id.fp_art, art);
        } else {
            rv.setImageViewResource(R.id.fp_art, R.mipmap.ic_launcher);
        }

        // Botón central según el estado; se envía "toggle" para evitar carreras
        rv.setImageViewResource(R.id.fp_play,
            s.playing ? R.drawable.fp_ic_pause : R.drawable.fp_ic_play);

        rv.setOnClickPendingIntent(R.id.fp_root, PlaybackService.openAppPending(ctx, REQ_OPEN));
        rv.setOnClickPendingIntent(R.id.fp_prev, buttonPending(ctx, "prev", REQ_PREV));
        rv.setOnClickPendingIntent(R.id.fp_play, buttonPending(ctx, "toggle", REQ_TOGGLE));
        rv.setOnClickPendingIntent(R.id.fp_next, buttonPending(ctx, "next", REQ_NEXT));

        return rv;
    }

    /** PendingIntent de botón del widget → MediaActionReceiver (explícito). */
    private static PendingIntent buttonPending(Context ctx, String action, int reqCode) {
        Intent i = new Intent(ctx, MediaActionReceiver.class);
        i.putExtra(MediaBridgePlugin.EXTRA_ACTION, action);
        return PendingIntent.getBroadcast(ctx, reqCode, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
