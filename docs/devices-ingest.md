# Devices ingestion (phase 2 design)

Status: decided 2026-10-17 (option A). Stage A, the server side (MET-196 Build
items 5–8), is implemented in MET-219: the endpoint, auth, ingest semantics,
per-device health and alerts, reads, SSE, the kiosk Devices pages, and the
hash enrollment step. Stage B, the factory-console agent and its installer, is
implemented in MET-220 (`devices-agent/`, `deploy/devices-agent/`) and not yet
installed; see [Stage B](#5-stage-b-factory-console-agent). No tailnet policy,
firewall, or Serve configuration has been created or changed. Operations are in
[devices.md](devices.md#phase-2a-remote-devices) and
[devices.md](devices.md#phase-2b-factory-console-agent).

Phase 1 ([devices.md](devices.md)) collects factory-gpu inside factory-api.
Phase 2 lets another factory node, first factory-console, push its own host
telemetry to that same factory-api. factory-console is an Ubuntu T2 MacBook
(kiosk, backups, overflow Amp runner, watchdog). It has no NVIDIA GPU, and its
sensors must be discovered, not assumed.

The base types are the merged phase-1 types in `factory-api/src/devices.rs`
(`Metric`, `Availability`, `HostIdentity`, `Cpu`, `Ram`, `Filesystem`, `Drive`,
`SmartStatus`, `DiskIo`, `Network`, `Cooling`, `BackupView`, `ClockView`,
`RebootView`, `CollectorHealth`) and the storage in `devices_history.rs` and
`devices_schema.sql`. Everything below is additive within API v1.

## 1. Contract

### Endpoint

```
POST /v1/devices/{device_id}/samples
Host: factory-gpu.bearded-pompano.ts.net   (existing Serve "/" mount -> 127.0.0.1:8080)
Authorization: Bearer fdv1_<43 base64url characters>
Content-Type: application/json
```

One request carries exactly one sample. There is no batch form in v1. Any
other method on this path returns 405 with `Allow: POST`. The existing
`GET /v1/devices`, `GET /v1/devices/{device_id}` and
`GET /v1/devices/{device_id}/history` stay GET-only.

`device_id` matches `^[a-z0-9][a-z0-9-]{0,62}$`. `factory-gpu` is reserved for
the local phase-1 collector and can never be written through this endpoint.
Token enrollment also reserves `fs`, `smart`, `cpu`, `power`, and `telemetry`
to prevent collisions with local alert keys.

### Schema version

`schema_version` is a required integer. The only accepted value is `1`. The
server lists what it accepts in `accepted_schema_versions` on the
`unsupported_schema_version` error.

- Additive changes stay at version 1: a new optional field, a new array
  element type the server can ignore, or a new `Availability` value. Clients
  must not depend on new fields being honored by an older server.
- The server ignores unknown fields at any level, except the server-owned
  names listed below, which it rejects. A newer client therefore works
  against an older server.
- A breaking change (removed or renamed field, changed unit, changed meaning)
  needs version 2. The server then accepts both 1 and 2 for at least 30 days.
  Version 1 is deprecated by documenting the end date here and returning a
  `Deprecation` response header with that date. Removal returns
  `unsupported_schema_version`.

### Sample fields

All timestamps are integer Unix milliseconds UTC. All integers fit in
2^53 − 1 so JavaScript clients do not lose precision.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schema_version` | integer | yes | `1` |
| `device_id` | string | yes | Must equal the path id and the credential's device |
| `agent.name` | string ≤ 64 | yes | `factory-devices-agent` |
| `agent.version` | string ≤ 64 | yes | Agent semver, informational |
| `session_id` | UUID string | yes | Random v4 per agent process start |
| `seq` | integer ≥ 1 | yes | Per-session sample counter, see below |
| `observed_at_ms` | integer | yes | Device wall clock when the fast sample was taken |
| `sent_at_ms` | integer | yes | Device wall clock when this attempt was sent |
| `identity` | `HostIdentity` | yes | `hostname`, `boot_id` (Linux `/proc/sys/kernel/random/boot_id`), `uptime` |
| `cpu` | `Cpu` | yes | All six metrics |
| `memory` | `Ram` | yes | All five metrics |
| `filesystems` | `Filesystem[]` | yes, may be `[]` | Same exclusions as phase 1 |
| `drives` | `Drive[]` | yes, may be `[]` | Same shape as phase 1 |
| `disk_io` | `DiskIo` | yes | Summed over whole disks, skipping the phase-1 virtual names (`loop`, `ram`, `fd`, `dm-`, `md`, `zram`, `nbd`, `sr`, `zd`) |
| `network` | `Network` | yes | Summed over every interface except `lo`, as phase 1 |
| `cooling` | `Cooling` | yes | Temperatures and fans |
| `power` | `Power` or null | no | Adapter and battery readings from `power_supply`, added in MET-258 |
| `maintenance.backup` | `BackupView` | yes | From the node's published backup status |
| `maintenance.clock` | `ClockView` | yes | From `timedatectl`-equivalent sync state |
| `maintenance.reboot` | `RebootView` | yes | Read-only copy of the published reboot status (MET-178), mapped field for field; reboot policy is not changed |
| `collector` | `CollectorHealth` | yes | The agent's own fast/slow schedule and probe state |

Server-owned fields are rejected with `400 server_owned_field` when present:
`health`, `gpus`, `generated_at_ms`, `warnings`, `maintenance.services`,
`maintenance.ups`. The server computes health with the phase-1 rules, takes
services from fleet, and reports `gpus: []` and UPS `unsupported` for every
remote device. A remote device cannot claim a GPU.

Every `Metric` object has all five fields: `value`, `unit`, `observed_at_ms`,
`availability`, `detail`. `detail` is a string ≤ 256 bytes or null.

- `availability` is one of `available`, `unsupported`, `permission_denied`,
  `stale`, `error`.
- `available` requires a finite numeric `value`. Every other availability
  requires `value: null`. Either mismatch is `400 invalid_metric`. Unknown is
  never sent as zero.
- A rate has no value on the first sample of a session. Send it as
  `stale` with detail `waiting for a second sample`, as phase 1 does.
- A counter reset or `boot_id` change restarts rate windows. A gap over 30 s
  between fast samples also restarts them. Rates are not interpolated.
- `observed_at_ms` on a metric may be older than the sample's
  `observed_at_ms` (slow inventory), never newer.

`SmartStatus`, `BackupView`, `ClockView` and `RebootView` follow the same rule:
fields other than `availability`, `observed_at_ms` and `detail` are null unless
`availability` is `available`.

### Power

`power` is optional in schema version 1. Omission or null preserves compatibility
with older agents. A non-null object contains all seven fields below, including
fields whose value is null.

| Field | Value |
| --- | --- |
| `availability` | `available`, `unsupported`, `permission_denied`, `stale`, or `error` |
| `observed_at_ms` | Integer UTC milliseconds, no newer than the sample's `observed_at_ms` |
| `adapter_online` | Boolean or null |
| `battery_status` | String of at most 64 bytes or null, such as `Charging` or `Discharging` |
| `battery_percent` | Finite number from 0 to 100 inclusive or null |
| `battery_power_w` | Finite watts from 0 to 1000 inclusive or null |
| `detail` | String of at most 256 bytes or null |

Unless `availability` is `available`, all four readings must be null.
`detail` may explain an unavailable source. With `available`, individual readings
may still be null when the host exposes only part of the power data.
Invalid types, ranges, or text lengths return `400 invalid_field` with the
`power.<field>` path. Non-null unavailable readings return `400 invalid_metric`.
A missing field returns `400 missing_field`.

Power uses its own observation timestamp for freshness. A fresh sample envelope
does not make an old power reading current.

### Units and ranges

Each field has one fixed unit string. A different unit is
`400 invalid_metric`. Values outside the range are `400 invalid_metric`.

| Unit | Fields | Range |
| --- | --- | --- |
| `%` | `cpu.utilization`, `cpu.iowait`, filesystem `used_percent`, `inodes_used_percent`, drive `available_spare` | 0–100 |
| `load` | `cpu.load1`, `load5`, `load15` | ≥ 0 |
| `C` | `cpu.temperature`, drive `temperature`, `cooling.temperatures[]` | −40 to 150 |
| `bytes` | `memory.*`, filesystem `size`, `used`, drive `size` | integer, 0 to 2^53 − 1 |
| `B/s` | `disk_io.*`, `network.*` | ≥ 0, ≤ 1e12 |
| `s` | `identity.uptime` | ≥ 0 |
| `count` | drive `media_errors` | integer ≥ 0 |
| `rpm` | `cooling.fans[]` | 0–30000 |

`spare_threshold_percent` is 0–100 or null.

### Identity

- **Device:** `device_id`. It is bound to the credential (section 3), not to
  `hostname`. `hostname` is display and collision evidence only.
- **Boot:** `identity.boot_id`. A change means the host rebooted.
- **Session:** `session_id`. A new UUID on every agent process start.
- **Sample:** `(device_id, session_id, seq)`. `seq` starts at 1 and increases
  by exactly 1 for each fast sample the agent creates. A retry resends the
  same sample with the same `session_id`, `seq` and `observed_at_ms`; only
  `sent_at_ms` changes. A gap in `seq` means the agent dropped samples from
  its buffer.

### Capability and error states

The agent reports what it found on this host, per source:

| Situation | Encoding |
| --- | --- |
| Sensor or tool does not exist (no fan controller, no `smartctl`, T2 drive SMART not exposed) | `unsupported`, detail names the missing piece |
| Source exists but the unprivileged agent cannot read it | `permission_denied` |
| Read failed, timed out or parsed badly | `error` |
| Value not yet computable (first rate) | `stale` |
| Whole category empty and unsupported | `[]` plus `cooling.fans_availability: "unsupported"` or `collector.smart: "unsupported"` |

Phase-1 health rules apply: unsupported fans and unsupported SMART do not
fail the host, and unsupported SMART is not shown as healthy.

### Freshness

The server stamps `received_at_ms` from its own clock when the request is
accepted. Two ages are shown for a remote device:

- **Transport age:** `now − last received_at_ms`.
- **Collection age:** `now − observed_at_ms` of the current sample.

The device is `stale` when transport age exceeds 45 s (three 15 s intervals)
or collection age exceeds 45 s. A remote device that has not sent a sample
since factory-api started is `unknown` with warning `waiting for first sample`.
The next accepted fresh sample recovers it. A connected agent is not proof
any metric is healthy.

`GET /v1/devices/{device_id}` gains one additive nullable field on
`DeviceView`, `ingest`. It is null for `factory-gpu`:

```json
{
  "source": "remote",
  "last_received_at_ms": 1792238415180,
  "session_id": "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b",
  "seq": 42,
  "agent_version": "0.1.0",
  "clock_skew_ms": -180,
  "dropped_samples": 0,
  "identity_conflict": false
}
```

`clock_skew_ms` is `sent_at_ms − received_at_ms` of the last accepted request.
It includes network latency.

### Limits

| Limit | Value | Error |
| --- | --- | --- |
| Request body | 64 KiB | 413 `body_too_large` |
| `filesystems` | 32 | 400 `too_many_items` |
| `drives` | 16 | 400 `too_many_items` |
| `cooling.temperatures` | 64 | 400 `too_many_items` |
| `cooling.fans` | 16 | 400 `too_many_items` |
| Any id, name, source, mountpoint, model, fstype | 256 bytes | 400 `invalid_field` |
| Any `detail` or `error` string | 256 bytes | 400 `invalid_field` |
| Duplicate filesystem or drive `id`, or duplicate sensor `name` | none allowed | 400 `invalid_field` |
| Requests per device | 4 per second, burst 8 | 429 `rate_limited` with `Retry-After` |
| Request time | 4 s (existing layer) | 504 `request_timeout` |

The complete example below is about 4.5 KiB compact.

### Example: complete sample

All sources available.

```json
{
  "schema_version": 1,
  "device_id": "factory-console",
  "agent": {
    "name": "factory-devices-agent",
    "version": "0.1.0"
  },
  "session_id": "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b",
  "seq": 42,
  "observed_at_ms": 1792238415000,
  "sent_at_ms": 1792238415180,
  "identity": {
    "hostname": "factory-console",
    "boot_id": "0b7d6c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e",
    "uptime": {
      "value": 86400.5,
      "unit": "s",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "cpu": {
    "utilization": {
      "value": 12.5,
      "unit": "%",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "iowait": {
      "value": 0.4,
      "unit": "%",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "load1": {
      "value": 0.62,
      "unit": "load",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "load5": {
      "value": 0.55,
      "unit": "load",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "load15": {
      "value": 0.48,
      "unit": "load",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "temperature": {
      "value": 51.0,
      "unit": "C",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "memory": {
    "total": {
      "value": 17179869184,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "available": {
      "value": 11811160064,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "used": {
      "value": 5368709120,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "swap_total": {
      "value": 2147483648,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "swap_free": {
      "value": 2147483648,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "filesystems": [
    {
      "id": "/dev/nvme0n1p2\t/",
      "source": "/dev/nvme0n1p2",
      "mountpoint": "/",
      "fstype": "ext4",
      "size": {
        "value": 245107195904,
        "unit": "bytes",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "used": {
        "value": 61276798976,
        "unit": "bytes",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "used_percent": {
        "value": 25.0,
        "unit": "%",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "inodes_used_percent": {
        "value": 4.1,
        "unit": "%",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      }
    }
  ],
  "drives": [
    {
      "id": "eui.0025388b91b2c3d4",
      "kernel": "nvme0n1",
      "model": "APPLE SSD AP0256M",
      "size": {
        "value": 251000193024,
        "unit": "bytes",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "smart": {
        "availability": "available",
        "passed": true,
        "observed_at_ms": 1792238300000,
        "detail": null
      },
      "available_spare": {
        "value": 100,
        "unit": "%",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "spare_threshold_percent": 2,
      "media_errors": {
        "value": 0,
        "unit": "count",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "media_critical": false,
      "temperature": {
        "value": 38,
        "unit": "C",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      }
    }
  ],
  "disk_io": {
    "read": {
      "value": 4096.0,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "write": {
      "value": 81920.0,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "network": {
    "rx": {
      "value": 2048.0,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "tx": {
      "value": 1536.0,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "cooling": {
    "temperatures": [
      {
        "name": "coretemp Package id 0",
        "metric": {
          "value": 51.0,
          "unit": "C",
          "observed_at_ms": 1792238415000,
          "availability": "available",
          "detail": null
        }
      }
    ],
    "fans": [
      {
        "name": "applesmc fan1",
        "metric": {
          "value": 1800,
          "unit": "rpm",
          "observed_at_ms": 1792238415000,
          "availability": "available",
          "detail": null
        }
      }
    ],
    "temperatures_availability": "available",
    "fans_availability": "available"
  },
  "power": {
    "availability": "available",
    "observed_at_ms": 1792238415000,
    "adapter_online": true,
    "battery_status": "Charging",
    "battery_percent": 80,
    "battery_power_w": 26.6,
    "detail": null
  },
  "maintenance": {
    "backup": {
      "availability": "available",
      "last_success_ms": 1792234815000,
      "last_attempt_ms": 1792234815000,
      "error": null,
      "observed_at_ms": 1792238415000
    },
    "clock": {
      "synchronized": true,
      "availability": "available",
      "observed_at_ms": 1792238415000
    },
    "reboot": {
      "availability": "available",
      "reboot_required": false,
      "pending_since_ms": null,
      "days_pending": 0,
      "consecutive_skips": 0,
      "alert_due": false,
      "last_check_ms": 1792231215000,
      "last_decision": "not-needed",
      "detail": null
    }
  },
  "collector": {
    "fast_interval_ms": 15000,
    "slow_interval_ms": 300000,
    "last_fast_ms": 1792238415000,
    "last_slow_ms": 1792238300000,
    "fast_ok": true,
    "filesystems": "available",
    "drives": "available",
    "smart": "available",
    "detail": null
  }
}
```

### Example: partial sample

First sample after an agent restart. Rates wait for a second sample, the
filesystem capacity probe failed, backup status could not be parsed, and the
reboot status file is unreadable. Good readings stay.

```json
{
  "schema_version": 1,
  "device_id": "factory-console",
  "agent": {
    "name": "factory-devices-agent",
    "version": "0.1.0"
  },
  "session_id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "seq": 1,
  "observed_at_ms": 1792238415000,
  "sent_at_ms": 1792238415095,
  "identity": {
    "hostname": "factory-console",
    "boot_id": "0b7d6c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e",
    "uptime": {
      "value": 31.2,
      "unit": "s",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "cpu": {
    "utilization": {
      "value": null,
      "unit": "%",
      "observed_at_ms": 1792238415000,
      "availability": "stale",
      "detail": "waiting for a second sample"
    },
    "iowait": {
      "value": null,
      "unit": "%",
      "observed_at_ms": 1792238415000,
      "availability": "stale",
      "detail": "waiting for a second sample"
    },
    "load1": {
      "value": 0.62,
      "unit": "load",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "load5": {
      "value": 0.55,
      "unit": "load",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "load15": {
      "value": 0.48,
      "unit": "load",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "temperature": {
      "value": 51.0,
      "unit": "C",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "memory": {
    "total": {
      "value": 17179869184,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "available": {
      "value": 11811160064,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "used": {
      "value": 5368709120,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "swap_total": {
      "value": 2147483648,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    },
    "swap_free": {
      "value": 2147483648,
      "unit": "bytes",
      "observed_at_ms": 1792238415000,
      "availability": "available",
      "detail": null
    }
  },
  "filesystems": [
    {
      "id": "/dev/nvme0n1p2\t/",
      "source": "/dev/nvme0n1p2",
      "mountpoint": "/",
      "fstype": "ext4",
      "size": {
        "value": null,
        "unit": "bytes",
        "observed_at_ms": 1792238415000,
        "availability": "error",
        "detail": "capacity missing"
      },
      "used": {
        "value": null,
        "unit": "bytes",
        "observed_at_ms": 1792238415000,
        "availability": "error",
        "detail": "capacity missing"
      },
      "used_percent": {
        "value": null,
        "unit": "%",
        "observed_at_ms": 1792238415000,
        "availability": "error",
        "detail": "capacity missing"
      },
      "inodes_used_percent": {
        "value": null,
        "unit": "%",
        "observed_at_ms": 1792238415000,
        "availability": "error",
        "detail": "capacity missing"
      }
    }
  ],
  "drives": [
    {
      "id": "eui.0025388b91b2c3d4",
      "kernel": "nvme0n1",
      "model": "APPLE SSD AP0256M",
      "size": {
        "value": 251000193024,
        "unit": "bytes",
        "observed_at_ms": 1792238415000,
        "availability": "available",
        "detail": null
      },
      "smart": {
        "availability": "available",
        "passed": true,
        "observed_at_ms": 1792238415000,
        "detail": null
      },
      "available_spare": {
        "value": 100,
        "unit": "%",
        "observed_at_ms": 1792238415000,
        "availability": "available",
        "detail": null
      },
      "spare_threshold_percent": 2,
      "media_errors": {
        "value": 0,
        "unit": "count",
        "observed_at_ms": 1792238415000,
        "availability": "available",
        "detail": null
      },
      "media_critical": false,
      "temperature": {
        "value": 38,
        "unit": "C",
        "observed_at_ms": 1792238415000,
        "availability": "available",
        "detail": null
      }
    }
  ],
  "disk_io": {
    "read": {
      "value": null,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "stale",
      "detail": "waiting for a second sample"
    },
    "write": {
      "value": null,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "stale",
      "detail": "waiting for a second sample"
    }
  },
  "network": {
    "rx": {
      "value": null,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "stale",
      "detail": "waiting for a second sample"
    },
    "tx": {
      "value": null,
      "unit": "B/s",
      "observed_at_ms": 1792238415000,
      "availability": "stale",
      "detail": "waiting for a second sample"
    }
  },
  "cooling": {
    "temperatures": [
      {
        "name": "coretemp Package id 0",
        "metric": {
          "value": 51.0,
          "unit": "C",
          "observed_at_ms": 1792238415000,
          "availability": "available",
          "detail": null
        }
      }
    ],
    "fans": [
      {
        "name": "applesmc fan1",
        "metric": {
          "value": 1800,
          "unit": "rpm",
          "observed_at_ms": 1792238415000,
          "availability": "available",
          "detail": null
        }
      }
    ],
    "temperatures_availability": "available",
    "fans_availability": "available"
  },
  "maintenance": {
    "backup": {
      "availability": "error",
      "last_success_ms": null,
      "last_attempt_ms": null,
      "error": null,
      "observed_at_ms": 1792238415000
    },
    "clock": {
      "synchronized": true,
      "availability": "available",
      "observed_at_ms": 1792238415000
    },
    "reboot": {
      "availability": "permission_denied",
      "reboot_required": null,
      "pending_since_ms": null,
      "days_pending": null,
      "consecutive_skips": null,
      "alert_due": null,
      "last_check_ms": null,
      "last_decision": null,
      "detail": "status file unreadable"
    }
  },
  "collector": {
    "fast_interval_ms": 15000,
    "slow_interval_ms": 300000,
    "last_fast_ms": 1792238415000,
    "last_slow_ms": 1792238415000,
    "fast_ok": true,
    "filesystems": "error",
    "drives": "available",
    "smart": "available",
    "detail": "filesystem capacity probe failed"
  }
}
```

### Example: unsupported SMART and sensors

The next sample on a host where `smartctl` is absent and no CPU temperature
or fan sensor is exposed, which is possible on the T2 MacBook. It is not
evidence the drive is healthy.

```json
{
  "schema_version": 1,
  "device_id": "factory-console",
  "agent": {
    "name": "factory-devices-agent",
    "version": "0.1.0"
  },
  "session_id": "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b",
  "seq": 43,
  "observed_at_ms": 1792238430000,
  "sent_at_ms": 1792238430210,
  "identity": {
    "hostname": "factory-console",
    "boot_id": "0b7d6c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e",
    "uptime": {
      "value": 86400.5,
      "unit": "s",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    }
  },
  "cpu": {
    "utilization": {
      "value": 12.5,
      "unit": "%",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "iowait": {
      "value": 0.4,
      "unit": "%",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "load1": {
      "value": 0.62,
      "unit": "load",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "load5": {
      "value": 0.55,
      "unit": "load",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "load15": {
      "value": 0.48,
      "unit": "load",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "temperature": {
      "value": null,
      "unit": "C",
      "observed_at_ms": 1792238430000,
      "availability": "unsupported",
      "detail": "no CPU temperature sensor"
    }
  },
  "memory": {
    "total": {
      "value": 17179869184,
      "unit": "bytes",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "available": {
      "value": 11811160064,
      "unit": "bytes",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "used": {
      "value": 5368709120,
      "unit": "bytes",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "swap_total": {
      "value": 2147483648,
      "unit": "bytes",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "swap_free": {
      "value": 2147483648,
      "unit": "bytes",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    }
  },
  "filesystems": [
    {
      "id": "/dev/nvme0n1p2\t/",
      "source": "/dev/nvme0n1p2",
      "mountpoint": "/",
      "fstype": "ext4",
      "size": {
        "value": 245107195904,
        "unit": "bytes",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "used": {
        "value": 61276798976,
        "unit": "bytes",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "used_percent": {
        "value": 25.0,
        "unit": "%",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "inodes_used_percent": {
        "value": 4.1,
        "unit": "%",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      }
    }
  ],
  "drives": [
    {
      "id": "eui.0025388b91b2c3d4",
      "kernel": "nvme0n1",
      "model": "APPLE SSD AP0256M",
      "size": {
        "value": 251000193024,
        "unit": "bytes",
        "observed_at_ms": 1792238300000,
        "availability": "available",
        "detail": null
      },
      "smart": {
        "availability": "unsupported",
        "passed": null,
        "observed_at_ms": 1792238300000,
        "detail": "smartctl absent"
      },
      "available_spare": {
        "value": null,
        "unit": "%",
        "observed_at_ms": 1792238300000,
        "availability": "unsupported",
        "detail": "SMART unsupported"
      },
      "spare_threshold_percent": null,
      "media_errors": {
        "value": null,
        "unit": "count",
        "observed_at_ms": 1792238300000,
        "availability": "unsupported",
        "detail": "SMART unsupported"
      },
      "media_critical": false,
      "temperature": {
        "value": null,
        "unit": "C",
        "observed_at_ms": 1792238300000,
        "availability": "unsupported",
        "detail": "SMART unsupported"
      }
    }
  ],
  "disk_io": {
    "read": {
      "value": 4096.0,
      "unit": "B/s",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "write": {
      "value": 81920.0,
      "unit": "B/s",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    }
  },
  "network": {
    "rx": {
      "value": 2048.0,
      "unit": "B/s",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    },
    "tx": {
      "value": 1536.0,
      "unit": "B/s",
      "observed_at_ms": 1792238430000,
      "availability": "available",
      "detail": null
    }
  },
  "cooling": {
    "temperatures": [],
    "fans": [],
    "temperatures_availability": "unsupported",
    "fans_availability": "unsupported"
  },
  "power": {
    "availability": "unsupported",
    "observed_at_ms": 1792238430000,
    "adapter_online": null,
    "battery_status": null,
    "battery_percent": null,
    "battery_power_w": null,
    "detail": "no power_supply battery or adapter"
  },
  "maintenance": {
    "backup": {
      "availability": "available",
      "last_success_ms": 1792234815000,
      "last_attempt_ms": 1792234815000,
      "error": null,
      "observed_at_ms": 1792238430000
    },
    "clock": {
      "synchronized": true,
      "availability": "available",
      "observed_at_ms": 1792238430000
    },
    "reboot": {
      "availability": "available",
      "reboot_required": false,
      "pending_since_ms": null,
      "days_pending": 0,
      "consecutive_skips": 0,
      "alert_due": false,
      "last_check_ms": 1792231215000,
      "last_decision": "not-needed",
      "detail": null
    }
  },
  "collector": {
    "fast_interval_ms": 15000,
    "slow_interval_ms": 300000,
    "last_fast_ms": 1792238430000,
    "last_slow_ms": 1792238300000,
    "fast_ok": true,
    "filesystems": "available",
    "drives": "available",
    "smart": "unsupported",
    "detail": null
  }
}
```

### Responses

Success is always 200. Both results tell the agent to drop the sample from
its buffer.

Stored:

```json
{
  "result": "stored",
  "device_id": "factory-console",
  "session_id": "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b",
  "seq": 42,
  "observed_at_ms": 1792238415000,
  "received_at_ms": 1792238415180,
  "current_updated": true,
  "history_written": true,
  "reason": null
}
```

Ignored (duplicate retry, older than current, or too old):

```json
{
  "result": "ignored",
  "device_id": "factory-console",
  "session_id": "6f1c2a9e-3b4d-4e8f-9a01-2c3d4e5f6a7b",
  "seq": 42,
  "observed_at_ms": 1792238415000,
  "received_at_ms": 1792238416020,
  "current_updated": false,
  "history_written": false,
  "reason": "duplicate"
}
```

`reason` is null on `stored`. On `ignored` it is `duplicate`, `out_of_order`
or `expired`. A `stored` result with `history_written: false` has reason
`clock_unsynchronized`: the server clock or the sample's
`maintenance.clock.synchronized` is not true.

Errors use the existing `ApiError` body. Some add fields, which is additive.

```json
{ "error": { "code": "unsupported_schema_version", "message": "schema_version 2 is not accepted" }, "accepted_schema_versions": [1] }
```

```json
{ "error": { "code": "invalid_metric", "message": "cpu.utilization: value 140 outside 0-100", "field": "cpu.utilization" } }
```

| Status | Code | Retry? | When |
| --- | --- | --- | --- |
| 400 | `invalid_json` | no | Body is not JSON, or a number is not representable (`NaN`, `Infinity`, `1e400` are not valid JSON numbers or overflow) |
| 400 | `unsupported_schema_version` | no | `schema_version` missing or not accepted |
| 400 | `missing_field` | no | A required field is absent |
| 400 | `invalid_field` | no | Wrong type, bad id format, string too long, duplicate id |
| 400 | `invalid_metric` | no | Unit, range, or availability/value mismatch |
| 400 | `too_many_items` | no | An array exceeds its limit |
| 400 | `server_owned_field` | no | A server-owned field is present |
| 400 | `clock_skew` | no | `observed_at_ms` or `sent_at_ms` more than 60 s ahead of `received_at_ms` |
| 400 | `device_mismatch` | no | Body `device_id` differs from the path |
| 401 | `unauthorized` | after operator fix | Missing, malformed, unknown or revoked credential. Includes `WWW-Authenticate: Bearer` |
| 403 | `forbidden_device` | after operator fix | Valid credential for another device, or path is `factory-gpu` |
| 403 | `cross_site` | no | `Sec-Fetch-Site: cross-site`, as the other write endpoints |
| 405 | `method_not_allowed` | no | Not POST |
| 413 | `body_too_large` | no | Over 64 KiB |
| 415 | `unsupported_media_type` | no | Not `application/json` |
| 429 | `rate_limited` | yes, after `Retry-After` | Over the per-device rate |
| 500 | `internal` | yes | Storage failure; nothing was half-written |
| 503 | `shutting_down`, `overloaded` | yes | Existing behavior |
| 504 | `request_timeout` | yes | Existing 4 s layer |

Checks run in this order, so a client without a valid credential learns
nothing about payload rules: method, `Sec-Fetch-Site`, credential (401),
device binding (403), content type (415), body size (413), JSON and schema
(400), rate (429).

### Agent upload rules

- Take a fast sample every 15 s and slow inventory every 5 min, as phase 1.
- Send samples oldest first, one request at a time.
- Per-attempt timeout 5 s.
- Retry network errors, 429, 500, 503 and 504 with full-jitter exponential
  backoff from 1 s to 60 s, and honor `Retry-After`.
- Never retry 400, 405, 413 or 415. Log the code and field, and drop that
  sample.
- On 401 or 403, keep sampling into the buffer, retry every 5 min, and log
  once per hour. The operator fixes the credential.
- Buffer at most 240 samples (1 hour) in memory. When full, drop the oldest
  and count it. No disk buffer in v1.
- Logs never contain the token, the `Authorization` header, or the request
  body.

## 2. Ingest semantics

The server keeps, per remote device, the current sample and the last accepted
sample identity `(observed_at_ms, session_id, seq)` in memory, and history
in the existing `device_samples` / `device_rollup_hourly` tables, keyed
`(device_id, ts_ms)` with `ts_ms = observed_at_ms`. No schema change is needed
for history. Retention and rollups are the phase-1 rules, applied per device.

Rules, in order, after validation:

1. **Future timestamps.** `observed_at_ms` or `sent_at_ms` more than 60 s
   after `received_at_ms` is rejected with `400 clock_skew`. The agent drops it.
2. **Expired.** `observed_at_ms` more than 2 h before `received_at_ms` is
   `ignored / expired`. This bounds a replay of old captured requests.
3. **Duplicate.** Same `session_id` as the last accepted sample and
   `seq ≤` its `seq` is `ignored / duplicate`. Retries after a lost
   response land here.
4. **Out of order.** `observed_at_ms ≤` the last accepted `observed_at_ms`
   (any session) is `ignored / out_of_order`. Current state never moves
   backward. Every sample that passes this rule becomes the last accepted
   sample, whether or not it updates current.
5. **Current state.** Otherwise, the sample replaces the current sample only
   if it is fresh: `received_at_ms − observed_at_ms ≤ 45 s`. A drained backlog
   sample older than that writes history but leaves current alone, so the
   view stays honestly stale until a fresh sample arrives.
6. **History.** The existing `devices_history::record` inserts the row only if
   `ts_ms` is newer than the device's latest row, inside one immediate
   transaction with the hourly rollup. Rules 3 and 4 already drop retries;
   this check is the backstop, so a replayed sample cannot add a second row. History is skipped while the server clock or the
   sample's `maintenance.clock.synchronized` is not true, the same as phase 1.
7. **SSE.** A sample that updates current publishes the existing
   `devices.sample` event with that device's view. Clients tell devices apart
   by `device.device_id`. History-only writes publish nothing. A null event
   payload keeps its phase-1 meaning (the factory-gpu collector failed); a
   remote device never produces one.

Situations:

- **Clock skew.** The agent's wall clock is trusted for ordering within ±60 s
  in the future. Skew is shown as `ingest.clock_skew_ms`. Larger forward skew
  is rejected. Backward skew shows as collection age, and the device goes
  stale.
- **Device clock steps backward** (NTP correction). Samples older than the
  current one are `out_of_order` until the clock passes the last accepted
  time. The view goes stale in the meantime. History is never rewritten.
- **Retries and interrupted uploads.** The server commits current and history
  before responding. A lost response leads to a retry that returns
  `ignored / duplicate` or `out_of_order`. The agent drops it either way.
- **Agent restart.** New `session_id`, `seq` restarts at 1. Accepted, because
  ordering is by `observed_at_ms`, not `seq`.
- **Host reboot.** New `boot_id` and new session. Rate windows restart on the
  agent. The server shows the boot change through `identity.boot_id` and uptime.
- **Server restart.** Current state is lost and the device is `unknown` until
  the next fresh sample (≤ 15 s). The last accepted `observed_at_ms` is
  reloaded from the device's latest `device_samples` row (one indexed query
  per device), so a retry after restart is still `out_of_order`, and rule 6
  still blocks a duplicate row. Session and `seq` are unknown until the first
  sample, so the first retry reports `out_of_order`, not `duplicate`.
- **Sequence gaps.** A gap within one session adds to `ingest.dropped_samples`.
  It is not an error.
- **Identity collision.** Two agents sending under one device credential
  produce interleaved sessions or `boot_id`s. If the current session changes
  more than twice in 5 minutes, or two sessions alternate, the server sets
  `ingest.identity_conflict: true` and adds a warning naming both hostnames.
  It keeps accepting by the ordering rules, because blocking would hide the
  real host too. The fix is to revoke and reissue the credential.
- **Stale clients.** An agent with an old schema version gets
  `unsupported_schema_version` with the accepted list. An agent that stops
  sending makes the device stale after 45 s. It never shows its last frame as
  live.
- **Unknown devices.** A device exists only when a credential is enrolled for
  it. No credential matches an unenrolled id, so it gets 401 or 403. There is
  no auto-registration.
- **factory-gpu.** Always 403 on ingest. The phase-1 local flow is unchanged and
  keeps working when no remote device is enrolled or the console is broken.

Rejected values: nonfinite numbers cannot be encoded in JSON and fail as
`invalid_json`. Out-of-range or wrong-unit values, value/availability
mismatches, oversized strings, too many items and duplicate ids are rejected
as a whole request. The server never stores part of a rejected sample.

## 3. Authentication and transport

Facts checked on 2026-10-17:

- [Serve, Identity headers](https://tailscale.com/kb/1312/serve#identity-headers):
  "These identity headers are not populated for traffic originating from
  tagged devices." Serve strips incoming identity headers to prevent spoofing.
  Both factory nodes are `tag:factory`, so `Tailscale-User-Login` cannot
  identify factory-console.
- [Serve, App capabilities header](https://tailscale.com/kb/1312/serve):
  Serve can forward granted app capabilities, for users or tagged nodes, in a
  `Tailscale-App-Capabilities` header when started with `--accept-app-caps`.
  It strips an incoming copy. The page says this needs Tailscale v1.92 or later.
- [Application capabilities](https://tailscale.com/kb/1537/grants-app-capabilities):
  capabilities are set in the `app` map of a grant, named `{domain}/{path}`.
- [Tags](https://tailscale.com/kb/1068/tags): "Applying a tag to a device
  removes any user-based authentication."
- Serve's documentation recommends the backend listen only on localhost,
  because a direct caller could forge headers. factory-api already listens on
  127.0.0.1:8080, but any local process on factory-gpu, including `agent`, can
  still reach it directly. A header-only identity check is not enough there.
  `docs/ups.md` solves the same problem for ups-control with a socket UID check.
- Existing policy (docs/PLAYBOOK.md): factory → factory on tcp
  22/443/3389/11434. factory-console already reaches
  `https://factory-gpu.bearded-pompano.ts.net` on 443. The Serve `/` mount
  proxies every path to 127.0.0.1:8080.

Tailnet reachability alone is not authorization. Admin devices and both
factory nodes can reach Serve today, and factory-api write endpoints have no
authentication beyond the cross-site check.

| Option | Security | Ops cost | Rotation / revocation | Network change |
| --- | --- | --- | --- | --- |
| **A. Serve + per-device bearer token** | Token is 256 random bits, sent only inside tailnet TLS. Server stores only its SHA-256 next to the one `device_id` it may write. A stolen console token can only write console telemetry. Works the same for Serve and loopback callers. | One secret per device in 1Password. One root-owned file on each side. | Add a second hash for the device, roll the console, remove the old hash. Revoke by deleting the line; factory-api rereads the file when its mtime changes. | None. Existing 443 and Serve `/` mount. |
| B. Serve + Tailscale app capability | No secret. Identity comes from the tailnet. Needs a per-device tag or host-specific grant, because a grant to `tag:factory` would also cover factory-gpu. A local process on factory-gpu can forge the header on 127.0.0.1:8080, so it also needs the ups-control UID check. | Policy grant, Serve restart with `--accept-app-caps`, Tailscale ≥ 1.92 on factory-gpu (not verified), header parsing incl. RFC 2047 encoding. | Edit the grant. Immediate, but every change is a tailnet policy change. | Policy change. Possibly a new tag on factory-console, which touches every existing `tag:factory` rule. |
| C. mTLS | Strong device keys. | Serve terminates TLS, and its documentation describes no client-certificate passthrough (not verified beyond the page). Needs a second TLS listener and a private CA. | Reissue certs, CRL or short lifetimes. | New port on factory-gpu, policy and ufw change. |
| D. factory-gpu pulls over SSH as `factory-backup` | No write endpoint. The server chooses the host, so identity is bound by Tailscale SSH. | Couples telemetry to the backup principal. SSH every 15 s or a long-lived stream. Console must publish a file readable by `factory-backup`. Adds a second transport beside the API the ticket asks for. | Stop the timer or edit the SSH rule. | None for SSH, but widens how the backup principal is used. |
| E. Tailscale user identity headers | Not available for tagged nodes (see above). | — | — | Rejected. |

**Recommendation: A.** It needs no new port, no second API on the console, no
tailnet policy change, no Serve change and no Tailscale version dependency.
The credential is bound to exactly one `device_id` on the server, so the
console cannot write as factory-gpu or as another device. The plaintext token
exists only on the console and in 1Password; factory-gpu holds only the hash.
It also covers the loopback bypass that header-based options must handle
separately. Option B is the upgrade path if Devon prefers no shared secret and
accepts a policy change.

Design of A:

- Token format `fdv1_` plus 43 base64url characters (32 random bytes). The
  prefix makes leaks greppable.
- factory-gpu: `/etc/factory-api/device-tokens`, `root:factory-api` mode 0640.
  One line per credential: `<device_id> <sha256 hex> <label>`. At most two
  lines per device. factory-api compares hashes in constant time. A missing
  file means no remote devices and the endpoint returns 401.
- factory-console: the agent runs as a dedicated unprivileged user and gets
  the token through systemd `LoadCredential=` from
  `/etc/factory-devices-agent/token`, `root:root` mode 0600. The token is
  never in the unit file, environment, arguments or logs.
- Enrollment: Devon generates the token on the Mac, stores it in 1Password,
  and pipes it to the installers with `op read … | ssh … sudo …`, as
  `docs/alerts.md` does for the Slack token. The gpu installer writes only
  the hash.
- Agents never put the token in a URL. Failed authentication is logged on the
  server with the claimed device and remote address, never the token.

## 4. Review list

### Decided

- One endpoint, `POST /v1/devices/{device_id}/samples`, one sample per
  request, on the existing factory-api behind the existing Serve mount.
- `schema_version: 1`, additive rules, unknown fields ignored, server-owned
  fields rejected, 30-day overlap for any future version 2.
- Payload reuses phase-1 types and units. No GPU or UPS for remote devices.
  Health is computed by the server.
- Sample identity `(device_id, session_id, seq)`. Ordering and dedupe by
  `observed_at_ms` against the last accepted sample, which is also the
  history key.
- `received_at_ms` is server-stamped. Stale after 45 s. `unknown` until the
  first sample after a server restart.
- Current state never moves backward. History never gets a duplicate row and
  is written only when both clocks are synchronized.
- Limits: 64 KiB body, item caps, 4 req/s per device, ±60 s future skew,
  2 h expiry, 240-sample in-memory agent buffer.
- `factory-gpu` cannot be written remotely. The phase-1 local flow is
  unchanged.
- Recommended authentication: per-device bearer token, hash-only on the
  server.
- MET-258 adds optional adapter and battery telemetry as `power` in schema
  version 1, and reads `applesmc` fans through `APP0001:00` when exposed.
  Other T2-specific sensors remain outside the contract.

### Decided by Devon (2026-10-17)

1. Option A: per-device bearer token over the existing Serve `/` mount.
2. The enrolled device id is `factory-console`. The agent's system user on
   the console is decided with stage B.
3. Devon generates the token on the Mac and stores it at
   `op://Factory/factory-console devices token/credential`. Generation stays
   manual. factory-gpu holds only the hash, in `/etc/factory-api/device-tokens`
   (`root:factory-api` 0640), lines `<device_id> <sha256 hex> <label>`.
   `install-factory-api.sh --enroll-device <id>` reads the token on stdin and
   is idempotent; `rollback-factory-api.sh --unenroll-device <snapshot>`
   removes only its line.
4. At most two hashes per device, reread on change without a restart,
   constant-time compare. Rotate only on suspicion; no schedule.
5. No tailnet policy, ufw or Serve change.
6. SMART on factory-console is decided with stage B (agent). The server
   accepts `unsupported` and `permission_denied` either way.
7. The phase-1 alert keys fire for remote devices, prefixed with the device
   id (`devices:factory-console:telemetry` and so on). Remote telemetry alerts
   stay quiet while fleet reports the node itself offline, so the node alert is
   not duplicated.
8. Remote devices are stale after 45 s.

### Implementation notes (MET-219)

- Success is HTTP 200 for every accepted request, stored or ignored, as
  section 1 says. (The MET-219 ticket text said 202; the contract wins.)
- MET-217 added `unsafe_shutdowns` to phase-1 drives after this contract was
  written. Schema version 1 does not include it, so a remote drive's
  `unsafe_shutdowns` is ignored like any unknown field and remote devices get
  no unclean-shutdown notice. Adding it is an additive v1 change.
- The device list is the enrolled devices. Removing a device's last hash
  removes it from `/v1/devices` and clears its alerts. An unreadable hash file
  fails closed: every request is 401 and no remote device is listed.
- Failed authentication is logged with the claimed device, the peer address
  (127.0.0.1 behind Serve) and the sanitized `X-Forwarded-For`, never the token
  or the hash.
- No storage change: remote samples use the existing `device_samples` table,
  and the last accepted time is reloaded from it after a restart.

### Not verified

- The Tailscale version on factory-gpu, and whether app capabilities work for
  tagged nodes in this tailnet (only matters for option B).
- That the real Serve forwards the `Authorization` header unchanged. The docs
  list only identity and capability headers as stripped. The sandbox Serve
  emulation forwards it and strips `Tailscale-*` headers
  (`scripts/sandbox-shims/devices-smoke.py`, MET-219), which proves only the
  emulation. The first real check is Devon's POST through Serve after deploy:
  401 without a token, 200 with the enrolled one.
- Which sensors factory-console exposes (CPU temperature, fans, T2 NVMe SMART,
  battery). The examples show plausible values, not readings from the host.

## 5. Stage B: factory-console agent

`factory-devices-agent` (crate `devices-agent/`) runs as the system user
`factory-devices` on factory-console. It calls the phase-1 collector
(`factory_api::devices::sample_timeout`) against its own `/proc` and `/sys`, so
collection is not forked. It then:

- sets the contract identity: `device_id` `factory-console`, a random v4
  `session_id` per start, and `seq` from 1;
- reports backup and reboot status as `unsupported` when no published file
  exists (`/var/lib/factory-backup-status/status.json`,
  `/var/lib/factory-reboot-status/status.json`), and `permission_denied` when
  one exists but is unreadable;
- reads clock sync from a read-only `adjtimex` (what `timedatectl` reports
  as NTPSynchronized); a failed call is `error`, not unsynchronized;
- drops filesystems it cannot see truthfully: its own PrivateTmp binds and
  mountpoints covered by a later mount;
- keeps every value inside this contract: an out-of-range, non-integer or
  non-finite reading becomes `error` on that metric only, repeated sensor names
  get ` #2`, and strings and lists are cut to the limits;
- checks each sample with the server's own `devices_ingest::parse` before
  queueing it; a sample that still fails is logged and dropped, never sent.

The upload rules are section 1's. Three choices are not spelled out there:
404 is treated like 401/403 (a rolled-back factory-api returns 404), every 5xx
is retried (Serve answers 502 while factory-api is down), and `Retry-After` is a
floor capped at 60 s. Logs never contain the token, the `Authorization`
header, a URL with credentials, or a body. Request errors are logged only by
kind (timeout, connect failed).

### Console capability table

Synthetic: the agent from this branch against the sandbox stack (stage A
factory-api, fake Serve) and a console-shaped fixture root
(`--discover --root`). It is not factory-console. The real table replaces the
right-hand column after the install (`journalctl -u factory-devices-agent`
logs a `discovered sources` line on each start).

| Source | Agent reads | Sandbox (synthetic) | factory-console (real) | T2 note (not verified) |
| --- | --- | --- | --- | --- |
| CPU utilization, iowait, load | `/proc/stat`, `/proc/loadavg` | available | pending install | — |
| CPU temperature | hwmon/thermal names containing package, tdie, tctl, cpu or x86_pkg | unsupported (fixture sensor is unlabeled) | pending install | Intel `coretemp` "Package id 0" is expected |
| Memory | `/proc/meminfo` | available | pending install | — |
| Filesystems | `/proc/self/mountinfo` + statvfs | available (`/`) | pending install | — |
| Drives | `/sys/block` | available (`nvme0n1`) | pending install | Apple NVMe (ANS2) through the T2 |
| SMART | `/var/lib/factory-devices/smart.json` from the root helper | unsupported (`tool: absent`) | pending install | `smartctl` may be absent or may not read the Apple controller's health log; either is `unsupported`, not healthy |
| Disk I/O | `/proc/diskstats` | available | pending install | — |
| Network | `/proc/net/dev`, all but `lo` | available | pending install | — |
| Temperatures | `/sys/class/hwmon`, `/sys/class/thermal` | available (1 sensor) | pending install | whatever hwmon exposes |
| Fans | hwmon `fan*_input`, plus the `APP0001:00` ACPI device, its `physical_node`, and their hwmon directories | unsupported in the baseline sandbox | sysfs reads 1824 and 1699 rpm; agent fix awaits deployment | MET-312 discovers the ACPI driver's attributes and deduplicates Apple fans by index before adding labels |
| Battery | `/sys/class/power_supply`, including adapter online state | unsupported without a battery fixture | pending verification | MET-258 adds optional `power` readings in schema v1 |
| Clock | `adjtimex` | available | pending install | — |
| Backup | published status file | unsupported (no file) | pending install | factory-console publishes none (`deploy/backup/nodes.conf`) |
| Reboot | published status file | unsupported (no file) | pending install | published only where a `factory-api` group exists, so none today |

### T2 fan discovery (MET-312)

Read-only probes as `agent` on factory-console on 2026-10-24 found that
`7.2.9-2-t2-resolute` already binds `applesmc` on the ACPI bus:

```text
readlink /sys/bus/acpi/devices/APP0001:00/driver
../../../../../../bus/acpi/drivers/applesmc
cat /sys/bus/acpi/devices/APP0001:00/name
applesmc
cat /sys/bus/acpi/devices/APP0001:00/fan1_input
1824
cat /sys/bus/acpi/devices/APP0001:00/fan2_input
1699
cat /sys/bus/acpi/devices/APP0001:00/physical_node/waiting_for_supplier
0
```

The empty platform `physical_node` is not the bound ACPI device. The nameless
`hwmon3` points back to that ACPI device through `device`; its own directory
has no fan attributes. MET-258 checked only the physical node and hwmon
directories, missing the attributes on the ACPI device itself. The deployed
API consequently reported only `amdgpu fan1 = 0`, with availability `available`.
No kernel, package, module option, or supplier-ordering fix is indicated.
`modinfo -F parm applesmc` returned no parameters. Both fan labels returned
`Invalid argument`, so the collector must tolerate unreadable optional labels.

Discovery accepts a hwmon named `applesmc` anywhere in the hwmon class, or
one beneath `APP0001:00` or its physical node even without a name. It also
reads fan attributes directly from both nodes. Duplicate Apple fan indices
are reported once, with hwmon-class readings preferred. Readable labels add
` (label)` to `applesmc fanN`; the index keeps repeated labels distinct.

When an Apple source exists, unrelated fans do not make `fans_availability`
available. At least one Apple fan must have a valid RPM reading. If no inputs
are readable, an `applesmc fans` entry has a null value and a diagnostic in
the existing metric `detail`. Availability is `unsupported` without a driver
binding and `error` with a binding but no readable inputs. Malformed or
out-of-range Apple readings remain individual errors. Non-Apple readings
are retained. No ingest schema change is needed.

The fix ships in the devices-agent binary through the existing installer.
There is no new host configuration to install or undo, and no module reload
or reboot is required. Live API acceptance remains pending Devon's install;
see [console deployment](devices.md#deploy-devon-from-the-mac).
