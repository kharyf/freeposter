"""FreePoster review relay for Hermes Agent's Telegram bot.

FreePoster sends videos for review through this bot with Approve / Reject / Redo buttons. Telegram lets only one
program read a bot's updates, and that is Hermes, so this plugin takes just FreePoster's part of them:

  - button taps whose data starts with "fp:",
  - replies to FreePoster's redo prompts (bot messages starting with the redo marker),
  - the /freeposter command (pairing the chat with FreePoster),

and posts each raw update to FreePoster, signed with the shared secret in settings.json (hex HMAC-SHA256 of
"<timestamp>.<body>"). Hermes's model never sees them, and nothing the model does can make one: FreePoster also
checks every tap with Telegram itself before it counts.

settings.json is written by FreePoster's setup (Setup > Production tools > Review on Telegram > Install).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

REDO_MARKER = "\U0001F501 FreePoster redo"
SETTINGS = Path(__file__).with_name("settings.json")


def _settings() -> dict:
    with open(SETTINGS, encoding="utf-8") as f:
        data = json.load(f)
    if not data.get("url") or not data.get("secret"):
        raise ValueError("settings.json needs url and secret; install the plugin again from FreePoster's setup")
    return data


def _forward(update: dict) -> None:
    """POSTs one update to FreePoster; raises on anything but a 2xx answer."""
    settings = _settings()
    body = json.dumps(update, separators=(",", ":"), ensure_ascii=False)
    ts = str(int(time.time()))
    sig = hmac.new(settings["secret"].encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        settings["url"],
        data=body.encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Webhook-Timestamp": ts, "X-Webhook-Signature-V2": sig},
    )
    with urllib.request.urlopen(req, timeout=20) as res:  # noqa: S310 (FreePoster's own local address)
        if res.status // 100 != 2:
            raise RuntimeError(f"FreePoster answered {res.status}")


def register(ctx) -> None:
    def factory(app, adapter) -> None:
        from telegram.ext import CallbackQueryHandler, CommandHandler, MessageHandler, filters

        class _RedoReply(filters.MessageFilter):
            """A reply to one of FreePoster's redo prompts."""

            def filter(self, message) -> bool:
                parent = getattr(message, "reply_to_message", None)
                author = getattr(parent, "from_user", None)
                return bool(parent and author and author.is_bot and (parent.text or "").startswith(REDO_MARKER))

        async def relay(update, context) -> None:
            try:
                await asyncio.to_thread(_forward, update.to_dict())
            except Exception as exc:  # FreePoster closed, or the plugin isn't set up
                logger.warning("freeposter-review: couldn't reach FreePoster: %s", exc)
                query = getattr(update, "callback_query", None)
                if query is not None:
                    try:
                        await query.answer("FreePoster isn't reachable. Is it running? Tap again once it is.")
                    except Exception:
                        pass
                elif update.effective_message is not None:
                    try:
                        await update.effective_message.reply_text("FreePoster isn't reachable. Is it running? Send it again once it is.")
                    except Exception:
                        pass

        # Scoped, so Hermes's own buttons and messages are untouched; Hermes places these ahead of its catch-alls.
        app.add_handler(CallbackQueryHandler(relay, pattern=r"^fp:"))
        app.add_handler(CommandHandler("freeposter", relay))
        app.add_handler(MessageHandler(filters.REPLY & filters.TEXT & _RedoReply(), relay))

    ctx.register_telegram_handler(factory)
