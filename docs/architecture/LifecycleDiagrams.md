# Lifecycle Diagrams

Every diagram reflects the actual states and transitions found in the code. Where the originating mission assumed a lifecycle shape that doesn't match the implementation, the diagram shows the real one and a note explains the gap.

## Tenant

Two overlapping representations exist and are now kept in sync (`docs/independent-audit/FinalBlockerResolution.md`) — the authoritative one is `tenant_licenses.status`; the legacy `tenants.status` mirrors it.

```mermaid
stateDiagram-v2
    [*] --> PENDING_APPROVAL: self-service signup
    [*] --> ACTIVE: legacy key-based registration (skips approval entirely)
    PENDING_APPROVAL --> ACTIVE: admin approves (requires email_verified_at set)
    PENDING_APPROVAL --> ARCHIVED: admin rejects
    ACTIVE --> READ_ONLY: expires_at passes (automatic, sweep)
    READ_ONLY --> ACTIVE: admin extends/renews
    READ_ONLY --> SUSPENDED: 30 days in READ_ONLY (automatic, sweep) or manual admin suspend
    SUSPENDED --> ACTIVE: admin reactivates
    SUSPENDED --> ARCHIVED: 365 days in SUSPENDED (automatic, sweep)
    ACTIVE --> SUSPENDED: manual admin suspend (legacy 'paused' action, now synced)
    note right of PENDING_APPROVAL
        No separate "Approved" state exists —
        approval transitions directly to ACTIVE,
        differing from the originally-assumed
        Pending/Approved/Active/Suspended/Archived shape.
    end note
    note right of ARCHIVED
        Terminal. Never deleted — ARCHIVED is
        the closest thing to "gone" this domain has.
    end note
```

**Legacy `tenants.status` mapping** (3-state, synced 1:1 onto the above): `active` ↔ `ACTIVE`/`READ_ONLY` (both map to legacy `active`), `paused` ↔ `SUSPENDED`, `terminated` ↔ `ARCHIVED`.

## User

### Server-side User

```mermaid
stateDiagram-v2
    [*] --> Active: created via registration or admin add-staff (PIN set immediately, no separate invite step)
    Active --> Deactivated: admin sets is_active=0 (soft only)
    Deactivated --> Active: admin reactivates
    note right of [*]
        No "Invited" state exists — a user is
        created with credentials already usable.
        No "Locked" state exists server-side.
        No "Deleted" state exists — is_active=0
        is the only removal, and it is blocked
        entirely if this would leave the tenant
        with zero active owners.
    end note
```

### Desktop User

```mermaid
stateDiagram-v2
    [*] --> Active: created via setup or Add Staff
    Active --> Locked: too many failed PIN attempts (brute-force lockout, _clearLockState)
    Locked --> Active: lockout window elapses
    note right of [*]
        No "Invited" or "Disabled" or "Deleted"
        state exists in the live code — a user
        can be created and can be brute-force
        locked out temporarily, but there is no
        persisted "disabled" flag and no delete
        function for a desktop User.
    end note
```

**Gap vs. the originally-assumed model**: neither implementation has all five of Invited/Active/Locked/Disabled/Deleted — server has (Active, Deactivated); desktop has (Active, Locked-temporary). Documented as a real gap, not filled in with invented states.

## Session

```mermaid
stateDiagram-v2
    [*] --> Active: created at login (JWT 15min + refresh 30day)
    Active --> Active: refresh rotates both tokens (20s reuse-grace window for racing tabs)
    Active --> Revoked: logout, admin kill-sessions, or a license-status transition to SUSPENDED
    Active --> Expired: 30 days of no activity (idle timeout)
    Revoked --> [*]: hard-deleted by cleanup job, only once >90 days past revocation
    Expired --> [*]: hard-deleted by cleanup job, only once >90 days past expiry
    note right of [*]
        Session is the one entity in the entire
        domain confirmed to be eventually
        hard-deleted — but only long after it
        stopped being relevant, never while active
        or recently ended.
    end note
```

## TenantLicense device/session interaction (not a separate lifecycle, but a real cross-entity effect)

Suspending a license (by any path — sweep or manual) always revokes every active Session for that tenant in the same operation. This is not modeled as a Session state of its own; it's a side effect of the TenantLicense transition above.

## RepairJob

```mermaid
stateDiagram-v2
    [*] --> Received: saveJob()
    Received --> Diagnosing
    Diagnosing --> Repairing
    Repairing --> Ready
    Ready --> Delivered
    Repairing --> Repairing: warranty claim re-opened (saveWarrantyEdit — forces status back to Repairing, clears delivered date)
    Ready --> Repairing: warranty claim re-opened
    Delivered --> Repairing: warranty claim re-opened (within warranty window only, isWarrantyActive)
    Received --> [*]: deleteJob() — hard delete, restores any parts-used stock
    Diagnosing --> [*]: deleteJob()
    Repairing --> [*]: deleteJob()
    Ready --> [*]: deleteJob()
    note right of [*]
        Real states: Received, Diagnosing, Repairing,
        Ready, Delivered — five, not the seven
        (Created/Assigned/In Progress/Waiting/
        Completed/Delivered/Cancelled) originally
        assumed. Transitions are NOT strictly
        sequential in the UI — any status chip can
        be clicked directly. There is no "Cancelled"
        state; a job that shouldn't proceed is
        deleted outright instead.
    end note
```

## Sale — no lifecycle exists

```mermaid
stateDiagram-v2
    [*] --> Exists: saveSale() / posCharge()
    Exists --> Exists: updateSale() — always allowed, any time, any prior state
    note right of Exists
        THERE IS NO STATUS FIELD. The originally-
        assumed Draft/Completed/Returned/Voided
        lifecycle does not exist in this code. A
        vestigial 'Completed' string is stamped by
        legacy-data migration code but is never read
        by any conditional anywhere — it does not
        gate anything. There is no delete, void,
        return, or cancel function for a Sale. Once
        created, a Sale exists in exactly one
        (unlabeled) state forever, always editable.
    end note
```

## Purchase — no entity, therefore no lifecycle

```mermaid
stateDiagram-v2
    [*] --> DoesNotExist
    note right of DoesNotExist
        No DB.purchases array, no create/save
        function, no PurchaseItem, no status field
        of any kind exists anywhere in the codebase.
        The originally-assumed Draft/Received/
        Cancelled lifecycle applies to nothing —
        restocking today is two disconnected manual
        actions (log an Expense; separately adjust
        Inventory stock) with no shared record tying
        them together, and neither of those two
        actions has a lifecycle of its own beyond
        existing once created.
    end note
```

## Summary — lifecycle completeness vs. the originating mission's assumptions

| Entity | Assumed lifecycle | Actual lifecycle | Match? |
|---|---|---|---|
| Tenant | Pending/Approved/Active/Suspended/Archived | PENDING_APPROVAL/ACTIVE/READ_ONLY/SUSPENDED/ARCHIVED | Close — no separate "Approved", has an extra READ_ONLY grace state |
| User | Invited/Active/Locked/Disabled/Deleted | Server: Active/Deactivated only. Desktop: Active/Locked(temporary) only | Partial — neither side has all 5 |
| Session | Created/Validated/Expired/Revoked | Active/Revoked/Expired, eventually hard-deleted after 90-day retention | Close match |
| License | Generated/Pending/Active/Expiring/Grace/Suspended/Archived | PENDING_APPROVAL/ACTIVE/READ_ONLY/SUSPENDED/ARCHIVED (5, not 7) | Partial — "Expiring"/"Grace"/"Generated" aren't distinct persisted states; READ_ONLY is the closest analog to a grace period |
| Repair | Created/Assigned/In Progress/Waiting/Completed/Delivered/Cancelled | Received/Diagnosing/Repairing/Ready/Delivered (5, not 7) | Partial — no Assigned/Waiting/Cancelled; delete replaces cancel |
| Sale | Draft/Completed/Returned/Voided | **No status field exists at all** | No match — the assumed lifecycle doesn't exist |
| Purchase | Draft/Received/Cancelled | **No entity exists** | No match — nothing to have a lifecycle |
