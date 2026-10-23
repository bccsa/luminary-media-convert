package org.bccsa.luminary.playerlab;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LabOrientationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
