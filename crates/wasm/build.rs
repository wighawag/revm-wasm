//! Bakes the exact revm version and pinned revision into the artifact, so a
//! downstream bug report can state precisely what was running.
//!
//! Read out of `Cargo.lock` rather than written by hand, because a hand-written
//! version string is a string that is eventually wrong and nobody notices.

use std::path::PathBuf;

fn main() {
    let lock = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock.display());

    let (mut version, mut rev) = (String::from("unknown"), String::from("unknown"));

    if let Ok(text) = std::fs::read_to_string(&lock) {
        // Cargo.lock is a flat list of `[[package]]` tables. Find the one whose
        // name is exactly `revm` and read its version and git source.
        for block in text.split("[[package]]") {
            let mut name = None;
            let mut ver = None;
            let mut src = None;
            for line in block.lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("name = ") {
                    name = Some(v.trim_matches('"').to_string());
                } else if let Some(v) = line.strip_prefix("version = ") {
                    ver = Some(v.trim_matches('"').to_string());
                } else if let Some(v) = line.strip_prefix("source = ") {
                    src = Some(v.trim_matches('"').to_string());
                }
            }
            if name.as_deref() == Some("revm") {
                if let Some(v) = ver {
                    version = v;
                }
                if let Some(s) = src {
                    // "git+https://github.com/bluealloy/revm?rev=<rev>#<resolved>"
                    if let Some(hash) = s.split('#').nth(1) {
                        rev = hash.to_string();
                    }
                }
                break;
            }
        }
    }

    println!("cargo:rustc-env=REVM_WASM_REVM_VERSION={version}");
    println!("cargo:rustc-env=REVM_WASM_REVM_REV={rev}");

    // Which configuration this artifact actually is, so a bug report cannot be
    // ambiguous about it and so a test can assert it is measuring the build it
    // thinks it is. Cargo exposes enabled features to the build script as
    // CARGO_FEATURE_<NAME>, which is more reliable than restating them by hand.
    let feature = |name: &str| {
        std::env::var(format!(
            "CARGO_FEATURE_{}",
            name.to_uppercase().replace('-', "_")
        ))
        .is_ok()
    };
    let mut config = String::from(if feature("precompiles-all") {
        "precompiles=all"
    } else if feature("precompiles-common") {
        "precompiles=common"
    } else {
        "precompiles=none"
    });
    for f in [
        "blst",
        "relaxed-validation",
        "measure-tracer",
        "ablate-outcome-v1",
        "ablate-commit",
        "ablate-extra-exports",
        "ablate-bloom",
        "ablate-fees",
        "ablate-egp",
    ] {
        if feature(f) {
            config.push('+');
            config.push_str(f);
        }
    }
    println!("cargo:rustc-env=REVM_WASM_BUILD_CONFIG={config}");
}
