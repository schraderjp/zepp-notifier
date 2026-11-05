// Phone-side settings page (rendered by the Zepp app, not the watch).
//
// The relay URL and bearer token live in the Zepp app's settings storage, which
// is the only persistent storage the Side Service can read - and it survives
// reinstalls of the watch app, unlike everything on the watch.
//
// 0.4.13: both fields are prefilled from shared/config.js, so a fresh install
// works without typing anything on a phone keyboard. Clearing a field restores
// the default.

import { DEFAULT_RELAY_URL, DEFAULT_RELAY_TOKEN } from '../shared/config'

AppSettingsPage({
  build(props) {
    const field = (key, label, fallback) =>
      TextInput({
        label,
        value: props.settingsStorage.getItem(key) || fallback,
        placeholder: fallback,
        onChange: (value) => props.settingsStorage.setItem(key, String(value).trim()),
      })

    return View({ style: { padding: '12px 20px' } }, [
      Text({}, 'Spike relay. Point this at the machine running server/spike_server.py.'),
      field('relay_url', 'Relay URL', DEFAULT_RELAY_URL),
      field('relay_token', 'Bearer token (optional)', DEFAULT_RELAY_TOKEN),
      Text(
        {},
        'There is no poll interval to set: the watch wakes itself from an alarm and pulls. Clear a field to fall back to the built-in default (' +
          DEFAULT_RELAY_URL +
          ').'
      ),
    ])
  },
})
