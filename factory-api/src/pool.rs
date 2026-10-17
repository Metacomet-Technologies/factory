//! API-owned resources and clock gating; execution lives in factory-db.
use anyhow::{Result, ensure};
use factory_db::{Config, Scope};
use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct Pool {
    pub requests: factory_db::Pool,
    pub pricing: factory_db::Pool<pricing::Store>,
    pub clock_synchronized: Arc<AtomicBool>,
}

impl Pool {
    pub async fn open(requests: PathBuf, prices: PathBuf) -> Result<Self> {
        let check = prices.clone();
        crate::data::blocking(move || pricing::verify_path(check)).await?;
        let check = requests.clone();
        crate::data::blocking(move || crate::data::verify_path(&check)).await?;
        let requests = factory_db::Pool::open(
            requests,
            Config::default(),
            |mut db, reader| {
                if !reader {
                    crate::data::initialize(&mut db)?;
                }
                Ok(db)
            },
            |db| db,
        )
        .await?;
        let pricing = factory_db::Pool::open(
            prices,
            Config::default(),
            |db, reader| {
                if reader {
                    pricing::Store::reader(db)
                } else {
                    pricing::Store::from_connection(db)
                }
            },
            pricing::Store::connection,
        )
        .await?;
        Ok(Self {
            requests,
            pricing,
            clock_synchronized: Arc::new(AtomicBool::new(false)),
        })
    }

    pub async fn write<T: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let clock = self.clock_synchronized.clone();
        self.requests
            .write(scope, move |db| {
                ensure!(
                    clock.load(Ordering::Acquire),
                    "clock not synchronized; data writes paused"
                );
                work(db)
            })
            .await
    }

    pub async fn write_pricing<T: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&mut pricing::Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let clock = self.clock_synchronized.clone();
        self.pricing
            .write(scope, move |db| {
                ensure!(
                    clock.load(Ordering::Acquire),
                    "clock not synchronized; data writes paused"
                );
                work(db)
            })
            .await
    }

    pub async fn close(&self) -> Result<()> {
        let (requests, pricing) = tokio::join!(self.requests.close(), self.pricing.close());
        requests?;
        pricing
    }
}
