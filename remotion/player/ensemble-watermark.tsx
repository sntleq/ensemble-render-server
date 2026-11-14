import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";

let watermarkFont: Promise<void> | undefined;
function loadWatermarkFont(): Promise<void> {
  if (!watermarkFont) {
    watermarkFont = new Promise<void>((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700&text=MADE%20IN%20Ensemble&display=block";
      link.onerror = () => reject(new Error("Unable to load the Ensemble watermark font."));
      link.onload = () => {
        Promise.all([600, 700].map(weight => document.fonts.load(`${weight} 36px "Plus Jakarta Sans"`, "MADE IN Ensemble")))
          .then(faces => {
            if (faces.some(loaded => loaded.length === 0)) throw new Error("Ensemble watermark font is unavailable.");
            resolve();
          }).catch(reject);
      };
      document.head.appendChild(link);
    });
  }
  return watermarkFont;
}

export function EnsembleWatermark({ width, height }: { width: number; height: number }) {
  const [fontHandle] = useState(() => delayRender("Loading Ensemble watermark font"));
  useEffect(() => {
    loadWatermarkFont().then(() => continueRender(fontHandle)).catch(error => cancelRender(error));
  }, [fontHandle]);
  const unit = Math.min(width, height) / 1080;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 2147483647 }}>
      <div data-ensemble-watermark="" style={{
        position: "absolute", left: "50%", top: 36 * unit, transform: "translateX(-50%)",
        display: "flex", alignItems: "baseline", gap: 10 * unit,
        padding: `${8 * unit}px ${12 * unit}px`,
        color: "#ffffff", textShadow: `0 ${2 * unit}px ${6 * unit}px rgba(0, 0, 0, 0.65)`,
        fontFamily: 'var(--font-plus-jakarta-sans, "Plus Jakarta Sans"), sans-serif',
        fontSize: 36 * unit, fontWeight: 600, letterSpacing: -0.8 * unit,
        lineHeight: 1.25, whiteSpace: "nowrap", userSelect: "none",
      }}>
        <span style={{ color: "rgba(255, 255, 255, 0.8)", fontSize: 24 * unit, letterSpacing: 1.2 * unit }}>MADE IN</span>
        <span style={{ fontWeight: 700 }}>Ensemble</span>
      </div>
    </div>
  );
}
