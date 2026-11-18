//! Roughcut shared data types.
//!
//! Every type that is saved to disk or crosses between the interface and the core is
//! defined here, once, exactly as spec section 3.4 writes it. The TypeScript form in
//! `src/types/generated.ts` is generated from these definitions (`npm run gen:types`),
//! so the two sides cannot drift apart.
//!
//! Conventions:
//! - JSON field names are camelCase; union strings are exactly the literals in the spec.
//! - `?:` fields in the spec are `Option` + `skip_serializing_if` (absent from JSON when `None`).
//! - `T | null` fields in the spec are `Option` that serialize as `null`.
//! - All times are whole microseconds ([`Micros`], `i64`), which become `number` in TypeScript.
//!
//! Also here: the names of the core-to-interface events of spec 3.5.5 and their payloads
//! ([`events`]), and the small result types of the commands of spec 3.5.4 ([`api`]).
//!
//! Shared contracts that are code rather than types, each with a TypeScript twin in
//! `src/types` checked against the same vectors (`testdata/contract_vectors.json`):
//! - [`grid`]: how a frame number becomes whole microseconds, and snapping to the grid;
//! - [`waveform`]: the byte layout of the waveform file;
//! - [`media_url`]: the media server's addresses and how the token travels (spec 3.5.6).

pub mod api;
pub mod basics;
pub mod cache;
pub mod events;
pub mod grid;
pub mod project;
pub mod runtime;
pub mod settings;
pub mod waveform;

pub use api::*;
pub use basics::*;
pub use cache::*;
pub use events::*;
pub use grid::*;
pub use project::*;
pub use runtime::*;
pub use settings::*;
pub use waveform::*;

/// Every type exported to TypeScript, in output order. Used by the `gen-ts` binary.
#[doc(hidden)]
pub mod ts_export;
