# Remote Host

Built-in KoinCode desktop instructions for operating user-selected SSH hosts. Version 1.1.2 requires the bundled Remote Host protocol version 2. macOS and Windows check authenticated SSH connectivity without a CPU or operating system gate; file operations require SFTP and command execution uses the target's shell. The content package contains no executable SSH implementation and no MCP command override.

Configure hosts in **Settings → Remote hosts**, verify the server fingerprint through a trusted channel, and select targets with `/remote-host` in a local desktop conversation. Use **Add upload file** or **Add upload directory** for upload-only sources. KoinCode freezes and hashes them locally; their contents are not attached to the model.

Each command, write and upload requires an exact user approval after bounded preflight reads. Results are tracked independently per host. Uploads verify remote contents; uncertain outcomes are preserved and never automatically replayed. See `skills/remote-host-operations/SKILL.md` for the operating rules.

The SSH account's OS permissions remain the security boundary for shell commands. File roots constrain structured file tools. Directory replacement is a multi-step operation and may leave backups or an interrupted target. Review the approval details and execution evidence.

This content ships with KoinCode and requires no marketplace installation. Explicit disablement and removal remain available in feature settings.

License: Apache-2.0. Copyright 2026 FCode contributors.
