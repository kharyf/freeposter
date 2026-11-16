// Fancy graphic: a number counting up, with an optional prefix and suffix, over a short label.
import { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Palette = { ink: string; ink2: string; yellow: string; gold: string; cream: string; shadowAlpha: number };
type Props = { palette: Palette; fontUrl: string; italicFontUrl: string; value: number; prefix: string; suffix: string; label: string };

const FAMILY = "Fancy Playfair";
const OUT = Easing.bezier(0.16, 1, 0.3, 1);

function Fonts({ fontUrl, italicFontUrl }: { fontUrl: string; italicFontUrl: string }) {
  const [handle] = useState(() => delayRender("Loading Playfair Display"));
  useEffect(() => {
    Promise.all([document.fonts.load(`italic 700 64px "${FAMILY}"`), document.fonts.load(`italic 400 64px "${FAMILY}"`)]).finally(() => continueRender(handle));
  }, [handle]);
  return (
    <style>{`
      @font-face { font-family: "${FAMILY}"; src: url("${staticFile(fontUrl)}") format("truetype"); font-style: italic; font-weight: 700; }
      @font-face { font-family: "${FAMILY}"; src: url("${staticFile(italicFontUrl)}") format("truetype"); font-style: italic; font-weight: 400; }
    `}</style>
  );
}

const decimals = (v: number) => Math.min(2, (String(v).split(".")[1] ?? "").length);
/** A symbol ("$", "×", "%") sits large beside the number; a word ("k a month") smaller. */
const affixScale = (s: string) => (s.length <= 2 ? 0.7 : 0.42);

export default function Shot({ palette: p, fontUrl, italicFontUrl, value, prefix = "", suffix = "", label }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = (sec: number) => sec * fps;
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

  // In over the first half second; the count runs on to about 1.4 s; a slow push carries to the end.
  const enter = interpolate(frame, [0, t(0.5)], [0, 1], { ...clamp, easing: OUT });
  const counted = interpolate(frame, [t(0.1), Math.min(t(1.4), durationInFrames * 0.6)], [0, value], { ...clamp, easing: Easing.out(Easing.cubic) });
  const push = interpolate(frame, [0, durationInFrames], [1, 1.045], clamp);
  const rule = interpolate(frame, [t(0.2), t(0.7), durationInFrames], [0, 300, 380], { ...clamp, easing: Easing.out(Easing.quad) });
  const labelIn = interpolate(frame, [t(0.25), t(0.65)], [0, 1], { ...clamp, easing: OUT });
  const glow = interpolate(frame, [0, durationInFrames], [0.1, 0.18], clamp);

  const shown = counted.toLocaleString("en-US", { minimumFractionDigits: decimals(value), maximumFractionDigits: decimals(value) });
  const final = value.toLocaleString("en-US", { minimumFractionDigits: decimals(value), maximumFractionDigits: decimals(value) });
  // Sized for the final number, so the line doesn't grow while it counts.
  const units = final.length + affixScale(prefix) * prefix.length + affixScale(suffix) * suffix.length;
  const size = Math.min(340, 900 / (0.62 * Math.max(units, 1)));
  const shadow = `0 6px 24px rgba(0,0,0,${p.shadowAlpha})`;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.ink} 0%, ${p.ink2} 100%)`, fontFamily: `"${FAMILY}", serif`, fontStyle: "italic" }}>
      <Fonts fontUrl={fontUrl} italicFontUrl={italicFontUrl} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 45% at 50% 46%, ${p.gold}${Math.round(glow * 255).toString(16).padStart(2, "0")} 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 72, transform: `scale(${push})` }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", whiteSpace: "nowrap", opacity: enter, transform: `translateY(${(1 - enter) * 40}px)`, textShadow: shadow }}>
          {prefix && <span style={{ color: p.gold, fontWeight: 700, fontSize: size * affixScale(prefix), marginRight: size * 0.06 }}>{prefix}</span>}
          <span style={{ color: p.yellow, fontWeight: 700, fontSize: size, lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{shown}</span>
          {suffix && <span style={{ color: p.gold, fontWeight: 700, fontSize: size * affixScale(suffix), marginLeft: size * 0.06 }}>{suffix}</span>}
        </div>
        <div style={{ width: rule, height: 3, background: p.gold, margin: "28px 0 32px", borderRadius: 2 }} />
        <div style={{ color: p.cream, fontWeight: 400, fontSize: 54, lineHeight: 1.25, textAlign: "center", maxWidth: 880, opacity: labelIn, transform: `translateY(${(1 - labelIn) * 24}px)`, textShadow: shadow }}>
          {label}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
