# Using FreePoster from Hermes Agent

Hermes works with FreePoster the same way every agent does: the MCP server, the event feed and, optionally, a webhook ([agents.md](agents.md)). This page is the Hermes-specific setup. Because Hermes runs all the time, it can take FreePoster's events as a webhook and act on them at once. It also has a ready-made plugin for getting reviews in the chat you already have with it.

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

FreePoster's MCP server is lean by default: Hermes sees two tools, `fp` and `fp_help`, which reach every FreePoster op, and costs about 0.5k tokens a session instead of about 10k. To have every tool typed, use `url: http://localhost:4400/mcp?profile=full`; for an exact set, `?tools=list_events,request_review,get_review` (comma-separated tool names). If Hermes can run shell commands, `curl http://localhost:4400/agent/v1` and `POST /agent/v1/<op>` cost even less ([agents.md](agents.md#1-the-mcp-server-the-api-and-the-command-line)).

Restart Hermes. Ask it "what can FreePoster make?" and it should call `fp_help` and then `describe_production_tools` through `fp`. With only this step, Hermes already hears what happened whenever you talk to it, through `list_events`. The webhook below makes it react without waiting for you.

## 2. The webhook route (optional)

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
            Read fp_help topic "events" once to see how to handle this event, then call the ops through
            fp(op, args) (get_production, get_edit, get_review, get_post, request_review, revise_edit,
            revise_production). If your Hermes uses ?profile=full, those are separate typed tools instead.
            Don't send me the video yourself: FreePoster sends it for review. You can't approve anything;
            if I say "yes" here, remind me to tap Approve on the review.
          deliver: telegram
```

`deliver: telegram` sends Hermes's reply to your Telegram home channel.

In FreePoster, open **Setup → Production tools → Your agent**:

- Click **Fill in Hermes Agent's address** (`http://localhost:8644/webhooks/freeposter`).
- **Webhook secret**: the same text as the route's `secret`.
- **Send a test event**: Hermes should message you on Telegram.

Hermes checks the `X-Webhook-Signature-V2` signature, one of the two FreePoster sends ([agents.md](agents.md#3-a-webhook-optional)).

## Reviews on Hermes's Telegram bot

Telegram lets only one program read a bot's messages, and for your bot that's Hermes. FreePoster still sends reviews with the same bot, and the `freeposter-review` plugin is the relay ([agents.md](agents.md#the-bot-your-agent-already-uses-one-chat)). It passes FreePoster's part of the incoming messages straight to FreePoster: taps on its buttons (`fp:…`), replies to its redo prompts, `/freeposter <code>` and `/stop` (the campaign kill switch). Hermes's model never sees them, and everything else in the chat stays Hermes's.

1. In **Setup → Production tools → Review on Telegram**, choose **The bot my agent already talks to me through**, paste Hermes's `TELEGRAM_BOT_TOKEN` (from `%LOCALAPPDATA%\hermes\.env`), and click **Connect**.
2. Under **Hermes Agent plugin**, click **Install the plugin**. FreePoster copies it to `%LOCALAPPDATA%\hermes\plugins\freeposter-review` with the relay's address and secret (`settings.json`).
3. Enable it and restart Hermes:

   ```bash
   hermes plugins enable freeposter-review
   ```

4. Send the pairing command FreePoster shows (`/freeposter 123456`) to the bot, in your private chat with it. Only that chat and your Telegram account can decide reviews from then on.
5. **Send a test message**.

One limit to know: Hermes runs as your Windows user and can run commands, so something steering it could in principle edit the plugin. FreePoster's checks stop it from approving with a made-up tap ([agents.md](agents.md#the-bot-your-agent-already-uses-one-chat)). Changing what a real tap does would mean altering the plugin's code. If that matters to you, use a separate bot instead.

## Without the webhook

Everything still works: Hermes reads the event feed whenever you talk to it, and the CLI can wait without spending any model turns:

```bash
freeposter events --watch
freeposter production 12 --watch
```
