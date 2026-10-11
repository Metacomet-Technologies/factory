//! One writer and two WAL readers. Each thread owns its connections for its lifetime.
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};

pub struct Databases {
    pub requests: Connection,
    pub pricing: pricing::Store,
}
type Job = Box<dyn FnOnce(&mut Databases) + Send>;
enum Message {
    Run(Job),
    Close(oneshot::Sender<()>),
}
pub struct Pool {
    workers: Vec<mpsc::Sender<Message>>,
    next: AtomicUsize,
    closed: AtomicBool,
    pub clock_synchronized: Arc<AtomicBool>,
}
impl Pool {
    pub async fn open(requests: PathBuf, prices: PathBuf) -> Result<Self> {
        let mut workers = Vec::new();
        for index in 0..3 {
            let (sender, mut receiver) = mpsc::channel::<Message>(8);
            let (ready, initialized) = oneshot::channel();
            let (requests, prices) = (requests.clone(), prices.clone());
            std::thread::Builder::new()
                .name(format!("sqlite-{index}"))
                .spawn(move || {
                    let open = || -> Result<Databases> {
                        if index == 0 {
                            let requests = crate::data::open(&requests)?;
                            let pricing = pricing::Store::open(prices)?;
                            Ok(Databases { requests, pricing })
                        } else {
                            let requests = Connection::open_with_flags(
                                requests,
                                OpenFlags::SQLITE_OPEN_READ_ONLY,
                            )?;
                            requests
                                .execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-65536;")?;
                            let pricing = pricing::Store::reader(Connection::open_with_flags(
                                prices,
                                OpenFlags::SQLITE_OPEN_READ_ONLY,
                            )?)?;
                            Ok(Databases { requests, pricing })
                        }
                    };
                    let mut databases = match open() {
                        Ok(db) => {
                            let _ = ready.send(Ok(()));
                            db
                        }
                        Err(error) => {
                            let _ = ready.send(Err(error));
                            return;
                        }
                    };
                    while let Some(message) = receiver.blocking_recv() {
                        match message {
                            Message::Run(job) => job(&mut databases),
                            Message::Close(done) => {
                                drop(databases);
                                let _ = done.send(());
                                return;
                            }
                        }
                    }
                })?;
            initialized.await??;
            workers.push(sender);
        }
        Ok(Self {
            workers,
            next: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            clock_synchronized: Arc::new(AtomicBool::new(false)),
        })
    }
    async fn call<T: Send + 'static>(
        &self,
        index: usize,
        work: impl FnOnce(&mut Databases) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        ensure!(!self.closed.load(Ordering::Acquire), "database pool closed");
        let (send, receive) = oneshot::channel();
        let clock = self.clock_synchronized.clone();
        let job = Message::Run(Box::new(move |db| {
            if send.is_closed() {
                return;
            }
            let result = if index == 0 && !clock.load(Ordering::Acquire) {
                Err(anyhow::anyhow!(
                    "clock not synchronized; data writes paused"
                ))
            } else {
                work(db)
            };
            let _ = send.send(result);
        }));
        if self.workers[index].try_send(job).is_err() {
            bail!("database pool busy or closed");
        }
        receive.await.context("database worker stopped")?
    }
    pub async fn read<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Databases) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.call(
            1 + self.next.fetch_add(1, Ordering::Relaxed) % 2,
            move |db| {
                let requests = db.requests.unchecked_transaction()?;
                let result = db.pricing.snapshot(|_| work(db))?;
                requests.commit()?;
                Ok(result)
            },
        )
        .await
    }
    pub async fn write<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Databases) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.call(0, work).await
    }
    pub async fn close(&self) -> Result<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        for worker in &self.workers {
            let (done, closed) = oneshot::channel();
            worker
                .send(Message::Close(done))
                .await
                .map_err(|_| anyhow::anyhow!("database worker stopped"))?;
            closed.await?;
        }
        Ok(())
    }
}
