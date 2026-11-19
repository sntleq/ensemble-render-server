import { IImage } from "@designcombo/types";
import { BaseSequence, SequenceItemOptions } from "../base-sequence";
import { BoxAnim, ContentAnim, MaskAnim } from "@designcombo/animations";
import { calculateContainerStyles, calculateMediaStyles } from "../styles";
import { getAnimations } from "../../utils/get-animations";
import { calculateFrames } from "../../utils/frames";
import { Gif } from "@remotion/gif";
import { Img, OffthreadVideo, Sequence, useCurrentFrame } from "remotion";
import { useContext } from "react";
import { isGifSource, PreparedGifs, type PreparedGif } from "../../prepared-gif";

const imageStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block"
} as const;

function PreparedGifVideo({ gif, fps, rate, id }: { gif: PreparedGif; fps: number; rate: number; id: string }) {
  const frame = useCurrentFrame();
  const ends = gif.endsMs;
  const elapsedMs = (frame * rate * 1000 / fps) % ends[ends.length - 1];
  let low = 0;
  let high = ends.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (elapsedMs < ends[middle]) high = middle;
    else low = middle + 1;
  }
  // Sample inside the chosen proxy frame, including at fractional sequence cuts.
  const proxyFrame = (low + 0.25) * fps / 25;
  return (
    <Sequence from={frame - proxyFrame} layout="none">
      <OffthreadVideo data-id={id} src={gif.src} muted transparent style={imageStyle} />
    </Sequence>
  );
}

export default function Image({
  item,
  options
}: {
  item: IImage;
  options: SequenceItemOptions;
}) {
  return BaseSequence({ item, options, children: options.visualsActive === false ? null : <ImageContent item={item} options={options} /> });
}

function ImageContent({
  item,
  options
}: {
  item: IImage;
  options: SequenceItemOptions;
}) {
  const { fps, frame } = options;
  const { details, animations } = item;
  const preparedGif = useContext(PreparedGifs)[details.src];
  const { animationIn, animationOut, animationTimed } = getAnimations(
    animations!,
    item,
    frame,
    fps
  );
  const crop = details?.crop || {
    x: 0,
    y: 0,
    width: details.width,
    height: details.height
  };
  const { durationInFrames } = calculateFrames(item.display, fps);
  const currentFrame = (frame || 0) - (item.display.from * fps) / 1000;

  const children = (
    <BoxAnim
      style={calculateContainerStyles(details, crop, {
        transform: "scale(1)"
      })}
      animationIn={animationIn!}
      animationOut={animationOut!}
      frame={currentFrame}
      durationInFrames={durationInFrames}
    >
      <ContentAnim
        animationTimed={animationTimed!}
        durationInFrames={durationInFrames}
        frame={currentFrame}
      >
        <MaskAnim
          item={item}
          keyframeAnimations={animationTimed!}
          frame={frame || 0}
        >
          <div
            id={`${item.id}-reveal-mask`}
            style={calculateMediaStyles(details, crop)}
          >
            {preparedGif ? (
              <PreparedGifVideo id={item.id} gif={preparedGif} fps={fps} rate={item.playbackRate ?? 1} />
            ) : isGifSource(details.src) ? (
              <Gif
                data-id={item.id}
                src={details.src}
                width={details.width}
                height={details.height}
                fit="cover"
                playbackRate={item.playbackRate}
                style={{ position: "absolute", top: 0, left: 0, display: "block" }}
              />
            ) : (
              <Img data-id={item.id} src={details.src} style={imageStyle} />
            )}
          </div>
        </MaskAnim>
      </ContentAnim>
    </BoxAnim>
  );

  return children;
}
