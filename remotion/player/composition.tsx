import { AbsoluteFill, useCurrentFrame } from "remotion";
import { ITrackItem, ITransition } from "@designcombo/types";
import { PreparedGifs, type PreparedGif } from "../prepared-gif";
import { VideoEditorSchemaProps } from "../schema";
import { getBackgroundFillStyle } from "./styles";
import { RenderVisibleItems } from "./render-visible-items";
import { EnsembleWatermark } from "./ensemble-watermark";

const emptyGifs = {};

const Composition: React.FC<VideoEditorSchemaProps & { preparedGifs?: Record<string, PreparedGif> }> = ({
  trackItemIds, trackItemsMap, transitionsMap, fps, size, background, ensembleWatermark, preparedGifs,
}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={getBackgroundFillStyle(background?.type === "color" ? background.value : "#000000")}>
      <PreparedGifs.Provider value={preparedGifs ?? emptyGifs}>
        <RenderVisibleItems
          trackItemIds={trackItemIds}
          trackItemsMap={trackItemsMap as Record<string, ITrackItem>}
          transitionsMap={transitionsMap as Record<string, ITransition>}
          fps={fps}
          size={size}
          frame={frame}
        />
      </PreparedGifs.Provider>
      {ensembleWatermark && <EnsembleWatermark width={size.width} height={size.height} />}
    </AbsoluteFill>
  );
};

export default Composition;
