use anyhow::Result;
use factory_db::{Config, Pool, Scope, pool::Overloaded, settings};
use rusqlite::Connection;
use std::{sync::Arc, time::Duration};

async fn open(path: std::path::PathBuf, config: Config) -> Result<Pool> {
    Pool::open(
        path,
        config,
        |db, reader| {
            if !reader {
                db.execute_batch("CREATE TABLE values_(n INTEGER)")?;
            }
            Ok(db)
        },
        |db| db,
    )
    .await
}

#[tokio::test]
async fn every_connection_settings_snapshots_and_barrier() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let pool = Arc::new(
        open(
            temp.path().join("db"),
            Config {
                reader_cache_kib: 12345,
                ..Config::default()
            },
        )
        .await?,
    );
    let scope = Scope::default();
    let settings = pool.settings(&scope).await?;
    assert_eq!(settings.len(), 3);
    for (i, actual) in settings.into_iter().enumerate() {
        assert_eq!(actual.journal_mode, "wal");
        assert_eq!(
            (actual.synchronous, actual.busy_timeout, actual.foreign_keys),
            (1, 5000, 1)
        );
        assert_eq!(actual.journal_size_limit, 67_108_864);
        assert_eq!(actual.wal_autocheckpoint, 1000);
        assert_eq!(actual.query_only, i64::from(i > 0));
        if i > 0 {
            assert_eq!(actual.cache_size, -12345);
        }
    }
    pool.write(&scope, |db| {
        db.execute("INSERT INTO values_ VALUES(7)", [])?;
        Ok(())
    })
    .await?;
    let (entered, started) = tokio::sync::oneshot::channel();
    let (resume, wait) = std::sync::mpsc::channel();
    let reader = pool.clone();
    let reading = tokio::spawn(async move {
        reader
            .read(&Scope::default(), move |db| {
                let sum = || db.query_row("SELECT SUM(n) FROM values_", [], |r| r.get::<_, i64>(0));
                let first = sum()?;
                let _ = entered.send(());
                wait.recv()?;
                Ok((first, sum()?))
            })
            .await
    });
    started.await?;
    pool.write(&scope, |db| {
        db.execute("INSERT INTO values_ VALUES(11)", [])?;
        Ok(())
    })
    .await?;
    pool.barrier(&scope).await?;
    resume.send(())?;
    assert_eq!(reading.await??, (7, 7));
    assert_eq!(
        pool.read(&scope, |db| Ok(db.query_row(
            "SELECT SUM(n) FROM values_",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .await?,
        18
    );
    assert!(
        pool.read(&scope, |db| {
            db.execute("INSERT INTO values_ VALUES(19)", [])?;
            Ok(())
        })
        .await
        .is_err()
    );
    let maintenance = Scope::default();
    pool.maintain(&maintenance, true).await?;
    assert_eq!(maintenance.counts().maintenance, 2);
    assert_eq!(maintenance.counts().data, 0);
    pool.close().await?;
    assert!(pool.barrier(&scope).await.is_err());
    let memory = Connection::open_in_memory()?;
    assert_eq!(
        settings::apply(&memory, false, 1024)?.journal_mode,
        "memory"
    );
    memory.pragma_update(None, "busy_timeout", 42)?;
    assert!(settings::verify(&memory, false, 1024).is_err());
    Ok(())
}

#[tokio::test]
async fn overload_cancel_and_shutdown_drain() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("db");
    let pool = Arc::new(
        open(
            path.clone(),
            Config {
                capacity: 2,
                ..Config::default()
            },
        )
        .await?,
    );
    let (entered, started) = tokio::sync::oneshot::channel();
    let (resume, wait) = std::sync::mpsc::channel();
    let p = pool.clone();
    let first = tokio::spawn(async move {
        p.write(&Scope::default(), move |db| {
            let _ = entered.send(());
            wait.recv()?;
            db.execute("INSERT INTO values_ VALUES(5)", [])?;
            Ok(())
        })
        .await
    });
    started.await?;
    let cancelled_scope = Scope::default();
    let p = pool.clone();
    let scope = cancelled_scope.clone();
    let cancelled = tokio::spawn(async move {
        p.write(&scope, |db| {
            db.execute("INSERT INTO values_ VALUES(99)", [])?;
            Ok(())
        })
        .await
    });
    tokio::task::yield_now().await;
    let error = pool.barrier(&Scope::default()).await.unwrap_err();
    assert!(error.is::<Overloaded>(), "{error}");
    cancelled.abort();
    let _ = cancelled.await;
    // Cancelled close still stops admission; a later close must finish draining.
    assert!(
        tokio::time::timeout(Duration::from_millis(20), pool.close())
            .await
            .is_err()
    );
    resume.send(())?;
    first.await??;
    pool.close().await?;
    assert_eq!(cancelled_scope.counts(), Default::default());
    let db = Connection::open(path)?;
    assert_eq!(
        db.query_row("SELECT SUM(n) FROM values_", [], |r| r.get::<_, i64>(0))?,
        5
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn busy_sqlite_does_not_block_tokio() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("db");
    let pool = Arc::new(open(path.clone(), Config::default()).await?);
    let lock = Connection::open(path)?;
    lock.execute_batch("BEGIN IMMEDIATE")?;
    let p = pool.clone();
    let (entered, started) = tokio::sync::oneshot::channel();
    let writing = tokio::spawn(async move {
        p.write(&Scope::default(), move |db| {
            let _ = entered.send(());
            db.execute("INSERT INTO values_ VALUES(13)", [])?;
            Ok(())
        })
        .await
    });
    started.await?;
    let start = std::time::Instant::now();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(start.elapsed() < Duration::from_millis(200));
    assert_eq!(
        pool.read(&Scope::default(), |db| Ok(db.query_row(
            "SELECT COUNT(*) FROM values_",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .await?,
        0
    );
    let barrier_scope = Scope::default();
    let mut barrier = Box::pin(pool.barrier(&barrier_scope));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut barrier)
            .await
            .is_err()
    );
    lock.execute_batch("ROLLBACK")?;
    barrier.await?;
    assert_eq!(
        pool.read(&Scope::default(), |db| Ok(db.query_row(
            "SELECT n FROM values_",
            [],
            |r| r.get::<_, i64>(0)
        )?))
        .await?,
        13
    );
    writing.await??;
    pool.close().await?;
    Ok(())
}

#[tokio::test]
async fn concurrent_scopes_across_databases_and_prepared_reexecution() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let a = open(temp.path().join("a"), Config::default()).await?;
    let b = open(temp.path().join("b"), Config::default()).await?;
    let one = Scope::default();
    let two = Scope::default();
    let insert = |n| {
        move |db: &mut Connection| -> Result<()> {
            let tx = db.transaction()?;
            {
                let mut statement = tx.prepare("INSERT INTO values_ VALUES(?1)")?;
                for value in 1..=n {
                    statement.execute([value])?;
                }
            }
            tx.commit()?;
            Ok(())
        }
    };
    let (x, y) = tokio::join!(a.write(&one, insert(3)), b.write(&two, insert(7)));
    x?;
    y?;
    let read = |n| {
        move |db: &Connection| -> Result<i64> {
            let mut statement =
                db.prepare("/* scope */ SELECT (SELECT SUM(n) FROM values_) + ?1")?;
            let mut last = 0;
            for value in 0..n {
                last = statement.query_row([value], |r| r.get(0))?;
            }
            Ok(last)
        }
    };
    let (x, y, z, w) = tokio::join!(
        a.read(&one, read(2)),
        b.read(&one, read(4)),
        a.read(&two, read(1)),
        b.read(&two, read(3))
    );
    assert_eq!((x?, y?, z?, w?), (7, 31, 6, 30));
    assert_eq!((one.counts().data, two.counts().data), (9, 11));
    assert_eq!((one.counts().transaction, two.counts().transaction), (6, 6));
    assert_eq!(one.counts().setup, 0);
    assert!(a.startup.counts().setup > 0);
    a.close().await?;
    b.close().await?;
    Ok(())
}

#[test]
fn synchronous_cli_facade() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let pool = Pool::open_sync(
        temp.path().join("db"),
        Config::default(),
        |db, reader| {
            if !reader {
                db.execute_batch("CREATE TABLE items(n INTEGER)")?;
            }
            Ok(db)
        },
        |db| db,
    )?;
    let scope = Scope::default();
    pool.write_sync(&scope, |db| {
        db.execute("INSERT INTO items VALUES(23)", [])?;
        Ok(())
    })?;
    assert_eq!(
        pool.read_sync(&scope, |db| Ok(db.query_row(
            "SELECT n FROM items",
            [],
            |r| r.get::<_, i64>(0)
        )?))?,
        23
    );
    pool.close_sync()?;
    Ok(())
}
