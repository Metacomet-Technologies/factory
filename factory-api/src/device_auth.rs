//! Per-device bearer credentials for remote ingest (docs/devices-ingest.md, section 3).
//! The file holds only SHA-256 hashes: `<device_id> <sha256 hex> <label>` per line,
//! at most two per device. It is reread whenever its metadata changes.
use axum::http::HeaderValue;
use std::{
    collections::BTreeMap,
    io,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;

pub const DEFAULT_PATH: &str = "/etc/factory-api/device-tokens";
pub const TOKEN_PREFIX: &str = "fdv1_";
const TOKEN_CHARS: usize = 43;
const PER_DEVICE: usize = 2;
/// `factory-gpu` is the local collector. The rest would collide with phase-1
/// alert keys (`devices:fs:…`, `devices:smart:…`, `devices:cpu:…`, `devices:telemetry`).
pub const RESERVED: [&str; 5] = ["factory-gpu", "fs", "smart", "cpu", "telemetry"];

pub fn valid_device_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=63).contains(&bytes.len())
        && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
        && bytes
            .iter()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    ino: u64,
    len: u64,
    mtime_ns: i128,
    ctime_ns: i128,
}

struct Entry {
    device_id: String,
    hash: [u8; 32],
}

#[derive(Default)]
struct Cache {
    stamp: Option<Stamp>,
    loaded: bool,
    entries: Arc<Vec<Entry>>,
    problem: Option<String>,
}

pub struct Tokens {
    path: PathBuf,
    cache: Mutex<Cache>,
}

fn parse(text: &str) -> (Vec<Entry>, Vec<String>) {
    let mut entries: Vec<Entry> = Vec::new();
    let mut skipped = Vec::new();
    let mut counts = BTreeMap::<String, usize>::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(device), Some(hex)) = (fields.next(), fields.next()) else {
            skipped.push(format!(
                "line {}: expected <device_id> <sha256> <label>",
                index + 1
            ));
            continue;
        };
        if !valid_device_id(device) || RESERVED.contains(&device) {
            skipped.push(format!("line {}: device id not allowed", index + 1));
            continue;
        }
        let Some(hash) = decode_hash(hex) else {
            skipped.push(format!("line {}: hash is not 64 hex characters", index + 1));
            continue;
        };
        let count = counts.entry(device.to_string()).or_default();
        *count += 1;
        if *count > PER_DEVICE {
            skipped.push(format!(
                "line {}: more than {PER_DEVICE} credentials for {device}",
                index + 1
            ));
            continue;
        }
        entries.push(Entry {
            device_id: device.to_string(),
            hash,
        });
    }
    (entries, skipped)
}

fn decode_hash(hex: &str) -> Option<[u8; 32]> {
    let bytes = hex.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let nibble = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        out[i] = nibble(pair[0])? << 4 | nibble(pair[1])?;
    }
    Some(out)
}

/// The bearer token, if the header has exactly the `fdv1_` format. Never logged.
fn bearer(header: Option<&HeaderValue>) -> Option<&str> {
    let value = header?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let body = token.strip_prefix(TOKEN_PREFIX)?;
    (body.len() == TOKEN_CHARS
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(token)
}

pub fn sha256(token: &str) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, token.as_bytes());
    digest.as_ref().try_into().expect("SHA-256 is 32 bytes")
}

impl Tokens {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cache: Mutex::new(Cache::default()),
        }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Current entries. A missing or unreadable file means no credentials.
    fn entries(&self) -> Arc<Vec<Entry>> {
        let stamp = match std::fs::metadata(&self.path) {
            Ok(meta) => Ok(Stamp {
                ino: meta.ino(),
                len: meta.len(),
                mtime_ns: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
                ctime_ns: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
            }),
            Err(error) => Err(error),
        };
        let mut cache = self.cache.lock().expect("device token cache");
        let current = stamp.as_ref().ok().copied();
        if cache.loaded && cache.stamp == current && current.is_some() {
            return cache.entries.clone();
        }
        let (entries, problem) = match stamp {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (
                Vec::new(),
                Some("device token file is absent; remote ingest refuses every request".into()),
            ),
            Err(error) => (
                Vec::new(),
                Some(format!("device token file unreadable: {}", error.kind())),
            ),
            Ok(_) => match std::fs::read_to_string(&self.path) {
                Ok(text) => {
                    let (entries, skipped) = parse(&text);
                    for line in &skipped {
                        tracing::warn!(path = %self.path.display(), problem = %line, "device token line ignored");
                    }
                    (entries, None)
                }
                Err(error) => (
                    Vec::new(),
                    Some(format!("device token file unreadable: {}", error.kind())),
                ),
            },
        };
        if problem != cache.problem || !cache.loaded {
            match &problem {
                Some(problem) => {
                    tracing::warn!(path = %self.path.display(), %problem, "device tokens")
                }
                None => {
                    tracing::info!(path = %self.path.display(), credentials = entries.len(), "device tokens loaded")
                }
            }
        }
        *cache = Cache {
            stamp: current,
            loaded: true,
            entries: Arc::new(entries),
            problem,
        };
        cache.entries.clone()
    }

    /// Enrolled device ids, sorted and unique.
    pub fn devices(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .entries()
            .iter()
            .map(|entry| entry.device_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// The device a well-formed, enrolled credential belongs to. Every hash is
    /// compared in constant time, and the scan never stops early.
    pub fn verify(&self, header: Option<&HeaderValue>) -> Option<String> {
        let token = bearer(header)?;
        let digest = sha256(token);
        let mut found = None;
        for entry in self.entries().iter() {
            if bool::from(entry.hash.ct_eq(&digest)) {
                found = Some(entry.device_id.clone());
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "fdv1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const B: &str = "fdv1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn hex(token: &str) -> String {
        sha256(token).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn header(value: &str) -> HeaderValue {
        HeaderValue::from_str(value).unwrap()
    }

    #[test]
    fn hashes_match_sha256sum_of_the_token_bytes() {
        // printf %s "$token" | sha256sum, as the installer's enrollment step does.
        assert_eq!(
            hex(A),
            "9d07722a37f90bf015baf931cfe52fa97ca5144e575686adf6fc157c51e79b78"
        );
        assert_ne!(hex(A), hex(B));
    }

    #[test]
    fn bearer_format_is_strict() {
        assert_eq!(bearer(Some(&header(&format!("Bearer {A}")))), Some(A));
        assert_eq!(bearer(Some(&header(&format!("bearer {A}")))), Some(A));
        assert_eq!(bearer(Some(&header(A))), None);
        assert_eq!(bearer(Some(&header(&format!("Basic {A}")))), None);
        assert_eq!(bearer(Some(&header(&format!("Bearer {A}x")))), None);
        assert_eq!(bearer(Some(&header("Bearer fdv1_short"))), None);
        assert_eq!(
            bearer(Some(&header(&format!("Bearer {}", A.replace('A', "+"))))),
            None
        );
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn parse_skips_bad_reserved_and_third_lines() {
        let text = format!(
            "# comment\n\nfactory-console {a} enrolled\nfactory-console {b} rotated\nfactory-console {a} third\nfactory-gpu {a} nope\nfs {a} nope\nBad_Id {a} x\nfactory-x {short} x\nonlyid\n",
            a = hex(A),
            b = hex(B),
            short = &hex(A)[..63]
        );
        let (entries, skipped) = parse(&text);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.device_id == "factory-console"));
        assert_eq!(skipped.len(), 6);
        assert!(skipped.iter().all(|s| !s.contains(&hex(A))));
    }

    #[test]
    fn verify_rereads_on_change_and_missing_file_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("device-tokens");
        let tokens = Tokens::new(&path);
        let bearer_a = header(&format!("Bearer {A}"));
        let bearer_b = header(&format!("Bearer {B}"));
        assert_eq!(tokens.verify(Some(&bearer_a)), None);
        assert!(tokens.devices().is_empty());

        std::fs::write(&path, format!("factory-console {} enrolled\n", hex(A))).unwrap();
        assert_eq!(
            tokens.verify(Some(&bearer_a)).as_deref(),
            Some("factory-console")
        );
        assert_eq!(tokens.verify(Some(&bearer_b)), None);

        // Rotation: both hashes valid at once.
        std::fs::write(
            &path,
            format!(
                "factory-console {} enrolled\nfactory-console {} rotated\n",
                hex(A),
                hex(B)
            ),
        )
        .unwrap();
        assert_eq!(
            tokens.verify(Some(&bearer_a)).as_deref(),
            Some("factory-console")
        );
        assert_eq!(
            tokens.verify(Some(&bearer_b)).as_deref(),
            Some("factory-console")
        );

        // Revocation of the old hash by atomic replacement.
        let next = dir.path().join("device-tokens.new");
        std::fs::write(&next, format!("factory-console {} rotated\n", hex(B))).unwrap();
        std::fs::rename(&next, &path).unwrap();
        assert_eq!(tokens.verify(Some(&bearer_a)), None);
        assert_eq!(
            tokens.verify(Some(&bearer_b)).as_deref(),
            Some("factory-console")
        );

        // A torn, non-atomic rewrite only loses the incomplete line.
        let full = format!("factory-console {} rotated\n", hex(B));
        std::fs::write(&path, &full[..full.len() - 20]).unwrap();
        assert_eq!(tokens.verify(Some(&bearer_b)), None);
        std::fs::write(&path, &full).unwrap();
        assert_eq!(
            tokens.verify(Some(&bearer_b)).as_deref(),
            Some("factory-console")
        );

        std::fs::remove_file(&path).unwrap();
        assert_eq!(tokens.verify(Some(&bearer_b)), None);
        assert!(tokens.devices().is_empty());
    }
}
