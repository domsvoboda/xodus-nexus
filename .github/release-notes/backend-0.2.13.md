# Xodus Nexus backend 0.2.13

- Detect an unreachable Microsoft in seconds: the CLI and service HTTP clients bound TCP connects to 10 seconds (no overall request timeout, the same client streams game data), so offline launches fall back to the stored offline license at once instead of after minutes of ticket timeouts.
- Skip the PlayFab authorisation attempt when the launch already runs on the stored offline license; the runtime signs the game in with its cached identity instead.
