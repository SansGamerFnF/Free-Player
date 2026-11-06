package com.freeplayer.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Almacén del último estado de reproducción conocido.
 *
 * Vive en memoria (el servicio, el plugin y el widget comparten proceso) y se
 * persiste en SharedPreferences (sin el base64 de la carátula, que es grande;
 * la carátula se guarda como archivo en disco por ArtUtils) para poder
 * repintar el widget cuando el launcher lo pida tras reiniciar el proceso.
 */
final class PlaybackStateStore {

    private static final String PREFS = "fp_media_store";

    private static final String K_TITLE = "title";
    private static final String K_ARTIST = "artist";
    private static final String K_ALBUM = "album";
    private static final String K_DURATION = "duration";
    private static final String K_POSITION = "position";
    private static final String K_PLAYING = "playing";
    private static final String K_CONTENT = "content";

    private static boolean loaded = false;

    private static String title = "";
    private static String artist = "";
    private static String album = "";
    private static long duration = 0;
    private static long position = 0;
    private static boolean playing = false;
    private static boolean hasContent = false;
    /** Base64 de la carátula; solo en memoria (puede pesar decenas de KB). */
    private static String artworkB64 = null;

    private PlaybackStateStore() {}

    /**
     * Guarda el estado que llega de la web. Llamar desde el hilo principal.
     *
     * @return true si la carátula cambió (la web envía artwork=null cuando no
     *         hay novedad, así que el llamante solo debe re-guardar el archivo
     *         del widget cuando esto devuelve true).
     */
    static synchronized boolean set(Context ctx, String t, String a, String al,
                                    long dur, long pos, boolean pl, String art) {
        ensureLoaded(ctx);

        boolean metaChanged = !equalsNull(title, t) || !equalsNull(artist, a)
            || !equalsNull(album, al) || playing != pl || hasContent == false;
        boolean artChanged = false;

        // hasContent=true tras el primer update: el widget deja de mostrar el
        // placeholder "Sin reproducción" aunque el servicio no haya arrancado.
        title = t == null ? "" : t;
        artist = a == null ? "" : a;
        album = al == null ? "" : al;
        duration = Math.max(0L, dur);
        position = Math.max(0L, pos);
        playing = pl;
        hasContent = true;

        // null → se mantiene la carátula anterior; "" → se limpia explícitamente
        if (art != null) {
            String clean = art.trim();
            if (clean.isEmpty()) {
                if (artworkB64 != null) {
                    artworkB64 = null;
                    artChanged = true;
                    metaChanged = true;
                }
            } else if (!clean.equals(artworkB64)) {
                artworkB64 = clean;
                artChanged = true;
                metaChanged = true;
            }
        }

        // La posición cambia a cada segundo: no merece escritura en disco
        if (metaChanged) persist(ctx);
        return artChanged;
    }

    /** Copia coherente del estado para pintar notificación/sesión/widget. */
    static synchronized Snapshot snapshot(Context ctx) {
        ensureLoaded(ctx);
        return new Snapshot(title, artist, album, duration, position,
            playing, hasContent, artworkB64);
    }

    /** Último base64 de carátula recibido (null si no hay o aún no se cargó). */
    static synchronized String artworkB64() {
        return artworkB64;
    }

    /** Borra todo el estado (al ocultar el reproductor). */
    static synchronized void clear(Context ctx) {
        title = "";
        artist = "";
        album = "";
        duration = 0;
        position = 0;
        playing = false;
        hasContent = false;
        artworkB64 = null;
        loaded = true;

        try {
            prefs(ctx).edit().clear().apply();
        } catch (Exception ignored) { /* sin preferencias: no pasa nada */ }
        ArtUtils.deleteArtFile(ctx);
    }

    // --------------------------------------------------------
    // Internos
    // --------------------------------------------------------
    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void ensureLoaded(Context ctx) {
        if (loaded) return;
        loaded = true;
        try {
            SharedPreferences p = prefs(ctx);
            title = p.getString(K_TITLE, "");
            artist = p.getString(K_ARTIST, "");
            album = p.getString(K_ALBUM, "");
            duration = p.getLong(K_DURATION, 0L);
            position = p.getLong(K_POSITION, 0L);
            playing = p.getBoolean(K_PLAYING, false);
            hasContent = p.getBoolean(K_CONTENT, false);
        } catch (Exception ignored) {
            // preferencias ilegibles: se arranca de cero
        }
    }

    private static void persist(Context ctx) {
        try {
            prefs(ctx).edit()
                .putString(K_TITLE, title)
                .putString(K_ARTIST, artist)
                .putString(K_ALBUM, album)
                .putLong(K_DURATION, duration)
                .putLong(K_POSITION, position)
                .putBoolean(K_PLAYING, playing)
                .putBoolean(K_CONTENT, hasContent)
                .apply();
        } catch (Exception ignored) {
            // sin persistencia el widget solo funcionará con el proceso vivo
        }
    }

    private static boolean equalsNull(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }

    // --------------------------------------------------------
    // Snapshot inmutable
    // --------------------------------------------------------
    static final class Snapshot {
        final String title;
        final String artist;
        final String album;
        final long duration;
        final long position;
        final boolean playing;
        final boolean hasContent;
        /** Puede ser null (la carátula puede estar solo en el archivo interno). */
        final String artworkB64;

        Snapshot(String title, String artist, String album, long duration,
                 long position, boolean playing, boolean hasContent, String artworkB64) {
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.duration = duration;
            this.position = position;
            this.playing = playing;
            this.hasContent = hasContent;
            this.artworkB64 = artworkB64;
        }

        /** Firma de lo que se VE (notificación, sesión y widget); sin posición. */
        String signature() {
            return title + "\u0001" + artist + "\u0001" + album + "\u0001"
                + playing + "\u0001" + hasContent + "\u0001"
                + (artworkB64 == null ? -1 : artworkB64.hashCode());
        }
    }
}
