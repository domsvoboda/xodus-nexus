# Xodus Nexus backend 0.2.12

- Add a device-bound offline license cache to `run --license-cache`: after a successful online launch, Microsoft's encrypted license block is kept for up to 30 days, bounded by the license's own expiry, and used only when Microsoft content licensing is unreachable. Licenses Microsoft marks online-only are never kept, and an online refusal removes the stored entry.
- Classify content-license failures as unreachable, refused or other, so sign-in and response problems are never hidden by a stored offline license.
