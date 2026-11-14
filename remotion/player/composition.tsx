import { AbsoluteFill, useCurrentFrame } from "remotion";
import { ITrackItem, ITransition } from "@designcombo/types";
import { VideoEditorSchemaProps } from "../schema";
import { getBackgroundFillStyle } from "./styles";
import { RenderVisibleItems } from "./render-visible-items";
import { EnsembleWatermark } from "./ensemble-watermark";

const Composition: React.FC<VideoEditorSchemaProps> = ({
  trackItemIds, trackItemsMap, transitionsMap, fps, size, background, ensembleWatermark,
}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={getBackgroundFillStyle(background?.type === "color" ? background.value : "#000000")}>
      <RenderVisibleItems
        trackItemIds={trackItemIds}
        trackItemsMap={trackItemsMap as Record<string, ITrackItem>}
        transitionsMap={transitionsMap as Record<string, ITransition>}
        fps={fps}
        size={size}
        frame={frame}
      />
      {ensembleWatermark && <EnsembleWatermark width={size.width} height={size.height} />}
    </AbsoluteFill>
  );
};

export default Composition;
