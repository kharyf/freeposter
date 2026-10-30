import type { Platform } from "../types.ts";
import type { Publisher } from "./base.ts";
import { facebook } from "./facebook.ts";
import { instagram } from "./instagram.ts";
import { tiktokPublisher } from "./tiktok.ts";
import { x } from "./x.ts";
import { youtube } from "./youtube.ts";

export const publishers: Record<Platform, Publisher> = {
  tiktok: tiktokPublisher,
  instagram,
  facebook,
  x,
  youtube,
};
