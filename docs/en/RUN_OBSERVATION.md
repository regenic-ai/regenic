# Run observation

- **中文：** [../zh/RUN_OBSERVATION.md](../zh/RUN_OBSERVATION.md)
- **Related:** [Search](SEARCH.md) · [Desktop](DESKTOP.md) · [Executors](EXECUTOR.md) · [RFC 0009](rfcs/0009-work-orchestration.md)
- **Status:** Design. The desktop does not yet render observation this way.

Run observation is how the desktop presents one agent run. Every run renders as the same **run card**: the conclusion and the action first, then timing, then the process on demand. The workbench thread, the automation editor, and Search Ask place that card in different spots.

## Questions observation answers

A person opening a run wants five things, in this order. The card follows the order, and the first two are visible without a click.

| Order | Question | Card part |
| --- | --- | --- |
| 1 | What did it conclude? | Conclusion |
| 2 | What did it do for me, and what is left for me? | Action line |
| 3 | Is it done, and is that normal? | Status and duration |
| 4 | What is that based on? | Process: trigger, task text, lookups |
| 5 | Is this automation reliable overall? | Health line on the automation |

## Current state

| Place | Shown today | Defects |
| --- | --- | --- |
| Automation · recent runs | Status, time, one truncated summary line. The whole row jumps to the source thread | The summary is not cleaned, so `REPLY`, `NOTE`, `feishu:oc_…`, and `**` leak. Every row says “Last run finished” although only the first one is the last. Waiting for a person shows as “Running now”. No duration. The full text cannot be read here, and the thread only holds the current run |
| Workbench thread | “Agent read N conversation records” under the title, then a Processing result card | Nothing shows that the conclusion is stale: in the screenshot the other person wrote “never mind, I’ll do it” after it. No duration, and no clock while live. No sign of whether this run replied. Earlier runs are invisible |
| Search · Ask | Question rail, bubbles, lookups, thinking, composer | No duration per answer. Lookups pile above the whole thread instead of the question that made them |

Ask already reads in the right order: question, lookups, answer, with an explicit waiting state. The other two places adopt that order, and Ask gains timing.

## Principles

1. **Conclusion before process.** The conclusion and the action are visible first. Lookups and task text are collapsed.
2. **One component, three places.** The card has the same structure everywhere. Width and density may differ.
3. **Only human text.** Protocol markers, internal IDs, and raw Markdown never appear in a preview.
4. **Say when it is stale.** If the conversation moved after the conclusion, say so.
5. **Point to the next step.** Failed, waiting for you, and not sent each say on the same line where to act.
6. **Honest time.** Show wall-clock durations only. Do not estimate “model time” against “waiting time”.

## Run card

### Anatomy

```
┌──────────────────────────────────────────────────────────────┐
│ ● Completed · took 2m 14s · Yesterday 17:46             Copy │  status line
│                                                              │
│ This month’s payroll is already submitted. On Nov 9 Fang…    │  conclusion
│                                                              │
│ ↩ Replied to Fang · delivered                                │  action line
│ ⚠ This conclusion predates 3 newer messages                  │  staleness (when needed)
│ ▸ Process · Scheduled check · 5 lookups                      │  process (collapsed)
└──────────────────────────────────────────────────────────────┘
```

| Part | Content | Rule |
| --- | --- | --- |
| Status line | Status, duration, time; Copy on the right | Status uses an icon and a word, never color alone |
| Conclusion | Cleaned summary body | Three lines by default with a fade and “Show all”. Expanded, it is capped at 40% of the pane and scrolls inside the card |
| Action line | Whom the agent replied to and whether it arrived, or why it stayed quiet | See Action. Always shown, except when there is no conclusion |
| Staleness | Count of messages after the conclusion | Workbench only. See Staleness |
| Process | Trigger, the task text frozen on this run, lookup detail | Collapsed by default, summarized as “Process · trigger · N lookups”. Lookups load on expand |

Copy copies the cleaned body, without the operator note.

### Text cleaning

Every preview and card first applies `workOperatorText`, as the thread does today. Then:

- **One-line previews** (list rows, collapsed runs, the question rail): strip Markdown, turn newlines into spaces, truncate with “…”.
- **Conversation IDs** (`feishu:oc_…` and the like) do not appear in previews or conclusions. When the card needs to name a conversation, it uses the conversation title.
- **The operator note** (the `NOTE` section) is not part of the conclusion. It sits under Process as “Note for you”.

### Action

The marker on the first protocol line says whether the agent replied. The action line reads:

| Case | Action line |
| --- | --- |
| `REPLY`, channel accepted it | Sent to “title” |
| `REPLY`, ledger says sent, channel did not accept | Not sent. Kept as a recommendation. |
| `REPLY`, queued or sending | Sending to “title”… |
| `REPLY`, send failed | Could not send · Retry |
| `REPLY`, delivery uncertain | Delivery unconfirmed · Review |
| `REPLY`, accepted, and the result says some messages were not sent | Sent. Some messages were not. |
| `QUIET` / `NO_REPLY` | No message needed |
| Rule does not write back | Recorded only |
| Waiting for a person | Needs your reply · Reply |

“…in the conversation” and “reply” are links. On the workbench they scroll to the existing header actions or the prompt dock. The card does not add a second set of buttons.

## Status vocabulary

All three places use one vocabulary. The old “Last run finished / failed” copy is used only for the single “last run” slot on the automation list card, never on run rows.

| `WorkRun.status` | Label | Icon | Tone | Status line |
| --- | --- | --- | --- | --- |
| `running` | Processing | spinner | progress | Processing · running 38s |
| `waiting_human` | Waiting for you | pause | attention | Waiting for you · waiting 6m |
| `completed` | Completed | ✓ | neutral | Completed · took 2m 14s |
| `failed` | Failed | ✕ | error | Failed · took 41s |
| `cancelled` | Cancelled | – | muted | Cancelled · took 12s |

“Waiting” counts from entering the wait, and that instant is not recorded today. Until it is, `waiting_human` reads “Waiting for you · running 6m”; switch to “waiting” once that instant exists.

## Time

### Duration

| Run | From | To |
| --- | --- | --- |
| One run (automation, workbench) | `created_at` | `updated_at` when terminal; now while live |
| One Ask answer | `occurred_at` of the person message | `occurred_at` of the last assistant message before the next person message |

An Ask answer has its own duration because, after a follow-up on the same executor thread, `created_at` through `updated_at` spans the idle gap between questions.

The first Ask turn starts at the question the person sees, not the task prompt sent to the executor.

### Format

| Length | Copy |
| --- | --- |
| < 1 s (terminal) | under 1s |
| < 1 min | 38s |
| < 1 h | 2m 14s |
| ≥ 1 h | 1h 5m |

A live clock ticks each second, then each minute after one hour. Digits use tabular figures so the line does not jitter.

### Instants

Use chat-time style: today “17:46”, yesterday “Yesterday 17:46”, this year “Nov 20 17:46”, older with the year. Hover shows the full time with the time zone.

### Slower than usual

When the rule has at least three recent terminal runs, take their median duration. A live run past three times that median and past five minutes switches the status line to the attention tone and adds “slower than usual”. It is a hint only; nothing is stopped.

## Staleness

Workbench only. If inbound or outbound messages arrived after the conclusion (not counting this run’s own write-back), a line appears under the action line:

> ⚠ This conclusion predates 3 newer messages

Clicking it scrolls the message list to the first newer message. The comparison is local: this run’s `updated_at` against `occurred_at` of loaded messages. No request, no rerun. When the rule has already opened new work for those messages, the line reads “New messages are being handled” and points to that run.

## Workbench thread

The card sits under the title and the find bar, above the message list, at message-column width.

By default it is one line: `✓ Completed · Yesterday 18:59 · 2m 14s · first line of the conclusion… · 19 newer messages ▾`. Clicking the line expands the full card; Collapse at the right of the status line folds it back. The choice is stored locally and holds across threads. Expanded, the card is at most 45% of the window height and scrolls inside, so the message list stays visible. The table below describes the expanded card.

| Thread state | Card |
| --- | --- |
| Live, no conclusion yet | Status line, “Process · N lookups”, then a one-line “Thinking” skeleton. No empty conclusion box |
| Live, partial conclusion | The conclusion renders; the status line still says “running” |
| Waiting for you | The card shrinks to one line: `Waiting for you · running 6m · Reason ▸`. The prompt dock stays at the bottom; Reason expands this conclusion. Only one dense card on screen |
| Finished, can reply | Full card |
| Conversation closed | The card moves to the bottom of the column, where the closed-state result card is today |

### Earlier processing

When the same work item has earlier runs, a row “Earlier processing (2) ▸” closes the card. Expanding lists compact rows, newest first, current run excluded:

```
✓ Completed   Nov 20 17:07   1m 2s    Checked — already submitted, no nudge needed…
✕ Failed      Nov 19 09:12   40s      The executor did not exit…
```

Clicking a row expands it in place into a full run card without leaving the thread. One row is expanded at a time. A new head event opens different work and is not listed here.

### Inbox row

The inbox row keeps today’s one-line preview (first line of the cleaned conclusion) without a duration. Waiting and failed keep today’s attention marks.

## Automation

### Placement

Recent runs currently sit at the top of the edit form and push “When to start” below the fold. Instead:

- The top of the editor holds only the **health line** and the latest three compact rows, ending with “All recent runs (5)”.
- Clicking any row slides in a **run detail panel** from the right with the full run card, process expanded. The panel overlays the form without moving it. Esc or an outside click closes it. ↑ ↓ moves between runs.
- “Open conversation” at the bottom of the panel goes to the run’s source thread. It is the only control that leaves the editor.

### Health line

```
Last 5: 4 completed, 1 failed · usually about 2m · next Dec 9 09:00
```

| Segment | Rule |
| --- | --- |
| Counts | Only the window the API returns (five today). Live runs add “1 processing”; waiting runs add “1 waiting for you”, listed first |
| Usual duration | Median of terminal runs, rounded to the nearest second or minute. Omitted with fewer than two terminal runs |
| Next | `next_run_at` for scheduled rules. Omitted otherwise |

When the latest run failed, the line opens in the error tone: `Last run failed · Nov 19 09:12 · View`.

### Compact row

```
✓  This month’s payroll is already submitted. On Nov 9 Fang posted…   Replied   Yesterday 17:46   2m 14s  ›
```

One line per run, aligned like a table: status icon, cleaned conclusion (truncated to one line), short action phrase, time, duration. The status word lives in the icon’s tooltip and screen-reader text. Hairlines separate rows inside one rounded border; “All recent runs (5)” is the last row inside it. A live row ticks and the conclusion slot reads “Processing…”. Narrow windows hide action and duration.

### Process in the panel

| Item | Content |
| --- | --- |
| Trigger | New message (with the first line of that message) / Scheduled check / Manual start |
| Agent | Executor name |
| Task | The task text frozen on this run, two lines with expand. Marked “Edited since” when it differs from the current task text in the editor |
| Lookups | Existing lookup detail: time, query, count |
| Note for you | The `NOTE` section |

“Edited since” explains why the same rule gave different answers over time, the most common question when debugging an automation.

## Ask

The layout stays. Each answer gains a duration, and lookups move to the question they belong to.

| Place | Change |
| --- | --- |
| Thinking | `Thinking · 12s`, ticking. Stops when an answer appears or the run ends |
| Under the assistant bubble | One muted meta line: `Took 1m 8s · 3 lookups ▸`. Clicking lookups expands that turn’s lookup detail in place |
| Lookup placement | A read belongs to the question whose time it follows and whose next question it precedes. Reads before the first question belong to the first. Reads that fit no question go to the last |
| Failure with no answer | `Did not finish · took 41s · Ask again` |
| Question rail | No durations. A live question shows the processing icon; a failed one shows an error dot |

The rail is navigation. Durations there are noise.

## Empty and error states

| Case | Shows |
| --- | --- |
| Automation never ran | Health line “No runs yet · next Dec 9 09:00” with “Run now” |
| Finished without a summary | “The agent left no conclusion” in muted text; action line hidden |
| Failed | The recorded error text in the conclusion slot, labeled “Failure reason” |
| Cancelled without a summary | Status line only |
| Lookups failed to load | “Lookups unavailable · Retry” under Process; the conclusion is unaffected |
| Missing time fields (historical rows) | No duration; everything else as usual |

## Accessibility

- A ticking clock is not in `aria-live`. Only status changes (started, waiting, completed, failed) are announced, once.
- Status has an icon and a word; color is never the only signal.
- With reduced motion, the spinner does not spin and live clocks update every ten seconds.
- Opening the run detail panel moves focus to its heading; closing returns focus to the row.

## Data

`RecipeLastRun` gains:

| Field | Source |
| --- | --- |
| `run_id` | `WorkRun.id` |
| `started_at` | `WorkRun.created_at` |
| `trigger_kind` | `WorkRun.trigger_kind` |
| `executor_type` | `WorkRun.executor_type` |
| `delivery` | This run’s delivery state (status, write-back, `last_error`); omitted when none |

`at` remains `updated_at` and `summary` remains the full `result.summary`. Cleaning and truncation happen only on the desktop.

The run detail panel also needs the frozen task text and the first line of the trigger message. Both load by `run_id` when the panel opens, not on the list payload.

The workbench loads runs for the thread’s current work item (the authority store has `listWorkRuns(org, work_item_id)`), with the same fields. Lookups stay a per-run fetch.

Ask durations come from message times already on the thread, and staleness compares loaded message times. Neither adds a field.

## Out of scope

- Observation is not written back to a channel and is not a channel message.
- The run detail panel and the editor have no composer and no follow-up.
- Inbox rows do not gain a duration.
- No token, cost, or per-tool latency figures.
- Waiting time is not subtracted from the wall clock.
- “Slower than usual” is a hint and does not cancel a run.
- The executor’s `earlier_runs` / `history.md` payload is unchanged.
- Precise search’s “in n s” is search latency, unrelated to this page.

## Current code

| Part | Code |
| --- | --- |
| Cleaning, action, durations, instants, health line, slower than usual, staleness, lookup turns | `run-observation.ts` (pure, `test/run-observation.test.ts`) |
| Run card | `RunCard`, styles in `styles/run.css`; live clock in `use-now.ts` |
| Thread result and earlier runs | `ThreadRuns`, data from `GET /v1/me/work-items/:id/runs` |
| Automation health line and compact rows | `RecipeRunHistory`; projected by `recentRunsForRecipe`, limit 5, with the latest delivery |
| Run details panel | `RunDetailPanel`, task text and trigger message from `GET /v1/me/work-runs/:id` |
| Lookups | `RunReadList`, `GET /v1/me/work-runs/:id/reads` |
| Ask per-turn duration and lookups, rail status | `AskTurns`, `SearchAsk`; the first turn starts at the hidden task message, falling back to the locally stored ask time |
| Reason while a prompt is up | `WorkContextStrip`, folded into the prompt dock |

## Acceptance

Without leaving the current page, a person can:

- On the automation editor’s first screen, tell whether the rule is healthy, how long it usually takes, and when it runs next, and still see “When to start” without scrolling.
- From any run row, open the panel and read the full conclusion, whether it replied, what it looked up, and the task text at the time.
- On a workbench thread, tell whether the conclusion predates the latest messages.
- On Ask, see each answer’s own duration and lookups.

Also:

- No preview shows `REPLY`, `NOTE`, `QUIET`, a conversation ID, or raw Markdown.
- Waiting for you and processing are two distinct states in all three places.
- Live runs tick in all three places and settle on a duration once terminal; “slower than usual” appears by its rule.
- A failed or uncertain delivery has an action-line link to where it is resolved.
- Screen readers do not announce the clock every second.
