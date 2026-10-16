package org.bccsa.luminary.playerlab;

import android.content.pm.ActivityInfo;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The lab's own seam for the Web mode: an Android WebView ignores `screen.orientation.lock`, so a
 * page that goes full-screen asks the activity directly. Native mode turns the screen itself.
 */
@CapacitorPlugin(name = "LabOrientation")
public class LabOrientationPlugin extends Plugin {
    @PluginMethod
    public void lockLandscape(PluginCall call) {
        boolean locked = Boolean.TRUE.equals(call.getBoolean("locked", true));
        getActivity().runOnUiThread(() -> {
            if (locked) {
                getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            } else {
                // A phone lying flat gives no sensor signal to turn it back: ask for portrait, then let go.
                getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                new Handler(Looper.getMainLooper()).postDelayed(
                    () -> getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED), 600);
            }
            call.resolve();
        });
    }
}
