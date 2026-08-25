# WhatsApp Personal Test and Acceptance

- **Chinese:** [../zh/WHATSAPP_PERSONAL_TESTING.md](../zh/WHATSAPP_PERSONAL_TESTING.md)
- **Related:** [Personal WhatsApp Bridge](WHATSAPP_PERSONAL.md) · [Desktop](../zh/DESKTOP.md)
- **Scope:** Purr WA 1.0.1 CSV and WhatsApp Personal Export v1 JSONL

This checklist separates deterministic repository tests from an optional real-account acceptance run. Never commit exported chats, browser profiles, QR codes, screenshots containing message text, cookies, or session data.

## Automated Gate

Run from the repository root without a WhatsApp account:

```bash
pnpm install --frozen-lockfile
pnpm --filter @regenic/domain test
pnpm --filter @regenic/whatsapp-personal test
pnpm --filter @regenic/authority-store test
pnpm --filter @regenic/api test
pnpm --filter @regenic/local-cli test
pnpm --filter @regenic/desktop test
pnpm --filter @regenic/desktop typecheck
pnpm run build
pnpm --filter @regenic/desktop build
```

When the pnpm store is already populated and public registries are unavailable,
the install gate may use `pnpm install --offline --frozen-lockfile`.

Expected results:

- Domain message-contract tests pass.
- WhatsApp tests cover quoted/multiline CSV, Purr `DD/MM/YYYY HH:mm`, stable identity, sender surface, and system events.
- Authority-store tests prove thread views return only the current revision while `listEvents` retains append-only history.
- API tests cover JSONL, Purr CSV, read-only inbox items, repeated import, and presentation metadata.
- Local CLI tests cover JSONL and Purr CSV import/replay.
- Desktop tests cover sequential multi-file aggregation and failed-file isolation.
- Desktop typecheck, repository build, and desktop production build pass.

## Fixture Acceptance

Use synthetic data only. A Purr CSV fixture must preserve this shape:

```csv
datetime,sender,fromMe,type,text
"21/08/2026 14:30","Alex",0,chat,"Please review."
"21/08/2026 14:31","You",1,chat,"Reviewing now."
```

The filename must retain the upstream identity suffix, for example:

```text
Team_120363000000000000_g_us.csv
Contact_15550001_c_us.csv
```

Verify through `POST /v1/me/imports/whatsapp`:

1. First import accepts the fixture with zero invalid lines.
2. A repeated import reports duplicates and creates no duplicate current items.
3. Incoming and outgoing messages are `kind=user` with different directions.
4. Incoming rows preserve `actor_label`; group events such as `gp2` become `kind=system`.
5. `conversation_label` comes from the original filename and `conversation_kind` is `group` or `direct`.
6. Every WhatsApp item has `can_send=false`.
7. A malformed row is isolated without discarding valid rows.
8. A renamed Purr CSV without `_c_us.csv` / `_g_us.csv` is rejected.
9. A file larger than 20 MiB is rejected.

## Real-Account Acceptance

Use an isolated browser profile and a chat whose participants consent to the test.

### Browser and exporter

1. Verify the installed userscript is Purr WA 1.0.1 from commit `b5527a349c1ee64d16c0ffff51ad934f52343291`.
2. Sign in by scanning the WhatsApp Web QR code yourself.
3. Open Purr WA, select **Scan chats**, then **Clear**.
4. Select exactly one test chat. Do not use **Select all**.
5. Enable only **CSV** and set a narrow date range.
6. Export and confirm one `.csv` file is downloaded.
7. Do not rename the file. Confirm the header is `datetime,sender,fromMe,type,text` without recording row contents in test evidence.

### Regenic desktop

1. Start the desktop and confirm the kernel is running.
2. Open **Engine** → **WhatsApp personal export** → **Import files**.
3. Select the downloaded CSV. Multiple CSV files may be selected in one operation.
4. Confirm the summary reports processed files, new messages, duplicates, invalid lines, and failed files.
5. Open **Inbox** and verify:
   - the source label is **WhatsApp**;
   - the conversation title is readable and the JID is not used as the primary title;
   - senders are distinct and consecutive messages from one sender group together;
   - incoming messages align left and outgoing messages align right;
   - group events render as centered system entries;
   - there is no composer or reply action;
   - the current thread contains no duplicate source identity.
6. Import the same CSV again and confirm zero new messages, all rows duplicate, and no second conversation appears.

### Known limitation check

Record counts only, never identifiers:

- Purr WA 1.0.1 lists `@c.us` and `@g.us` chats.
- Chats exposed only as `@lid` may be absent from the Purr list.
- Web export includes only history synced to WhatsApp Web.
- Media is not part of the Regenic CSV text workflow.
- CSV has no source message ID or timezone; same-file replay is stable, while changed display names/text may create a new identity, and dates use the importer machine's local timezone.

## Privacy and Security Check

- No cookies, tokens, QR data, browser storage, or profile directories enter Regenic.
- Regenic never selects a chat on behalf of the user.
- Regenic reads only files selected in the desktop picker.
- Purr may access selected chats inside WhatsApp Web; review upstream changes before updating the pinned commit.
- No exported chat file, message text, participant name, phone number, chat ID, or screenshot containing private data is committed or attached to a PR.
- WhatsApp items remain read-only and no egress adapter is registered.

## PR Evidence

A PR may include only sanitized evidence:

```text
Automated: domain pass; whatsapp pass; authority-store pass; api pass; local-cli pass; desktop tests/typecheck/build pass; root build pass
Manual E2E: one consented chat; CSV export pass; first import pass; replay dedupe pass; read-only UI pass
Privacy: no exported data, credentials, identifiers, or private screenshots included
Known limitation: pinned Purr WA 1.0.1 does not list @lid-only chats
```
