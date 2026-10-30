# Xodus Nexus backend 0.2.14

- Add an optional full launch view (`run --materialize-all --view-dir`) for running a game under the Proton selected in Steam. Every decrypted file is placed in an owner-only directory, so no Wine file maps are needed.
- Stage the PlayFab Game Saves adapter in that view (`--playfab-adapter`), only when the game's SDK exports match exactly.
