# Using FreePoster from Hermes Agent

Hermes is your point of contact: you ask it for a video in chat, it makes it with FreePoster (an edit or a production), and asks FreePoster to send it to you for review. FreePoster sends the exact file that would post to your Telegram chat with **Approve**, **Reject** and **Redo** buttons. Only your tap posts it: Hermes can't, and saying "yes" to Hermes doesn't. A redo goes back to Hermes with your reason and note, and the new version comes back to you for review.

Three pieces of Hermes config do this: FreePoster as an MCP server, one webhook route so FreePoster can tell Hermes when something happens, and (when reviews come through Hermes's own Telegram bot) the `freeposter-review` plugin.

Hermes and FreePoster both run on this Windows computer, so everything below uses `localhost`.

## 1. FreePoster as an MCP server

In Hermes's `config.yaml` (`%LOCALAPPDATA%\hermes\config.yaml`), under `mcp_servers`:

```yaml
mcp_servers:
  freeposter:
    url: http://localhost:4400/mcp
    enabled: true
```

If you set an app password in FreePoster, add it as HTTP Basic auth (any user name):

```yaml
    headers:
      Authorization: "Basic <base64 of freeposter:YOUR_APP_PASSWORD>"
```

Downloading a preview (`preview_url`) needs the same header when a password is set.

Restart Hermes. Ask it "what can FreePoster make?" and it should call `describe_production_tools`.

## 2. The webhook route

Turn on Hermes's webhook adapter, in `%LOCALAPPDATA%\hermes\.env`:

```bash
WEBHOOK_ENABLED=true
```

Then add a route in `config.yaml`. Pick any long random text for the secret, and use the same text in FreePoster:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        freeposter:
          secret: "the-same-long-random-text-as-in-freeposter"
          events: ["production.ready", "production.failed", "edit.ready", "edit.failed",
                   "review.waiting", "review.approved", "review.rejected", "review.redo", "review.failed", "review.expired",
                   "post.done", "test"]
          prompt: |
            FreePoster says ({event_type}): {summary}
            Use the freeposter MCP tools for details (get_production, get_edit, get_review, get_post).
            For production.ready or edit.ready: call request_review with the accounts and caption we agreed on, unless the summary says FreePoster sends it for review itself (Drive videos). Don't send me the video yourself: FreePoster sends it for review.
            For review.redo: if handled_by is "freeposter", just tell me in one line what FreePoster is changing. Otherwise call get_review, make the change with revise_edit or revise_production, and tell me in one line what you changed.
            For review.rejected: acknowledge it and ask whether I want something different.
            For review.failed: tell me why and offer to fix it.
            For a production or edit failure: tell me what failed and offer to fix it.
            For post.done: send me the links.
            You can't approve anything. If I say "yes" here, remind me to tap Approve on the review.
          deliver: telegram
```

`deliver: telegram` sends Hermes's reply to your Telegram home channel.

In FreePoster, open **Setup → Production tools**:

- **Webhook address**: `http://localhost:8644/webhooks/freeposter`
- **Webhook secret**: the same text as the route's `secret`
- **Send a test event**: Hermes should message you on Telegram.

FreePoster signs every event with Hermes's generic HMAC scheme (`X-Webhook-Timestamp` and `X-Webhook-Signature-V2`, the hex HMAC-SHA256 of `"<timestamp>.<body>"`), and puts the event name in `event_type`.

## 3. Reviews on Telegram

In FreePoster, open **Setup → Production tools → Review on Telegram**.

### With the bot Hermes already uses (one chat)

Telegram lets only one program read a bot's messages, and for your bot that's Hermes. FreePoster still sends reviews with the same bot, and a small Hermes plugin passes FreePoster's part of the incoming messages straight to FreePoster: taps on its buttons (`fp:…`), replies to its redo prompts, and `/freeposter <code>`. Hermes's model never sees them, and everything else in the chat stays Hermes's.

1. Choose **The bot Hermes already talks to me through**, paste Hermes's `TELEGRAM_BOT_TOKEN` (from `%LOCALAPPDATA%\hermes\.env`), and click **Connect**.
2. Click **Install the plugin**. FreePoster copies it to `%LOCALAPPDATA%\hermes\plugins\freeposter-review` with its address and a secret of its own (`settings.json`).
3. Enable it and restart Hermes:

   ```bash
   hermes plugins enable freeposter-review
   ```

4. Send the pairing command FreePoster shows (`/freeposter 123456`) to the bot, in your private chat with it. Only that chat and your Telegram account can decide reviews from then on.
5. **Send a test message**.

How a tap is checked: the plugin signs what it passes on (the same HMAC scheme as the webhook, with the plugin's secret), and FreePoster also asks Telegram to confirm the tap (`answerCallbackQuery` only succeeds for a tap Telegram really delivered). Then the tap must come from your account in your chat, carry the current buttons' one-time code, and the review must still be waiting, current and unexpired.

One limit to know: Hermes runs as your Windows user and can run commands, so something steering it could in principle edit the plugin. The checks above stop it from approving with a made-up tap. Changing what a real tap does would mean altering the plugin's code. If that matters to you, use a separate bot.

### With a separate bot (two chats)

Make a bot with @BotFather, choose **A separate bot only FreePoster uses**, paste its token, and send it the 6-digit code. FreePoster reads that bot's messages itself, so taps never pass through Hermes at all. Reviews arrive in that chat, not in your chat with Hermes.

### What you see

Each review is a message with the video, who it posts to and when, the caption, the start of the file's fingerprint (SHA-256), and the buttons. The exact file follows as a document when it's 50 MB or less (Telegram's limit for bots); otherwise the video is a smaller copy and the message says so. The fingerprint is what decides what posts: FreePoster uploads that exact file, and refuses if it changed.

- **Approve** posts it (or schedules it).
- **Reject** asks why (optional). Nothing is posted.
- **Redo** asks what kind of change (cuts, captions, framing, sound, zooms, something else), then asks you to reply with a note (add a time like 0:14 for one spot). Hermes gets it, makes the change, and the new version comes to you as a new review.

Reviews also wait in the FreePoster window, under **Waiting for your review**, with the same three buttons. A review expires after 72 hours, or at the post's scheduled time if that's sooner (Drive videos: always 72 hours).

### Videos from your Google Drive folder

Every video FreePoster edits from the watched Drive folder comes to you as a review before anything posts:

1. You upload `Gatekeeping_11.9.26_5.30.pm.mp4` to the folder. FreePoster downloads it, edits it, and writes its caption.
2. The edit arrives as a review card (in your Hermes chat with the plugin, or in the separate bot's chat), covering your **Default** accounts, the caption, and the time in the file name.
3. **Approve** schedules it for that time, or posts it at once if the time has passed. **Reject** posts nothing, and the Drive list shows **Rejected**. **Redo** makes a new edit, which comes to you as a new review:
   - If you pick Zooms, Framing or Sound and reply `go` with no note, FreePoster switches that setting off and makes the new edit itself.
   - Anything else (cuts, captions, or any note) goes to Hermes as `review.redo`, with the time you named mapped to the source video and the words said there. Hermes calls `revise_edit`, and FreePoster sends the new edit back for review. Hermes doesn't call `request_review` for Drive videos.

If a review expires without a decision, the Drive list shows **Not reviewed** with **Send for review again**. Videos whose name ends in `_RAW` were edited elsewhere: they skip both the edit and the review, and post as uploaded.

`freeposter audit` (or the `audit_reviews` tool) checks every published post: each one an agent asked for was approved by you before it was made, and every account uploaded the exact file you approved.

## Without the webhook

Everything still works; Hermes just has to ask. The CLI can wait without spending any model turns:

```bash
freeposter production 12 --watch
freeposter reviews 7
```

## The CLI

The installed app ships the CLI in `%LOCALAPPDATA%\Programs\FreePoster\resources\app.asar.unpacked\cli\`. To run it from anywhere, add that folder to your PATH, or from a source checkout run `npm run cli -- <command>`. `freeposter help` lists the commands. It needs Node 24 or later on PATH.
