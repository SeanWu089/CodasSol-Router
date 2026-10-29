# Design notes

Windows candidate preserves explicit identity, authenticated outbound transport, scoped roots and monotonic session generations. Physical acceptance gates remain separate from automated validation.

## Isolated clean reinstall candidate
- Fresh NodeCleanR1 uses private DevSpace config/auth/storage and node state. Legacy owned tasks are verified and disabled; inaccessible runtime remains preserved. Shared configuration and user projects are not deleted or reused.
- Explicit CLEAN, INIT and optional PAIR gates; bounded worker operations, visible progress, sanitized health checks, exact authenticated identity verification.
- Windows automated isolation/fault tests added; physical clean install, backend startup, pairing, reboot and sleep acceptance remain pending. No claim that the original backend failure is diagnosed.
