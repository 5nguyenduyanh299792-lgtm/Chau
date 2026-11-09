# Security Specification & Test Payloads

## 1. Data Invariants
- **Identity Isolation**: A user can only access `/users/{userId}/records/{recordId}` and `/users/{userId}/settings/{settingId}` where `request.auth != null && request.auth.uid == userId`.
- **Identity Integrity**: `request.resource.data.userId == request.auth.uid` on write.
- **Key & Path Invariant**: In `/users/{userId}/records/{recordId}`, the document ID `{recordId}` must match `request.resource.data.month`.
- **Immutability**: `userId` and `createdAt` cannot be altered on update.
- **Type & Range Guards**: `rent >= 0`, `electric >= 0`, `water >= 0`, `people >= 1 && people <= 20`, `note.size() <= 500`, `others.size() <= 30`.
- **Default Deny**: All other collections and paths are blocked (`read, write: if false`).

## 2. The "Dirty Dozen" Payloads (Must return PERMISSION_DENIED)
1. **Unauthenticated Read**: Anonymous user reading `/users/alice/records/2026-11` -> PERMISSION_DENIED.
2. **Cross-User Read**: User Bob (`request.auth.uid == "bob"`) reading `/users/alice/records/2026-11` -> PERMISSION_DENIED.
3. **Cross-User Write**: User Bob attempting to create `/users/alice/records/2026-11` -> PERMISSION_DENIED.
4. **Identity Spoofing**: User Alice creating `/users/alice/records/2026-11` with `userId: "bob"` -> PERMISSION_DENIED.
5. **Path Mismatch / Poisoning**: User Alice creating doc at `/users/alice/records/2026-12` with `month: "2026-11"` -> PERMISSION_DENIED.
6. **Path ID Injection**: Document ID with invalid characters `/users/alice/records/2026-11;DROP_TABLE` -> PERMISSION_DENIED.
7. **Negative Money Attack**: Creating a record with `rent: -500000` -> PERMISSION_DENIED.
8. **Invalid People Range**: Creating a record with `people: 99` -> PERMISSION_DENIED.
9. **Denial of Wallet String Injection**: Creating a record with `note` having 50,000 characters -> PERMISSION_DENIED.
10. **Array Explosion Attack**: Creating a record with `others` having 1,000 items -> PERMISSION_DENIED.
11. **Immutable Key Hijack**: Updating an existing record to change `userId` from `"alice"` to `"bob"` -> PERMISSION_DENIED.
12. **Settings Cross-User Write**: User Bob writing to `/users/alice/settings/app` -> PERMISSION_DENIED.
