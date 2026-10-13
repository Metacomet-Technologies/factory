use std::{fs, path::Path, process::Command};

fn run(root: &Path, command: &str, args: &[&str]) -> String {
    let output = Command::new(command)
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn fingerprints(root: &Path) -> Vec<String> {
    ["meter", "factory-api", "kiosk"]
        .map(|component| {
            let value = run(root, "bash", &["scripts/build-fingerprint.sh", component]);
            let value = value.trim().to_owned();
            assert_eq!(value.len(), 12);
            assert!(
                value
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            );
            value
        })
        .into()
}

#[test]
fn fingerprints_are_stable_relocatable_and_component_scoped() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let tracked = run(source, "git", &["ls-files", "-z"]);
    let directory = tempfile::tempdir().unwrap();
    let relocated = tempfile::tempdir().unwrap();
    for root in [directory.path(), relocated.path()] {
        for name in tracked.split('\0').filter(|name| !name.is_empty()) {
            let destination = root.join(name);
            fs::create_dir_all(destination.parent().unwrap()).unwrap();
            fs::copy(source.join(name), destination).unwrap();
        }
        run(root, "git", &["init", "-q"]);
        run(root, "git", &["add", "."]);
    }
    let root = directory.path();
    let baseline = fingerprints(root);
    assert_eq!(baseline, fingerprints(root));
    assert_eq!(baseline, fingerprints(relocated.path()));

    let meter = root.join("meter/src/lib.rs");
    let original = fs::read(&meter).unwrap();
    let mut changed = original.clone();
    changed.extend_from_slice(b"\n// fingerprint regression probe\n");
    fs::write(&meter, changed).unwrap();
    let after = fingerprints(root);
    assert_ne!(baseline[0], after[0]);
    assert_eq!(baseline[1..], after[1..]);
    fs::write(meter, original).unwrap();

    let types = root.join("factory-api/src/types.rs");
    let mut changed = fs::read(&types).unwrap();
    changed.extend_from_slice(b"\n// API-only fingerprint regression probe\n");
    fs::write(types, changed).unwrap();
    let after = fingerprints(root);
    assert_eq!(baseline[0], after[0]);
    assert_ne!(baseline[1], after[1]);
    assert_eq!(baseline[2], after[2]);
}
