import type { PhotoDTO } from "./types.ts";

// Longest-edge caps used by the server's image pipeline (imagePipeline.ts).
const PREVIEW_EDGE = 1600;
const PREVIEW2X_EDGE = 2400;

/** Builds a yet-another-react-lightbox slide with real pixel dimensions for
 * both preview variants. YARL needs slide-level width/height to size the
 * image to the viewport — without them it renders photos far below full
 * size. */
export function lightboxSlide(photo: {
  width: number | null;
  height: number | null;
  urls: PhotoDTO["urls"];
}) {
  const w = photo.width ?? 3000;
  const h = photo.height ?? 2000;
  const longEdge = Math.max(w, h);
  const scale1x = Math.min(1, PREVIEW_EDGE / longEdge);
  const scale2x = Math.min(1, PREVIEW2X_EDGE / longEdge);
  const at = (s: number) => ({ width: Math.round(w * s), height: Math.round(h * s) });
  const full = at(scale2x);
  return {
    src: photo.urls.preview2x,
    width: full.width,
    height: full.height,
    srcSet: [
      { src: photo.urls.preview, ...at(scale1x) },
      { src: photo.urls.preview2x, ...full },
    ],
  };
}
