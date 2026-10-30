<div align="center">

<img src="assets/icon.png" width="96" alt="Xodus Nexus" />

# Xodus Nexus

Your Microsoft Store PC games, on Linux.

[![CI](https://github.com/domsvoboda/xodus-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/domsvoboda/xodus-nexus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[🌐 Help translate Xodus Nexus on Tolgee](https://app.tolgee.io/projects/36162)**

</div>

> [!CAUTION]
> **Xodus Nexus is an independent, unofficial project built on Xodus. It is not an official project or release from the upstream Xodus developers.**
>
> Please report all issues encountered with **Xodus Nexus** only in the [Xodus Nexus repository](https://github.com/domsvoboda/xodus-nexus/issues), not in the upstream Xodus issue tracker or support channels.
>
> Nexus includes its own changes, so a problem in Nexus does not necessarily indicate a problem in upstream Xodus.

An Xbox-inspired launcher built on [Xodus](https://github.com/xodus-gaming/xodus),
using our patched Nexus backend and Nexus runtime.
Browse the Store, install games you own or can access through a subscription,
and play with one shared runtime. Xbox sign-in and cloud saves are available
for supported games.

![Xodus Nexus demo](docs/screenshots/demo.gif?v=bb1bc859)

*Preview with sample account data.*

## Community translations

Help make Nexus available in your language. Open our
[public Tolgee project](https://app.tolgee.io/projects/36162), sign in and suggest
translations for the launcher interface. No coding or GitHub access is needed.
Maintainers review suggestions before including them in a release. Missing a
language? Request it in a [GitHub issue](https://github.com/domsvoboda/xodus-nexus/issues).

[Start translating →](https://app.tolgee.io/projects/36162/translations) ·
[Translation guide](docs/TRANSLATING.md)

## Install

Download the latest Linux AppImage from [Releases](https://github.com/domsvoboda/xodus-nexus/releases), make it executable and open it. Stable releases currently ship for x86_64. Experimental ARM64 support requires matching native launcher, backend and runtime builds, compatible graphics drivers and FEX for x86 Windows games.

The current x86_64 runtime requires glibc 2.38 or newer (for example Ubuntu 24.04 or a current SteamOS, Fedora or Arch installation). Ubuntu 22.04 does not meet this requirement.

For an application-menu installation on supported distributions:

```sh
curl -fsSL https://raw.githubusercontent.com/domsvoboda/xodus-nexus/main/scripts/install.sh | bash
```

On first startup, the launcher installs and verifies the **Nexus backend** in
the background so you can sign in during setup. Install the **Nexus runtime**
from **Settings** before launching games. A valid purchase or subscription is required.

If passkey sign-in gets stuck, choose **Continue in browser** in the sign-in
window. This option requires Google Chrome, either a native installation or the
Flatpak version available through Discover. Other browsers are not supported.

[Setup guide and SteamOS requirements](https://github.com/domsvoboda/xodus-nexus/wiki/Getting-started)

## Uninstall

Close Nexus and its games, then remove the application-menu installation without sudo:

```sh
curl -fsSL https://raw.githubusercontent.com/domsvoboda/xodus-nexus/main/scripts/uninstall.sh | bash
```

Games, saves, settings, downloaded runtimes, wallet credentials and system packages are kept.
For a custom installation, use the same `XODUS_NEXUS_PREFIX` and `XDG_DATA_HOME` as during installation.
To preview the files, download the script and run `bash uninstall.sh --dry-run`.
If you only downloaded an AppImage manually, delete that AppImage instead.

## Use

- **My Library** combines owned, Game Pass and installed games, with Access, Play state and title filters.
- In **My Library → In Game Pass**, choose **Recently added to Game Pass** to show games in Microsoft's recent PC collection first.
- Open a game for its description, categories, screenshot gallery and available Xbox achievements, time played and last activity. Xbox data depends on the account and game.
- **Store** lets you browse and install supported PC games.
- New game installations show the estimated download size and free space on the destination drive. The downloader checks exact space requirements.
- **Manage content** installs licensed add-ons and campaign packages.
- **Install Queue** downloads games one at a time and lets you add more while downloading or playing another game. Pause and resume are supported, including manual resume after restarting the launcher.
- Cancelling a new installation can keep or delete its partial files. Existing games, updates and DLC keep their files.
- Right-click an installed game for settings, VC++ prerequisites, shortcuts or removal.
- Removing a game can keep its files or permanently delete its installation folder without using Trash. Saves inside that folder are deleted too; saves elsewhere are not affected.
- Game settings offer separate **DualSense** and **DualShock 4 compatibility modes** for controller detection. They apply only to the selected game. The DualSense fallback may disable advanced haptics and adaptive triggers.
- Choose **Add to Steam** in the game menu, or **Add Nexus to Steam** in Settings, to create a Non-Steam shortcut with available artwork. Steam can stay running, including in Game Mode. Requires native Linux Steam; Flatpak Steam is not yet supported.
- Update the launcher, backend and runtime in **Settings**.
- **Settings → Close Nexus to the system tray** keeps the launcher and downloads running after closing its window. Use the tray menu to reopen Nexus or quit. Requires a desktop system tray.
- **Settings → Interface language** selects a bundled translation independently of game language and Store region. Missing translations fall back to English.
- **Settings → Downloads** sets a combined game download speed limit in MiB/s (0 means unlimited). A supporting Nexus backend is required; saving the limit also applies it to active downloads.
- **Settings → Shader cache** sets the per-game Mesa/NVIDIA driver cache limit, 4 GiB by default. Changes apply on the next game launch; explicit environment overrides take precedence.
- For account, library or installation errors, use **Settings → Xodus backend → Open backend diagnostic log**. The local log contains safe error codes and operation results, not credentials. Review it before sharing.

## In-game overlay

Enable **Settings → Nexus Overlay** to open friends, chats and party controls
while playing. Record a shortcut, choose the screen edge and save the settings.
The overlay requires Python 3, PyGObject, GTK 3 and WebKitGTK 4.1. Your desktop
may ask you to approve the shortcut on Wayland; fullscreen and monitor detection
depend on the desktop. The overlay is optional and disabled by default.

## Offline play

Use **Settings → Offline permissions** while online to designate this PC for
offline play. Microsoft allows only one offline PC per account; changing it
removes the designation from the previous device and is subject to the limit
shown before confirmation. Launch each game online once afterwards. Supported
games can then start without a connection while their Microsoft-issued lease
remains valid. A compatible backend and runtime are required; online-only games
still need their servers. See [Xbox offline-play guidance](https://support.xbox.com/en-GB/help/games-apps/game-setup-and-play/play-games-offline-on-windows-10-using-offline-mode).

## Wallet setup and unlocking

- If the service is stopped, use **Start service**. Supported KDE wallets should also start automatically when Nexus opens in Game Mode.
- If your wallet has a password, its native unlock window may appear. Enter your **wallet password**, which is not necessarily your Microsoft account password. Nexus does not receive this password.
- A wallet without a password should unlock without requiring password entry.
- If no wallet exists, use **Create wallet** and complete the system dialog. On KDE, choose **Classic, blowfish encrypted file** for a normal password-based wallet if you do not have a GPG encryption key. An empty password does not protect stored credentials.
- If setup or the password dialog does not work in Game Mode, try it in Desktop Mode first. If the problem persists, include the backend diagnostic log in your issue report.

## Microsoft Store device limit

Microsoft Store supports up to 10 linked devices. If downloading or launching a
game fails with **Microsoft Store device limit reached** (licensing code 501),
open [Microsoft Store device management](https://account.microsoft.com/devices/content)
and sign in with the same Microsoft account. Unlink only an old device you no
longer use, then retry in Nexus. You do not need to sign out or reset the wallet.
Other license errors can have different causes.

[Documentation](https://github.com/domsvoboda/xodus-nexus/wiki) ·
[Report an issue](https://github.com/domsvoboda/xodus-nexus/issues)

## How it works

| Component | Role |
| --- | --- |
| Xodus Nexus launcher | The desktop interface for the Store, library, downloads, settings and launching games. |
| Nexus backend | Our patched build of [Xodus](https://github.com/xodus-gaming/xodus), handling Microsoft account sign-in, genuine license checks, package downloads and launch preparation. |
| [Nexus Runtime](https://github.com/domsvoboda/nexus-runtime) | Our fork of Valve's Proton Experimental, assembling Wine, XGameRuntime, graphics translation and supporting libraries into one complete runtime. |
| [Nexus Wine](https://github.com/domsvoboda/nexus-wine) | The matching Wine fork, providing Windows API compatibility and Nexus game fixes. |
| [Nexus XGameRuntime](https://github.com/domsvoboda/nexus-xgameruntime) | Our fork of the upstream C++ XGameRuntime, providing game-facing account, cloud-save, package and Store/DLC interfaces. API coverage varies by game. |

The launcher asks the backend to prepare a licensed game, then starts it with
the shared Nexus Runtime. Wine provides Windows compatibility; XGameRuntime
connects supported Xbox and Microsoft Store game APIs to the Nexus backend.
DXVK and VKD3D-Proton translate supported Direct3D graphics to Vulkan.

Install or update the complete runtime through **Settings**. Its Wine and
XGameRuntime components are built together at matching revisions, so there is
no need to install the individual forks separately. All games use the same
shared runtime; compatibility and online services still depend on the game.

## Compatible games

These results come from manual testing and user reports. Other games may work,
but have not been verified and may encounter compatibility issues.

| Game | Playable | Status |
| --- | --- | --- |
| Persona 3 Reload | Yes | Gameplay, network features and cloud saves work; expansion pass not recognized. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/317)) |
| Forza Motorsport | Partial | Unreleased runtime: intro completed. Online play unverified. |
| Age of Empires II: Definitive Edition | Yes | Unreleased runtime: single-player gameplay works. Online play unverified. |
| Age of Empires III: Definitive Edition | Yes | Unreleased runtime: works. Online play unverified. |
| Age of Empires: Definitive Edition | Partial | Unreleased runtime: menu and sign-in work; Multiplayer and LAN menus enabled. Gameplay unverified. |
| Age of Empires IV | Startup verified | Unreleased runtime: starts successfully; online play unverified. |
| Gears of War: E-Day | Yes | Playable online; Xbox playing status works. |
| Deep Rock Galactic | Yes | Playable online. |
| Minecraft Dungeons | Yes | Playable online with launcher 0.3.5; [ownership failures](https://github.com/domsvoboda/xodus-nexus/issues/80) also reported on other setups. |
| Minecraft Dungeons II | Yes | Playable online. |
| Minecraft for Windows | Yes | Playable online. For licensing code 501, check the [Store device limit](#microsoft-store-device-limit). |
| Minecraft Launcher | Yes | Sign-in and Java download/startup work with launcher 0.3.5; Java online unverified. [Login failure](https://github.com/domsvoboda/xodus-nexus/issues/107) also reported on another setup. |
| No Man's Sky | Yes | Playable online. |
| Valor Mortis | Yes | Fully playable. |
| Forza Horizon 6 | Yes | Playable online; some setups need [VC++ prerequisites](https://github.com/domsvoboda/xodus-nexus/issues/96). [Loading failures](https://github.com/domsvoboda/xodus-nexus/issues/13) also reported. |
| Palworld | Yes | Playable online. |
| DOOM Eternal | Yes | Playable. |
| Microsoft Flight Simulator 2024 | Partial | Unreleased runtime: gameplay works, but sign-in can stall. Multiplayer unverified. |
| Ori and the Will of the Wisps | Partial | Unreleased Experimental runtime: sign-in and main menu work; gameplay unverified. |
| Like a Dragon: Infinite Wealth | Partial | Unreleased Experimental runtime: main menu works; gameplay unverified. |
| DOOM: The Dark Ages | Yes | Playable (user report). |
| Fallout 76 | Yes | Playable online; [one reported setup](https://github.com/domsvoboda/xodus-nexus/issues/9#issuecomment-6227548598) requires gamescope to display correctly. |
| The Outer Worlds 2 | Yes | Playable. |
| Wolfenstein: The Old Blood | Yes | Playable. |
| Wasteland Remastered | Yes | Playable. |
| Danganronpa 2 | Yes | Playable. |
| Neon Abyss 2 | Yes | Playable. |
| Hollow Knight: Voidheart Edition | Yes | Playable. |
| Avowed | Yes | Playable. |
| Mortal Shell: Enhanced Edition | Yes | Playable (user report). |
| Sea of Thieves | Yes | Playable online. |
| Tony Hawk's Pro Skater 3 + 4 | Partial | Solo playable; Private Match loads a map. Joining other players and public matchmaking remain unconfirmed. ([#88](https://github.com/domsvoboda/xodus-nexus/issues/88)) |
| ARC Raiders | No | Launches but cannot connect to online services. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/100)) |
| Hogwarts Legacy | Yes | Playable. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/110)) |
| Halo Infinite | Partial | Unreleased Experimental runtime: main menu and campaign start; multiplayer unavailable (offline). |
| Halo: Campaign Evolved | Yes | Playable; may remain running after quitting. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/97)) |
| Resonance: A Plague Tale Legacy | Yes | Desktop gameplay and Xbox cloud saves work. Steam Deck exit black screen also reported. ([desktop report](https://github.com/domsvoboda/xodus-nexus/issues/446), [Steam Deck report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Resident Evil 2 | Yes | Playable; may remain running after quitting. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/110)) |
| Wreckfest | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| TUNIC | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Hades | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Hell Let Loose: Vietnam | No | Crashes after Easy Anti-Cheat initialization on Arch Linux with an Arc A770. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Human: Fall Flat | Partial | Public online game search fails. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Wolfenstein II: The New Colossus | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| The Dungeon of Naheulbeuk: The Amulet of Chaos | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Soul Hackers 2 | Yes | Playable with launcher 0.3.8 (user report, [#166](https://github.com/domsvoboda/xodus-nexus/issues/166#issuecomment-6285236638)). |
| Monster Boy and the Cursed Kingdom | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Hollow Knight: Silksong | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| Teenage Mutant Ninja Turtles: Shredder's Revenge | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| DRAGON QUEST XI S: Echoes of an Elusive Age - Definitive Edition | No | Crashes after the first loading screen. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| ACA NEOGEO METAL SLUG | No | Crashes at launch. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| SIGNALIS | Yes | Playable. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
| DREDGE | Yes | Playable. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/106)) |
| Warhammer 40,000: Space Marine 2 | Yes | Playable; online unverified. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/106)) |
| Indiana Jones and the Great Circle | Yes | First mission playable. ([#78](https://github.com/domsvoboda/xodus-nexus/issues/78)) |
| Microsoft Jewel | No | Crashes at launch. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| Microsoft Bubble | No | Crashes at launch. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| AI: THE SOMNIUM FILES - nirvanA Initiative | Yes | Playable; Store ID detection issue reported. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| Minecraft Legends | Yes | Playable; an online session starts, but play with friends is unverified. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| The Elder Scrolls: Arena | No | Crashes at launch. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| The Elder Scrolls II: Daggerfall | No | Crashes at launch. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| Wolfenstein: Enemy Territory | Partial | Playable, but cannot join PunkBuster-enabled servers. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/107)) |
| Hell Let Loose | No | Crashes at startup. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/105)) |
| Kingdom Come: Deliverance II | Yes | Playable. ([#112](https://github.com/domsvoboda/xodus-nexus/issues/112)) |
| PAC-MAN MUSEUM+ | No | Stops after the opening logos. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/61)) |
| Farming Simulator 25 | No | Startup failure reported; updated runtime retest pending. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/62)) |
| PowerWash Simulator 2 | Yes | Playable. ([#69](https://github.com/domsvoboda/xodus-nexus/issues/69)) |
| Young Souls | Unverified | Launches in Steam Deck Desktop Mode; gameplay unverified. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/8#issuecomment-6225913594)) |
| Remnant II | Unverified | Starts and exits cleanly; gameplay and online were not detailed. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/34#issuecomment-6190973665)) |
| The Witcher 3 | No | Currently crashes on launch. |
| LIMBO | Yes | Playable. |
| World War Z | Partial | Connects to online services and starts Quick Match search; joining a match is unverified. |
| Balatro | Yes | Playable. |

[Full compatibility list](https://github.com/domsvoboda/xodus-nexus/wiki/Compatibility)

User reports describe individual setups, not universal compatibility. The wiki
links to report sources and the community spreadsheet. Launch-only reports do
not confirm gameplay or online support.

## Screenshots

[Library](docs/screenshots/demo-library.png) ·
[Store](docs/screenshots/demo-store.png) ·
[Install queue](docs/screenshots/demo-downloads.png) ·
[Settings](docs/screenshots/demo-settings.png)

Independent project, not affiliated with Microsoft or Xbox. A valid game license
is required. Launcher: [MIT license](LICENSE). The separate Xodus backend retains
its upstream GPLv3 license and ships with corresponding source.
The Nexus runtime includes [FFmpeg](https://ffmpeg.org/) shared libraries under
LGPL 2.1 or later; its corresponding pinned source and build recipe accompany
each runtime release.
[Contributing](CONTRIBUTING.md)
