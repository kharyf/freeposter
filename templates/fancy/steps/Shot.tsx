// Fancy graphic: numbered steps along a gold progress line that fills as each one lights up.
import { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, interpolateColors, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Palette = { ink: string; ink2: string; yellow: string; gold: string; cream: string; shadowAlpha: number };
type Props = { palette: Palette; fontUrl: string; italicFontUrl: string; steps: string };

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

const NODE = 88;

export default function Shot({ palette: p, fontUrl, italicFontUrl, steps }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const t = (sec: number) => sec * fps;
  const list = steps.split("|").map((s) => s.trim()).filter(Boolean);
  const n = list.length;
  const row = Math.min(210, 680 / Math.max(1, n - 1));
  const span = row * (n - 1);
  const longest = Math.max(...list.map((s) => s.length));
  const size = Math.min(68, 700 / (0.46 * Math.max(longest, 1)));

  // Everything is in, dimmed, by 0.5 s; then the line fills step by step through about 75% of the clip.
  const enter = interpolate(frame, [0, t(0.5)], [0, 1], { ...clamp, easing: OUT });
  const first = t(0.45);
  const last = Math.max(first + 1, durationInFrames * 0.75);
  const reach = (i: number) => (n === 1 ? first : first + ((last - first) * i) / (n - 1));
  const fill = interpolate(frame, [first, last], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  const push = interpolate(frame, [0, durationInFrames], [1, 1.04], clamp);
  const shadow = `0 5px 20px rgba(0,0,0,${p.shadowAlpha})`;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.ink} 0%, ${p.ink2} 100%)`, fontFamily: `"${FAMILY}", serif`, fontStyle: "italic" }}>
      <Fonts fontUrl={fontUrl} italicFontUrl={italicFontUrl} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 55% at 45% 50%, ${p.gold}16 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `scale(${push})` }}>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: row - NODE, opacity: enter, transform: `translateY(${(1 - enter) * 36}px)` }}>
          <div style={{ position: "absolute", left: NODE / 2 - 1, top: NODE / 2, width: 2, height: span, background: `${p.gold}44` }} />
          <div style={{ position: "absolute", left: NODE / 2 - 2, top: NODE / 2, width: 4, height: span * fill, background: p.gold, borderRadius: 2, boxShadow: `0 0 14px ${p.gold}88` }} />
          {list.map((s, i) => {
            const on = interpolate(frame, [reach(i) - t(0.1), reach(i) + t(0.25)], [0, 1], { ...clamp, easing: OUT });
            const passed = i < n - 1 ? interpolate(frame, [reach(i + 1), reach(i + 1) + t(0.3)], [0, 1], clamp) : 0;
            // Waiting: faint cream. Its turn: yellow. Done: cream.
            const color = interpolateColors(passed, [0, 1], [interpolateColors(on, [0, 1], [p.cream, p.yellow]), p.cream]);
            return (
              <div key={i} style={{ position: "relative", height: NODE, display: "flex", alignItems: "center", gap: 40 }}>
                <div style={{ width: NODE, height: NODE, borderRadius: NODE / 2, flex: "none", border: `3px solid ${p.gold}`, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", background: interpolateColors(on, [0, 1], [p.ink, p.gold]), transform: `scale(${1 + 0.12 * on * (1 - passed)})` }}>
                  <span style={{ color: interpolateColors(on, [0, 1], [p.gold, p.ink]), fontWeight: 700, fontSize: 44, marginTop: -4 }}>{i + 1}</span>
                </div>
                <div style={{ color, opacity: 0.3 + 0.7 * on, fontWeight: 700, fontSize: size, lineHeight: 1.1, whiteSpace: "nowrap", textShadow: shadow, transform: `translateX(${on * 10}px)` }}>{s}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
