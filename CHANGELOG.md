# Changelog

## Unreleased

- Stop background update checks, keep game actions responsive, and queue updates while another game downloads.

- Optionally keep Nexus and downloads running in the desktop system tray, with shortcuts to Home, Library, Store and Settings.
- Keep Steam game shortcuts open while the account initializes.
- Skip development-only executables when selecting a game’s launch target. Thanks @MaxxJag.

- Add a per-game DualShock 4 compatibility option for SDL input.
- Show missing system library and glibc requirements when runtime installation fails.

- Open the running Steam client’s on-screen keyboard when a text field is tapped on a touchscreen.

- Suggest DLC owned through a bundle when a game starts from a Steam shortcut or right after the launcher opens: the launch now loads the account's owned products while it prepares (waiting at most 2.5 s, skipped offline) instead of using them only when the Library page had loaded them recently.
- Add native arm64 launcher and backend builds, with architecture-aware downloads and updates. Thanks @indiesaudi.

- Overlap local data verification and staged writes during game updates without changing checkpoint recovery.
- Reduce download preparation time and memory use while preserving existing update checkpoints.
- Improve game download and update performance with batched writes, parallel update transfers and fewer repeated local reads.
- Add a redesigned Social panel with conversations, player profiles and friend management. Thanks @Rbanh.
- Show unread conversations and game updates in a notification bell beside the account, and open chats at the latest message.
- Reduce disk space and downloads for game updates by reusing verified local data, and support recovery of interrupted updates. Thanks @Rbanh.
- Remove abandoned temporary game launch directories while preserving active sessions and directories without a usable session lock. Thanks @xerhab.
- Start offline launches about 5 seconds sooner: additional DLC discovery no longer waits for the unreachable Store catalog and uses the content installed on the device. Thanks @indiesaudi.
- Add **Settings → Offline permissions** and lease-checked offline launches with a compatible runtime. Each game needs an online launch after designating the device. Thanks @indiesaudi.
- Remove stored offline licenses and offline sign-ins whenever offline play ends: turning it off, Microsoft reporting another device as the offline device, another account, sign-out, or a licensing refusal.
- Fix Xbox sign-in, downloads and profiles failing with "Xbox authentication request failed" for accounts that receive compact JWE delegation tickets; other tickets are unchanged. Thanks @burghr.
- Skip the administrator password prompt for hardware data at sign-in on devices without a firmware SMBIOS table, such as most ARM devices; other devices are unchanged. Thanks @burghr.
- Handle reordered game sign-in responses and return authentication failures without crashing the account service.
- Return a normal sign-in error for invalid or refused device registration responses instead of crashing.
- Preserve Microsoft broker headers on both hosted sign-in steps. Thanks @Wyze3306 for the upstream fix adapted here.
- Accept compact JWE tickets when requesting game content licenses without changing Xbox or Store sign-in token handling.
- Show owned games with unsupported packages in My Library with the existing Unsupported badge and installation disabled.
- Fix missing library editions when several Store bundles are loaded together.
- Implement communication audio endpoint queries and change notifications requested by games such as Deep Rock Galactic.
- Fix missing new-save notifications at session close and incorrectly successful cloud-upload results.
- Fully remove saved sign-in credentials and local device registration on Sign out; keep device registration when using Sign in again.
- Preserve local save containers when cloud transfers fail or conflict with unuploaded changes, and reject incomplete cloud metadata.
- Report real installed package byte totals and unknown-size states instead of zero-sized progress for nonempty games.
- Export a reviewable diagnostic report with versions, system information and selected logs, with automatic redaction and local saving.
- Support adding Steam shortcuts to large imported libraries without changing existing entries.
- Prevent permissive directory permissions from blocking managed Proton prefixes at game startup.
- Resolve game and add-on bundles using explicit contents instead of unrelated licensing offers, and report precise Store metadata errors.
- Fix resolving game editions whose non-installable bonus items reference the parent bundle.
- Fix Jurassic World Evolution 3 aborting during app-constrained notification registration at startup.
- Fix repeated Xbox task-queue termination requests leaving games waiting during world cleanup or shutdown.

## 0.3.10

- Start supported KDE wallets automatically in Game Mode and show native unlock dialogs for password-protected wallets.
- Correct keyring-provider detection and show actionable account-service errors.
- Offer native first-wallet creation when no collection exists.
- Improve saved-account persistence across Desktop Mode, Game Mode and shutdown.

## Backend 0.2.10

- Add native wallet setup and unlock helpers and improve KWallet credential persistence.
- Preserve complete encrypted executable files during resumed installations and repair files trimmed by an earlier resume.
- Report actionable launch-image errors instead of panicking.

## Backend 0.2.7

- Keep independently verified account-library records available when other license records are invalid or conflicting.
- Add safe library error codes and HTTP status diagnostics without recording account or credential contents.

## 0.3.7

- Keep independently verified library games available when individual license records are invalid, with a warning when results are incomplete.
- Add a local backend diagnostic log with safe error codes, an in-app viewer and a Copy log button.
- Improve spacing around action buttons in Advanced / Diagnostics.

## Backend 0.2.6

- Prevent sign-in and installation panics when stored credentials are invalid, verify keyring writes and show actionable sign-in errors. Thanks @jordanfaz for reporting the issue.
- Include nested dependency source directories in the corresponding-source archive for offline builds.

## 0.3.6

- Prevent repeated task-queue closes from releasing pending work or crashing during game shutdown.
- Support app-state notification registration during game startup.
- Accept SKU-qualified product IDs when requesting genuine Store license receipts.
- Fix LIMBO failing to start with a pixel shader compiler error.
- Fix Brotato installation failing while reading package metadata. Thanks @Techzilla44 for reporting the issue.
- Fix Kingdom Come: Deliverance II crashing during startup. Thanks @TinyRoar-Basti for reporting the issue.
- Support asynchronous multiplayer privilege resolution using authenticated Xbox account permissions. Account restrictions still require resolution through Xbox settings.
- Fix PowerWash Simulator 2 getting stuck on the initial loading screen.
- Deliver installation-progress notifications, fixing Indiana Jones and the Great Circle crashing after the opening logos.
- Enumerate installed package chunks, languages, tags and features from layout metadata.
- Support a legacy XPackage interface and its installed-package metadata queries.
- Clear My Library search on restart while remembering Access and Play state filters.
- Add gamepad navigation for the launcher, including directional focus, dialogs and game options, while preserving mouse and touch controls. Thanks @Techzilla44 for the suggestion.
- Support gzip response decompression and server certificate-chain queries in the shared runtime's WinHTTP implementation.
- Prevent doubled keyboard input in Steam Game Mode without changing game input settings. Thanks @Techzilla44 for reporting the issue.
- Search all pages of the account library automatically instead of only the games already loaded.
- Open the selected game from Most recent and library search results.
- Delete uninstalled game files directly instead of moving them to Trash, with an explicit permanent-deletion warning and an option to keep the files.
- Preview installation progress when hovering over Install Queue and show a desktop notification when a download completes.
- Allow removing an unrelated game while another game downloads, keeping active installation folders protected.
- Ignore commented-out manifest examples when importing games and reading runtime package metadata.

## 0.3.5

- Add an optional per-game DualSense compatibility mode for controllers not detected through native HIDRAW input.
- Prevent automatic display sleep while a game is running, including when playing with a controller.
- Keep library cards in place when loading more games and fix opening game options with a single click or tap. Thanks @Techzilla44 for reporting these issues.
- Queue multiple game installations and download other games while playing. Keep queued installations cancellable.
- Preserve cover proportions in Steam portrait library cards.
- Add games and Nexus to Steam with library artwork, including while Steam is running.
- Fix access to the KDE keyring when launching game shortcuts in Steam Game Mode.
- Fix launcher startup from Steam Game Mode when the Steam overlay is injected.
- Support Store game-license change subscriptions in the shared runtime.
- Support Google Chrome installed through Discover/Flatpak for browser sign-in. Thanks @quentingeorgel for reporting the issue.
- Fix games remaining active after a normal exit.
- Fix games exiting during speech initialization when using the bundled runtime.
- Support chunk-order requests for verified installed packages in the runtime.

## 0.3.4

- Fix games failing to launch with a WINEPREFIX error when no custom launch options or overlays are enabled.
- Correct the demo's version display and use wide Store artwork for banners and game details.

## 0.3.3

- Offer Continue in browser when Microsoft passkey sign-in is waiting, including during first-time setup. Requires Google Chrome installed on the computer; other browsers are not supported.
- Let users cancel a waiting passkey request without closing Microsoft sign-in.
- Bundle a fallback font to prevent font-related startup crashes on minimal Linux installations.
- Keep My Library filters after restarting Nexus and close search suggestions when leaving the search field or changing pages.
- Fix desktop game shortcuts reporting an invalid profile path when Nexus is already running.
- Show an installation package picker for Store offers with multiple downloads instead of waiting for terminal input. Requires the updated Nexus backend.
- Name game shortcut files after the game, with safe handling of duplicate titles.
- Add per-game MangoHud, gamescope and custom command-prefix settings.
- Align the game details with the library grid and give installed and installable cards matching heights.
- Use Store covers and wide detail artwork instead of small package icons, with a local-image fallback.
- Use wide Store artwork for the Home banner instead of stretching package icons.
- Make the library refresh control compact and aligned with the filters.

## 0.3.2

- Fix Microsoft sign-in on SteamOS without installing WebKitGTK or changing the system partition. Start the built-in KDE keyring automatically when needed.
- Keep My Library's Access, Play state and search filters when switching between tabs.

The updated sign-in backend requires launcher 0.3.2 or newer. Update both the launcher and Nexus backend.
