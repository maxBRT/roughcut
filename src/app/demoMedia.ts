/**
 * Media for the stand-in core in a plain browser (`npm run dev`), so the player and the
 * timeline show something without the real core's media server:
 *
 * - Video (original and proxy): the speech fixture, `fixtures/out/speech-2min.mp4`, which the
 *   Vite dev server serves from the project root (`npm run fixtures` makes it). It lasts about
 *   two minutes, the demo recording about twelve: past its end the player shows its last frame.
 *   Without the fixture the address answers 404 and the player reports that it cannot play.
 * - Waveform: made here from the demo transcript (loud where words are spoken, quiet in pauses),
 *   in the waveform file layout of spec 3.5.6, handed out as a `blob:` address.
 */
import { createDemoWaveformValues } from "./demoWaveform";
import type { MediaItem, SourceId } from "../types";
import { encodeWaveform } from "../types/waveform";

/** Where the dev server serves the demo video from. */
export const DEMO_VIDEO_PATH = "/fixtures/out/speech-2min.mp4";

const VALUES_PER_SECOND = 50;
const waveformUrls = new Map<SourceId, string>();

/** The address of one media item of a stand-in source, for use in a browser. */
export function browserDemoMediaUrl(sourceId: SourceId, item: MediaItem): string {
  if (item !== "waveform") return `${DEMO_VIDEO_PATH}?source=${encodeURIComponent(sourceId)}&item=${item}`;
  let url = waveformUrls.get(sourceId);
  if (!url) {
    const values = createDemoWaveformValues(VALUES_PER_SECOND);
    const bytes = encodeWaveform({ sourceId, valuesPerSecond: VALUES_PER_SECOND, count: values.length }, values);
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    waveformUrls.set(sourceId, url);
  }
  return url;
}
