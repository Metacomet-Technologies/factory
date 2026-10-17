use anyhow::Result;
use factory_api::data;
use factory_db::migrations::{Migration, run, schema_fingerprint};
use rusqlite::Connection;

const TABLES: [&str; 4] = [
    "net_probe_samples",
    "net_probe_rollup_hourly",
    "net_speed_tests",
    "net_events",
];

fn database() -> Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    data::initialize(&mut db)?;
    Ok(db)
}
fn version(db: &Connection) -> Result<i64> {
    Ok(db.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

#[test]
fn version_one_database_upgrades_to_three_and_reruns_are_noops() -> Result<()> {
    let mut db = Connection::open_in_memory()?;
    run(
        &mut db,
        &[Migration {
            version: 1,
            sql: include_str!("../src/ups_schema.sql"),
            checksum: 0xf7820cc3e88268c1,
        }],
        None,
        |_, _| Ok(()),
        |_, _| Ok(()),
    )?;
    db.execute(
        "INSERT INTO ups_samples(ts_ms,energy_mwh,coverage_ms) VALUES(5,7,0)",
        [],
    )?;
    assert_eq!(version(&db)?, 1);
    data::initialize(&mut db)?;
    assert_eq!(version(&db)?, 3);
    let upgraded = schema_fingerprint(&db)?;
    data::initialize(&mut db)?;
    assert_eq!(version(&db)?, 3);
    assert_eq!(schema_fingerprint(&db)?, upgraded);
    assert_eq!(
        db.query_row(
            "SELECT energy_mwh FROM ups_samples WHERE ts_ms=5",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        7
    );
    // An empty database reaches the identical schema.
    assert_eq!(schema_fingerprint(&database()?)?, upgraded);
    Ok(())
}

#[test]
fn network_tables_are_strict_and_reject_invalid_rows() -> Result<()> {
    let db = database()?;
    for table in TABLES {
        assert_eq!(
            db.query_row(
                "SELECT strict FROM pragma_table_list WHERE name=?1",
                [table],
                |r| r.get::<_, i64>(0)
            )?,
            1,
            "{table}"
        );
    }
    const SAMPLE: &str = "INSERT INTO net_probe_samples(device_id,ts_ms,target,layer,address,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_us) VALUES";
    const ROLLUP: &str = "INSERT INTO net_probe_rollup_hourly(device_id,ts_ms,target,layer,sample_count,sent,received,rtt_min_us,rtt_avg_us,rtt_max_us,rtt_mdev_p95_us) VALUES";
    const SPEED: &str = "INSERT INTO net_speed_tests(device_id,started_ms,ended_ms,outcome,error,download_bps,upload_bps,download_bytes,upload_bytes) VALUES";
    const EVENT: &str = "INSERT INTO net_events(device_id,state,layer,reason,started_ms,ended_ms,end_reason,peak_loss_percent) VALUES";
    for values in [
        "('factory-gpu',30000,'gateway','lan','192.168.4.1',10,10,300,400,900,100)",
        "('factory-gpu',30000,'1.1.1.1','wan','1.1.1.1',10,0,NULL,NULL,NULL,NULL)",
        "('factory-gpu',30000,'gateway2','lan',NULL,10,0,NULL,NULL,NULL,NULL)",
    ] {
        db.execute(&format!("{SAMPLE}{values}"), [])?;
    }
    db.execute(
        &format!("{ROLLUP}('factory-gpu',3600000,'gateway','lan',2,20,15,1,2,3,4)"),
        [],
    )?;
    db.execute(
        &format!("{SPEED}('factory-gpu',1,2,'ok',NULL,900000000,800000000,1,1)"),
        [],
    )?;
    db.execute(
        &format!("{SPEED}('factory-gpu',1,2,'failed','HTTP 429',NULL,NULL,0,0)"),
        [],
    )?;
    db.execute(
        &format!("{SPEED}('factory-gpu',1,2,'timeout',NULL,NULL,NULL,5,0)"),
        [],
    )?;
    db.execute(
        &format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,'recovered',100.0)"),
        [],
    )?;
    db.execute(
        &format!("{EVENT}('factory-gpu','degraded','dns','latency',3,NULL,NULL,0.0)"),
        [],
    )?;
    for invalid in [
        format!("{SAMPLE}('',1,'gateway','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',-1,'gateway','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','wifi',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan','',10,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,0,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,101,0,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,11,1,1,1,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,0,1,1,1,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,NULL,NULL,NULL,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1,1,1,NULL)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,-1,1,1,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,5,4,6,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1,4,3,0)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1,2,3,-1)"),
        format!("{SAMPLE}('factory-gpu',1,'x','lan',NULL,10,5,1.5,2,3,0)"),
        format!("{SAMPLE}('factory-gpu',30000,'gateway','lan',NULL,10,0,NULL,NULL,NULL,NULL)"),
        format!("{ROLLUP}('factory-gpu',1,'x','lan',1,10,10,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',0,10,10,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',2,1,1,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',1,10,11,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',1,10,0,1,1,1,0)"),
        format!("{ROLLUP}('factory-gpu',0,'x','lan',1,10,1,NULL,NULL,NULL,NULL)"),
        format!("{ROLLUP}('factory-gpu',0,'x','tailscale',1,10,1,1,1,1,0)"),
        format!("{SPEED}('factory-gpu',2,1,'ok',NULL,1,1,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'partial',NULL,1,1,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'failed',NULL,NULL,NULL,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,1,NULL,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'failed','boom',1,NULL,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,-1,1,0,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,1,1,-1,0)"),
        format!("{SPEED}('factory-gpu',1,2,'ok',NULL,1.5,1,0,0)"),
        format!("{EVENT}('factory-gpu','down','wan','loss',1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','degraded','wan',NULL,1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','degraded','wan','speed',1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','up','wan',NULL,1,NULL,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,2,1,'recovered',1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,NULL,1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,NULL,'recovered',1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,'resolved',1.0)"),
        format!("{EVENT}('factory-gpu','down','wan',NULL,1,2,'recovered',100.5)"),
        // One open episode per device.
        format!("{EVENT}('factory-gpu','down','lan',NULL,4,NULL,NULL,100.0)"),
    ] {
        assert!(db.execute(&invalid, []).is_err(), "{invalid}");
    }
    db.execute(
        &format!("{EVENT}('factory-console','down','lan',NULL,4,NULL,NULL,100.0)"),
        [],
    )?;
    Ok(())
}
