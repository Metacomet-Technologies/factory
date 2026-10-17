//! Runs the MET-219 device credential enrollment suite (install-factory-api.sh
//! --enroll-device and rollback-factory-api.sh --unenroll-device against a fake
//! root) so the existing `cargo test --workspace` CI job enforces it.
use std::{path::Path, process::Command};

#[test]
fn device_enrollment_and_rollback_against_fake_root() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../deploy/test-device-tokens.py");
    let output = Command::new("python3")
        .arg("-B")
        .arg(&path)
        .env_remove("FACTORY_API_TEST_ROOT")
        .output()
        .expect("python3 is required for the deploy device tests");
    assert!(
        output.status.success(),
        "test-device-tokens.py failed:\n{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
