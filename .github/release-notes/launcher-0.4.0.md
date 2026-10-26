# Xodus Nexus 0.4.0

- Add Xbox chat directly to the launcher.
- Show your playing status and current game to friends in the Xbox app. Clear the activity when the game closes.
- Add invitation handling for compatible games.
- Fix discovery of DLC included with owned editions and bundles.
- Fix installation of supported add-ons into the correct base game, and distinguish downloadable DLC from license-only content.
- Fix missing library entries and incorrect ownership labels for conditional and other active licenses.
- Install the backend automatically during first-time setup, before sign-in.
- Download runtime updates from the new Nexus runtime repository.
- Keep each game's shader cache between launches. Add a configurable cache limit with a **4 GiB default**.
- Fix per-game language overrides and restoring the system-default language.
- Show download size and required disk space before installation.
- Fix cancellation and cleanup of resumed downloads.
- Add recently-added Game Pass sorting.
- Fix window sizing and restoration on smaller displays.
- Preserve component selections when saving settings, and show clearer backend dependency and wallet errors.
- Add community UI translation support through [Tolgee](https://app.tolgee.io/projects/36162).

Thanks @btsouth and @burghr for their contributions.

## Xodus Nexus backend 0.2.12

- Add Xbox friends and messaging support, including authenticated message sending and server-confirmed send results.
- Support downloadable add-ons associated with an installed base game.
- Preserve conditional license information used to display games correctly in the library.
- Explain Microsoft Store device-limit refusals instead of reporting an unexplained licensing failure.
- Support declared plaintext game executables and launching from filesystems without symbolic links.
- Provide package download and installation-size information.

## Nexus runtime

- Move the shared runtime to the C++ XGameRuntime implementation.
- Fix Halo Infinite account matching and profile loading.
- Fix Ori and the Will of the Wisps returning to “Press any key” during sign-in.
- Fix Like a Dragon: Infinite Wealth startup failures.
- Reduce repeated installation checks that caused long Gears startup delays, while preserving checks for missing or changed files.
- Add Xbox playing-status reporting and invitation handling for compatible games.
- Fix atomic save-file writes when paths contain non-ASCII characters.
- Fix game relaunches that could not find their executable beside the original launcher.
- Add missing P-256 signing support and correct signature-buffer handling.
- Implement package identity and application-data folders needed by games including Flight Simulator 2024. **FS2024 authentication can still stall.**
