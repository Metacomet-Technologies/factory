use std::{env, fs, path::Path, process::Command, time::SystemTime};

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // Refresh on every Cargo invocation, including unstaged edits and new commits.
    // This intentionally absent file prevents Cargo from caching build identity.
    println!(
        "cargo:rerun-if-changed={}/build-info-refresh",
        env::var("OUT_DIR").unwrap()
    );
    let version = fs::read_to_string(root.join("VERSION")).expect("read root VERSION");
    let version = version.trim();
    assert_eq!(
        version,
        env!("CARGO_PKG_VERSION"),
        "workspace version must match VERSION"
    );
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
    let sha = git(&["rev-parse", "--short=7", "HEAD"]).unwrap_or("unknown".into());
    let dirty = git(&["status", "--porcelain"]).is_some_and(|status| !status.is_empty());
    let built_at_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis();
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
