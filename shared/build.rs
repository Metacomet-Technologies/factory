use std::{env, fs, path::Path, process::Command, time::SystemTime};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // Local builds must notice unstaged edits and new commits, so they depend
    // on a file that is never created and Cargo rebuilds identity every time.
    // A release build is a clean exact SHA. Rebuild only when its version,
    // VERSION, or HEAD changes, so a later cargo in that checkout can reuse
    // the binaries. meter and factory-api include this script.
    println!("cargo:rerun-if-env-changed=FACTORY_RELEASE_VERSION");
    let release = env::var("FACTORY_RELEASE_VERSION").ok();
    if release.is_some() {
        println!("cargo:rerun-if-changed={}", root.join("VERSION").display());
        let head = root.join(".git").join("HEAD");
        if head.is_file() {
            println!("cargo:rerun-if-changed={}", head.display());
        }
    } else {
        println!(
            "cargo:rerun-if-changed={}/build-info-refresh",
            env::var("OUT_DIR").unwrap()
        );
    }
    let version = fs::read_to_string(root.join("VERSION")).expect("read root VERSION");
    let version = version.trim();
    assert_eq!(
        version,
        env!("CARGO_PKG_VERSION"),
        "workspace version must match VERSION"
    );
    if let Some(release) = &release {
        let parse = |text: &str| -> Vec<u32> {
            let parts: Vec<_> = text.split('.').collect();
            assert_eq!(parts.len(), 3, "release version must be stable SemVer");
            parts
                .iter()
                .map(|part| {
                    assert!(
                        !part.is_empty()
                            && part.bytes().all(|b| b.is_ascii_digit())
                            && (part.len() == 1 || !part.starts_with('0')),
                        "release version must be stable SemVer"
                    );
                    part.parse().expect("release version component exceeds u32")
                })
                .collect()
        };
        assert!(
            parse(release) >= parse(version),
            "release version below VERSION"
        );
    }
    let version = release.as_deref().unwrap_or(version);
    let git = |args: &[&str]| {
        if !root.join(".git").exists() {
            return None;
        }
        Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|text| text.trim().to_owned())
    };
    let sha = if release.is_some() {
        git(&["rev-parse", "HEAD"]).expect("release build requires git identity")
    } else {
        git(&["rev-parse", "--short=7", "HEAD"]).unwrap_or("unknown".into())
    };
    let dirty = git(&["status", "--porcelain"]).is_some_and(|status| !status.is_empty());
    // Release retries must reproduce identical assets, including embedded time.
    let built_at_ms = if release.is_some() {
        git(&["show", "-s", "--format=%ct", "HEAD"])
            .expect("release build requires commit time")
            .parse::<u128>()
            .expect("invalid commit time")
            * 1000
    } else {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    };
    println!("cargo:rustc-env=FACTORY_VERSION={version}");
    println!("cargo:rustc-env=FACTORY_GIT_SHA={sha}");
    println!("cargo:rustc-env=FACTORY_GIT_DIRTY={dirty}");
    println!("cargo:rustc-env=FACTORY_BUILT_AT_MS={built_at_ms}");
    let component = env!("CARGO_PKG_NAME");
    if matches!(component, "meter" | "factory-api") {
        let output = Command::new("bash")
            .arg(root.join("scripts/build-fingerprint.sh"))
            .arg(component)
            .output()
            .expect("compute build inputs fingerprint");
        assert!(
            output.status.success(),
            "build fingerprint failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let fingerprint = String::from_utf8(output.stdout).unwrap();
        println!(
            "cargo:rustc-env=FACTORY_INPUTS_FINGERPRINT={}",
            fingerprint.trim()
        );
    }
}
