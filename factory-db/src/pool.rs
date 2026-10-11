use crate::{Category, Scope, Tracked, settings};
use anyhow::{Context, Result, anyhow, ensure};
use rusqlite::{Connection, OpenFlags};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};

#[derive(Clone, Copy)]
pub struct Config {
    pub readers: usize,
    /// Maximum outstanding jobs across all workers, including running jobs.
    pub capacity: usize,
    pub reader_cache_kib: u32,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            readers: 2,
            capacity: 1024,
            reader_cache_kib: 65_536,
        }
    }
}

#[derive(Debug)]
pub struct Overloaded;
impl std::fmt::Display for Overloaded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("database pool overloaded")
    }
}
impl std::error::Error for Overloaded {}

type Job<T> = Box<dyn FnOnce(&mut Tracked<T>) + Send>;
/// One file, one writer and N persistent read-only connections on dedicated OS
/// threads. Owners can wrap connections but must not replace them or their hooks.
pub struct Pool<T = Connection> {
    workers: Mutex<Option<Vec<mpsc::Sender<Job<T>>>>>,
    stopped: Vec<watch::Receiver<bool>>,
    capacity: Arc<Semaphore>,
    next: AtomicUsize,
    readers: usize,
    connection: fn(&T) -> &Connection,
    pub startup: Scope,
}

impl<T: Send + 'static> Pool<T> {
    pub async fn open(
        path: PathBuf,
        config: Config,
        initialize: impl Fn(Connection, bool) -> Result<T> + Send + Sync + 'static,
        connection: fn(&T) -> &Connection,
    ) -> Result<Self> {
        tokio::task::spawn_blocking(move || Self::open_sync(path, config, initialize, connection))
            .await
            .context("pool startup panicked")?
    }

    /// CLI facade; call outside async runtimes. Initialization happens on workers.
    pub fn open_sync(
        path: PathBuf,
        config: Config,
        initialize: impl Fn(Connection, bool) -> Result<T> + Send + Sync + 'static,
        connection: fn(&T) -> &Connection,
    ) -> Result<Self> {
        ensure!(
            config.readers > 0 && config.capacity > 0,
            "pool sizes must be positive"
        );
        ensure!(
            path != std::path::Path::new(":memory:"),
            "pool requires a file database"
        );
        let initialize = Arc::new(initialize);
        let startup = Scope::default();
        let mut workers = Vec::new();
        let mut stopped = Vec::new();
        for index in 0..=config.readers {
            let reader = index > 0;
            let (sender, mut receiver) = mpsc::channel::<Job<T>>(config.capacity);
            let (ready, initialized) = std::sync::mpsc::sync_channel(1);
            let (finished, closed) = watch::channel(false);
            let (path, initialize, scope) = (path.clone(), initialize.clone(), startup.clone());
            std::thread::Builder::new()
                .name(format!("sqlite-{index}"))
                .spawn(move || {
                    let open = || -> Result<Tracked<T>> {
                        let flags = if reader {
                            OpenFlags::SQLITE_OPEN_READ_ONLY
                        } else {
                            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
                        };
                        let mut db =
                            Tracked::new(Connection::open_with_flags(path, flags)?, |db| db)?;
                        db.run(&scope, Category::Setup, |db| {
                            settings::apply(db, reader, config.reader_cache_kib)
                        })?;
                        let mut db = db.try_map(&scope, |db| initialize(db, reader))?;
                        // Owner bootstrap must not override the shared settings.
                        db.run(&scope, Category::Setup, |db| {
                            settings::verify(connection(db), reader, config.reader_cache_kib)
                        })?;
                        if !reader {
                            db.run(&scope, Category::Maintenance, |db| {
                                settings::optimize(connection(db))
                            })?;
                        }
                        Ok(db)
                    };
                    match open() {
                        Ok(mut db) => {
                            let _ = ready.send(Ok(()));
                            while let Some(job) = receiver.blocking_recv() {
                                job(&mut db);
                            }
                            drop(db);
                        }
                        Err(error) => {
                            let _ = ready.send(Err(error));
                        }
                    }
                    let _ = finished.send(true);
                })?;
            initialized
                .recv()
                .context("database worker stopped during startup")??;
            workers.push(sender);
            stopped.push(closed);
        }
        Ok(Self {
            workers: Mutex::new(Some(workers)),
            stopped,
            capacity: Arc::new(Semaphore::new(config.capacity)),
            next: AtomicUsize::new(0),
            readers: config.readers,
            connection,
            startup,
        })
    }

    fn submit<R: Send + 'static>(
        &self,
        index: usize,
        scope: &Scope,
        category: Category,
        work: impl FnOnce(&mut T) -> Result<R> + Send + 'static,
    ) -> Result<oneshot::Receiver<Result<R>>> {
        let permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| Overloaded)?;
        let scope = scope.clone();
        let (send, receive) = oneshot::channel();
        let job = Box::new(move |db: &mut Tracked<T>| {
            let _permit = permit;
            if send.is_closed() {
                return;
            }
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                db.run(&scope, category, work)
            }))
            .unwrap_or_else(|_| Err(anyhow!("database job panicked")));
            let _ = send.send(result);
        });
        // Admission and close use the same brief lock. No sender clone can enqueue
        // behind close; dropping all senders drains every accepted live job.
        let workers = self.workers.lock().unwrap();
        let workers = workers.as_ref().context("database pool closed")?;
        workers[index]
            .try_send(job)
            .map_err(|_| anyhow!("database worker stopped"))?;
        Ok(receive)
    }

    pub async fn write<R: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&mut T) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        self.submit(0, scope, Category::Data, work)?
            .await
            .context("database worker stopped")?
    }
    pub fn write_sync<R: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&mut T) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        self.submit(0, scope, Category::Data, work)?
            .blocking_recv()
            .context("database worker stopped")?
    }
    fn read_job<R: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&T) -> Result<R> + Send + 'static,
    ) -> Result<oneshot::Receiver<Result<R>>> {
        let connection = self.connection;
        let index = 1 + self.next.fetch_add(1, Ordering::Relaxed) % self.readers;
        self.submit(index, scope, Category::Data, move |db| {
            let tx = connection(db).unchecked_transaction()?;
            let result = work(db)?;
            tx.commit()?;
            Ok(result)
        })
    }
    pub async fn read<R: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&T) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        self.read_job(scope, work)?
            .await
            .context("database worker stopped")?
    }
    pub fn read_sync<R: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(&T) -> Result<R> + Send + 'static,
    ) -> Result<R> {
        self.read_job(scope, work)?
            .blocking_recv()
            .context("database worker stopped")?
    }
    /// Acknowledge all earlier writes before submitting a new reader snapshot.
    pub async fn barrier(&self, scope: &Scope) -> Result<()> {
        self.write(scope, |_| Ok(())).await
    }

    pub async fn maintain(&self, scope: &Scope, optimize: bool) -> Result<(i64, i64, i64)> {
        let connection = self.connection;
        self.submit(0, scope, Category::Maintenance, move |db| {
            let checkpoint = settings::checkpoint(connection(db))?;
            if optimize {
                settings::optimize(connection(db))?;
            }
            Ok(checkpoint)
        })?
        .await
        .context("database worker stopped")?
    }

    /// Read settings back from every persistent connection on its owning thread.
    pub async fn settings(&self, scope: &Scope) -> Result<Vec<settings::Settings>> {
        let mut values = Vec::new();
        for index in 0..=self.readers {
            let connection = self.connection;
            values.push(
                self.submit(index, scope, Category::Setup, move |db| {
                    settings::Settings::read(connection(db))
                })?
                .await??,
            );
        }
        Ok(values)
    }

    /// Cancellation-safe and repeatable: stop admission, drain, then await closes.
    pub async fn close(&self) -> Result<()> {
        self.workers.lock().unwrap().take();
        for mut stopped in self.stopped.clone() {
            stopped
                .wait_for(|done| *done)
                .await
                .context("database worker panicked")?;
        }
        Ok(())
    }
    pub fn close_sync(&self) -> Result<()> {
        self.workers.lock().unwrap().take();
        // Only the CLI calls this facade; no Tokio executor is blocked.
        for stopped in &self.stopped {
            while !*stopped.borrow() {
                ensure!(stopped.has_changed().is_ok(), "database worker panicked");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        Ok(())
    }
}
