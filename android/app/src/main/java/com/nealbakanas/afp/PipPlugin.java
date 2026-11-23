package com.nealbakanas.afp;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Rational;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Pop-out (picture-in-picture): the app shrinks to a small window over other apps, a video full screen included, and
// the web page shows just the timer and heart rate in it. `setAuto` makes going home pop it out (while a timer runs).
// Events: "pipChange" { on }.
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {
    private static final Rational ASPECT = new Rational(3, 2);
    private static PipPlugin instance;
    private boolean auto = false;

    @Override
    public void load() {
        instance = this;
    }

    private boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && getActivity().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private PictureInPictureParams params() {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder().setAspectRatio(ASPECT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(auto).setSeamlessResizeEnabled(false);
        return b.build();
    }

    // { supported, pip (in the small window now), resumed (the app full screen and in front) }
    @PluginMethod
    public void status(PluginCall call) {
        Activity a = getActivity();
        JSObject r = new JSObject();
        r.put("supported", supported());
        r.put("pip", Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && a.isInPictureInPictureMode());
        r.put("resumed", getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED));
        call.resolve(r);
    }

    @PluginMethod
    public void enter(PluginCall call) {
        if (!supported()) {
            call.reject("Pop-out isn't available on this phone");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                JSObject r = new JSObject();
                r.put("ok", getActivity().enterPictureInPictureMode(params()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void setAuto(PluginCall call) {
        auto = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (supported()) {
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().setPictureInPictureParams(params());
                } catch (Exception ignored) {
                    // not in a state to take them: the next call will
                }
            });
        }
        call.resolve();
    }

    static void leaving(Activity a) {
        PipPlugin p = instance;
        if (p == null || !p.auto || !p.supported() || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return;
        try {
            a.enterPictureInPictureMode(p.params());
        } catch (Exception ignored) {
            // the system said no: it just goes to the background
        }
    }

    static void changed(boolean on) {
        PipPlugin p = instance;
        if (p == null) return;
        JSObject r = new JSObject();
        r.put("on", on);
        p.notifyListeners("pipChange", r);
    }
}
