package dev.opensesame.authenticator

import android.app.Application
import org.multipaz.context.initializeApplication

class OpenSesameApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        initializeApplication(applicationContext)
    }
}
