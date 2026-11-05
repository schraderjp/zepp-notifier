// Build-time defaults, so a reinstall does not mean retyping the relay address
// on a 390 px screen with a phone keyboard.
//
// The value is only a FALLBACK: anything set in the phone-side settings page wins
// (settingsStorage is the one store the Side Service can read, and it survives
// reinstalls of the watch app). Empty string in settings means "use this".
//
// Keep this file free of runtime imports so page, service and side can share it.

// This machine's LAN address; the relay listens on 8097.
export const DEFAULT_RELAY_URL = 'http://192.168.68.61:8097'

// No token on a LAN-only relay. Set one in the settings page if the relay has one.
export const DEFAULT_RELAY_TOKEN = ''
