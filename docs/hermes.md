# Using FreePoster from Hermes Agent

Hermes is your only point of contact: you ask it for a video in chat, it writes a production spec, FreePoster renders and previews it, Hermes shows you the preview, and FreePoster posts it once you say yes. Two pieces of Hermes config do this: FreePoster as an MCP server, and one webhook route so FreePoster can tell Hermes when something is done.

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
          events: ["production.ready", "production.failed", "edit.ready", "edit.failed", "post.done", "test"]
          prompt: |
            FreePoster says ({event_type}): {summary}
            Use the freeposter MCP tools for details (get_production, get_edit, get_post).
            For production.ready: download its preview_url, send me the preview with this summary, and wait for my yes before approve_production.
            For a failure: tell me what failed and offer to fix the spec with revise_production.
            For post.done: send me the links.
          deliver: telegram
```

`deliver: telegram` sends Hermes's reply to your Telegram home channel.

In FreePoster, open **Setup → Production tools**:

- **Webhook address**: `http://localhost:8644/webhooks/freeposter`
- **Webhook secret**: the same text as the route's `secret`
- **Send a test event**: Hermes should message you on Telegram.

FreePoster signs every event with Hermes's generic HMAC scheme (`X-Webhook-Timestamp` and `X-Webhook-Signature-V2`, the hex HMAC-SHA256 of `"<timestamp>.<body>"`), and puts the event name in `event_type`.

## 3. Approving from chat

By default you approve videos in the FreePoster window. To approve from Telegram instead, set **Let my agent approve** to **On** in **Setup → Production tools**. Hermes then posts a production (or an edit) only after it has shown you the preview and you've said yes. No agent can change this setting.

## Without the webhook

Everything still works; Hermes just has to ask. The CLI can wait without spending any model turns:

```bash
freeposter production 12 --watch
```

## The CLI

The installed app ships the CLI in `%LOCALAPPDATA%\Programs\FreePoster\resources\app.asar.unpacked\cli\`. To run it from anywhere, add that folder to your PATH, or from a source checkout run `npm run cli -- <command>`. `freeposter help` lists the commands. It needs Node 24 or later on PATH.
