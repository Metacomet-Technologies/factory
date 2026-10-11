pub mod fake;
pub mod seed;

pub const MODELS: [&str; 3] = ["factory-assist", "factory-assist-max", "factory-code"];

// FNV-1a: unlike DefaultHasher, this fixture format is stable across Rust releases.
pub fn fingerprint(seed: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325 ^ seed, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}
