mod identity {
    include!("../shared/build.rs");
    pub fn emit() {
        main();
    }
}

fn main() {
    identity::emit();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../meter/openapi.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let output = std::process::Command::new("sha256sum")
        .arg(path)
        .output()
        .expect("hash meter OpenAPI snapshot");
    assert!(
        output.status.success(),
        "hash meter OpenAPI snapshot failed"
    );
    let hash = String::from_utf8(output.stdout).expect("SHA-256 is ASCII");
    println!(
        "cargo:rustc-env=FACTORY_METER_OPENAPI_SHA256={}",
        &hash[..12]
    );
}
