# Xodus Nexus backend 0.2.14

- Add `run --offline` (with `--license-cache`): the launcher passes it once it has found Microsoft unreachable, so the launch skips the device-credential renewal, the ticket and content-license requests and the PlayFab authorisation outright and starts on the stored offline license at once. The Wine process gets `XODUS_FORCE_OFFLINE=1`, so the runtime signs the game in from its cached Xbox identity without waiting for its own connect timeouts.
- Keep an offline launch alive when the device token has expired: a launch with a license cache no longer fails before the content-license step when the device-credential renewal cannot reach Microsoft. The content-license step still decides; only an unreachable Microsoft lets the stored offline license stand in.
