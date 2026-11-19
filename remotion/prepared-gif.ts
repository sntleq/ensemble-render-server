import { createContext } from "react";

export const isGifSource = (src: string) => /^(?:data:image\/gif[;,]|[^?#]*\.gif(?:[?#]|$))/i.test(src);
export type PreparedGif = { src: string; endsMs: number[] };
export const PreparedGifs = createContext<Record<string, PreparedGif>>({});
