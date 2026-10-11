//! rusqlite 0.38 trace/profile accept function pointers, not capturing closures;
//! progress counts VM instructions, not statements. Use its exported SQLite FFI
//! trace_v2 context argument so each connection carries an explicit job scope.
//! https://docs.rs/rusqlite/0.38.0/rusqlite/struct.Connection.html#method.trace_v2
use anyhow::{Result, ensure};
use rusqlite::{Connection, ffi};
use std::{
    ffi::{CStr, c_int, c_uint, c_void},
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Copy)]
pub enum Category {
    Data,
    Setup,
    Maintenance,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub data: usize,
    pub transaction: usize,
    pub setup: usize,
    pub maintenance: usize,
}

/// Clone and pass the same handle to every job belonging to one request.
/// No global registry, thread-local state, or reset operation exists.
#[derive(Debug, Default, Clone)]
pub struct Scope(Arc<Mutex<ScopeState>>);

#[derive(Debug, Default)]
struct ScopeState {
    counts: Counts,
    statements: Option<Vec<String>>,
}

impl Scope {
    pub fn counts(&self) -> Counts {
        self.0.lock().unwrap().counts
    }

    /// Test-only opt-in evidence: SQL templates, never expanded parameter values.
    pub fn recording() -> Self {
        Self(Arc::new(Mutex::new(ScopeState {
            counts: Counts::default(),
            statements: Some(Vec::new()),
        })))
    }

    pub fn statements(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .statements
            .clone()
            .unwrap_or_default()
    }
}

struct Context {
    active: Mutex<Option<(Scope, Category)>>,
}

unsafe extern "C" fn destroy_context(context: *mut c_void) {
    // SQLite clientdata destructors run exactly once, even on registration OOM.
    unsafe {
        drop(Arc::from_raw(context.cast::<Context>()));
    }
}

fn first_word(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start();
        if let Some(comment) = sql.strip_prefix("--") {
            sql = comment.split_once('\n').map_or("", |(_, rest)| rest);
        } else if let Some(comment) = sql.strip_prefix("/*") {
            sql = comment.split_once("*/").map_or("", |(_, rest)| rest);
        } else {
            return sql
                .split(|c: char| !c.is_ascii_alphabetic())
                .next()
                .unwrap_or("");
        }
    }
}

unsafe extern "C" fn trace(
    event: c_uint,
    context: *mut c_void,
    statement: *mut c_void,
    text: *mut c_void,
) -> c_int {
    // SQLite clientdata owns an Arc until the connection actually closes. A
    // TRACE_CLOSE event is insufficient: SQLite emits it even on a failed close.
    let _ = std::panic::catch_unwind(|| unsafe {
        if event != ffi::SQLITE_TRACE_STMT {
            return;
        }
        let original = ffi::sqlite3_sql(statement.cast());
        if original.is_null() || text.is_null() {
            return;
        }
        let original = CStr::from_ptr(original);
        let event_sql = CStr::from_ptr(text.cast());
        // Trigger subprogram callbacks are not extra application executions.
        if event_sql.to_bytes().starts_with(b"--") && event_sql != original {
            return;
        }
        let context = &*context.cast::<Context>();
        let active = context.active.lock().unwrap();
        let Some((scope, category)) = active.as_ref() else {
            return;
        };
        let mut state = scope.0.lock().unwrap();
        let sql = original.to_string_lossy();
        if let Some(statements) = &mut state.statements {
            statements.push(sql.to_string());
        }
        let counts = &mut state.counts;
        let word = first_word(&sql);
        if ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]
            .iter()
            .any(|token| word.eq_ignore_ascii_case(token))
        {
            counts.transaction += 1;
        } else {
            match category {
                Category::Data => counts.data += 1,
                Category::Setup => counts.setup += 1,
                Category::Maintenance => counts.maintenance += 1,
            }
        }
    });
    0
}

/// Owns both the resource and its trace context. `connection` must always return
/// the same connection; jobs must not replace it or install another trace hook.
pub struct Tracked<T> {
    value: T,
    context: Arc<Context>,
}

impl<T> Tracked<T> {
    pub fn new(value: T, connection: fn(&T) -> &Connection) -> Result<Self> {
        let tracked = Self {
            value,
            context: Arc::new(Context {
                active: Mutex::new(None),
            }),
        };
        // The bundled SQLite supports clientdata (>=3.44). Its destructor, unlike
        // TRACE_CLOSE, does not run when sqlite3_close returns SQLITE_BUSY.
        // https://sqlite.org/c3ref/get_clientdata.html
        let db = unsafe { (connection)(&tracked.value).handle() };
        ensure!(
            unsafe { ffi::sqlite3_get_clientdata(db, c"factory-db-counter".as_ptr()).is_null() },
            "connection already has a counter"
        );
        let context = Arc::into_raw(tracked.context.clone());
        let status = unsafe {
            ffi::sqlite3_set_clientdata(
                db,
                c"factory-db-counter".as_ptr(),
                context.cast_mut().cast(),
                Some(destroy_context),
            )
        };
        ensure!(
            status == ffi::SQLITE_OK,
            "cannot register counter context: {status}"
        );
        let status = unsafe {
            ffi::sqlite3_trace_v2(
                db,
                ffi::SQLITE_TRACE_STMT,
                Some(trace),
                context.cast_mut().cast(),
            )
        };
        ensure!(
            status == ffi::SQLITE_OK,
            "cannot register statement counter: {status}"
        );
        Ok(tracked)
    }

    /// Wrap the same connection in an owner's resource, preserving its counter.
    pub fn try_map<U>(
        self,
        scope: &Scope,
        work: impl FnOnce(T) -> Result<U>,
    ) -> Result<Tracked<U>> {
        *self.context.active.lock().unwrap() = Some((scope.clone(), Category::Setup));
        let value = work(self.value);
        *self.context.active.lock().unwrap() = None;
        Ok(Tracked {
            value: value?,
            context: self.context,
        })
    }

    pub fn run<R>(
        &mut self,
        scope: &Scope,
        category: Category,
        work: impl FnOnce(&mut T) -> R,
    ) -> R {
        *self.context.active.lock().unwrap() = Some((scope.clone(), category));
        struct Reset<'a>(&'a Context);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                *self.0.active.lock().unwrap() = None;
            }
        }
        let _reset = Reset(&self.context);
        work(&mut self.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_close_preserves_counter_and_triggers_are_not_application_statements() -> Result<()> {
        let mut db = Tracked::new(Connection::open_in_memory()?, |db| db)?;
        let setup = Scope::default();
        db.run(&setup, Category::Setup, |db| db.execute_batch(
            "CREATE TABLE items(n INTEGER); CREATE TABLE audit(n INTEGER);
             CREATE TRIGGER audit_insert AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(new.n); END;"
        ))?;
        // An unfinished native statement forces Connection::close to return BUSY.
        // Finalize it below on the same thread; never close the handle ourselves.
        let mut unfinished = std::ptr::null_mut();
        let code = db.run(&setup, Category::Setup, |db| unsafe {
            ffi::sqlite3_prepare_v2(
                db.handle(),
                c"SELECT 1".as_ptr(),
                -1,
                &mut unfinished,
                std::ptr::null_mut(),
            )
        });
        assert_eq!(code, ffi::SQLITE_OK);
        let mut db = db.try_map(&setup, |db| {
            let (db, error) = db
                .close()
                .expect_err("unfinished statement must prevent close");
            assert_eq!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy)
            );
            Ok(db)
        })?;
        let scope = Scope::default();
        let total = db.run(&scope, Category::Data, |db| -> Result<i64> {
            let mut insert = db.prepare("INSERT INTO items VALUES(?1)")?;
            insert.execute([7])?;
            insert.execute([11])?;
            Ok(db.query_row("SELECT (SELECT SUM(n) FROM audit)", [], |r| r.get(0))?)
        })?;
        assert_eq!(total, 18);
        assert_eq!(scope.counts().data, 3);
        assert_eq!(setup.counts().setup, 3);
        assert_eq!(unsafe { ffi::sqlite3_finalize(unfinished) }, ffi::SQLITE_OK);
        drop(db);
        Ok(())
    }
}
