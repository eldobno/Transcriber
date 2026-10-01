use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone)]
pub struct HistoryState {
    db_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct HistoryJobContext {
    pub id: String,
    pub source_path: String,
    pub file_name: String,
    pub media_duration_sec: f64,
    pub model: String,
    pub backend: String,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct HistoryFinish {
    pub status: String,
    pub completed_at_ms: u64,
    pub processing_duration_ms: Option<u64>,
    pub speed_factor: Option<f64>,
    pub output_files: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub source_path: String,
    pub file_name: String,
    pub media_duration_sec: f64,
    pub status: String,
    pub model: String,
    pub backend: String,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub processing_duration_ms: Option<u64>,
    pub speed_factor: Option<f64>,
    pub output_files: Vec<String>,
    pub error: Option<String>,
}

impl HistoryState {
    pub fn new(db_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create history directory '{}': {error}",
                    parent.display()
                )
            })?;
        }

        let state = Self { db_path };
        state.initialize()?;
        Ok(state)
    }

    fn connect(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.db_path).map_err(|error| {
            format!(
                "Failed to open history database '{}': {error}",
                self.db_path.display()
            )
        })?;

        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Failed to configure history database timeout: {error}"))?;

        Ok(connection)
    }

    fn initialize(&self) -> Result<(), String> {
        let connection = self.connect()?;

        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = NORMAL;

                CREATE TABLE IF NOT EXISTS history_jobs (
                    id TEXT PRIMARY KEY,
                    source_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    media_duration_sec REAL NOT NULL DEFAULT 0,
                    status TEXT NOT NULL,
                    model TEXT NOT NULL DEFAULT '',
                    backend TEXT NOT NULL DEFAULT '',
                    created_at_ms INTEGER NOT NULL,
                    started_at_ms INTEGER,
                    completed_at_ms INTEGER,
                    processing_duration_ms INTEGER,
                    speed_factor REAL,
                    output_files_json TEXT NOT NULL DEFAULT '[]',
                    error TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_history_jobs_completed
                    ON history_jobs(completed_at_ms DESC);

                CREATE INDEX IF NOT EXISTS idx_history_jobs_status
                    ON history_jobs(status);
                "#,
            )
            .map_err(|error| format!("Failed to initialize history database: {error}"))?;

        // Any job left as "running" means the app/process ended before it could
        // finish the record. Mark those entries interrupted on the next launch.
        let now = now_ms() as i64;
        connection
            .execute(
                r#"
                UPDATE history_jobs
                SET
                    status = 'interrupted',
                    completed_at_ms = ?1,
                    processing_duration_ms =
                        CASE
                            WHEN started_at_ms IS NOT NULL
                            THEN MAX(0, ?1 - started_at_ms)
                            ELSE processing_duration_ms
                        END,
                    error =
                        COALESCE(
                            error,
                            'Application closed before the job completed.'
                        )
                WHERE status = 'running'
                "#,
                params![now],
            )
            .map_err(|error| format!("Failed to recover interrupted history jobs: {error}"))?;

        Ok(())
    }

    pub fn record_started(&self, job: &HistoryJobContext) -> Result<(), String> {
        let connection = self.connect()?;

        connection
            .execute(
                r#"
                INSERT INTO history_jobs (
                    id,
                    source_path,
                    file_name,
                    media_duration_sec,
                    status,
                    model,
                    backend,
                    created_at_ms,
                    started_at_ms,
                    completed_at_ms,
                    processing_duration_ms,
                    speed_factor,
                    output_files_json,
                    error
                )
                VALUES (
                    ?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8,
                    NULL, NULL, NULL, '[]', NULL
                )
                ON CONFLICT(id) DO UPDATE SET
                    source_path = excluded.source_path,
                    file_name = excluded.file_name,
                    media_duration_sec = excluded.media_duration_sec,
                    status = 'running',
                    model = excluded.model,
                    backend = excluded.backend,
                    created_at_ms = excluded.created_at_ms,
                    started_at_ms = excluded.started_at_ms,
                    completed_at_ms = NULL,
                    processing_duration_ms = NULL,
                    speed_factor = NULL,
                    output_files_json = '[]',
                    error = NULL
                "#,
                params![
                    job.id,
                    job.source_path,
                    job.file_name,
                    job.media_duration_sec,
                    job.model,
                    job.backend,
                    job.created_at_ms as i64,
                    job.started_at_ms.map(|value| value as i64),
                ],
            )
            .map_err(|error| format!("Failed to record history job start: {error}"))?;

        Ok(())
    }

    pub fn record_finished(
        &self,
        job: &HistoryJobContext,
        finish: &HistoryFinish,
    ) -> Result<(), String> {
        let connection = self.connect()?;

        let output_files_json = serde_json::to_string(&finish.output_files)
            .map_err(|error| format!("Failed to serialize output file history: {error}"))?;

        connection
            .execute(
                r#"
                INSERT INTO history_jobs (
                    id,
                    source_path,
                    file_name,
                    media_duration_sec,
                    status,
                    model,
                    backend,
                    created_at_ms,
                    started_at_ms,
                    completed_at_ms,
                    processing_duration_ms,
                    speed_factor,
                    output_files_json,
                    error
                )
                VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
                )
                ON CONFLICT(id) DO UPDATE SET
                    source_path = excluded.source_path,
                    file_name = excluded.file_name,
                    media_duration_sec = excluded.media_duration_sec,
                    status = excluded.status,
                    model = excluded.model,
                    backend = excluded.backend,
                    created_at_ms = excluded.created_at_ms,
                    started_at_ms = excluded.started_at_ms,
                    completed_at_ms = excluded.completed_at_ms,
                    processing_duration_ms = excluded.processing_duration_ms,
                    speed_factor = excluded.speed_factor,
                    output_files_json = excluded.output_files_json,
                    error = excluded.error
                "#,
                params![
                    job.id,
                    job.source_path,
                    job.file_name,
                    job.media_duration_sec,
                    finish.status,
                    job.model,
                    job.backend,
                    job.created_at_ms as i64,
                    job.started_at_ms.map(|value| value as i64),
                    finish.completed_at_ms as i64,
                    finish.processing_duration_ms.map(|value| value as i64),
                    finish.speed_factor,
                    output_files_json,
                    finish.error,
                ],
            )
            .map_err(|error| format!("Failed to finalize history job: {error}"))?;

        Ok(())
    }

    pub fn entries(&self, limit: u32, offset: u32) -> Result<Vec<HistoryEntry>, String> {
        let connection = self.connect()?;
        let limit = limit.clamp(1, 500);

        let mut statement = connection
            .prepare(
                r#"
                SELECT
                    id,
                    source_path,
                    file_name,
                    media_duration_sec,
                    status,
                    model,
                    backend,
                    created_at_ms,
                    started_at_ms,
                    completed_at_ms,
                    processing_duration_ms,
                    speed_factor,
                    output_files_json,
                    error
                FROM history_jobs
                ORDER BY
                    COALESCE(completed_at_ms, started_at_ms, created_at_ms) DESC,
                    created_at_ms DESC
                LIMIT ?1 OFFSET ?2
                "#,
            )
            .map_err(|error| format!("Failed to prepare history query: {error}"))?;

        let rows = statement
            .query_map(params![limit as i64, offset as i64], |row| {
                let output_files_json: String = row.get(12)?;
                let output_files =
                    serde_json::from_str::<Vec<String>>(&output_files_json).unwrap_or_default();

                let created_at_ms: i64 = row.get(7)?;
                let started_at_ms: Option<i64> = row.get(8)?;
                let completed_at_ms: Option<i64> = row.get(9)?;
                let processing_duration_ms: Option<i64> = row.get(10)?;

                Ok(HistoryEntry {
                    id: row.get(0)?,
                    source_path: row.get(1)?,
                    file_name: row.get(2)?,
                    media_duration_sec: row.get(3)?,
                    status: row.get(4)?,
                    model: row.get(5)?,
                    backend: row.get(6)?,
                    created_at_ms: created_at_ms.max(0) as u64,
                    started_at_ms: started_at_ms.map(|value| value.max(0) as u64),
                    completed_at_ms: completed_at_ms.map(|value| value.max(0) as u64),
                    processing_duration_ms: processing_duration_ms.map(|value| value.max(0) as u64),
                    speed_factor: row.get(11)?,
                    output_files,
                    error: row.get(13)?,
                })
            })
            .map_err(|error| format!("Failed to read history: {error}"))?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|error| format!("Failed to decode history row: {error}"))?);
        }

        Ok(entries)
    }

    pub fn delete_entry(&self, id: &str) -> Result<bool, String> {
        let connection = self.connect()?;
        let deleted = connection
            .execute("DELETE FROM history_jobs WHERE id = ?1", params![id])
            .map_err(|error| format!("Failed to delete history entry: {error}"))?;

        Ok(deleted > 0)
    }

    pub fn clear(&self) -> Result<(), String> {
        let connection = self.connect()?;
        connection
            .execute("DELETE FROM history_jobs", [])
            .map_err(|error| format!("Failed to clear history: {error}"))?;

        Ok(())
    }

    pub fn get_entry(&self, id: &str) -> Result<Option<HistoryEntry>, String> {
        let connection = self.connect()?;

        connection
            .query_row(
                r#"
                SELECT
                    id,
                    source_path,
                    file_name,
                    media_duration_sec,
                    status,
                    model,
                    backend,
                    created_at_ms,
                    started_at_ms,
                    completed_at_ms,
                    processing_duration_ms,
                    speed_factor,
                    output_files_json,
                    error
                FROM history_jobs
                WHERE id = ?1
                "#,
                params![id],
                |row| {
                    let output_files_json: String = row.get(12)?;
                    let output_files =
                        serde_json::from_str::<Vec<String>>(&output_files_json).unwrap_or_default();

                    let created_at_ms: i64 = row.get(7)?;
                    let started_at_ms: Option<i64> = row.get(8)?;
                    let completed_at_ms: Option<i64> = row.get(9)?;
                    let processing_duration_ms: Option<i64> = row.get(10)?;

                    Ok(HistoryEntry {
                        id: row.get(0)?,
                        source_path: row.get(1)?,
                        file_name: row.get(2)?,
                        media_duration_sec: row.get(3)?,
                        status: row.get(4)?,
                        model: row.get(5)?,
                        backend: row.get(6)?,
                        created_at_ms: created_at_ms.max(0) as u64,
                        started_at_ms: started_at_ms.map(|value| value.max(0) as u64),
                        completed_at_ms: completed_at_ms.map(|value| value.max(0) as u64),
                        processing_duration_ms: processing_duration_ms
                            .map(|value| value.max(0) as u64),
                        speed_factor: row.get(11)?,
                        output_files,
                        error: row.get(13)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Failed to read history entry: {error}"))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub fn get_history_entries(
    state: tauri::State<'_, HistoryState>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    state.entries(limit.unwrap_or(100), offset.unwrap_or(0))
}

#[tauri::command]
pub fn get_history_entry(
    state: tauri::State<'_, HistoryState>,
    id: String,
) -> Result<Option<HistoryEntry>, String> {
    state.get_entry(&id)
}

#[tauri::command]
pub fn delete_history_entry(
    state: tauri::State<'_, HistoryState>,
    id: String,
) -> Result<bool, String> {
    state.delete_entry(&id)
}

#[tauri::command]
pub fn clear_history(state: tauri::State<'_, HistoryState>) -> Result<(), String> {
    state.clear()
}
