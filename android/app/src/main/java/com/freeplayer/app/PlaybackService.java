package com.freeplayer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Servicio en primer plano (foreground service tipo "mediaPlayback") que:
 *
 *  - mantiene vivo el proceso mientras la web reproduce con Web Audio;
 *  - publica la notificación tipo reproductor (canal "freeplayer.playback",
 *    IMPORTANCE_LOW, Notification.MediaStyle con token de la MediaSession);
 *  - mantiene una MediaSession para los controles del lockscreen, el panel de
 *    rápido acceso de Android 10+ y bluetooth (AVRCP);
 *  - pide/abandona el foco de audio y un wake lock parcial mientras suena.
 *
 * Toda la reproducción real sigue viviendo en la web: este servicio solo
 * conserva el proceso y traduce los controles del sistema en el evento
 * "action" para que la web decida qué hacer (ver MediaBridgePlugin).
 *
 * Todos sus métodos públicos/estáticos se llaman desde el hilo principal.
 */
public class PlaybackService extends Service {

    static final String CHANNEL_ID = "freeplayer.playback";
    private static final String TAG = "FreePlayer"; // logcat: `adb logcat -s FreePlayer`
    private static final int NOTIF_ID = 0x4650; // "FP"

    private static final int ART_NOTIF_MAX = 320;       // px del icono grande
    private static final long STATE_MIN_INTERVAL = 500; // ms entre posiciones enviadas

    // Referencia estática al servicio vivo: el plugin y los receivers comparten
    // proceso, así que pueden repintar o parar sin binder ni intents.
    private static volatile PlaybackService sSelf;

    // La MediaSession también es estática: así se puede soltar aunque el
    // servicio ya hubiera muerto (rutas de parada redundantes).
    private static volatile MediaSession sSession;

    private NotificationManager nm;
    private PowerManager pm;
    private PowerManager.WakeLock wakeLock;

    private String lastSig;           // firma de metadatos ya publicados
    private long lastStateAt;         // ms del último setPlaybackState con posición
    private boolean notified = false; // notificación ya publicada

    private Bitmap artBmp;            // carátula en memoria (notificación/sesión)
    private String artB64Applied;     // último base64 ya decodificado a artBmp

    // --------------------------------------------------------
    // Ciclo de vida
    // --------------------------------------------------------
    @Override
    public void onCreate() {
        super.onCreate();
        sSelf = this;
        nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Acabamos de recibir startForegroundService: hay que entrar en primer
        // plano YA (la ley de Android es <5 s), reconstruyendo desde el almacén.
        // Si algo revienta, se garantiza igualmente startForeground con una
        // notificación mínima: si no, el sistema MATA la app entera (y con ella
        // la reproducción de la web) por no haber entrado en primer plano.
        try {
            applyState(true);
        } catch (Throwable t) {
            Log.e(TAG, "onStartCommand: applyState falló; se usa notificación mínima", t);
            try {
                if (!notified) {
                    startForegroundCompat(minimalNotification());
                    notified = true;
                }
            } catch (Throwable ignored) { /* imposible entrar en primer plano */ }
        }

        // NOT_STICKY a propósito: si el sistema mata el proceso, el audio de la
        // web (que vive en ese mismo proceso) también moriría, así que no tiene
        // sentido resucitar un servicio sin reproducción ni notificación.
        return START_NOT_STICKY;
    }

    /** Notificación de emergencia para entrar en primer plano sin fallos. */
    private Notification minimalNotification() {
        Notification.Builder nb;
        if (Build.VERSION.SDK_INT >= 26) {
            nb = new Notification.Builder(this, CHANNEL_ID);
        } else {
            @SuppressWarnings("deprecation")
            Notification.Builder legacy = new Notification.Builder(this);
            nb = legacy;
        }
        return nb.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.app_name))
            .setPriority(Notification.PRIORITY_LOW)
            .build();
    }

    @Override
    public void onDestroy() {
        if (sSelf == this) sSelf = null;
        releaseSession();
        releaseWake();
        try {
            stopForeground(true); // por si nadie canceló la notificación
        } catch (Exception ignored) { /* ya detenido */ }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // no es un servicio enlazable
    }

    // --------------------------------------------------------
    // Puntos de entrada estáticos (hilo principal)
    // --------------------------------------------------------

    /**
     * Refresca a partir del almacén. Si el servicio no está vivo lo arranca
     * (solo la primera vez; las llamadas siguientes repintan en el sitio).
     */
    static void requestUpdate(Context ctx) {
        PlaybackService svc = sSelf;
        if (svc != null) {
            svc.applyState(false);
            return;
        }
        Intent i = new Intent(ctx.getApplicationContext(), PlaybackService.class);
        i.putExtra("cmd", "update");
        try {
            Context app = ctx.getApplicationContext();
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i);
            else app.startService(i);
            Log.d(TAG, "requestUpdate: servicio arrancado con startForegroundService");
        } catch (Exception e) {
            // Android 12+ prohíbe arrancar servicios en primer plano desde
            // segundo plano; solo puede pasar si la web llama update() con la
            // app oculta y el servicio había muerto (caso raro y tolerable).
            Log.w(TAG, "requestUpdate: startForegroundService bloqueado, se intenta startService", e);
            try {
                ctx.getApplicationContext().startService(i);
            } catch (Exception e2) {
                // imposible: notificación/sesión caídas, pero el widget NO
                // depende de esto (se repinta desde MediaBridgePlugin.update()).
                Log.w(TAG, "requestUpdate: servicio no arrancable (se reintenta en el próximo update)", e2);
            }
        }
    }

    /**
     * Parada total: notificación fuera, servicio detenido, sesión y foco
     * liberados, almacén limpio y widget en su estado de reposo.
     */
    static void stopAll(Context ctx) {
        Log.d(TAG, "stopAll: parada completa (notificación, servicio, sesión, widget)");
        Context app = ctx.getApplicationContext();
        PlaybackService svc = sSelf;
        if (svc != null) {
            svc.stopEverything();
        } else {
            // El servicio no está vivo: limpiamos lo que pueda quedar suelto.
            try {
                NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(NOTIF_ID);
            } catch (Exception ignored) { /* sin servicio de notificaciones */ }
            releaseSession();
        }
        PlaybackStateStore.clear(app);
        PlayerWidgetProvider.pushAll(app);
    }

    // --------------------------------------------------------
    // Repintado completo
    // --------------------------------------------------------

    /**
     * Reconstruye notificación, sesión y widget a partir del almacén.
     *
     * @param asForeground true solo desde onStartCommand: en ese caso hay que
     *                     llamar a startForeground con la notificación.
     */
    private void applyState(boolean asForeground) {
        Context app = getApplicationContext();
        PlaybackStateStore.Snapshot s = PlaybackStateStore.snapshot(app);

        // Wake lock según el estado (la pausa lo suelta). El foco de audio lo
        // gestiona el <audio> del WebView: si el servicio también lo pidiera,
        // se lo quitaría a Chromium y la canción se pausaría al primer play.
        try {
            if (s.playing) acquireWake();
            else releaseWake();
        } catch (Throwable t) {
            Log.e(TAG, "applyState: fallo en wake lock", t);
        }

        ensureSession();

        // La firma agrupa todo lo visible (sin posición): si no cambia, no se
        // vuelve a publicar la notificación ni a tocar el widget.
        String sig = s.signature();
        boolean metaChanged = !sig.equals(lastSig);
        lastSig = sig;

        Bitmap art = artBitmap();

        // La posición se envía a la sesión siempre (barra de lockscreen y
        // bluetooth), con una frecuencia mínima para no saturar el sistema.
        long now = System.currentTimeMillis();
        if (metaChanged || now - lastStateAt >= STATE_MIN_INTERVAL) {
            updateSessionState(s);
            lastStateAt = now;
        }
        if (metaChanged) updateSessionMetadata(s, art);

        // Notificación: bloque aislado para que un fallo aquí (build/permisos)
        // no impida repintar el widget ni mate el servicio recién arrancado.
        try {
            Notification n = buildNotification(s, art);
            if (asForeground) {
                startForegroundCompat(n);
                notified = true;
            } else if (metaChanged || !notified) {
                // Solo se re-publica cuando cambia algo visible; la posición vive
                // en la MediaSession, no en la notificación (MediaStyle no dibuja
                // progreso), así que "update()" por segundo no genera IPC.
                notify(n);
            }
        } catch (Throwable t) {
            Log.e(TAG, "applyState: fallo construyendo/publicando la notificación", t);
            if (asForeground && !notified) {
                // Se garantiza startForeground aunque falle la notificación completa
                try {
                    startForegroundCompat(minimalNotification());
                    notified = true;
                } catch (Throwable ignored) { /* ya en primer plano o imposible */ }
            }
        }

        // Widget: comprobación barata (solo repinta si cambió algo visible).
        // Refuerzo del repintado directo que ya hace MediaBridgePlugin.update().
        try {
            PlayerWidgetProvider.pushAllIfChanged(app);
        } catch (Throwable t) {
            Log.e(TAG, "applyState: fallo repintando el widget", t);
        }
    }

    private void notify(Notification n) {
        try {
            nm.notify(NOTIF_ID, n);
            notified = true;
        } catch (Exception e) {
            // sin permiso de notificaciones la notificación no se muestra,
            // pero el servicio en primer plano sigue funcionando
            Log.w(TAG, "notify: sin permiso de notificaciones (POST_NOTIFICATIONS)", e);
        }
    }

    private void startForegroundCompat(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                // Android 14 exige indicar el tipo declarado en el manifiesto
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            // fallo al entrar en primer plano: la web sigue con la app abierta
            Log.e(TAG, "startForegroundCompat: no se pudo entrar en primer plano", e);
        }
    }

    private void stopEverything() {
        try {
            nm.cancel(NOTIF_ID);
        } catch (Exception ignored) { /* sin notificaciones */ }
        try {
            stopForeground(true);
            stopSelf();
        } catch (Exception ignored) { /* ya detenido */ }
        releaseSession();
        releaseWake();
    }

    // --------------------------------------------------------
    // Notificación
    // --------------------------------------------------------
    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return; // los canales no existen antes de API 26
        try {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, getString(R.string.fp_channel_name), NotificationManager.IMPORTANCE_LOW);
            ch.setSound(null, null);       // IMPORTANCE_LOW + sin sonido
            ch.enableVibration(false);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } catch (Exception ignored) { /* canal ya creado */ }
    }

    private Notification buildNotification(PlaybackStateStore.Snapshot s, Bitmap art) {
        // Tocar la notificación abre la app
        Notification.Builder nb;
        if (Build.VERSION.SDK_INT >= 26) {
            nb = new Notification.Builder(this, CHANNEL_ID);
        } else {
            @SuppressWarnings("deprecation")
            Notification.Builder legacy = new Notification.Builder(this);
            nb = legacy;
        }

        nb.setSmallIcon(s.playing
                ? android.R.drawable.ic_media_play
                : android.R.drawable.ic_media_pause)
            .setContentTitle(s.title.isEmpty() ? getString(R.string.app_name) : s.title)
            .setContentText(s.artist)
            .setContentIntent(openAppPending(100))
            .setContentInfo(s.album)
            .setDeleteIntent(dismissPending())
            .setOngoing(s.playing)     // mientras suena no se puede descartar
            .setOnlyAlertOnce(true)    // sin alertas repetidas al mover la posición
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC) // visible en el lockscreen
            .setCategory(Notification.CATEGORY_TRANSPORT);

        if (art != null && !art.isRecycled()) nb.setLargeIcon(art);

        // Botones: anterior / reproducir-pausar (según estado) / siguiente.
        // Se emite "toggle" en el central para que la web decida con su estado
        // real (evita carreras si el toque llega justo al cambiar de pista).
        nb.addAction(action(android.R.drawable.ic_media_previous, "Anterior", "prev", 101));
        nb.addAction(action(
            s.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            s.playing ? "Pausar" : "Reproducir", "toggle", 102));
        nb.addAction(action(android.R.drawable.ic_media_next, "Siguiente", "next", 103));

        Notification.MediaStyle style = new Notification.MediaStyle()
            .setShowActionsInCompactView(0, 1, 2);
        MediaSession sess = sSession;
        if (sess != null) style.setMediaSession(sess.getSessionToken());
        nb.setStyle(style);

        return nb.build();
    }

    /** Acción de notificación (icono + título) → MediaActionReceiver. */
    private Notification.Action action(int icon, String title, String action, int reqCode) {
        Intent i = new Intent(this, MediaActionReceiver.class);
        i.putExtra(MediaBridgePlugin.EXTRA_ACTION, action);
        PendingIntent pi = PendingIntent.getBroadcast(this, reqCode, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(icon, title, pi).build();
    }

    /** El usuario descartó la notificación (solo posible estando en pausa). */
    private PendingIntent dismissPending() {
        Intent i = new Intent(this, MediaActionReceiver.class);
        i.putExtra(MediaBridgePlugin.EXTRA_ACTION, "dismiss");
        return PendingIntent.getBroadcast(this, 104, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Abrir la app (contenido de la notificación y botón del widget). */
    static PendingIntent openAppPending(Context ctx, int reqCode) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, reqCode, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openAppPending(int reqCode) {
        return openAppPending(this, reqCode);
    }

    // --------------------------------------------------------
    // MediaSession (lockscreen, controles rápidos, bluetooth)
    // --------------------------------------------------------
    private void ensureSession() {
        if (sSession != null) return;
        try {
            MediaSession sess = new MediaSession(this, "FreePlayer");
            sess.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            // Tocar el reproductor del lockscreen abre la app
            sess.setSessionActivity(openAppPending(105));
            // Los controles del sistema llegan aquí y se traducen al evento
            // "action" de la web (el nativo no toca el audio).
            sess.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() { MediaBridgePlugin.dispatchExternalAction("play"); }

                @Override
                public void onPause() { MediaBridgePlugin.dispatchExternalAction("pause"); }

                @Override
                public void onSkipToNext() { MediaBridgePlugin.dispatchExternalAction("next"); }

                @Override
                public void onSkipToPrevious() { MediaBridgePlugin.dispatchExternalAction("prev"); }

                @Override
                public void onStop() { MediaBridgePlugin.dispatchExternalAction("stop"); }

                @Override
                public void onSeekTo(long pos) {
                    // Mueve la barra de la notificación / lockscreen.
                    MediaBridgePlugin.dispatchSeek(pos);
                    // Refleja el punto nuevo al instante: si no, la barra
                    // volvería a la posición anterior hasta el siguiente tick.
                    MediaSession s = sSession;
                    if (s == null) return;
                    try {
                        boolean playing = PlaybackStateStore
                            .snapshot(getApplicationContext()).playing;
                        s.setPlaybackState(new PlaybackState.Builder()
                            .setActions(playbackActions())
                            .setState(playing ? PlaybackState.STATE_PLAYING
                                : PlaybackState.STATE_PAUSED, Math.max(0L, pos), 1f)
                            .build());
                    } catch (Exception ignored) { /* estado no aplicable */ }
                    lastStateAt = System.currentTimeMillis();
                }
            });
            sess.setActive(true);
            sSession = sess;
        } catch (Exception ignored) {
            // sin sesión los controles del sistema no aparecen, pero la app va
        }
    }

    private void updateSessionMetadata(PlaybackStateStore.Snapshot s, Bitmap art) {
        MediaSession sess = sSession;
        if (sess == null) return;
        try {
            MediaMetadata md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.duration)
                .build();
            if (art != null && !art.isRecycled()) {
                md = new MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                    .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, s.duration)
                    .putBitmap(MediaMetadata.METADATA_KEY_ART, art)
                    .build();
            }
            sess.setMetadata(md);
        } catch (Exception ignored) { /* metadatos no aplicables */ }
    }

    private void updateSessionState(PlaybackStateStore.Snapshot s) {
        MediaSession sess = sSession;
        if (sess == null) return;
        try {
            int state = s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            sess.setPlaybackState(new PlaybackState.Builder()
                .setActions(playbackActions())
                .setState(state, s.position, 1f)
                .build());
        } catch (Exception ignored) { /* estado no aplicable */ }
    }

    private static long playbackActions() {
        return PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_STOP
            | PlaybackState.ACTION_SEEK_TO;
    }

    private static void releaseSession() {
        MediaSession sess = sSession;
        sSession = null;
        if (sess == null) return;
        try {
            sess.setActive(false);
            sess.release();
        } catch (Exception ignored) { /* ya liberada */ }
    }

    // --------------------------------------------------------
    // Wake lock (mantener la CPU despierta mientras suena el WebView)
    // --------------------------------------------------------
    private void acquireWake() {
        try {
            if (pm == null) return;
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "freeplayer:playback");
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) {
                wakeLock.acquire();
                Log.d(TAG, "Wake lock parcial adquirido (playing=true)");
            }
        } catch (Exception e) { /* sin wake lock: puede fallar en pantallas apagadas */
            Log.w(TAG, "acquireWake: no se pudo adquirir el wake lock", e);
        }
    }

    private void releaseWake() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.d(TAG, "Wake lock liberado");
            }
        } catch (Exception ignored) { /* ya liberado */ }
    }

    // --------------------------------------------------------
    // Carátula
    // --------------------------------------------------------

    /**
     * Devuelve la carátula en memoria para la notificación y la sesión.
     * Solo decodifica el base64 cuando cambia; si no hay base64 (p. ej. proceso
     * reiniciado) usa el archivo guardado para el widget.
     */
    private Bitmap artBitmap() {
        String b64 = PlaybackStateStore.artworkB64();
        if (b64 != null && !b64.equals(artB64Applied)) {
            Bitmap decoded = ArtUtils.decodeBase64(b64, ART_NOTIF_MAX);
            if (decoded != null) {
                if (artBmp != null && !artBmp.isRecycled()) artBmp.recycle();
                artBmp = decoded;
                // Se guarda en disco para repintar el widget tras reinicios
                ArtUtils.saveJpeg(this, decoded, ArtUtils.ART_FILE);
            }
            artB64Applied = b64;
        } else if (artBmp == null) {
            artBmp = ArtUtils.loadFile(this, ArtUtils.ART_FILE, ART_NOTIF_MAX);
        }
        return (artBmp != null && !artBmp.isRecycled()) ? artBmp : null;
    }
}
