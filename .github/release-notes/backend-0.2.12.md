# Xodus Nexus backend 0.2.12

- Add offline play for the account's designated offline device: `run --license-cache` keeps the device-bound content license when Microsoft attaches an offline lease, for no longer than that lease (30 days, renewed on every online launch), and uses it only when Microsoft content licensing is unreachable. Devices without the designation receive online-only licenses and nothing is kept; an online refusal removes the stored entry.
- Add `offline-pc` to show whether this device is the account's designated offline PC and, with `--set true --confirm`, to claim the designation (Microsoft allows three changes per year and one PC per account).
- Classify content-license failures as unreachable, refused or other, so sign-in and response problems are never hidden by a stored offline license, and log the license and lease policy on every launch.
- Publish a native aarch64 build next to x86_64, and stop asking for an administrator password at sign-in on devices without an SMBIOS table (ARM handhelds): the firmware table is probed only when it exists.
