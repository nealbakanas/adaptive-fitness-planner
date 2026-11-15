// The Android app's native plugins, for the web code (which has no build step). `npm run native` bundles this into
// vendor/capacitor/native.js; app.js loads that only inside the app (window.Capacitor is native), and it puts the
// plugins on window.AFPNative. The browser version never loads it.
import { Capacitor } from '@capacitor/core';
import { BleClient, numberToUUID } from '@capacitor-community/bluetooth-le';
import { LocalNotifications } from '@capacitor/local-notifications';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { App } from '@capacitor/app';
import { ForegroundService } from '@capawesome-team/capacitor-android-foreground-service';

globalThis.AFPNative = { Capacitor, BleClient, numberToUUID, LocalNotifications, KeepAwake, App, ForegroundService };
