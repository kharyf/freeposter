# Design: Telegram review gate

Status: implemented on branch `telegram-review` (2026-11-08). Setup steps for users are in [hermes.md](hermes.md#3-reviews-on-telegram).

### Changes made while building it

- **Hermes's own bot is supported, not just a separate one.** The user's Hermes already talks through a bot (loxis-meet), and they want reviews in that chat. Route A from §2.1 is built as mode `hermes`. FreePoster sends with that bot's token and doesn't read its updates. The `freeposter-review` Hermes plugin ([templates/hermes/freeposter-review](../templates/hermes/freeposter-review)) passes only `fp:` taps, replies to redo prompts and `/freeposter <code>` to `POST /api/telegram/relay`, signed with its own secret. Route B is mode `own`. Hermes's validator passes the plugin (`hermes plugins validate`). A check against Hermes's installed python-telegram-bot confirmed it forwards only those three kinds of update and leaves the rest to Hermes.
- **Telegram confirms every tap before it counts, in both modes.** FreePoster calls `answerCallbackQuery` *before* acting. Telegram refuses a query id it never issued, so a made-up tap (for example one POSTed to the relay by something that read the secret) is ignored. That narrows §2.1's weakness of route A: forging needs a real tap from the paired user, so an attacker would have to change the plugin's code, not just send requests. The toast therefore says "Approving…". When a decision can't be made, the reason is posted as a reply under the card.
- **The window decides reviews too, and agents are never refused outright.** §2.2 said agents can't post without Telegram. Instead, every agent request becomes a review that waits in the window (**Waiting for your review**) and, when Telegram is set up, on Telegram as well. Agents still can't approve.
- **A review is prepared in the background** (state `preparing`): the master render, the hash, the viewing copy, and the caption when it's blank. `request_review` returns at once, like the other tools.
- **CLI:** `approve` is replaced by `review`, `reviews` and `audit`.
- **Drive videos are reviewed too (2026-11-08).** The user chose this over §1's auto-approval: Drive intake sends each finished edit for review (`requested_via = 'drive'`, 72-hour expiry, not capped at the post time) and follows the decision. Approve schedules it; Reject marks the file `rejected`; Redo with a one-setting reason and no note is applied by FreePoster (`autoRedo`), and anything else goes to Hermes as `review.redo` (`handled_by: "agent"`), whose `revise_edit` the intake picks up and sends back for review. `_RAW` files still skip the edit and the review.
- **Recorded fixtures (§9.1):** the Telegram update fixtures in `test/fixtures/telegram/` are written from the Bot API reference, not recorded from the live bot. Replace them with recorded ones when convenient.

Every video an agent wants to post stops at a review. FreePoster sends the reviewer the exact file that will be uploaded, with **Approve**, **Reject** and **Redo** buttons, on Telegram. Only a verified tap on Approve, or the Approve button in the FreePoster window, creates a post. Nothing an agent says or calls can.

## 1. What the code does today, and why it isn't a gate

| Finding | Where | Consequence |
|---|---|---|
| With **Let my agent approve** on, `publish_video(edit_id)` approves the edit itself, and `approve_production` posts, when the agent decides the user said yes. | [src/mcp.ts:208](../src/mcp.ts#L208), [src/produce/mcp-tools.ts:190](../src/produce/mcp-tools.ts#L190) | Whether "yes" was said is up to the model. A misread reply, a "yes" to the wrong preview, or text injected from a page or file all count as approval. |
| `publish_video(video_path)` posts any file with no approval at all. `get_edit` returns `preview_path`, and productions keep `outputPath` on disk. | [src/mcp.ts:213](../src/mcp.ts#L213) | Even with agent approval **off**, an agent can post a production's `final.mp4` or an edit's output by its path, skipping both approval paths. |
| An edit post records the **source** hash (`draft.sha256 = edit.sha256`). The runner then picks `edit.outputPath` when it posts and re-encodes it through `render()`. | [src/mcp.ts:226](../src/mcp.ts#L226), [src/runner.ts:146](../src/runner.ts#L146), [src/media.ts:137](../src/media.ts#L137) | Nothing records which bytes were approved, and the bytes uploaded are a new ffmpeg encode made at post time. libx264 output isn't guaranteed to be byte-identical across runs or builds, so "what you approved" and "what posted" can't be compared. |
| Edits have no `rejected` state and no revise path. A different edit means a new edit with other settings, and the settings are five booleans. | [src/types.ts:102](../src/types.ts#L102), [src/edit/settings.ts](../src/edit/settings.ts) | A reject can't be recorded. A redo like "the cut at 0:14 is wrong" can't be expressed. |
| The cut list for an edit isn't saved. Only the transcript is. | [src/edit/worker.ts:87](../src/edit/worker.ts#L87) | A timestamp in the edited video can't be mapped back to the source, so "0:14" isn't actionable. |
| Drive intake approves its own edits on purpose. | [src/drive/intake.ts:220](../src/drive/intake.ts#L220) | That's the user's earlier decision. This design leaves it as is, with an opt-in (§10). |

## 2. Decisions

### 2.1 Routing: a FreePoster-owned review bot (recommended)

I read Hermes's installed Telegram adapter (`%LOCALAPPDATA%\hermes\hermes-agent\plugins\platforms\telegram\adapter.py`). What matters:

- Hermes receives updates by **long-polling `getUpdates`** with its bot token. Telegram lets only one `getUpdates` consumer use a token at a time; a second gets 409 Conflict. FreePoster therefore can't also listen on Hermes's bot.
- Hermes's core `CallbackQueryHandler` only handles fixed prefixes (`mp:`, `cp:`, `gt:`, `ea:`, `sc:`, `cl:`, `update_prompt:`) and **silently drops anything else**.
- Plugins *can* add their own button handler: `ctx.register_telegram_handler(factory)` (`hermes_cli/plugins_context.py`, line 654 in the installed copy). It has to be scoped with a `pattern=`, and Hermes moves it ahead of the core catch-all (`_wire_plugin_handlers`).

That gives two workable routes:

| | A. Hermes plugin relays taps | **B. Separate FreePoster bot** |
|---|---|---|
| Chats | One chat with Hermes; cards appear inline in the conversation. | A second chat, e.g. "FreePoster Review". |
| Who receives the tap | Hermes's process (plugin code, not the model), which forwards it to FreePoster over signed HTTP. | FreePoster, from its own `getUpdates` poll. Hermes never sees it. |
| Can an agent fake a tap? | Hermes has shell tools and runs as the same Windows user, so it can read the plugin's shared secret and POST a forged decision to FreePoster. | It would need the review bot's token, which FreePoster stores encrypted with `secret.key` like the platform tokens, and it would need to make Telegram itself deliver a callback from the reviewer's user id. |
| Coupling | Depends on Hermes adapter internals that are changing fast (handler hoisting, issue #87770). Every Hermes update risks breaking approvals. | Depends only on the Telegram Bot API. |
| Redo notes | The plugin must also catch replies before Hermes's text handler, or the model receives them. | Replies go to FreePoster's bot naturally. |

**Choose B.** The point of the gate is that the approval never passes through the agent's process. A is more convenient but brings back the problem the gate exists to solve. Hermes still learns about every decision from FreePoster's webhook events (§8), so it can follow up in the main chat.

What B doesn't defend against: a program running as the same Windows user can read `secret.key`, and then everything. This gate defends against the realistic failures (misreading, injected instructions, confusion, an agent taking a shortcut through `video_path`), not against an agent deliberately decrypting secrets. Closing that gap means running Hermes's tools in a sandbox or as another user, which is outside FreePoster.

### 2.2 `agentApproval` is replaced, not kept beside the gate

- Remove **Let my agent approve**, `approve_production`, and the self-approve branch in `publish_video`.
- Add `request_review`. It is the only way an agent asks for something to be posted.
- When Telegram review is set up, agent calls to `publish_video` **always** create a review instead of a post, including calls with `video_path`. Without that, the bypass in §1 stays open. The tool returns `{ review_id, state: "pending" }`.
- The window keeps its own Approve buttons, because the user is physically present. They write a review row too (`decided_via = "window"`), so the audit (§9) has one source.
- If Telegram review **isn't** set up, agents can't post at all and get: "Ask the user to approve in FreePoster, or set up Telegram review." That's strictly safer than today. It's a behavior change, so the release notes must call it out.

## 3. What the reviewer sees is what gets posted

### 3.1 The master

When a review is requested, FreePoster:

1. Makes the **master**: the platform render (`render()` from [src/media.ts](../src/media.ts)), run once against the edit or production output. This is the file every platform will upload.
2. Hashes it (`master_sha256`) and keeps it at `data/reviews/<sha256>.mp4`. It's never re-encoded after this.
3. Runs every check `publish_video` would (`checkDraft`, as a dry run) against the chosen accounts, caption, title, schedule and TikTok options.
4. Writes the caption with the AI provider **now**, if none was given. Today the caption can be written after the post exists (`captionPending`), so the reviewer would approve a video without seeing its text.

A review covers the whole post: master hash + accounts + caption + title + schedule + TikTok options. Changing any of these needs a new review.

### 3.2 What Telegram can carry

- A bot can upload at most **50 MB** through the cloud Bot API. A 60 s master at 10 Mbit/s (`TARGET.maxBitrate`) can be about 75 MB.
- `sendVideo` content is played back by Telegram's player and may be shown re-compressed. `sendDocument` delivers the bytes unchanged.

So each review sends:

| Message | Contents |
|---|---|
| **Card** (`sendVideo`) | A **viewing copy**: 720×1280, sized to fit under 45 MB, `supports_streaming: true`, with this caption: |
| | `Edit 41 · 38.2 s (was 61.0 s)` · accounts with platform icons, e.g. `TikTok @me · YouTube @me` · `Posts: now` or the schedule time · the caption text, quoted · `File a1b2c3d4…` (first 16 hex digits of `master_sha256`) |
| | Buttons: **Approve** · **Reject** · **Redo** |
| **Exact file** (`sendDocument`, reply to the card) | The master itself, when it's 50 MB or less. Otherwise a note: "The exact file is too big for Telegram (72 MB); the video above is a smaller copy of it. Its fingerprint is a1b2c3d4…" |

Optional later: Telegram's self-hosted Bot API server (`telegram-bot-api`) raises the upload limit to 2000 MB. It's another program to run, so it isn't part of v1.

The guarantee doesn't come from what's on screen. It comes from the hash binding in §5. The viewing copy is for the reviewer's eyes; the hash decides what may be uploaded.

## 4. Data model

### 4.1 New table `reviews`

```sql
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL,          -- 'edit' | 'production' | 'file'
  subject_id INTEGER,                  -- edit or production id; null for 'file'
  revision INTEGER NOT NULL,           -- production revision; 1 for edits and files
  master_path TEXT NOT NULL,
  master_sha256 TEXT NOT NULL,
  post_draft TEXT NOT NULL,            -- JSON: account_ids, caption, title, schedule_at, tiktok
  nonce_hash TEXT NOT NULL,            -- sha256 of the nonce in the buttons
  state TEXT NOT NULL,                 -- pending | approved | rejected | redo | superseded | expired | failed
  expires_at INTEGER NOT NULL,
  chat_id INTEGER, card_message_id INTEGER, file_message_id INTEGER,
  decided_at INTEGER,
  decided_via TEXT,                    -- 'telegram' | 'window'
  decided_by INTEGER,                  -- Telegram from.id
  decision_update_id INTEGER UNIQUE,   -- Telegram update_id of the tap: a repeated update can't decide twice
  reason TEXT,                         -- redo/reject: cuts | captions | framing | sound | zooms | other
  note TEXT,
  at_sec REAL,                         -- redo: time in the edited video
  post_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_review
  ON reviews(subject_kind, subject_id) WHERE state = 'pending';
```

### 4.2 Changes to existing tables

- `posts`: add `review_id` and `approved_sha256`.
- `jobs.progress`: the runner records `uploadedSha256` before each upload (§6.2).
- `edits`: add the states `rejected` and `superseded`, plus `parent_edit_id` and `cuts_path`.
- `productions`: add the state `rejected`.
- `prefs`: add `telegram_offset` (the last `update_id` handled), plus the paired `chat_id` and `user_id`.

### 4.3 State changes

```
review:   pending ──Approve──► approved ──(post created)
             │ ──Reject───► rejected
             │ ──Redo─────► redo        (subject is revised, and a new review follows)
             │ ──subject changed / new review──► superseded
             │ ──expires_at passed──► expired
             └ ──Approve, but checks now fail──► failed (with error; card offers Redo)

edit:        ready ─► rejected | superseded (by a child edit from revise_edit)
production:  ready ─► rejected            (revise_production still bumps the revision as today)
```

Every change is one guarded `UPDATE … WHERE id = ? AND state = 'pending'`. If it changes 0 rows, the decision was already made, and the tap gets "Already decided".

## 5. Buttons and taps

### 5.1 `callback_data`

Telegram allows 1–64 bytes. Format: `fp:<a|r|d>:<review_id>:<nonce>`, where the nonce is 12 random bytes in base64url (16 characters). That comes to about 30 bytes. Only `sha256(nonce)` is stored, so reading the database doesn't give you a working button.

### 5.2 Checking a tap (in order; the first failure answers and stops)

1. `update_id` is at or below `telegram_offset`, or is already in `decision_update_id` → ignore. Telegram redelivers updates if the offset wasn't confirmed.
2. `callback_query.from.id` ≠ paired `user_id`, or `message.chat.id` ≠ paired `chat_id` → "Not yours". Log it.
3. The prefix or the format is wrong → ignore.
4. The review doesn't exist, or `sha256(nonce)` ≠ `nonce_hash` → "This button isn't valid".
5. `expires_at` has passed → mark expired, then "Expired: ask Hermes to send it again".
6. The subject's current revision ≠ `revision`, or the edit is superseded → mark superseded, then "There's a newer version below".
7. The file at `master_path` no longer hashes to `master_sha256` → mark failed, then "The file changed; send it again".
8. Do the guarded state change (§4.3).

Call `answerCallbackQuery` right after step 8, before any slow work, so the button spinner stops. Then call `editMessageReplyMarkup` to remove the buttons, and `editMessageCaption` to add the outcome line, e.g. `✅ Approved 14:02 · post 88`. The chat history then shows what was decided.

### 5.3 Polling

- Long-poll `getUpdates?offset=<telegram_offset+1>&timeout=50&allowed_updates=["callback_query","message"]`.
- Save the offset only **after** an update has been handled and committed. A crash in between redelivers the update, and step 1 plus the unique `decision_update_id` make that harmless.
- Telegram keeps undelivered updates for 24 hours, so taps made while FreePoster is closed are handled when it starts, within that window.
- Outgoing sends (cards, files, edits to cards) go through the existing outbox pattern from [src/notify.ts](../src/notify.ts), with its own Telegram outbox and the same retry and backoff. Sends keep working if Telegram is briefly down.

## 6. Flows

### 6.1 Request

`request_review({ edit_id | production_id | video_path, account_ids, caption?, title?, schedule_at?, tiktok?, expires_in_hours? = 72 })`

1. The subject must be `ready`.
2. Make the master, run the checks, write the caption (§3.1). Problems come back to the agent right away, as today.
3. Mark any older pending review for the same subject `superseded`, and edit its card.
4. Insert the review and queue the card and file sends.
5. Return `{ review_id, state: "pending", master_sha256 }`.

Optional setting **Send edits for review automatically**: when an edit or production becomes ready and its spec or Drive file names accounts, FreePoster requests the review itself, so Hermes isn't needed to start one.

### 6.2 Approve

1. Tap checked (§5.2) → `approved`.
2. Re-run `checkDraft` with the stored draft. An account may have been disconnected since. If it fails → `failed` with the reason on the card, and only **Redo** offered.
3. `createPost` with `sourcePath = master_path`, `sha256 = master_sha256`, `approved_sha256 = master_sha256`, `review_id`.
4. Mark the edit or production approved (`approveEdit` / `productions.approve`) with the new post id.
5. Queue the `review.approved` event to Hermes.

Runner changes in [src/runner.ts](../src/runner.ts) `renderFor`: when `post.approved_sha256` is set, use `master_path` as it is. Don't call `render()` again; the master already is the render. Check the file with `probe` + `specProblems`, hash it, and refuse with `FatalError("the approved file changed; send it for review again")` if the hash isn't `approved_sha256`. Record `uploadedSha256` in `jobs.progress` before the publisher reads a single chunk.

### 6.3 Reject

Tap → one row of reason buttons (`Cuts · Captions · Framing · Sound · Zooms · Other · No reason`) → `rejected`. The edit or production becomes `rejected`, which can't be posted, and the `review.rejected` event goes to Hermes with the reason. Rejecting never starts any work.

### 6.4 Redo

Tap **Redo** → the same reason buttons → a `force_reply` prompt: "What should change? Put a time like 0:14 if it's one spot." The reply is matched to the review by `reply_to_message.message_id`. FreePoster pulls out a time (`m:ss` or `ss s`) and stores `reason`, `note`, `at_sec`. The review becomes `redo`, and `review.redo` goes to Hermes with:

- for **edits**: `at_sec` mapped back to the source time through the saved cut list (§7), the words spoken in ±2 s, and a suggested settings change when the reason is a single toggle (`zooms` → `punchIn: false`, `framing` → `reframe: false`, `sound` → `audio: false`);
- for **productions**: the shot playing at `at_sec`, worked out from the assembled shot lengths, and its spec.

Hermes, meaning the model, turns that into `revise_edit` or `revise_production`. A redo can't post anything, so it's safe to let the model interpret it. When the new version is ready, a new review follows (§6.1). That's the whole loop.

## 7. Redo needs two new edit capabilities

1. **Save the cut list.** When an edit renders, write `planCuts`' segments to `data/edits/<key>.cuts.json` and set `cuts_path`. Time in the edited video then maps to source time through the segments.
2. **`revise_edit(edit_id, settings)`** makes a child edit (`parent_edit_id`) with the new settings and marks the parent `superseded`. Two new settings make timestamped notes actionable:
   - `keep: [{ start, end }]` and `drop: [{ start, end }]` in source seconds. They override `planCuts` inside those ranges.
   - `captionFixes: [{ at, from, to }]`: replace a misheard word at a source time before `buildAss`.

   Both go into `editKey`, so caching still works. Transcription is cached per source file, so a revised edit re-renders but doesn't transcribe again. (A production already re-renders only the changed shots, through `revise_production`.)

## 8. Hermes changes

- New `EventType`s in [src/notify.ts](../src/notify.ts): `review.sent`, `review.approved`, `review.rejected`, `review.redo`, `review.failed`, `review.expired`.
- New MCP tools: `request_review`, `get_review`, `revise_edit`. Removed: `approve_production`. Changed: `publish_video` (§2.2). The instructions text in [src/mcp.ts](../src/mcp.ts) and `PRODUCTION_INSTRUCTIONS` changes to match: "You can't approve. Ask for a review; the user decides on Telegram."
- [docs/hermes.md](hermes.md): replace §3 "Approving from chat". New route prompt:

```yaml
events: ["production.ready", "production.failed", "edit.ready", "edit.failed",
         "review.sent", "review.approved", "review.rejected", "review.redo", "review.failed", "review.expired",
         "post.done", "test"]
prompt: |
  FreePoster says ({event_type}): {summary}
  For production.ready / edit.ready: call request_review with the accounts and caption we discussed. Don't send the video yourself; FreePoster sends it for review.
  For review.redo: call get_review, turn the note into revise_edit or revise_production, and tell me what you changed.
  For review.rejected: acknowledge it and ask if I want something different.
  You can't approve anything. If I say "yes" in this chat, tell me to tap Approve on the review message.
```

## 9. How we'll know it's right, without trusting either of us

### 9.1 Replay tests on real Telegram updates

During development, record real `Update` JSON from the review bot (one tap of each button, a reply, a tap from a second account, a second chat) into `test/fixtures/telegram/`. Tests feed them to `TelegramReview.handleUpdate(update)` with a stub Bot API `fetch`, the same pattern `Notifier` uses in [test/notify.test.ts](../test/notify.test.ts). Each test checks the database, not log text:

| Test | Expected |
|---|---|
| The same Approve update delivered twice | One post; the second delivery changes nothing. |
| Approve tapped twice (two `update_id`s) | One post; the second gets "Already decided". |
| Approve, then Reject on the same card | Stays approved; Reject is refused. |
| Approve on an old card after `revise_production` | No post; the review becomes `superseded`. |
| A tap from another user id, or the right user in another chat | No change; "Not yours". |
| Forged `callback_data`: wrong nonce, other review id, bad format | No change. |
| A tap after `expires_at` | `expired`, no post. |
| The master overwritten after the review | Approve → `failed`; and a post made before the overwrite is refused by the runner. |
| Hermes calls `publish_video(video_path=<production final.mp4>)` | A pending review, **no post row**. |
| Hermes calls `publish_video(edit_id)` while the user says "yes" in text | A pending review, no post. `approve_production` no longer exists. |
| Redo "the cut at 0:14 is wrong" | `at_sec = 14`, mapped to the right source time through the saved cut list; `review.redo` sent. |
| `revise_production` changing one shot after a Redo | Only that shot renders again (an existing test pattern in [test/produce-worker.test.ts](../test/produce-worker.test.ts)). |
| FreePoster restarted between a tap and saving the offset | The update is handled once. |

### 9.2 The audit check

`freeposter audit-reviews` (CLI and window) checks every published job and fails loudly on any of these:

- the job's post has no `review_id` and wasn't made in the window or by Drive intake;
- `jobs.progress.uploadedSha256` ≠ the review's `master_sha256`;
- the review's `decided_via` is missing, or it was decided after the job ran.

This compares records written at different moments by different code paths: the review at tap time, the runner just before upload. Note: the platforms re-encode what they receive, so the hash can be checked only on the FreePoster side, at the moment of upload. That's the strongest check available.

### 9.3 Telegram's own history

Every decided card in the review chat shows no buttons and an outcome line. A pending card older than its expiry means the expiry job is broken. One look at the chat confirms it.

## 10. Setup and rollout

1. **Setup → Telegram review**: paste a token from @BotFather. FreePoster shows a 6-digit code; send `/start <code>` to the new bot. FreePoster records that message's `chat.id` and `from.id`. Only a message with the right code pairs, so a stranger who finds the bot can't. Send a test card.
2. **Phase 1**: reviews for edits and productions; the master, hash binding and runner check; Approve and Reject; the `publish_video` change; replacing agent approval; tests in §9.1 except redo.
3. **Phase 2**: Redo with reasons and notes; saving the cut list; `revise_edit` with `keep`, `drop` and `captionFixes`; the Hermes route update.
4. **Phase 3**: the audit command; **Send edits for review automatically**; an opt-in setting to route Drive intake through review instead of auto-approving.

## 11. Open questions

- **Expiry default**: 72 hours, or the scheduled time when that's sooner? A scheduled post approved days early should still post the approved file, which the hash check already guarantees.
- **Several reviewers**: v1 pairs one Telegram user. Supporting more would mean a list of `from.id`s, and a decision about whether one approval is enough.
- **Hermes-only users who don't want a second chat**: route A (the plugin relay) could be offered later as a weaker, clearly labeled option. I'd rather not build it until someone asks.
