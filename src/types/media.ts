/**
 * Media server addresses (spec 3.5.6): the TypeScript twin of `rc_types::media_url`.
 * Hand-written, not generated; checked against the shared vectors in `contract.test.ts`.
 *
 * The interface never builds addresses for the real core: it uses `SourceAssets.playbackUrl`
 * and `waveformUrl` verbatim, with no extra headers (the token is in the `token` query
 * parameter). This twin exists so the stand-in core produces addresses of the same form.
 */
import type { MediaItem, SourceId } from "./generated";

/** The query parameter that carries the media server's per-launch token. */
export const MEDIA_TOKEN_PARAM = "token";

/** Percent-encodes every byte except `A-Z a-z 0-9 - . _ ~` (as the core does). */
function encode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `{base}/media/{sourceId}/{item}?token={token}`; a trailing `/` on `base` is ignored. */
export function mediaUrl(base: string, token: string, sourceId: SourceId, item: MediaItem): string {
  return `${base.replace(/\/+$/, "")}/media/${encode(sourceId)}/${item}?${MEDIA_TOKEN_PARAM}=${encode(token)}`;
}
