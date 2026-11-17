# MagicRemote

A web app that remote-controls Blackmagic Design cinema cameras over Bluetooth LE, using Web Bluetooth.
It runs in the browser, with nothing to install: <https://magicremote.veemax.be>

*MagicRemote is an independent project, not affiliated with or endorsed by Blackmagic Design.*

## Status

Early. Working today, tested on a Pocket Cinema Camera 6K G2:

- connect to a paired camera, reconnect after a link drop
- record start/stop, confirmed by the camera
- timecode, battery, media slot and remaining time
- packet log with export

Camera controls (ISO, shutter, iris, white balance, focus), slate, presets, offline install and
multi-camera are planned.

## Requirements

A browser with Web Bluetooth: Chrome or Edge on Windows, macOS, ChromeOS, Android or Linux.
Firefox and Safari are not supported.

The camera asks for a 6-digit PIN the first time it is paired with a device. After that it connects
without one.

### Linux

Chrome on Linux cannot take the PIN, so pair once outside the browser:

```
bluetoothctl
agent KeyboardOnly
default-agent
scan on
pair <camera address>
```

Type the PIN the camera shows within about 30 seconds. GNOME Settings cannot pair these cameras.
Chrome also needs `chrome://flags/#enable-experimental-web-platform-features` enabled.

## Development

```
pnpm install
pnpm dev        # http://localhost:5173
pnpm test
pnpm check
pnpm build
```

Web Bluetooth needs a secure context: `localhost` or HTTPS.

- `src/lib/protocol` — packet codec, parameter registry, timecode, record recipes
- `src/lib/transport` — GATT queue and the Web Bluetooth link
- `src/lib/domain` — connection state machine, camera state, record controller
- `src/lib/ui` — components
- `fixtures/` — traffic captured from a real camera, replayed by the tests
- `tools/` — scripts used for protocol tests on real hardware

## Licence

GPL-3.0. See [`LICENSE`](LICENSE).
