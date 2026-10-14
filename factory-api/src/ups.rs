//! Read-only NUT telemetry. No credentials, commands, or persisted power history.
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use utoipa::ToSchema;

const CAP: usize = 64 * 1024;
const VARIABLES: [&str; 14] = [
    "ups.status",
    "battery.charge",
    "battery.charge.low",
    "battery.charge.warning",
    "battery.runtime",
    "battery.runtime.low",
    "battery.voltage",
    "ups.load",
    "ups.realpower",
    "ups.realpower.nominal",
    "input.voltage",
    "output.voltage",
    "ups.test.result",
    "ups.model",
];

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Ups {
    pub generated_at_ms: i64,
    pub current: Option<UpsCurrent>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UpsCurrent {
    pub ts_ms: i64,
    pub status: Option<String>,
    pub flags: Vec<String>,
    pub on_line: Option<bool>,
    pub on_battery: Option<bool>,
    pub low_battery: Option<bool>,
    pub replace_battery: Option<bool>,
    pub charge_percent: Option<f64>,
    pub charge_low_percent: Option<f64>,
    pub charge_warning_percent: Option<f64>,
    pub runtime_s: Option<i64>,
    pub runtime_low_s: Option<i64>,
    pub load_percent: Option<f64>,
    pub load_w: Option<f64>,
    pub load_nominal_w: Option<f64>,
    pub input_v: Option<f64>,
    pub output_v: Option<f64>,
    pub battery_v: Option<f64>,
    pub test_result: Option<String>,
    pub model: Option<String>,
}

pub async fn read(addr: &str, name: &str) -> Result<UpsCurrent> {
    ensure!(
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b)),
        "invalid UPS name"
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut socket = tokio::net::TcpStream::connect(addr)
            .await
            .map_err(|e| anyhow::anyhow!("connect failed: {e}"))?;
        socket
            .write_all(format!("LIST VAR {name}\nLOGOUT\n").as_bytes())
            .await?;
        let mut response = Vec::new();
        socket
            .take((CAP + 1) as u64)
            .read_to_end(&mut response)
            .await?;
        parse(&response, name)
    })
    .await
    .map_err(|_| anyhow::anyhow!("read timed out after 3 s"))?
}

fn quoted(text: &str) -> Result<String> {
    let mut chars = text.chars();
    ensure!(chars.next() == Some('"'), "malformed quoted value");
    let mut value = String::new();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                ensure!(chars.as_str().is_empty(), "trailing quoted value data");
                return Ok(value);
            }
            '\\' => match chars.next() {
                Some(c @ ('"' | '\\')) => value.push(c),
                _ => bail!("malformed NUT escape"),
            },
            _ => value.push(c),
        }
    }
    bail!("unterminated quoted value")
}

fn parse(response: &[u8], name: &str) -> Result<UpsCurrent> {
    ensure!(response.len() <= CAP, "response exceeds 64 KiB cap");
    let text = std::str::from_utf8(response)?;
    let mut values = BTreeMap::new();
    let mut begun = false;
    let mut ended = false;
    for line in text.lines() {
        if line.starts_with("ERR ") || line == "ERR" {
            bail!("{line}");
        }
        if line == format!("BEGIN LIST VAR {name}") && !begun {
            begun = true;
        } else if line == format!("END LIST VAR {name}") && begun && !ended {
            ended = true;
        } else if begun && !ended {
            let rest = line
                .strip_prefix(&format!("VAR {name} "))
                .ok_or_else(|| anyhow::anyhow!("malformed LIST VAR line"))?;
            let (key, raw) = rest
                .split_once(' ')
                .ok_or_else(|| anyhow::anyhow!("malformed variable"))?;
            ensure!(!key.is_empty(), "empty variable");
            let value = quoted(raw)?;
            if VARIABLES.contains(&key) {
                ensure!(
                    values.insert(key, value).is_none(),
                    "duplicate variable {key}"
                );
            }
        } else {
            ensure!(ended && line == "OK Goodbye", "malformed LIST VAR response");
        }
    }
    ensure!(begun && ended, "missing BEGIN or END LIST VAR");
    let status = values.get("ups.status").cloned();
    let flags: Vec<String> = status
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let flag = |f: &str| status.as_ref().map(|_| flags.iter().any(|s| s == f));
    let number = |key| {
        values
            .get(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    let integer = |key| values.get(key).and_then(|v| v.parse::<i64>().ok());
    Ok(UpsCurrent {
        ts_ms: crate::now_ms(),
        on_line: flag("OL"),
        on_battery: flag("OB"),
        low_battery: flag("LB"),
        replace_battery: flag("RB"),
        status,
        flags,
        charge_percent: number("battery.charge"),
        charge_low_percent: number("battery.charge.low"),
        charge_warning_percent: number("battery.charge.warning"),
        runtime_s: integer("battery.runtime"),
        runtime_low_s: integer("battery.runtime.low"),
        load_percent: number("ups.load"),
        load_w: number("ups.realpower"),
        load_nominal_w: number("ups.realpower.nominal"),
        input_v: number("input.voltage"),
        output_v: number("output.voltage"),
        battery_v: number("battery.voltage"),
        test_result: values.get("ups.test.result").cloned(),
        model: values.get("ups.model").cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nut_lists() {
        let sample = parse(
            br#"BEGIN LIST VAR cyberpower
VAR cyberpower ups.status "OB DISCHRG LB"
VAR cyberpower ups.model "A \"quote\" and \\slash"
VAR cyberpower battery.charge "bad"
VAR cyberpower battery.runtime "301"
VAR cyberpower battery.runtime.low "bad"
VAR cyberpower ups.realpower "NaN"
VAR cyberpower unknown "ignored"
END LIST VAR cyberpower
OK Goodbye
"#,
            "cyberpower",
        )
        .unwrap();
        assert_eq!(sample.model.as_deref(), Some("A \"quote\" and \\slash"));
        assert_eq!(sample.on_battery, Some(true));
        assert_eq!(sample.low_battery, Some(true));
        assert_eq!(sample.on_line, Some(false));
        assert_eq!(sample.runtime_s, Some(301));
        assert_eq!(sample.runtime_low_s, None);
        assert_eq!(sample.charge_percent, None);
        assert_eq!(sample.load_w, None);
        assert!(
            parse(&vec![b'x'; CAP + 1], "cyberpower")
                .unwrap_err()
                .to_string()
                .contains("cap")
        );
        for error in ["DATA-STALE", "DRIVER-NOT-CONNECTED", "UNKNOWN-UPS", "OTHER"] {
            for prefix in [
                "",
                "BEGIN LIST VAR cyberpower\n",
                "BEGIN LIST VAR cyberpower\nEND LIST VAR cyberpower\n",
            ] {
                assert!(
                    parse(format!("{prefix}ERR {error}\n").as_bytes(), "cyberpower")
                        .unwrap_err()
                        .to_string()
                        .contains(error)
                );
            }
        }
        for invalid in [
            "BEGIN LIST VAR cyberpower\n",
            "BEGIN LIST VAR cyberpower\nVAR wrong ups.status \"OL\"\nEND LIST VAR cyberpower\n",
            "BEGIN LIST VAR cyberpower\nVAR cyberpower ups.status \"bad\\q\"\nEND LIST VAR cyberpower\n",
        ] {
            assert!(parse(invalid.as_bytes(), "cyberpower").is_err());
        }
        let absent = parse(
            b"BEGIN LIST VAR cyberpower\nEND LIST VAR cyberpower\n",
            "cyberpower",
        )
        .unwrap();
        assert_eq!(absent.on_line, None);
        assert!(absent.flags.is_empty());
    }
}
