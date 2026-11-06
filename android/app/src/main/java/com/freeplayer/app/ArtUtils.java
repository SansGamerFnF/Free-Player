package com.freeplayer.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Utilidades para la carátula (artwork) que llega de la web en base64.
 *
 * La web envía un JPEG en base64 (sin prefijo "data:"). Lo decodificamos ya
 * reducido (inSampleSize) para no tumbar a la app ni al launcher del escritorio,
 * y lo guardamos también en almacenamiento interno para que el widget pueda
 * repintarse aunque el proceso se haya reiniciado.
 */
final class ArtUtils {

    /** Nombre del archivo interno con la última carátula. */
    static final String ART_FILE = "fp_artwork.jpg";

    private static final int ART_QUALITY = 85; // JPEG

    private ArtUtils() {}

    /** Decodifica base64 (JPEG) reduciendo el lado máximo a maxSide px. */
    static Bitmap decodeBase64(String b64, int maxSide) {
        if (b64 == null || b64.isEmpty()) return null;
        try {
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            return decodeBytes(bytes, maxSide);
        } catch (Exception e) {
            return null;   // base64 roto: no es un error fatal
        }
    }

    /** Decodifica un JPEG ya reducido (inSampleSize potencia de 2). */
    private static Bitmap decodeBytes(byte[] bytes, int maxSide) {
        if (bytes == null || bytes.length == 0) return null;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);

            int sample = 1;
            int biggest = Math.max(bounds.outWidth, bounds.outHeight);
            while (biggest / (sample * 2) >= maxSide) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = Math.max(1, sample);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
        } catch (Exception e) {
            return null;
        }
    }

    /** Guarda la carátula en el almacenamiento interno (para el widget). */
    static void saveJpeg(Context ctx, Bitmap bmp, String name) {
        if (ctx == null || bmp == null) return;
        FileOutputStream fos = null;
        try {
            File f = new File(ctx.getFilesDir(), name);
            fos = new FileOutputStream(f);
            bmp.compress(Bitmap.CompressFormat.JPEG, ART_QUALITY, fos);
        } catch (Exception ignored) {
            // sin espacio o error de E/S: el widget usará el placeholder
        } finally {
            if (fos != null) {
                try { fos.close(); } catch (Exception ignored) { /* ya cerrado */ }
            }
        }
    }

    /** Lee la carátula guardada reduciéndola a maxSide px (null si no existe). */
    static Bitmap loadFile(Context ctx, String name, int maxSide) {
        if (ctx == null) return null;
        try {
            File f = new File(ctx.getFilesDir(), name);
            if (!f.exists()) return null;

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), bounds);

            int sample = 1;
            int biggest = Math.max(bounds.outWidth, bounds.outHeight);
            while (biggest / (sample * 2) >= maxSide) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = Math.max(1, sample);
            return BitmapFactory.decodeFile(f.getAbsolutePath(), opts);
        } catch (Exception e) {
            return null;
        }
    }

    /** Borra la carátula guardada (al ocultar el reproductor). */
    static void deleteArtFile(Context ctx) {
        if (ctx == null) return;
        try {
            File f = new File(ctx.getFilesDir(), ART_FILE);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {
            // no se pudo borrar: no es importante
        }
    }
}
