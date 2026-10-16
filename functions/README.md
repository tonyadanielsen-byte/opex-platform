# OpEx Push V1B

Cloud Functions for automatic OpEx push notifications.

## Notification scope

- New production task -> assigned owner
- Reassignment -> new owner
- Status `Til godkjenning` -> admin (Tony)
- Terminal status (`Fullført`, `Stanset`, `Avsluttet`) -> assigned owner
- Deadline reminders -> assigned owner
  - 3 days before
  - due today
  - 1 day overdue
  - then every 7 overdue days

Test data is excluded. Unknown owners without a mapped Firebase Auth UID are skipped until they have an OpEx account/token.

## Deploy

From repository root:

```bash
firebase login
firebase use opex-nortura
cd functions
npm install
cd ..
firebase deploy --only functions
```

The scheduled reminder function uses Cloud Scheduler in `Europe/Oslo` and runs daily at 08:00.

## Artifact Registry cleanup (production)

The `gcf-artifacts` repository in `europe-west1` is managed manually in Google Cloud.
The current `delete-old-builds` cleanup policy is intentionally in **Dry run**.
Do not run `firebase functions:artifacts:setpolicy` or `firebase deploy --force`:
these can disable repository-wide Dry run and activate actual deletion.
Any future cleanup policy change must be reviewed in Google Cloud, with active
function images and rollback requirements checked before enabling deletion.
The deployment workflow must not modify artifact cleanup policies.
