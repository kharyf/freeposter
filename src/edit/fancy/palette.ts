// The Fancy editing style's colours and font. Captions, graphics and covers all draw from here.
import { join } from "node:path";
import { codeDir } from "../../config.ts";

export const PALETTE = {
  ink: "#14110F",
  ink2: "#241D15",
  yellow: "#FFD23F",
  gold: "#E8B923",
  cream: "#FFF4D6",
  /** Drop shadows are black at this opacity. */
  shadowAlpha: 0.6,
} as const;

export const FONT_FAMILY = "Playfair Display";

/** An ASS colour (&HAABBGGRR) from "#RRGGBB". `alpha` is opacity 0..1; ASS stores transparency, so 1 is 00. */
export function assHex(hex: string, alpha = 1): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const a = Math.round((1 - Math.min(1, Math.max(0, alpha))) * 255).toString(16).padStart(2, "0");
  return `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

/** The shipped fonts. In the installed app they are unpacked beside app.asar, since ffmpeg/libass read them as files. */
export const fancyFontDir = () => join(codeDir.replace(/app\.asar$/, "app.asar.unpacked"), "assets", "fonts", "fancy");

export const fancyFontFile = (weight: "italic" | "boldItalic") =>
  join(fancyFontDir(), weight === "italic" ? "PlayfairDisplay-Italic.ttf" : "PlayfairDisplay-BoldItalic.ttf");
