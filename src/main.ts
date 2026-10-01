import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type JobStatus =
  | "inspecting"
  | "ready"
  | "queued"
  | "converting"
  | "transcribing"
  | "completed"
  | "failed"
  | "cancelled";

type QueueJob = {
  id: string;
  sourcePath: string;
  fileName: string;
  format: string;
  size: string;
  durationSec: number;
  status: JobStatus;
  progress: number;
  message: string | null;
  outputFiles: string[];
  error: string | null;
  durationMs: number | null;
  speedFactor: number | null;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

type QueueSnapshot = {
  jobs: QueueJob[];
  running: boolean;
  totalDurationSec: number;
};

type AddJobsResult = {
  queue: QueueSnapshot;
  ignoredPaths: string[];
};

type TranscribeProgress = {
  progress: number;
  message: string;
  active: boolean;
  stage?: string;
};

type TranscribeMetrics = {
  progress: number;
  elapsedSec: number;
  speedFactor: number;
  etaSec: number;
};

type HistoryEntry = {
  id: string;
  sourcePath: string;
  fileName: string;
  mediaDurationSec: number;
  status: string;
  model: string;
  backend: string;
  createdAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  processingDurationMs: number | null;
  speedFactor: number | null;
  outputFiles: string[];
  error: string | null;
};

type WhisperSettings = Record<string, any>;

let settings: WhisperSettings | null = null;

let queue: QueueSnapshot = {
  jobs: [],
  running: false,
  totalDurationSec: 0,
};

let historyEntries: HistoryEntry[] = [];
let activeProgress = 0;
let activeMessage = "";
let activeMetrics: TranscribeMetrics | null = null;
let activeView: "convert" | "history" = "convert";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main>
    <div style="
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:24px;
      margin-bottom:28px;
    ">
      <div>
        <h1 style="margin-bottom:6px;">Transcriber</h1>
        <p style="margin:0;">Queue + SQLite history verification</p>
      </div>

      <nav style="display:flex; gap:8px;">
        <button id="nav-convert">Convert</button>
        <button id="nav-history">History</button>
      </nav>
    </div>

    <section id="convert-view">
      <div style="
        display:flex;
        gap:12px;
        flex-wrap:wrap;
        margin-bottom:24px;
      ">
        <button id="add-files">Add Files</button>
        <button id="start-queue" disabled>Start Queue</button>
        <button id="clear-queue">Clear</button>
      </div>

      <div id="queue-summary"></div>
      <div id="jobs"></div>
    </section>

    <section id="history-view" hidden>
      <div style="
        display:flex;
        gap:12px;
        flex-wrap:wrap;
        margin-bottom:24px;
      ">
        <button id="refresh-history">Refresh History</button>
        <button id="clear-history">Clear History</button>
      </div>

      <div id="history-summary"></div>
      <div id="history-list"></div>
    </section>
  </main>
`;

const convertView =
  document.querySelector<HTMLElement>("#convert-view")!;
const historyView =
  document.querySelector<HTMLElement>("#history-view")!;

const convertNav =
  document.querySelector<HTMLButtonElement>("#nav-convert")!;
const historyNav =
  document.querySelector<HTMLButtonElement>("#nav-history")!;

const queueSummary =
  document.querySelector<HTMLDivElement>("#queue-summary")!;
const jobsContainer =
  document.querySelector<HTMLDivElement>("#jobs")!;

const historySummary =
  document.querySelector<HTMLDivElement>("#history-summary")!;
const historyContainer =
  document.querySelector<HTMLDivElement>("#history-list")!;

const addButton =
  document.querySelector<HTMLButtonElement>("#add-files")!;
const startButton =
  document.querySelector<HTMLButtonElement>("#start-queue")!;
const clearQueueButton =
  document.querySelector<HTMLButtonElement>("#clear-queue")!;

const refreshHistoryButton =
  document.querySelector<HTMLButtonElement>("#refresh-history")!;
const clearHistoryButton =
  document.querySelector<HTMLButtonElement>("#clear-history")!;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }

  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      secs,
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatDurationMs(value: number | null): string {
  if (value === null) {
    return "—";
  }

  if (value < 1000) {
    return `${value} ms`;
  }

  return `${(value / 1000).toFixed(2)} s`;
}

function formatDate(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return new Date(value).toLocaleString();
}

function statusLabel(status: string): string {
  switch (status) {
    case "inspecting":
      return "Inspecting";
    case "ready":
      return "Ready";
    case "queued":
      return "Queued";
    case "converting":
      return "Converting";
    case "transcribing":
      return "Transcribing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "running":
      return "Running";
    default:
      return status;
  }
}

function isPending(job: QueueJob): boolean {
  return (
    job.status === "inspecting" ||
    job.status === "ready" ||
    job.status === "queued"
  );
}

function isActive(job: QueueJob): boolean {
  return (
    job.status === "converting" ||
    job.status === "transcribing"
  );
}

function canMove(job: QueueJob): boolean {
  return job.status === "ready" || job.status === "queued";
}

function canCancel(job: QueueJob): boolean {
  return isPending(job) || isActive(job);
}

function referenceSpeed(): number {
  if (
    activeMetrics &&
    Number.isFinite(activeMetrics.speedFactor) &&
    activeMetrics.speedFactor > 0
  ) {
    return activeMetrics.speedFactor;
  }

  const completedSpeeds = queue.jobs
    .filter(
      (job) =>
        job.status === "completed" &&
        job.speedFactor !== null &&
        Number.isFinite(job.speedFactor) &&
        (job.speedFactor ?? 0) > 0 &&
        job.durationSec >= 5,
    )
    .map((job) => job.speedFactor as number);

  if (completedSpeeds.length === 0) {
    return 0;
  }

  return (
    completedSpeeds.reduce((sum, speed) => sum + speed, 0) /
    completedSpeeds.length
  );
}

function estimatedJobSeconds(
  job: QueueJob,
  speed: number,
): number | null {
  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return 0;
  }

  if (
    (job.status === "converting" ||
      job.status === "transcribing") &&
    activeMetrics
  ) {
    return Math.max(0, activeMetrics.etaSec);
  }

  if (speed > 0 && job.durationSec > 0) {
    return job.durationSec / speed;
  }

  return null;
}

function queueEtaSeconds(): number | null {
  const speed = referenceSpeed();
  let total = 0;
  let hasEstimate = false;

  for (const job of queue.jobs) {
    const estimate = estimatedJobSeconds(job, speed);

    if (estimate !== null) {
      total += estimate;

      if (
        job.status !== "completed" &&
        job.status !== "failed" &&
        job.status !== "cancelled"
      ) {
        hasEstimate = true;
      }
    }
  }

  return hasEstimate ? total : 0;
}

function renderQueue() {
  const completed = queue.jobs.filter(
    (job) => job.status === "completed",
  ).length;

  const failed = queue.jobs.filter(
    (job) => job.status === "failed",
  ).length;

  const cancelled = queue.jobs.filter(
    (job) => job.status === "cancelled",
  ).length;

  const speed = referenceSpeed();
  const queueEta = queueEtaSeconds();

  queueSummary.innerHTML = `
    <div style="
      padding:14px 16px;
      border:1px solid #444;
      border-radius:8px;
      background:#242424;
      line-height:1.6;
      margin-bottom:18px;
    ">
      <strong>${queue.running ? "QUEUE RUNNING" : "QUEUE IDLE"}</strong><br>
      Files: ${queue.jobs.length}
      &nbsp;•&nbsp;
      Duration: ${formatDuration(queue.totalDurationSec)}
      &nbsp;•&nbsp;
      Completed: ${completed}
      &nbsp;•&nbsp;
      Failed: ${failed}
      &nbsp;•&nbsp;
      Cancelled: ${cancelled}
      ${
        queue.running
          ? `<br>
             Speed: ${
               speed > 0
                 ? `${speed.toFixed(2)}× realtime`
                 : "measuring…"
             }
             &nbsp;•&nbsp;
             Queue remaining: ${
               queueEta !== null
                 ? formatDuration(queueEta)
                 : "measuring…"
             }`
          : ""
      }
    </div>
  `;

  if (queue.jobs.length === 0) {
    jobsContainer.innerHTML = `
      <div style="
        padding:24px;
        border:1px solid #444;
        border-radius:8px;
        background:#242424;
      ">
        No files yet. Add a few short audio/video files.
      </div>
    `;
  } else {
    jobsContainer.innerHTML = queue.jobs
      .map((job, index) => {
        const active = isActive(job);

        const progress =
          active && job.status === "transcribing"
            ? Math.round(activeProgress * 100)
            : job.status === "completed"
              ? 100
              : 0;

        const progressText =
          active && job.status === "transcribing"
            ? `${progress}%`
            : "";

        const detailMessage =
          activeMessage && active
            ? activeMessage
            : job.message ?? "";

        const speedForEstimate = referenceSpeed();
        const estimate = estimatedJobSeconds(
          job,
          speedForEstimate,
        );

        const timingText =
          job.status === "transcribing" && activeMetrics
            ? `${activeMetrics.speedFactor.toFixed(
                2,
              )}× • ${formatDuration(
                activeMetrics.etaSec,
              )} remaining`
            : job.status === "queued" &&
                estimate !== null
              ? `~${formatDuration(
                  estimate,
                )} estimated`
              : job.status === "completed" &&
                  job.speedFactor
                ? `${job.speedFactor.toFixed(
                    2,
                  )}× realtime`
                : "";

        const outputs =
          job.outputFiles.length > 0
            ? `
              <div style="margin-top:10px; font-size:0.9rem;">
                <strong>Output</strong><br>
                ${job.outputFiles
                  .map(
                    (file) =>
                      `${escapeHtml(file)}<br>`,
                  )
                  .join("")}
              </div>
            `
            : "";

        const error =
          job.error
            ? `
              <div style="margin-top:10px;">
                <strong>Error:</strong>
                ${escapeHtml(job.error)}
              </div>
            `
            : "";

        const upDisabled =
          !canMove(job) || index === 0
            ? "disabled"
            : "";

        const downDisabled =
          !canMove(job) ||
          index === queue.jobs.length - 1
            ? "disabled"
            : "";

        const cancelDisabled =
          !canCancel(job) ? "disabled" : "";

        return `
          <section style="
            margin-bottom:12px;
            padding:16px;
            border:1px solid #444;
            border-radius:8px;
            background:#242424;
          ">
            <div style="
              display:flex;
              justify-content:space-between;
              align-items:flex-start;
              gap:16px;
            ">
              <div style="min-width:0; flex:1;">
                <div style="font-weight:600;">
                  ${index + 1}. ${escapeHtml(
                    job.fileName,
                  )}
                </div>

                <div style="
                  margin-top:6px;
                  font-size:0.9rem;
                  color:#b8b8b8;
                ">
                  ${statusLabel(job.status)}
                  ${
                    progressText
                      ? ` • ${progressText}`
                      : ""
                  }
                  ${
                    timingText
                      ? ` • ${escapeHtml(
                          timingText,
                        )}`
                      : ""
                  }
                  ${
                    detailMessage
                      ? ` • ${escapeHtml(
                          detailMessage,
                        )}`
                      : ""
                  }
                </div>

                <div style="
                  margin-top:6px;
                  font-size:0.85rem;
                  color:#999;
                ">
                  ${escapeHtml(job.format || "Unknown")}
                  ${
                    job.size
                      ? ` • ${escapeHtml(job.size)}`
                      : ""
                  }
                  ${
                    job.durationSec > 0
                      ? ` • ${formatDuration(
                          job.durationSec,
                        )}`
                      : ""
                  }
                </div>

                ${outputs}
                ${error}
              </div>

              <div style="
                display:flex;
                gap:8px;
                flex-wrap:wrap;
                justify-content:flex-end;
              ">
                <button
                  data-action="up"
                  data-job-id="${escapeHtml(job.id)}"
                  ${upDisabled}
                  title="Move up"
                >
                  ↑
                </button>

                <button
                  data-action="down"
                  data-job-id="${escapeHtml(job.id)}"
                  ${downDisabled}
                  title="Move down"
                >
                  ↓
                </button>

                <button
                  data-action="cancel"
                  data-job-id="${escapeHtml(job.id)}"
                  ${cancelDisabled}
                >
                  ${active ? "Cancel Active" : "Cancel"}
                </button>
              </div>
            </div>
          </section>
        `;
      })
      .join("");
  }

  const hasRunnableJobs = queue.jobs.some(
    (job) =>
      job.status === "ready" ||
      job.status === "queued",
  );

  startButton.disabled =
    queue.running || !hasRunnableJobs;

  addButton.disabled = queue.running;
  clearQueueButton.disabled = queue.running;
}

function renderHistory() {
  const completed = historyEntries.filter(
    (entry) => entry.status === "completed",
  ).length;

  const failed = historyEntries.filter(
    (entry) => entry.status === "failed",
  ).length;

  const cancelled = historyEntries.filter(
    (entry) => entry.status === "cancelled",
  ).length;

  const interrupted = historyEntries.filter(
    (entry) => entry.status === "interrupted",
  ).length;

  historySummary.innerHTML = `
    <div style="
      padding:14px 16px;
      border:1px solid #444;
      border-radius:8px;
      background:#242424;
      line-height:1.6;
      margin-bottom:18px;
    ">
      <strong>HISTORY</strong><br>
      Records: ${historyEntries.length}
      &nbsp;•&nbsp;
      Completed: ${completed}
      &nbsp;•&nbsp;
      Failed: ${failed}
      &nbsp;•&nbsp;
      Cancelled: ${cancelled}
      &nbsp;•&nbsp;
      Interrupted: ${interrupted}
    </div>
  `;

  if (historyEntries.length === 0) {
    historyContainer.innerHTML = `
      <div style="
        padding:24px;
        border:1px solid #444;
        border-radius:8px;
        background:#242424;
      ">
        No history records yet.
        Run or cancel a few queue jobs in Convert.
      </div>
    `;
    return;
  }

  historyContainer.innerHTML = historyEntries
    .map((entry, index) => {
      const outputs =
        entry.outputFiles.length > 0
          ? `
            <div style="margin-top:10px;">
              <strong>Outputs</strong><br>
              ${entry.outputFiles
                .map(
                  (file) =>
                    `${escapeHtml(file)}<br>`,
                )
                .join("")}
            </div>
          `
          : "";

      const error =
        entry.error
          ? `
            <div style="margin-top:10px;">
              <strong>Error</strong><br>
              ${escapeHtml(entry.error)}
            </div>
          `
          : "";

      return `
        <section style="
          margin-bottom:12px;
          padding:16px;
          border:1px solid #444;
          border-radius:8px;
          background:#242424;
        ">
          <div style="
            display:flex;
            justify-content:space-between;
            gap:16px;
            align-items:flex-start;
          ">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:600;">
                ${index + 1}. ${escapeHtml(
                  entry.fileName,
                )}
              </div>

              <div style="
                margin-top:6px;
                color:#b8b8b8;
              ">
                ${escapeHtml(
                  statusLabel(entry.status),
                )}
                ${
                  entry.speedFactor !== null
                    ? ` • ${entry.speedFactor.toFixed(
                        2,
                      )}× realtime`
                    : ""
                }
                ${
                  entry.processingDurationMs !== null
                    ? ` • ${formatDurationMs(
                        entry.processingDurationMs,
                      )}`
                    : ""
                }
              </div>

              <div style="
                margin-top:6px;
                color:#999;
                font-size:0.9rem;
              ">
                Media: ${formatDuration(
                  entry.mediaDurationSec,
                )}
                • Backend: ${escapeHtml(
                  entry.backend || "—",
                )}
                • Model: ${escapeHtml(
                  entry.model || "—",
                )}
              </div>

              <div style="
                margin-top:6px;
                color:#999;
                font-size:0.9rem;
                overflow-wrap:anywhere;
              ">
                ${escapeHtml(entry.sourcePath)}
              </div>

              <div style="
                margin-top:6px;
                color:#999;
                font-size:0.85rem;
              ">
                Created: ${formatDate(
                  entry.createdAtMs,
                )}<br>
                Started: ${formatDate(
                  entry.startedAtMs,
                )}<br>
                Finished: ${formatDate(
                  entry.completedAtMs,
                )}
              </div>

              ${outputs}
              ${error}
            </div>

            <button
              data-delete-history-id="${escapeHtml(
                entry.id,
              )}"
            >
              Delete
            </button>
          </div>
        </section>
      `;
    })
    .join("");
}

async function refreshQueue() {
  queue =
    await invoke<QueueSnapshot>("get_job_queue");
  renderQueue();
}

async function loadHistory() {
  try {
    historyEntries =
      await invoke<HistoryEntry[]>(
        "get_history_entries",
        {
          limit: 100,
          offset: 0,
        },
      );

    renderHistory();
  } catch (error) {
    historySummary.textContent =
      `History load failed: ${String(error)}`;
  }
}

async function showView(
  view: "convert" | "history",
) {
  activeView = view;

  convertView.hidden = view !== "convert";
  historyView.hidden = view !== "history";

  if (view === "history") {
    await loadHistory();
  }
}

async function initialize() {
  settings =
    await invoke<WhisperSettings>(
      "load_settings",
    );

  // Keep our known-good CUDA regression configuration
  // while these backend systems are still being verified.
  settings.selectedBackend = "CUDA";
  settings.modelPath = "ggml-tiny.en.bin";
  settings.outputTxt = true;
  settings.outputSrt = false;
  settings.outputVtt = false;
  settings.outputLrc = false;
  settings.outputCsv = false;
  settings.outputJson = false;
  settings.outputJsonFull = false;
  settings.vad = false;
  settings.diarize = false;
  settings.tinyDiarize = false;
  settings.ffmpegSource = "bundled";
  settings.outputDirMode = "input_dir";
  settings.outputDirPath = "";

  await invoke(
    "save_settings",
    { settings },
  );

  await refreshQueue();
  renderHistory();
}

await listen<QueueSnapshot>(
  "job-queue-updated",
  async (event) => {
    queue = event.payload;

    const hasActive =
      queue.jobs.some(isActive);

    if (!hasActive) {
      activeProgress = 0;
      activeMessage = "";
      activeMetrics = null;
    }

    renderQueue();

    if (activeView === "history") {
      await loadHistory();
    }
  },
);

await listen<TranscribeMetrics>(
  "transcribe-metrics",
  (event) => {
    activeMetrics = event.payload;
    activeProgress = event.payload.progress;
    renderQueue();
  },
);

await listen<TranscribeProgress>(
  "transcribe-status",
  (event) => {
    activeProgress =
      event.payload.progress ?? 0;
    activeMessage =
      event.payload.message ?? "";

    renderQueue();
  },
);

convertNav.addEventListener(
  "click",
  () => {
    void showView("convert");
  },
);

historyNav.addEventListener(
  "click",
  () => {
    void showView("history");
  },
);

addButton.addEventListener(
  "click",
  async () => {
    try {
      const paths =
        await invoke<string[] | null>(
          "select_files",
        );

      if (!paths || paths.length === 0) {
        return;
      }

      const result =
        await invoke<AddJobsResult>(
          "add_job_queue_files",
          { paths },
        );

      queue = result.queue;
      renderQueue();

      if (
        result.ignoredPaths.length > 0
      ) {
        console.log(
          "Unsupported files ignored:",
          result.ignoredPaths,
        );
      }
    } catch (error) {
      queueSummary.textContent =
        `Adding files failed: ${String(
          error,
        )}`;
    }
  },
);

startButton.addEventListener(
  "click",
  async () => {
    if (!settings) {
      return;
    }

    try {
      await invoke<QueueSnapshot>(
        "start_job_queue",
        { settings },
      );
    } catch (error) {
      queueSummary.textContent =
        `Queue failed: ${String(error)}`;

      await refreshQueue();
    }
  },
);

clearQueueButton.addEventListener(
  "click",
  async () => {
    try {
      queue =
        await invoke<QueueSnapshot>(
          "clear_job_queue",
        );

      activeProgress = 0;
      activeMessage = "";
      activeMetrics = null;

      renderQueue();
    } catch (error) {
      queueSummary.textContent =
        `Clear failed: ${String(error)}`;
    }
  },
);

jobsContainer.addEventListener(
  "click",
  async (event) => {
    const target =
      event.target as HTMLElement;

    const button =
      target.closest<HTMLButtonElement>(
        "button[data-action][data-job-id]",
      );

    if (!button) {
      return;
    }

    const action =
      button.dataset.action;
    const jobId =
      button.dataset.jobId;

    if (!action || !jobId) {
      return;
    }

    const index =
      queue.jobs.findIndex(
        (job) => job.id === jobId,
      );

    if (index < 0) {
      return;
    }

    button.disabled = true;

    try {
      if (action === "up" && index > 0) {
        queue =
          await invoke<QueueSnapshot>(
            "move_queue_job",
            {
              jobId,
              newIndex: index - 1,
            },
          );
      }

      if (
        action === "down" &&
        index < queue.jobs.length - 1
      ) {
        queue =
          await invoke<QueueSnapshot>(
            "move_queue_job",
            {
              jobId,
              newIndex: index + 1,
            },
          );
      }

      if (action === "cancel") {
        queue =
          await invoke<QueueSnapshot>(
            "cancel_queue_job",
            { jobId },
          );
      }

      renderQueue();
    } catch (error) {
      queueSummary.textContent =
        `${action} failed: ${String(
          error,
        )}`;

      await refreshQueue();
    }
  },
);

refreshHistoryButton.addEventListener(
  "click",
  loadHistory,
);

clearHistoryButton.addEventListener(
  "click",
  async () => {
    try {
      await invoke("clear_history");
      await loadHistory();
    } catch (error) {
      historySummary.textContent =
        `Clear history failed: ${String(
          error,
        )}`;
    }
  },
);

historyContainer.addEventListener(
  "click",
  async (event) => {
    const target =
      event.target as HTMLElement;

    const button =
      target.closest<HTMLButtonElement>(
        "button[data-delete-history-id]",
      );

    if (!button) {
      return;
    }

    const id =
      button.dataset.deleteHistoryId;

    if (!id) {
      return;
    }

    button.disabled = true;

    try {
      await invoke<boolean>(
        "delete_history_entry",
        { id },
      );

      await loadHistory();
    } catch (error) {
      historySummary.textContent =
        `Delete failed: ${String(error)}`;
    }
  },
);

initialize().catch((error) => {
  queueSummary.textContent =
    `Initialization failed: ${String(
      error,
    )}`;
});
