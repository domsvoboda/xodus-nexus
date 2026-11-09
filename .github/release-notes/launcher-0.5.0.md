# Nexus Launcher 0.5.0

Xodus Nexus is now **Nexus Launcher**. This release introduces managed Standard and CachyOS runtime families, expanded account management and coordinated component updates, alongside improvements to game launching, authentication, licensing and cloud saves.

## Runtime and component management

- Manage **Standard** and optional **CachyOS** runtimes independently in Settings.
- Select the runtime family **per game**. Standard remains the default.
- Allow changing a game's runtime selection while downloads or game updates are running.
- Add coordinated updates for the launcher, backend and installed runtime families, with clearer progress, individual results and recovery from partial failures.
- Show update notifications only when component updates are actually available.
- Improve handling of incomplete or damaged component packages.

## Accounts and authentication

- Add optional management of multiple Store accounts and a separate Xbox player account.
- Keep the default single-account setup simple, with advanced account controls available when enabled.
- Preserve independent Xbox player sessions when switching Store accounts.
- Bind library access, licensing and launch preparation more accurately to the active account.
- Improve sign-in discovery for games with different executable layouts.
- Reduce duplicate authorization, token and signing-certificate requests.
- Improve cancellation and timeout handling for authentication and licensing operations.
- Improve compatibility with persisted Windows signing keys and certificates.
- Provide clearer Xbox authentication errors without exposing credentials.

## Home, Library and Store

- Add **Recently installed** and official **PC Game Pass additions** sections to Home.
- Offer installation only when the active Store account has verified access.
- Fix duplicate featured offers and improve edition and bundle handling.
- Expand paid-game browsing and fix catalog pagination loops.
- Show available installation-space or download-size estimates on game details, without treating unknown sizes as zero.
- Keep size lookups scoped to the current account and ignore stale responses after account changes.
- Show Play instead of another installation action for games already installed.

## DLC and licensing

- Fix content bundles being reported as license-only offers.
- Fix source and destination path mapping for add-on content, including SRC layout metadata.

## Game launching and runtime compatibility

- Launch games through the runtime's Proton session so its game preparation, compatibility fixes and supported options are applied.
- Pass game paths and launch context more accurately.
- Preserve explicit user settings, including large-address-aware options and custom EAC runtime paths.
- Improve shader-cache handling without overriding custom environment settings.
- Bind Xbox playing activity more accurately to the authenticated game.
- Improve WinHTTP request cancellation and connection lifetime handling.

## Cloud saves

- Fix initialization through the legacy GameSave interface when a game relies on the configuration ID declared in its manifest.
- Improve recoverable local save transactions and interrupted-operation handling.
- Preserve local save data when an index cannot be read, and reject malformed indexes before changing data.
- Prevent older operations from overwriting newer save state.
- Report failed writes and deletions instead of treating them as successful synchronization.

## Interface, controls and performance

- Remove excessive empty scrolling space from Home, Settings, installation pages and game details.
- Simplify redundant informational text and make profile controls more compact.
- Improve controller navigation and focus recovery in search and player menus.
- Improve recovery of game artwork in Xbox profiles and handling of missing images.
- Load Social interface modules on demand.
- Reduce repeated Store requests and improve startup metadata loading and Library persistence.
- Fix log text containing terminal hyperlinks.

## Translations

- Add **Swedish**, thanks @kimpoliini.
- Update existing community translations and newly added interface text.

## Updating

Install the accompanying launcher, backend and runtime updates to receive the complete set of fixes. Existing games, accounts, settings, prefixes and saves are preserved.

> [!IMPORTANT]
> **Users upgrading directly from 0.4.2 must update manually.** Its in-app updater cannot download this release after the repository rename. Download the latest AppImage from [Releases](https://github.com/domsvoboda/nexus-launcher/releases). Version 0.4.3 includes support for updates from the renamed repository.

> [!CAUTION]
> **Nexus Launcher is an independent, unofficial project built on Xodus. It is not an official project or release from the upstream Xodus developers.**
>
> Please report Nexus Launcher issues only in the [Nexus Launcher repository](https://github.com/domsvoboda/nexus-launcher/issues). A problem in Nexus Launcher does not necessarily indicate a problem in upstream Xodus.

## Steam Deck and similar handhelds

Steam Deck and similar handheld support is experimental. I'm currently testing and debugging on virtualized SteamOS and Bazzite, so I can't fully verify how everything behaves on real handheld hardware. Please report any issues you encounter.

I'm looking to buy an older Steam Deck or a similar handheld compatible with Bazzite or SteamOS for development and testing. If you have one you'd be willing to sell, please message me on Reddit at [u/Embarrassed-Hall-617](https://www.reddit.com/user/Embarrassed-Hall-617/). Cosmetic damage and signs of wear don't matter, as long as the device's basic functions work.

## Contributions

Special thanks to:

- **@Juancafr** for the foundation of separate Store and Xbox player accounts and saved Store-account management, adapted from [#521](https://github.com/domsvoboda/nexus-launcher/pull/521).
- **@thewalldao** for the PlayFab Party cryptographic compatibility fixes, including NCrypt ECDSA keys, self-signed certificates and Schannel support, contributed in [nexus-wine#9](https://github.com/domsvoboda/nexus-wine/pull/9).
- **@kimpoliini** for adding Swedish translations in [#525](https://github.com/domsvoboda/nexus-launcher/pull/525).

Thanks to everyone contributing translations, bug reports, logs and game compatibility testing.

Contributions are welcome:

- [Report bugs or request features](https://github.com/domsvoboda/nexus-launcher/issues).
- [Help translate Nexus Launcher on Tolgee](https://app.tolgee.io/projects/36162).
- [Contribute code or documentation](https://github.com/domsvoboda/nexus-launcher/blob/main/CONTRIBUTING.md).

Please include component versions and reproduction steps when reporting a problem.
