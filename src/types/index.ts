/**
 * `types`: the data types shared with the core (spec 3.4) and the core-to-interface
 * event names and payloads (spec 3.5.5).
 *
 * `generated.ts` is generated from the Rust crate `rc-types`; do not edit it, run
 * `npm run gen:types` instead.
 *
 * The shared contracts that are code rather than types are hand-written twins of
 * `rc-types` functions, checked against the same vectors
 * (`src-tauri/crates/rc-types/testdata/contract_vectors.json`, see `contract.test.ts`):
 * - `grid.ts`: frame numbers to whole microseconds, and snapping to the frame grid;
 * - `media.ts`: media server addresses (token in the `token` query parameter);
 * - `waveform.ts`: the byte layout of the waveform file.
 */
export * from "./generated";
export * from "./grid";
export * from "./media";
export * from "./waveform";
