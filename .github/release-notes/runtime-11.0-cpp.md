# Nexus runtime

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
