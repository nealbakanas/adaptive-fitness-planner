package com.nealbakanas.afp;

import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PipPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Going home (Android 11 and older; 12+ pops out by itself when asked to).
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        PipPlugin.leaving(this);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean on, Configuration config) {
        super.onPictureInPictureModeChanged(on, config);
        PipPlugin.changed(on);
    }
}
