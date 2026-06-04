package dev.forgeagent.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class ConnectionBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        ConnectionStore store = new ConnectionStore(context);
        if (!store.hasAnyToken()) return;
        Intent serviceIntent = new Intent(context, ConnectionMonitorService.class);
        context.startForegroundService(serviceIntent);
    }
}
