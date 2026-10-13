//! Runs the MET-150 deploy/alerts Python suites (watchdog against a fake health
//! endpoint and fake Slack; installer/rollback against a fake root) so the
//! existing `cargo test --workspace` CI job enforces them.
use std::{path::Path, process::Command};

fn run(script: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../deploy/alerts")
        .join(script);
    let output = Command::new("python3")
        .arg("-B")
        .arg(&path)
        .env_remove("CREDENTIALS_DIRECTORY")
        .output()
        .expect("python3 is required for the deploy/alerts tests");
    assert!(
        output.status.success(),
        "{script} failed:\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn watchdog_against_fake_health_and_fake_slack() {
    run("test-watchdog.py");
}

#[test]
fn installer_and_rollback_against_fake_root() {
    run("test-install.py");
}
