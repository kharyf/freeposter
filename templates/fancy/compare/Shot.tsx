// Fancy graphic: two columns either side of a gold rule (before and after, or A versus B).
import { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Palette = { ink: string; ink2: string; yellow: string; gold: string; cream: string; shadowAlpha: number };
type Props = { palette: Palette; fontUrl: string; italicFontUrl: string; left_title: string; left: string; right_title: string; right: string };

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

const COL = 390;
/** Big for a short value, smaller for a long one that wraps (up to 40 characters in three lines). */
const valueSize = (s: string) => (s.length <= 8 ? 96 : s.length <= 16 ? 78 : s.length <= 26 ? 64 : 54);

function Column({ title, value, enter, from, p }: { title: string; value: string; enter: number; from: number; p: Palette }) {
  const shadow = `0 5px 20px rgba(0,0,0,${p.shadowAlpha})`;
  return (
    <div style={{ width: COL, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", opacity: enter, transform: `translateX(${(1 - enter) * from}px)` }}>
      <div style={{ color: p.cream, fontWeight: 400, fontSize: 44, lineHeight: 1.2, letterSpacing: "0.02em", textShadow: shadow }}>{title}</div>
      <div style={{ width: 64 * enter, height: 2, background: p.gold, margin: "26px 0 30px" }} />
      <div style={{ color: p.yellow, fontWeight: 700, fontSize: valueSize(value), lineHeight: 1.12, textShadow: shadow, overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

export default function Shot({ palette: p, fontUrl, italicFontUrl, left_title, left, right_title, right }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const t = (sec: number) => sec * fps;

  const rule = interpolate(frame, [0, t(0.5)], [0, 1], { ...clamp, easing: OUT });
  const leftIn = interpolate(frame, [t(0.05), t(0.55)], [0, 1], { ...clamp, easing: OUT });
  const rightIn = interpolate(frame, [t(0.35), t(0.85)], [0, 1], { ...clamp, easing: OUT });
  const vs = interpolate(frame, [t(0.25), t(0.6)], [0, 1], { ...clamp, easing: Easing.out(Easing.back(2)) });
  const push = interpolate(frame, [0, durationInFrames], [1, 1.04], clamp);
  // A glint that keeps running down the rule, once a second and a half.
  const glint = ((frame / fps) % 1.5) / 1.5;
  const H = 600;

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.ink} 0%, ${p.ink2} 100%)`, fontFamily: `"${FAMILY}", serif`, fontStyle: "italic" }}>
      <Fonts fontUrl={fontUrl} italicFontUrl={italicFontUrl} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 50% at 50% 50%, ${p.gold}18 0%, transparent 70%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `scale(${push})` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <Column title={left_title} value={left} enter={leftIn} from={-60} p={p} />
          <div style={{ width: 140, height: H, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ position: "absolute", left: 69, top: (H * (1 - rule)) / 2, width: 2, height: H * rule, background: `linear-gradient(180deg, ${p.gold}00, ${p.gold} 20%, ${p.gold} 80%, ${p.gold}00)` }} />
            <div style={{ position: "absolute", left: 66, top: glint * H - 40, width: 8, height: 80, borderRadius: 4, opacity: rule * 0.8, background: `linear-gradient(180deg, ${p.yellow}00, ${p.yellow}, ${p.yellow}00)` }} />
            <div style={{ width: 84, height: 84, borderRadius: 42, border: `2px solid ${p.gold}`, background: p.ink, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${vs})`, position: "relative" }}>
              <span style={{ color: p.gold, fontWeight: 400, fontSize: 38, marginTop: -6 }}>vs</span>
            </div>
          </div>
          <Column title={right_title} value={right} enter={rightIn} from={60} p={p} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
