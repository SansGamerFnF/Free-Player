package com.freeplayer.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receiver de los botones de la notificación y del widget.
 *
 * Camino de una acción externa:
 *  1. Si el plugin está cargado (proceso con Activity vivo — lo normal mientras
 *     suena la música, porque el servicio en primer plano mantiene el proceso),
 *     se reenvía directamente a la web con notifyListeners("action", ...).
 *  2. Si no hay plugin (app cerrada y toque en el widget), se arranca
 *     MainActivity con el extra "fp_action": Capacitor entrega ese Intent a
 *     MediaBridgePlugin.handleOnNewIntent() incluso en el arranque en frío, y
 *     el evento queda retenido hasta que la web se suscribe.
 *
 * Nota sobre Android 12+: bloquear el arranque de actividades desde segundo
 * plano es posible, pero un toque en el widget llega con el launcher visible,
 * que es el caso de uso clásico permitido; si aun así se bloqueara, la acción
 * se descarta sin romper nada (el usuario abrirá la app a mano).
 */
public class MediaActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (ctx == null || intent == null) return;

        String action = intent.getStringExtra(MediaBridgePlugin.EXTRA_ACTION);

        // "dismiss" = el usuario descartó la notificación (solo en pausa):
        // se avisa a la web con "stop"; si no hay web, se para el servicio.
        if ("dismiss".equals(action)) {
            if (!MediaBridgePlugin.dispatchExternalAction("stop")) {
                PlaybackService.stopAll(ctx);
            }
            return;
        }

        if (MediaBridgePlugin.dispatchExternalAction(action)) return;

        // No hay plugin cargado: arrancar la app con la acción pendiente.
        Intent i = new Intent(ctx, MainActivity.class);
        i.putExtra(MediaBridgePlugin.EXTRA_ACTION, action);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_CLEAR_TOP
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            ctx.startActivity(i);
        } catch (Exception ignored) {
            // Arranque bloqueado por el sistema: la acción se pierde.
        }
    }
}
