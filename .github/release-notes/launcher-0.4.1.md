# Xodus Nexus 0.4.1

## Launcher

- Add experimental native ARM64 builds.
- Redesign the Social panel with player profiles, friend management and separate chat windows.
- Add a notification bell for unread messages and game updates.
- Open conversations at the latest message and synchronize read state between chat windows.
- Add experimental Xbox voice parties and the optional **Nexus Overlay**, with a configurable keyboard shortcut and screen position.
- Improve download and update performance with parallel transfers, batched writes and faster processing of verified local data.
- Improve interrupted-update recovery and prevent launching games with incomplete updates.
- Add Microsoft offline-device management and license-checked offline launches. Offline play requires a compatible runtime, device designation and an initial online launch.
- Show game details, screenshots and achievements for games that are not installed.
- Fix Overlay shortcut changes reverting, unnecessary shortcut registration when disabled, and opening failures when game-window display information is unavailable.
- Fix sign-in failures affecting some Microsoft accounts and improve authentication response handling.
- Avoid unnecessary administrator password prompts on devices without an SMBIOS firmware table.

## Xodus Nexus backend 0.2.13

- Add the APIs needed for the expanded Social panel, chat and experimental voice parties.
- Improve downloads and incremental updates while preserving verified data and recovery checkpoints.
- Support Microsoft-designated offline play with account-bound license validation.
- Fix Xbox authentication response handling and sign-in on devices without SMBIOS firmware information.

## Nexus runtime

- Add an experimental ARM64 runtime with FEX for x86 and x86_64 games.
- Fix Age of Empires IV startup through Windows Store licensing support. Thanks @Anirudh09.
- Add license-checked offline sign-in with the compatible backend and launcher.

Update the Nexus backend to **0.2.13** and install the matching Nexus runtime for your system architecture in Settings.

ARM64 game compatibility has not yet been verified on physical hardware.

Voice parties and the Overlay are experimental. In-game invitation support varies by game.

Thanks @Rbanh, @indiesaudi, @burghr and @xerhab for their contributions.

> [!CAUTION]
> **Xodus Nexus is an independent, unofficial project built on Xodus. It is not an official project or release from the upstream Xodus developers.**
>
> Please report Xodus Nexus issues only in the [Xodus Nexus repository](https://github.com/domsvoboda/xodus-nexus/issues). A problem in Nexus does not necessarily indicate a problem in upstream Xodus.

## Steam Deck and similar handhelds

Steam Deck and similar handheld support is experimental. I'm currently testing and debugging on virtualized SteamOS and Bazzite, so I can't fully verify how everything behaves on real handheld hardware. Please report any issues you encounter.

I'm looking to buy an older Steam Deck or a similar handheld compatible with Bazzite or SteamOS for development and testing. If you have one you'd be willing to sell, please message me on Reddit at [u/Embarrassed-Hall-617](https://www.reddit.com/user/Embarrassed-Hall-617/). Cosmetic damage and signs of wear don't matter, as long as the device's basic functions work.
