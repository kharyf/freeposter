// Fancy graphic: a phrase in big italic serif behind a gold quotation mark, with a hand-drawn gold underline.
import { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Palette = { ink: string; ink2: string; yellow: string; gold: string; cream: string; shadowAlpha: number };
type Props = { palette: Palette; fontUrl: string; italicFontUrl: string; quote: string };

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

const sizeFor = (s: string) => (s.length <= 20 ? 104 : s.length <= 40 ? 88 : s.length <= 60 ? 74 : 64);

export default function Shot({ palette: p, fontUrl, italicFontUrl, quote }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const t = (sec: number) => sec * fps;
  const words = quote.trim().split(/\s+/);
  const stagger = Math.min(0.06 * fps, (0.35 * fps) / Math.max(1, words.length - 1));
  const size = sizeFor(quote);

  const mark = interpolate(frame, [0, t(0.45)], [0, 1], { ...clamp, easing: OUT });
  const draw = interpolate(frame, [t(0.45), t(1.1)], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const push = interpolate(frame, [0, durationInFrames], [1, 1.05], clamp);
  const drift = interpolate(frame, [0, durationInFrames], [0, -14], clamp);
  const shadow = `0 6px 22px rgba(0,0,0,${p.shadowAlpha})`;
  const U = 620; // underline length
  const curve = `M 4 18 C ${U * 0.25} 6, ${U * 0.55} 4, ${U - 4} 12 M ${U * 0.18} 26 C ${U * 0.45} 18, ${U * 0.7} 18, ${U * 0.86} 22`;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.ink} 0%, ${p.ink2} 100%)`, fontFamily: `"${FAMILY}", serif`, fontStyle: "italic" }}>
      <Fonts fontUrl={fontUrl} italicFontUrl={italicFontUrl} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 50% at 50% 50%, ${p.gold}16 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `scale(${push}) translateY(${drift}px)` }}>
        <div style={{ position: "relative", maxWidth: 860 }}>
          <div style={{ position: "absolute", left: -36, top: -196, color: p.gold, fontWeight: 400, fontSize: 240, lineHeight: 1, opacity: 0.9 * mark, transform: `translateY(${(1 - mark) * 30}px) scale(${0.85 + 0.15 * mark})`, transformOrigin: "left bottom" }}>“</div>
          <div style={{ color: p.yellow, fontWeight: 700, fontSize: size, lineHeight: 1.18, textAlign: "left", textShadow: shadow }}>
            {words.map((w, i) => {
              const k = interpolate(frame, [t(0.05) + i * stagger, t(0.05) + i * stagger + t(0.4)], [0, 1], { ...clamp, easing: OUT });
              return <span key={i} style={{ display: "inline-block", marginRight: "0.26em", opacity: k, transform: `translateY(${(1 - k) * 22}px)` }}>{w}</span>;
            })}
          </div>
          <svg width={U} height={34} viewBox={`0 0 ${U} 34`} style={{ display: "block", marginTop: 22, overflow: "visible" }}>
            <path d={curve} fill="none" stroke={p.gold} strokeWidth={4} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
          </svg>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
