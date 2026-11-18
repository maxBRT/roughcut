//! Writes `src/types/generated.ts` (or the path given as the first argument).
//! Run through `npm run gen:types`.

use std::path::PathBuf;

fn main() {
    let path = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../src/types/generated.ts")
    });
    let ts = rc_types::ts_export::typescript();
    std::fs::write(&path, ts).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
    println!("wrote {}", path.display());
}
