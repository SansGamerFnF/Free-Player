package com.freeplayer.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Volumen multimedia REAL del teléfono.
 *
 * El reproductor tenía un volumen interno (ganancia de Web Audio) que no
 * tenía nada que ver con el del sistema: la app podía marcar 100 % mientras
 * el teléfono estaba al 15 %. Este plugin lee y cambia STREAM_MUSIC y avisa
 * a la web cuando el usuario mueve los botones físicos, para que el control
 * del reproductor y el volumen del sistema vayan siempre iguales.
 */
@CapacitorPlugin(name = "SystemVolume")
public class SystemVolumePlugin extends Plugin {

    private AudioManager am;
    private BroadcastReceiver receiver;
    private int last = -1;

    @Override
    public void load() {
        am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        startWatch();
    }

    @Override
    protected void handleOnDestroy() {
        stopWatch();
        super.handleOnDestroy();
    }

    private void startWatch() {
        if (receiver != null || am == null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                push();
            }
        };
        IntentFilter filter = new IntentFilter("android.media.VOLUME_CHANGED_ACTION");
        filter.addAction("android.media.STREAM_MUTE_CHANGED_ACTION");
        try {
            ContextCompat.registerReceiver(
                getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        } catch (Exception e) {
            try {
                getContext().registerReceiver(receiver, filter);
            } catch (Exception ignored) {
                receiver = null;
            }
        }
        push();
    }

    private void stopWatch() {
        if (receiver == null) return;
        try {
            getContext().unregisterReceiver(receiver);
        } catch (Exception ignored) {
            // ya estaba desregistrado
        }
        receiver = null;
    }

    private int percent() {
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        return Math.round(am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max);
    }

    /** Avisa a la web solo si el porcentaje cambió de verdad. */
    private void push() {
        if (am == null) return;
        int p = percent();
        if (p == last) return;
        last = p;
        JSObject ret = new JSObject();
        ret.put("percent", p);
        notifyListeners("change", ret);
    }

    @PluginMethod
    public void get(PluginCall call) {
        if (am == null) {
            call.reject("AudioManager no disponible");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("percent", percent());
        ret.put("max", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        call.resolve(ret);
    }

    @PluginMethod
    public void set(PluginCall call) {
        Integer pct = call.getInt("percent");
        if (pct == null) {
            call.reject("Falta percent");
            return;
        }
        if (am == null) {
            call.reject("AudioManager no disponible");
            return;
        }
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int value = Math.round(max * Math.max(0, Math.min(100, pct)) / 100f);
        try {
            am.setStreamVolume(AudioManager.STREAM_MUSIC, value, 0);
        } catch (Exception e) {
            call.reject("No se pudo cambiar el volumen");
            return;
        }
        last = -1;
        JSObject ret = new JSObject();
        ret.put("percent", percent());
        call.resolve(ret);
        push();
    }
}
