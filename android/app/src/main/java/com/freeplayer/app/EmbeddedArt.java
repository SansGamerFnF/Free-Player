package com.freeplayer.app;

import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Lee la carátula INCORPORADA en el propio archivo de audio (por canción),
 * en lugar de la miniatura compartida por álbum de MediaStore.
 *
 * Formatos soportados (solo se lee la CABECERA, no el archivo completo):
 *  - MP3 / ID3v2: frame APIC (v2.3, tamaños "plain") o PIC (v2.2) y APIC de
 *    v2.4 (tamaños synchsafe); se salta la cabecera extendida si existe.
 *  - MP4 / M4A:   átomos moov → udta → meta → ilst → ©covr → data. Si "moov"
 *    está al FINAL del archivo (habitual), se abre por posición con
 *    FileChannel usando el tamaño del átomo del header (sin leer el mdat).
 *  - FLAC:        bloque de metadatos PICTURE (tipo 6).
 *  - OGG/Vorbis · Opus: base64 "METADATA_BLOCK_PICTURE=" del bloque de
 *    comentarios (opcional; se buscan los primeros ~512 KB del archivo).
 *
 * La imagen se devuelve TAL CUAL (sin recomprimir): quien la reduce es la web.
 * Un archivo sin carátula o con error simplemente devuelve null (el llamante
 * lo omite). Corre en el hilo propio de Capacitor, así que la E/S de disco no
 * bloquea la interfaz.
 */
final class EmbeddedArt {

    private static final String TAG = "FreePlayer";

    private static final int BUF = 64 * 1024;           // BufferedInputStream: 64 KB
    private static final int MAX_ART = 8 * 1024 * 1024; // tope de imagen (8 MB)
    private static final int MAX_TAG = 16 * 1024 * 1024; // tope de tag ID3 (16 MB)
    private static final int OGG_SCAN = 512 * 1024;      // primeros 512 KB en OGG

    /** Imagen incrustada + mime detectado por firma (no por confiar en el tag). */
    static final class Art {
        final byte[] bytes;
        final String mime;

        Art(byte[] bytes, String mime) {
            this.bytes = bytes;
            this.mime = mime;
        }
    }

    private EmbeddedArt() {}

    /**
     * @param pfd descriptor del archivo (content:// de MediaStore); se cierra
     *            al terminar.
     * @return la carátula incrustada o null si no tiene (o hay error).
     */
    static Art read(ParcelFileDescriptor pfd) {
        if (pfd == null) return null;
        BufferedInputStream in = null;
        try {
            FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
            in = new BufferedInputStream(fis, BUF);
            FileChannel ch = fis.getChannel();

            // Identificación por firma de los primeros 12 bytes
            byte[] head = readFully(in, 12);
            if (head == null) return null;

            if (head[0] == 'I' && head[1] == 'D' && head[2] == '3') {
                return readId3(in, head);
            }
            if (head[0] == 'f' && head[1] == 'L' && head[2] == 'a' && head[3] == 'C') {
                return readFlac(in);
            }
            if (head[0] == 'O' && head[1] == 'g' && head[2] == 'g' && head[3] == 'S') {
                return readOgg(in);
            }
            if (head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p') {
                // MP4/M4A: moov puede estar al final → acceso posicional
                return readMp4(ch, pfd.getStatSize());
            }
            // MP3 sin tag ID3 (empieza por sincronismo 0xFF Exx): sin carátula
            return null;
        } catch (Throwable t) {
            Log.d(TAG, "EmbeddedArt: error leyendo carátula incrustada: " + t);
            return null;
        } finally {
            closeQuietly(in); // cierra también el fd compartido con el pfd
        }
    }

    // --------------------------------------------------------
    // MP3 / ID3v2
    // --------------------------------------------------------
    private static Art readId3(InputStream in, byte[] head) throws IOException {
        int major = head[3] & 0xFF;   // 2, 3 o 4
        int flags = head[5] & 0xFF;
        long tagSize = syncsafe(head, 6); // bytes posteriores a la cabecera de 10
        if (major < 2 || major > 4) return null;
        if (tagSize <= 0 || tagSize > MAX_TAG) return null;

        long remaining = tagSize; // cuánto queda por recorrer del tag

        // Cabecera extendida (hay que saltarla para llegar a los frames)
        if ((flags & 0x40) != 0) {
            byte[] eh = readFully(in, 4);
            if (eh == null || remaining < 4) return null;
            remaining -= 4;
            long extSize;
            if (major == 3) {
                extSize = bigEndian(eh, 0, 4);   // v2.3: NO incluye estos 4 bytes
            } else if (major == 4) {
                extSize = syncsafe(eh, 0) - 4;   // v2.4: synchsafe e INCLUYE estos 4
            } else {
                return null;
            }
            if (extSize < 0 || extSize > remaining) return null;
            skipFully(in, extSize);
            remaining -= extSize;
        }

        // Cabecera de frame: 6 bytes en v2.2 (id3+tamaño3) y 10 en v2.3/v2.4
        int hdrLen = (major == 2) ? 6 : 10;
        while (remaining >= hdrLen) {
            byte[] fh = readFully(in, hdrLen);
            if (fh == null) break;
            remaining -= hdrLen;

            // Relleno final (ceros) o id no imprimible: fin del tag
            if ((fh[0] & 0xFF) == 0 || !isFrameIdChar(fh[0])) break;

            String id;
            long size;
            if (major == 2) {
                id = latin1(fh, 0, 3);
                size = bigEndian(fh, 3, 3);
            } else {
                id = latin1(fh, 0, 4);
                size = (major == 4) ? syncsafe(fh, 4) : bigEndian(fh, 4, 4);
            }
            if (size < 0 || size > remaining) break;   // tag corrupto

            if ("APIC".equals(id) || "PIC".equals(id)) {
                if (size > MAX_ART) return null;       // portada gigante: descartada
                byte[] body = readFully(in, (int) size);
                if (body == null) return null;
                return parseApic(body, major);
            }
            skipFully(in, size);
            remaining -= size;
        }
        return null;
    }

    /** Cuerpo del frame APIC/PIC → imagen. No se fía del tipo/mime del tag. */
    private static Art parseApic(byte[] b, int major) {
        if (b == null || b.length < 5) return null;
        int enc = b[0] & 0xFF; // 0=Latin-1, 1=UTF-16(BOM), 2=UTF-16BE, 3=UTF-8
        int i;
        String mime;
        if (major == 2) {
            // PIC: sin byte de tipo; el formato son 3 letras ("JPG", "PNG"…)
            String fmt = latin1(b, 1, 3).trim().toUpperCase(Locale.US);
            mime = "PNG".equals(fmt) ? "image/png" : "image/jpeg";
            i = 4;
        } else {
            // APIC: byte de tipo (ignorado) + MIME ASCII terminado en 0
            int end = indexOf(b, (byte) 0, 2);
            if (end < 0) return null;
            mime = latin1(b, 2, end - 2).trim().toLowerCase(Locale.US);
            i = end + 1;
        }
        // Descripción: hasta 0 (o 00 si la codificación es UTF-16)
        if (enc == 1 || enc == 2) {
            int end = -1;
            for (int k = i; k + 1 < b.length; k += 2) {
                if (b[k] == 0 && b[k + 1] == 0) { end = k + 2; break; }
            }
            i = end;
        } else {
            int end = indexOf(b, (byte) 0, i);
            i = end < 0 ? -1 : end + 1;
        }
        if (i < 0 || i >= b.length) return null;
        int len = b.length - i;
        byte[] img = new byte[len];
        System.arraycopy(b, i, img, 0, len);
        return new Art(img, sniffMime(img, mime));
    }

    // --------------------------------------------------------
    // FLAC
    // --------------------------------------------------------
    private static Art readFlac(InputStream in) throws IOException {
        // "fLaC" ya consumido; siguen bloques: [flags(1) = last|tipo][len(3)]
        while (true) {
            byte[] h = readFully(in, 4);
            if (h == null) return null;
            boolean last = (h[0] & 0x80) != 0;
            int type = h[0] & 0x7F;
            long len = bigEndian(h, 1, 3);
            if (len < 0) return null;

            if (type == 6) { // PICTURE
                if (len > MAX_ART) return null;
                byte[] body = readFully(in, (int) len);
                if (body == null) return null;
                return parsePictureBlock(body);
            }
            skipFully(in, len); // STREAMINFO, padding, VORBIS_COMMENT…
            if (last) return null;
        }
    }

    /**
     * Bloque PICTURE (FLAC): tipo(4) mimeLen(4) mime descLen(4) desc
     * ancho(4) alto(4) profundidad(4) colores(4) datosLen(4) datos.
     * Compartido por FLAC y OGG.
     */
    private static Art parsePictureBlock(byte[] b) {
        if (b == null || b.length < 8) return null;
        try {
            ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.BIG_ENDIAN);
            bb.getInt(); // tipo (3 = portada frontal)
            int mimeLen = bb.getInt();
            if (mimeLen < 0 || mimeLen > 256 || bb.remaining() < mimeLen + 4) return null;
            byte[] mimeB = new byte[mimeLen];
            bb.get(mimeB);
            String mime = new String(mimeB, StandardCharsets.US_ASCII).trim().toLowerCase(Locale.US);
            int descLen = bb.getInt();
            if (descLen < 0 || bb.remaining() < descLen + 20) return null;
            bb.position(bb.position() + descLen);
            bb.getInt(); bb.getInt(); bb.getInt(); bb.getInt(); // ancho, alto, prof, colores
            if (bb.remaining() < 4) return null;
            int dataLen = bb.getInt();
            if (dataLen <= 0 || dataLen > bb.remaining()) dataLen = bb.remaining();
            if (dataLen > MAX_ART) return null;
            byte[] img = new byte[dataLen];
            bb.get(img);
            return new Art(img, sniffMime(img, mime));
        } catch (Throwable t) {
            return null;
        }
    }

    // --------------------------------------------------------
    // MP4 / M4A (acceso posicional: moov puede estar al final)
    // --------------------------------------------------------
    private static Art readMp4(FileChannel ch, long statSize) throws IOException {
        long fsize = statSize > 0 ? statSize : Long.MAX_VALUE / 4;
        return findCovr(ch, 0, fsize, 0);
    }

    /** Busca recursivamente (profundidad limitada) moov/udta/meta/ilst → ©covr. */
    private static Art findCovr(FileChannel ch, long start, long end, int depth) throws IOException {
        if (depth > 6 || start < 0 || end <= start) return null;
        long pos = start;
        byte[] hdr = new byte[16];
        while (pos + 8 <= end) {
            if (readAt(ch, hdr, pos, 8) < 8) return null;
            long size = bigEndian(hdr, 0, 4);
            String type = latin1(hdr, 4, 4);
            long headerLen = 8;
            if (size == 1) {                     // tamaño en 64 bits (largesize)
                if (readAt(ch, hdr, pos + 8, 8) < 8) return null;
                size = ByteBuffer.wrap(hdr, 0, 8).order(ByteOrder.BIG_ENDIAN).getLong();
                headerLen = 16;
            } else if (size == 0) {              // átomo hasta el final del archivo
                size = end - pos;
            }
            if (size < headerLen || pos + size > end) return null; // corrupto: no se avanza

            long bodyStart = pos + headerLen;
            long bodyEnd = pos + size;

            if ("moov".equals(type) || "udta".equals(type) || "ilst".equals(type)) {
                Art a = findCovr(ch, bodyStart, bodyEnd, depth + 1);
                if (a != null) return a;
            } else if ("meta".equals(type)) {
                Art a = findCovr(ch, bodyStart + 4, bodyEnd, depth + 1); // meta = FullBox
                if (a != null) return a;
            } else if ("covr".equals(type)) {
                Art a = readCovrData(ch, bodyStart, bodyEnd);
                if (a != null) return a;
            }
            pos = bodyEnd;
        }
        return null;
    }

    /** ©covr contiene un átomo "data": [size]["data"][type|flags(4)][locale(4)][imagen]. */
    private static Art readCovrData(FileChannel ch, long start, long end) throws IOException {
        long pos = start;
        byte[] hdr = new byte[8];
        while (pos + 8 <= end) {
            if (readAt(ch, hdr, pos, 8) < 8) return null;
            long size = bigEndian(hdr, 0, 4);
            String type = latin1(hdr, 4, 4);
            if (size < 8 || pos + size > end) return null;
            if ("data".equals(type)) {
                long dataStart = pos + 16;       // salta type/flags(4) + locale(4)
                long dataLen = size - 16;
                if (dataLen <= 0 || dataLen > MAX_ART) return null;
                byte[] img = new byte[(int) dataLen];
                if (readAt(ch, img, dataStart, (int) dataLen) < dataLen) return null;
                return new Art(img, sniffMime(img, null));
            }
            pos += size;
        }
        return null;
    }

    // --------------------------------------------------------
    // OGG / Opus (opcional): METADATA_BLOCK_PICTURE= en los comentarios
    // --------------------------------------------------------
    private static Art readOgg(InputStream in) throws IOException {
        // Los comentarios Vorbis/Opus viven en los primeros paquetes: se leen
        // los primeros OGG_SCAN bytes y se busca el marcador en ellos.
        byte[] buf = new byte[OGG_SCAN];
        int total = 0;
        while (total < buf.length) {
            int r = in.read(buf, total, buf.length - total);
            if (r < 0) break;
            total += r;
        }
        byte[] mark = "METADATA_BLOCK_PICTURE=".getBytes(StandardCharsets.US_ASCII);
        int idx = indexOfBytes(buf, total, mark);
        if (idx < 0) return null;

        // Recoge el base64 siguiente (hasta el límite de tamaño de imagen)
        StringBuilder b64 = new StringBuilder();
        int maxB64 = MAX_ART * 2;
        int i = idx + mark.length;
        while (i < total && b64.length() < maxB64 && isB64(buf[i])) {
            b64.append((char) buf[i]);
            i++;
        }
        if (b64.length() < 32) return null;
        byte[] block;
        try {
            block = Base64.decode(b64.toString(), Base64.DEFAULT);
        } catch (Exception e) {
            return null;
        }
        return parsePictureBlock(block); // el base64 es un bloque PICTURE de FLAC
    }

    // --------------------------------------------------------
    // Utilidades de E/S y binarias
    // --------------------------------------------------------
    /** Lee exactamente n bytes; devuelve null si el archivo acaba antes. */
    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(b, off, n - off);
            if (r < 0) break;
            off += r;
        }
        return off == n ? b : null;
    }

    /** Salta n bytes (in.skip no garantiza saltar todo de una vez). */
    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long s = in.skip(n);
            if (s <= 0) {
                if (in.read() < 0) throw new EOFException();
                s = 1;
            }
            n -= s;
        }
    }

    /** Lectura posicional en el canal: no mueve el puntero (para MP4). */
    private static int readAt(FileChannel ch, byte[] dst, long pos, int len) throws IOException {
        ByteBuffer bb = ByteBuffer.wrap(dst, 0, len);
        int total = 0;
        while (bb.hasRemaining()) {
            int r = ch.read(bb, pos + total);
            if (r <= 0) break;
            total += r;
        }
        return total;
    }

    private static long bigEndian(byte[] b, int off, int len) {
        long v = 0;
        for (int i = 0; i < len; i++) v = (v << 8) | (b[off + i] & 0xFF);
        return v;
    }

    private static long syncsafe(byte[] b, int off) {
        return ((b[off] & 0x7F) << 21) | ((b[off + 1] & 0x7F) << 14)
            | ((b[off + 2] & 0x7F) << 7) | (b[off + 3] & 0x7F);
    }

    private static String latin1(byte[] b, int off, int len) {
        if (len <= 0) return "";
        return new String(b, off, len, StandardCharsets.ISO_8859_1);
    }

    private static boolean isFrameIdChar(byte c) {
        return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    }

    private static int indexOf(byte[] b, byte v, int from) {
        for (int i = from; i < b.length; i++) if (b[i] == v) return i;
        return -1;
    }

    private static int indexOfBytes(byte[] hay, int hayLen, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hayLen; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    private static boolean isB64(byte c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=';
    }

    /**
     * Mime por FIRMA de la imagen (JPEG/PNG/GIF/WEBP); solo recurre al valor
     * del tag si la firma no la identifica. Los tags suelen mentir.
     */
    private static String sniffMime(byte[] b, String fallback) {
        if (b != null && b.length >= 4) {
            int b0 = b[0] & 0xFF, b1 = b[1] & 0xFF;
            if (b0 == 0xFF && b1 == 0xD8) return "image/jpeg";
            if (b0 == 0x89 && b1 == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
            if (b0 == 'G' && b1 == 'I' && b[2] == 'F') return "image/gif";
            if (b0 == 'R' && b1 == 'I' && b[2] == 'F' && b[3] == 'F'
                && b.length >= 12 && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
                return "image/webp";
            }
        }
        if (fallback != null && fallback.startsWith("image/")) return fallback;
        return "image/jpeg";
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Exception ignored) { /* ya cerrado */ }
    }
}
