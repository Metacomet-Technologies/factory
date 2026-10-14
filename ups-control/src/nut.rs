use anyhow::{Context, Result, bail, ensure};
use std::{collections::BTreeMap, net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};

pub struct Nut {
    pub addr: SocketAddr,
    password: String,
}

pub struct Session(BufReader<TcpStream>);

pub struct Outcome {
    pub status: &'static str,
    pub response: String,
    pub tracking_id: Option<String>,
}

impl Nut {
    pub fn new(addr: SocketAddr, password: String) -> Result<Self> {
        ensure!(addr.ip().is_loopback(), "NUT must be loopback");
        ensure!(
            !password.is_empty()
                && password.len() <= 256
                && password.bytes().all(|c| c.is_ascii_graphic()),
            "invalid NUT credential"
        );
        Ok(Self { addr, password })
    }

    pub async fn connect(&self) -> Result<Session> {
        let stream = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(self.addr))
            .await
            .context("NUT timeout")?
            .context("NUT unavailable")?;
        Ok(Session(BufReader::new(stream)))
    }

    pub async fn execute(&self, command: &str) -> Result<Outcome> {
        // Only the fixed allowlist builds commands. No shell or subprocess.
        let (mut session, receipt) = tokio::time::timeout(Duration::from_secs(5), async {
            let mut session = self.connect().await?;
            session.ok("USERNAME factory-control").await?;
            session
                .ok(&format!("PASSWORD {}", quote(&self.password)))
                .await?;
            if command != "FSD cyberpower" {
                session.ok("SET TRACKING ON").await?;
            }
            session.send(command).await?;
            let receipt = session.line().await?;
            Ok::<_, anyhow::Error>((session, receipt))
        })
        .await
        .context("NUT submission outcome unknown (timeout)")??;
        if command == "FSD cyberpower" {
            ensure!(
                receipt == "OK FSD-SET",
                "FSD not acknowledged; physical outcome unknown"
            );
            return Ok(Outcome {
                status: "FSD_SET",
                response: receipt,
                tracking_id: None,
            });
        }
        let id = receipt
            .strip_prefix("OK TRACKING ")
            .context("tracking receipt missing; not executed (unconfirmed)")?;
        ensure!(
            id.len() == 36
                && id
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }),
            "invalid tracking receipt; not executed (unconfirmed)"
        );
        let poll = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                session.send(&format!("GET TRACKING {id}")).await?;
                let result = session.line().await?;
                match result.as_str() {
                    "SUCCESS" => return Ok(("SUCCESS", result)),
                    "ERR FAILED"
                    | "ERR UNKNOWN"
                    | "ERR INVALID-ARGUMENT"
                    | "ERR FEATURE-NOT-CONFIGURED" => return Ok(("FAILURE", result)),
                    "PENDING" => tokio::time::sleep(Duration::from_millis(200)).await,
                    _ => bail!("invalid tracking response; not executed (unconfirmed)"),
                }
            }
        })
        .await;
        let (status, response) = match poll {
            Ok(result) => result?,
            Err(_) => (
                "PENDING",
                "PENDING (10 s timeout; may execute later; never auto-retry)".into(),
            ),
        };
        Ok(Outcome {
            status,
            response,
            tracking_id: Some(id.into()),
        })
    }
}

pub fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn fields(line: &str) -> Result<Vec<String>> {
    let mut values = Vec::new();
    let mut value = String::new();
    let (mut quoted, mut escaped, mut started) = (false, false, false);
    for c in line.chars() {
        if escaped {
            value.push(c);
            escaped = false;
        } else if c == '\\' && quoted {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
            started = true;
        } else if c.is_ascii_whitespace() && !quoted {
            if started {
                values.push(std::mem::take(&mut value));
                started = false;
            }
        } else {
            value.push(c);
            started = true;
        }
    }
    ensure!(!quoted && !escaped, "invalid NUT quoting");
    if started {
        values.push(value);
    }
    Ok(values)
}

impl Session {
    async fn send(&mut self, command: &str) -> Result<()> {
        ensure!(!command.contains(['\n', '\r', '\0']), "invalid NUT command");
        self.0
            .get_mut()
            .write_all(format!("{command}\n").as_bytes())
            .await
            .context("NUT write failed")
    }

    async fn line(&mut self) -> Result<String> {
        let mut bytes = Vec::new();
        (&mut self.0)
            .take(8193)
            .read_until(b'\n', &mut bytes)
            .await
            .context("NUT read failed")?;
        ensure!(
            bytes.len() <= 8192 && bytes.last() == Some(&b'\n'),
            "invalid NUT response"
        );
        Ok(String::from_utf8(bytes)
            .context("invalid NUT text")?
            .trim_end()
            .to_owned())
    }

    async fn ok(&mut self, command: &str) -> Result<String> {
        self.send(command).await?;
        let response = self.line().await?;
        // Do not echo an untrusted server response, especially during authentication.
        match response.as_str() {
            "OK" | "OK FSD-SET" => Ok(response),
            _ => bail!("NUT rejected command; response withheld"),
        }
    }

    pub async fn list(&mut self, kind: &str, variable: Option<&str>) -> Result<Vec<Vec<String>>> {
        let tail = variable.map(|v| format!(" {v}")).unwrap_or_default();
        let request = format!("LIST {kind} cyberpower{tail}");
        self.send(&request).await?;
        let first = self.line().await?;
        if matches!(kind, "ENUM" | "RANGE")
            && matches!(
                first.as_str(),
                "ERR NOT-ENUM" | "ERR NOT-RANGE" | "ERR FEATURE-NOT-SUPPORTED"
            )
        {
            return Ok(Vec::new());
        }
        ensure!(first == format!("BEGIN {request}"), "NUT list unavailable");
        let mut rows = Vec::new();
        for _ in 0..512 {
            let line = self.line().await?;
            if line == format!("END {request}") {
                return Ok(rows);
            }
            let row = fields(&line)?;
            ensure!(
                row.len() >= 3 && row[0] == kind && row[1] == "cyberpower",
                "invalid NUT list"
            );
            if let Some(var) = variable {
                ensure!(row[2] == var, "mismatched NUT variable");
            }
            rows.push(row);
        }
        bail!("NUT list too large")
    }

    pub async fn variables(&mut self) -> Result<BTreeMap<String, String>> {
        self.list("VAR", None)
            .await?
            .into_iter()
            .map(|row| {
                ensure!(row.len() == 4, "invalid NUT variable");
                Ok((row[2].clone(), row[3].clone()))
            })
            .collect()
    }
}
