package com.freeplayer.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // El plugin de escaneo de música se registra antes de arrancar.
        registerPlugin(AudioScannerPlugin.class);
        // Puente de reproducción: notificación en primer plano, MediaSession
        // (lockscreen/bluetooth) y widget de la pantalla de inicio.
        registerPlugin(MediaBridgePlugin.class);
        // Volumen multimedia real (STREAM_MUSIC), sincronizado con la web.
        registerPlugin(SystemVolumePlugin.class);
        super.onCreate(savedInstanceState);
        // Si la activity se arrancó con un extra "fp_action" (botón del widget
        // con la app cerrada), Capacitor lo entrega al plugin mediante
        // handleOnNewIntent() al construir el puente: no hace falta nada más.
    }
}
