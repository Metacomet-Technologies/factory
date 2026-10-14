use anyhow::{Result, ensure};
use factory_db::{
    Pool, Scope,
    migrations::{self, Migration},
};
use rusqlite::params;
use serde::Serialize;
use std::path::PathBuf;

pub struct Store(pub Pool);

#[derive(Clone, Serialize)]
pub struct Row {
    pub id: i64,
    pub ts_ms: i64,
    pub event: String,
    pub login: Option<String>,
    pub action: Option<String>,
    pub value: Option<String>,
    pub old_value: Option<String>,
    pub result: String,
    pub nut_response: Option<String>,
    pub boot_id: String,
    pub attempted: bool,
    pub executed: bool,
    pub tracking_status: Option<String>,
    pub tracking_id: Option<String>,
}

impl Store {
    pub async fn open(path: PathBuf, migrate: bool) -> Result<Self> {
        Ok(Self(
            Pool::open(
                path,
                factory_db::Config {
                    readers: 1,
                    capacity: 64,
                    reader_cache_kib: 1024,
                },
                move |mut db, reader| {
                    if migrate && !reader {
                        migrations::run(
                            &mut db,
                            &[Migration {
                                version: 1,
                                sql: include_str!("../migrations/001.sql"),
                                checksum: 0xbffb76ea0f323bcd,
                            }],
                            None,
                            |_, _| Ok(()),
                            |_, _| Ok(()),
                        )?;
                    }
                    ensure!(
                        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))? == 1,
                        "run migrate before startup"
                    );
                    Ok(db)
                },
                |db| db,
            )
            .await?,
        ))
    }

    pub async fn append(&self, row: Row, notify: bool) -> Result<i64> {
        self.0.write(&Scope::default(), move |db| {
            let notify = if row.event == "guard-deny" {
                let recent: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM audit WHERE event='guard-deny' AND notify>0 AND ts_ms>?)", [row.ts_ms - 60_000], |r| r.get(0))?;
                notify && !recent
            } else { notify };
            db.execute("INSERT INTO audit(ts_ms,event,login,action,value,old_value,result,nut_response,boot_id,attempted,executed,tracking_status,tracking_id,notify) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![row.ts_ms,row.event,row.login,row.action,row.value,row.old_value,row.result,row.nut_response,row.boot_id,row.attempted,row.executed,row.tracking_status,row.tracking_id,i64::from(notify)])?;
            Ok(db.last_insert_rowid())
        }).await
    }

    pub async fn rows(&self, limit: i64, before: i64) -> Result<Vec<Row>> {
        self.0.read(&Scope::default(), move |db| {
            let mut statement = db.prepare("SELECT id,ts_ms,event,login,action,value,old_value,result,nut_response,boot_id,attempted,executed,tracking_status,tracking_id FROM audit WHERE ts_ms < ? ORDER BY ts_ms DESC,id DESC LIMIT ?")?;
            Ok(statement.query_map(params![before,limit], read_row)?.collect::<rusqlite::Result<_>>()?)
        }).await
    }
}

pub fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: row.get(0)?,
        ts_ms: row.get(1)?,
        event: row.get(2)?,
        login: row.get(3)?,
        action: row.get(4)?,
        value: row.get(5)?,
        old_value: row.get(6)?,
        result: row.get(7)?,
        nut_response: row.get(8)?,
        boot_id: row.get(9)?,
        attempted: row.get(10)?,
        executed: row.get(11)?,
        tracking_status: row.get(12)?,
        tracking_id: row.get(13)?,
    })
}
