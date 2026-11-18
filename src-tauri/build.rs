use std::path::{Path, PathBuf};

#[path = "build_mirror.rs"]
mod build_mirror;
use build_mirror::mirror;

fn main() {
    tauri_build::build();
    // tauri-build links the Windows resource (icon and the app manifest that selects Common
    // Controls v6) into the binaries only. The integration tests link the whole app as well,
    // and without that manifest Windows refuses to start them (STATUS_ENTRYPOINT_NOT_FOUND,
    // TaskDialogIndirect is missing from the old comctl32). Give the tests the same resource.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let out = std::env::var("OUT_DIR").expect("OUT_DIR");
        let name = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu") { "libresource.a" } else { "resource.lib" };
        let resource = Path::new(&out).join(name);
        if resource.is_file() {
            println!("cargo:rustc-link-arg-tests={}", resource.display());
        }
    }
    speech_runtime();
}

/// The folder next to the built exe that the app looks in for the transcriber by default
/// (`appcore::config::SPEECH_RUNTIME_DIR`; Cargo's own `transcriber.exe` output sits beside it
/// too, so the name must differ from `transcriber`).
const SPEECH_RUNTIME_DIR: &str = "speech-runtime";

/// Puts the transcriber and its runtime files into `<target>/<profile>/speech-runtime`, so the
/// built app (`npm run tauri -- build --debug --no-bundle`, `cargo build`) can make a
/// transcript without `ROUGHCUT_TRANSCRIBER_DIR`. The files come from the deployed transcriber
/// folder that `transcriber/scripts/build.sh` writes: `.cache-dev/speech/dist/gpu` when it is
/// there, else `.cache-dev/speech/dist/cpu`. They are copied, never hard-linked (see
/// `build_mirror.rs`: a write into a linked target folder once reached `dist/gpu`). Without
/// either folder nothing is done and the app reports that the transcriber is not installed.
fn speech_runtime() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest.parent().expect("project root").join(".cache-dev").join("speech").join("dist");
    for variant in ["gpu", "cpu"] {
        println!("cargo:rerun-if-changed={}", dist.join(variant).join("transcriber.exe").display());
    }
    let Some(from) = ["gpu", "cpu"].iter().map(|v| dist.join(v)).find(|d| d.join("transcriber.exe").is_file()) else {
        println!("cargo:warning=no deployed transcriber in {}; the built app needs ROUGHCUT_TRANSCRIBER_DIR", dist.display());
        return;
    };
    // OUT_DIR is <target>/<profile>/build/<pkg>-<hash>/out (or .../build/<pkg>/<hash>/out in
    // newer Cargo layouts): the profile folder is the parent of the `build` folder.
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let Some(profile_dir) = out.ancestors().find(|a| a.file_name().is_some_and(|n| n == "build")).and_then(Path::parent) else {
        println!("cargo:warning=cannot tell the target folder from OUT_DIR {}", out.display());
        return;
    };
    let to = profile_dir.join(SPEECH_RUNTIME_DIR);
    println!("cargo:rerun-if-changed={}", to.join("transcriber.exe").display());
    println!("cargo:rerun-if-changed={}", to.join(build_mirror::MARKER).display());
    println!("cargo:rerun-if-changed=build_mirror.rs");
    // This runs after tauri_build::build(), which copies the installer's bundle resources (the
    // processor runtime from dist-app) into this same folder; the mirror puts the deployed
    // files back, and since they are copies that write never reaches dist/.
    if let Err(e) = mirror(&from, &to) {
        println!("cargo:warning=could not put the transcriber into {}: {e}", to.display());
    }
}
