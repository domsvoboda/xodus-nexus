This update focuses primarily on runtime fixes to improve game compatibility. Most of the work went into the Microsoft APIs that games depend on, including authentication, Store licensing, DLC, media playback and cloud saves. The priority remains getting games and core functionality working reliably.

## Game compatibility and runtime

- Fix intermittent Microsoft Flight Simulator 2024 Authentication 18/19 failures caused by fragmented network responses.
- Fix a Microsoft Flight Simulator 2020 startup crash caused by missing Store metadata. Content installation and flight remain unverified.
- Fix false HDD/SSD AP702 warnings in Forza Motorsport and improve cryptographic API compatibility.
- Fix the startup warning and false Tampering detected state in Age of Empires II: Definitive Edition through correct package registration and signature handling.
- Fix Age of Empires: Definitive Edition crashes, sign-in and local network address discovery needed to enable LAN.
- Fix the Store licensing startup path used by Age of Empires III: Definitive Edition.
- Improve intro playback, including ASF and Windows Media support, and supply missing codec dependencies for both 32-bit and 64-bit games.
- Improve networking callbacks, Store queries, add-on licensing and DLC mounting. Preserve verified installed DLC information when the catalog is unavailable and improve package metadata handling.
- Fix PlayFab SDK staging and launch failures on game disks with restricted permission support.

## Cloud saves

- Add an explicit choice between local and cloud saves when a GDK save conflict occurs, with backups of both versions before applying the choice.
- Upload the selected local save when resolving a conflict and retain it for retry if synchronization fails.
- Protect local saves from incomplete cloud listings and avoid false conflicts after partially completed synchronization.
- Keep synchronization failures visible after the game exits, including games launched through Steam shortcuts.

These changes do not resolve every game-specific cloud issue. Forza PlayFab upload problems remain under investigation.

## Launcher and controls

- Improve Steam shortcut startup and preserve Steam Input when launching through an already open Nexus.
- Improve controller navigation, focus and Steam keyboard support across the launcher, with small-screen layout and dialog fixes. Thanks @Philadner.
- Fix Last played history and incorrect game icons on the desktop taskbar.
- Keep game actions responsive during update checks and select the correct executable when packages also contain development tools. Thanks @MaxxJag.
- Add optional close-to-tray behavior and per-game DualShock 4 SDL compatibility.
- Add an uninstaller that preserves installed games and saves, and clearer runtime prerequisite messages.

## Translations

- Add Spanish, thanks @OJambrina, and expand Brazilian Portuguese, thanks @Mrpac6689.
- Add partial German and Italian translations and update French, Polish and Simplified Chinese from reviewed Tolgee contributions.
- Improve plural-form support and translation completeness. Thanks to everyone contributing translations.

Install the accompanying launcher, backend and runtime updates to get the complete set of fixes.

> [!CAUTION]
> **Xodus Nexus is an independent, unofficial project built on Xodus. It is not an official project or release from the upstream Xodus developers.**
>
> Please report Xodus Nexus issues only in the [Xodus Nexus repository](https://github.com/domsvoboda/xodus-nexus/issues). A problem in Nexus does not necessarily indicate a problem in upstream Xodus.

## Steam Deck and similar handhelds

Steam Deck and similar handheld support is experimental. I'm currently testing and debugging on virtualized SteamOS and Bazzite, so I can't fully verify how everything behaves on real handheld hardware. Please report any issues you encounter.

I'm looking to buy an older Steam Deck or a similar handheld compatible with Bazzite or SteamOS for development and testing. If you have one you'd be willing to sell, please message me on Reddit at [u/Embarrassed-Hall-617](https://www.reddit.com/user/Embarrassed-Hall-617/). Cosmetic damage and signs of wear don't matter, as long as the device's basic functions work.
