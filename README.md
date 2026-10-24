<div align="center">

<img src="assets/icon.png" width="96" alt="Xodus Nexus" />

# Xodus Nexus

Your Microsoft Store PC games, on Linux.

[![CI](https://github.com/domsvoboda/xodus-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/domsvoboda/xodus-nexus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

![Xodus Nexus demo](docs/screenshots/demo.gif?v=c2c5cd4c)

*Preview with sample account data.*

## Install

Download the latest x86_64 Linux AppImage from [Releases](https://github.com/domsvoboda/xodus-nexus/releases), make it executable and open it.

For an application-menu installation on supported distributions:

```sh
curl -fsSL https://raw.githubusercontent.com/domsvoboda/xodus-nexus/main/scripts/install.sh | bash
```

In **Settings**, install the **Nexus backend** and **Nexus runtime**, then sign in
with your Microsoft account. A valid game purchase or subscription is required.

If passkey sign-in gets stuck, choose **Continue in browser** in the sign-in
window. This option requires Google Chrome, either a native installation or the
Flatpak version available through Discover. Other browsers are not supported.

[Setup guide and SteamOS requirements](https://github.com/domsvoboda/xodus-nexus/wiki/Getting-started)

## Use

- **My Library** combines owned, Game Pass and installed games, with Access, Play state and title filters.
- Open a game for its description, categories, screenshot gallery and available Xbox achievements, time played and last activity. Xbox data depends on the account and game.
- **Store** lets you browse and install supported PC games.
- **Manage content** installs licensed add-ons and campaign packages.
- **Install Queue** downloads games one at a time and lets you add more while downloading or playing another game. Pause and resume are supported, including manual resume after restarting the launcher.
- Cancelling a new installation can keep or delete its partial files. Existing games, updates and DLC keep their files.
- Play installed games offline on the account's designated offline device: Microsoft then attaches a 30-day offline lease to each game started while online, and the launcher keeps that license and uses it only when Microsoft licensing cannot be reached. The stored license is tied to the signed-in account and removed on Sign out. Devices without the designation receive online-only licenses and nothing is kept. The designation is the same **Offline permissions** setting as in the Xbox app (one PC per account, changeable three times a year); **Settings → Offline permissions** shows whether this device holds it, how many changes remain this year, and turns it on or off after a confirmation that explains the consequences; the same is available as `xodus-cli offline-pc`. Requires Nexus backend 0.2.12 or later.
- Right-click an installed game for settings, VC++ prerequisites, shortcuts or removal.
- Removing a game can keep its files or permanently delete its installation folder without using Trash. Saves inside that folder are deleted too; saves elsewhere are not affected.
- Game settings offer an optional **DualSense compatibility mode** if a standard DualSense is not detected. It applies only to that game and may disable advanced haptics and adaptive triggers.
- Choose **Add to Steam** in the game menu, or **Add Nexus to Steam** in Settings, to create a Non-Steam shortcut with available artwork. Steam can stay running, including in Game Mode. Requires native Linux Steam; Flatpak Steam is not yet supported.
- Update the launcher, backend and runtime in **Settings**.
- **Settings → Downloads** sets a combined game download speed limit in MiB/s (0 means unlimited). A supporting Nexus backend is required; saving the limit also applies it to active downloads.
- For account, library or installation errors, use **Settings → Xodus backend → Open backend diagnostic log**. The local log contains safe error codes and operation results, not credentials. Review it before sharing.

## Wallet setup and unlocking

- If the service is stopped, use **Start service**. Supported KDE wallets should also start automatically when Nexus opens in Game Mode.
- If your wallet has a password, its native unlock window may appear. Enter your **wallet password**, which is not necessarily your Microsoft account password. Nexus does not receive this password.
- A wallet without a password should unlock without requiring password entry.
- If no wallet exists, use **Create wallet** and complete the system dialog. On KDE, choose **Classic, blowfish encrypted file** for a normal password-based wallet if you do not have a GPG encryption key. An empty password does not protect stored credentials.
- If setup or the password dialog does not work in Game Mode, try it in Desktop Mode first. If the problem persists, include the backend diagnostic log in your issue report.

[Documentation](https://github.com/domsvoboda/xodus-nexus/wiki) ·
[Report an issue](https://github.com/domsvoboda/xodus-nexus/issues)

## How it works

| Component | Role |
| --- | --- |
| Xodus Nexus | Store browsing, library, installation queue and launch controls. |
| Nexus backend | Patched build of [Xodus](https://github.com/xodus-gaming/xodus) for account sign-in, license checks, package downloads and launch preparation. |
| Nexus runtime | Built on [Xodus Proton](https://github.com/xodus-gaming/Proton) and [Xodus XGameRuntime](https://github.com/xodus-gaming/xgameruntime), with additional Nexus compatibility patches. |

Every game uses the same launch path and shared runtime.

## Compatible games

These results come from manual testing and user reports. Other games may work,
but have not been verified and may encounter compatibility issues.

| Game | Playable | Status |
| --- | --- | --- |
| Gears of War: E-Day | Yes | Playable online. |
| Deep Rock Galactic | Yes | Playable online. |
| Minecraft Dungeons | Yes | Playable online with launcher 0.3.5; [ownership failures](https://github.com/domsvoboda/xodus-nexus/issues/80) also reported on other setups. |
| Minecraft Dungeons II | Yes | Playable online. |
| Minecraft for Windows | Yes | Playable online. |
| Minecraft Launcher | Yes | Sign-in and Java download/startup work with launcher 0.3.5; Java online unverified. [Login failure](https://github.com/domsvoboda/xodus-nexus/issues/107) also reported on another setup. |
| No Man's Sky | Yes | Playable online. |
| Valor Mortis | Yes | Fully playable. |
| Forza Horizon 6 | Yes | Playable online; some setups need [VC++ prerequisites](https://github.com/domsvoboda/xodus-nexus/issues/96). [Loading failures](https://github.com/domsvoboda/xodus-nexus/issues/13) also reported. |
| Palworld | Yes | Playable online. |
| DOOM Eternal | Yes | Playable. |
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
| Halo: Campaign Evolved | Yes | Playable; may remain running after quitting. ([user report](https://github.com/domsvoboda/xodus-nexus/issues/97)) |
| Resonance: A Plague Tale Legacy | Yes | Playable; black screen reported when ending a game on Steam Deck. ([user report](https://docs.google.com/spreadsheets/d/1HD8fr8XotC2o0seA5TRaiZ3TeltdyUv5aWhxSPeD-6s/edit?usp=sharing)) |
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
