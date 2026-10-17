use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

fn endpoint(raw: &str) -> Option<SocketAddr> {
    let (address, port) = raw.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let ip = match address.len() {
        8 => IpAddr::V4(Ipv4Addr::from(
            u32::from_str_radix(address, 16).ok()?.to_ne_bytes(),
        )),
        32 => {
            let mut bytes = [0; 16];
            for (i, part) in address.as_bytes().as_chunks::<8>().0.iter().enumerate() {
                bytes[i * 4..i * 4 + 4].copy_from_slice(
                    &u32::from_str_radix(std::str::from_utf8(part).ok()?, 16)
                        .ok()?
                        .to_ne_bytes(),
                );
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// Match the connecting (client) socket, not our accepted server socket.
/// Addresses and ESTABLISHED state prevent unrelated same-port matches.
pub fn owner(table: &str, peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    let mut found = None;
    for line in table.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[3] != "01" || fields[9] == "0" {
            continue;
        }
        if endpoint(fields[1]) == Some(peer) && endpoint(fields[2]) == Some(local) {
            // Connection churn can make /proc repeat a socket. Only a different
            // UID or inode makes the ownership ambiguous.
            let identity = (fields[7].parse().ok()?, fields[9]);
            if found.replace(identity).is_some_and(|old| old != identity) {
                return None;
            }
        }
    }
    found.map(|(uid, _)| uid)
}

pub fn authorize(
    peer: SocketAddr,
    uid: Option<u32>,
    trusted: u32,
    login: Option<&str>,
    allowed: &[String],
) -> bool {
    peer.ip().is_loopback()
        && uid == Some(trusted)
        && login.is_some_and(|name| allowed.iter().any(|item| item == name))
}

pub async fn socket_owner(peer: SocketAddr, local: SocketAddr) -> Option<u32> {
    if !peer.ip().is_loopback() {
        return None;
    }
    // Both reading and parsing the growing socket table are blocking work.
    // Keep the permit in that work even if the HTTP caller disconnects.
    static SCANS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let permit = SCANS.acquire().await.ok()?;
    let file = if peer.is_ipv4() {
        "/proc/net/tcp"
    } else {
        "/proc/net/tcp6"
    };
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        // /proc socket walks are not atomic under connection churn. Retry a
        // missing/ambiguous match, never substitute a header or cached UID.
        for _ in 0..3 {
            let table = std::fs::read_to_string(file).ok()?;
            if let Some(uid) = owner(&table, peer, local) {
                return Some(uid);
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}
