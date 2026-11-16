// Fancy graphic: two to four short items appearing one by one; the newest in yellow, the earlier ones in cream.
import { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, interpolateColors, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Palette = { ink: string; ink2: string; yellow: string; gold: string; cream: string; shadowAlpha: number };
type Props = { palette: Palette; fontUrl: string; italicFontUrl: string; items: string };

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

export default function Shot({ palette: p, fontUrl, italicFontUrl, items }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const list = items.split("|").map((s) => s.trim()).filter(Boolean);
  const n = list.length;

  // The first item is in by 0.5 s; the rest follow, all in by about 60% of the clip; then a slow push.
  const gap = Math.min(0.7 * fps, (durationInFrames * 0.6 - 0.5 * fps) / Math.max(1, n - 1));
  const at = (i: number) => Math.round(0.05 * fps + i * gap);
  const push = interpolate(frame, [0, durationInFrames], [1, 1.04], clamp);
  const longest = Math.max(...list.map((s) => s.length));
  const size = Math.min(n <= 2 ? 104 : 88, 820 / (0.46 * Math.max(longest, 1)));
  const row = Math.min(190, 760 / n);
  const shadow = `0 5px 20px rgba(0,0,0,${p.shadowAlpha})`;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.ink} 0%, ${p.ink2} 100%)`, fontFamily: `"${FAMILY}", serif`, fontStyle: "italic" }}>
      <Fonts fontUrl={fontUrl} italicFontUrl={italicFontUrl} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 55% 50% at 50% 50%, ${p.gold}1c 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `scale(${push})` }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {list.map((item, i) => {
            const enter = interpolate(frame, [at(i), at(i) + 0.5 * fps], [0, 1], { ...clamp, easing: OUT });
            const rule = interpolate(frame, [at(i) + 0.15 * fps, at(i) + 0.7 * fps], [0, 1], { ...clamp, easing: Easing.out(Easing.quad) });
            // Yellow while it's the newest, then settling to cream as the next one arrives.
            const settle = i < n - 1 ? interpolate(frame, [at(i + 1), at(i + 1) + 0.4 * fps], [0, 1], clamp) : 0;
            return (
              <div key={i} style={{ height: row, display: "flex", flexDirection: "column", justifyContent: "center", opacity: enter, transform: `translateX(${(1 - enter) * -48}px)` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
                  <div style={{ width: 18, height: 18, background: p.gold, transform: `rotate(45deg) scale(${enter})`, flex: "none" }} />
                  <div style={{ color: interpolateColors(settle, [0, 1], [p.yellow, p.cream]), fontWeight: 700, fontSize: size, lineHeight: 1.1, whiteSpace: "nowrap", textShadow: shadow }}>{item}</div>
                </div>
                <div style={{ height: 2, marginTop: 18, marginLeft: 52, width: `${rule * 100}%`, background: `linear-gradient(90deg, ${p.gold}, ${p.gold}00)`, opacity: 0.7 }} />
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
