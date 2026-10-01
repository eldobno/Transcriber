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
    createdAtMs: number;
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

type WhisperSettings = Record<string, any>;

let settings: WhisperSettings | null = null;

let queue: QueueSnapshot = {
    jobs: [],
    running: false,
    totalDurationSec: 0,
};

let activeProgress = 0;
let activeMessage = "";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main>
    <h1>Transcriber</h1>
    <p>Queue controls verification</p>

    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:24px;">
      <button id="add-files">Add Files</button>
      <button id="start-queue" disabled>Start Queue</button>
      <button id="clear-queue">Clear</button>
    </div>

    <div id="summary" style="margin-bottom:18px;"></div>
    <div id="jobs"></div>
  </main>
`;

const summary = document.querySelector<HTMLDivElement>("#summary")!;
const jobsContainer = document.querySelector<HTMLDivElement>("#jobs")!;

const addButton =
    document.querySelector<HTMLButtonElement>("#add-files")!;

const startButton =
    document.querySelector<HTMLButtonElement>("#start-queue")!;

const clearButton =
    document.querySelector<HTMLButtonElement>("#clear-queue")!;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function statusLabel(status: JobStatus): string {
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

    summary.innerHTML = `
    <div style="
      padding:14px 16px;
      border:1px solid #444;
      border-radius:8px;
      background:#242424;
      line-height:1.6;
    ">
      <strong>${queue.running ? "QUEUE RUNNING" : "QUEUE IDLE"}</strong><br>
      Files: ${queue.jobs.length}
      &nbsp;•&nbsp;
      Duration: ${queue.totalDurationSec.toFixed(1)} sec
      &nbsp;•&nbsp;
      Completed: ${completed}
      &nbsp;•&nbsp;
      Failed: ${failed}
      &nbsp;•&nbsp;
      Cancelled: ${cancelled}
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

                const outputs =
                    job.outputFiles.length > 0
                        ? `
              <div style="margin-top:10px; font-size:0.9rem;">
                <strong>Output</strong><br>
                ${job.outputFiles
                            .map(
                                (file) =>
                                    `<span>${escapeHtml(file)}</span><br>`,
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
                    !canMove(job) || index === 0 ? "disabled" : "";

                const downDisabled =
                    !canMove(job) || index === queue.jobs.length - 1
                        ? "disabled"
                        : "";

                const cancelDisabled =
                    !canCancel(job) ? "disabled" : "";

                return `
          <section
            style="
              margin-bottom:12px;
              padding:16px;
              border:1px solid #444;
              border-radius:8px;
              background:#242424;
            "
          >
            <div style="
              display:flex;
              justify-content:space-between;
              align-items:flex-start;
              gap:16px;
            ">
              <div style="min-width:0; flex:1;">
                <div style="font-weight:600;">
                  ${index + 1}. ${escapeHtml(job.fileName)}
                </div>

                <div style="
                  margin-top:6px;
                  font-size:0.9rem;
                  color:#b8b8b8;
                ">
                  ${statusLabel(job.status)}
                  ${progressText ? ` • ${progressText}` : ""}
                  ${detailMessage ? ` • ${escapeHtml(detailMessage)}` : ""}
                </div>

                <div style="
                  margin-top:6px;
                  font-size:0.85rem;
                  color:#999;
                ">
                  ${escapeHtml(job.format || "Unknown")}
                  ${job.size ? ` • ${escapeHtml(job.size)}` : ""}
                  ${
                    job.durationSec > 0
                        ? ` • ${job.durationSec.toFixed(1)} sec`
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
    clearButton.disabled = queue.running;
}

async function refreshQueue() {
    queue = await invoke<QueueSnapshot>("get_job_queue");
    renderQueue();
}

async function initialize() {
    settings =
        await invoke<WhisperSettings>("load_settings");

    // Known-good test configuration from our successful CUDA test.
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

    await invoke("save_settings", { settings });

    await refreshQueue();
}

await listen<QueueSnapshot>(
    "job-queue-updated",
    (event) => {
        queue = event.payload;

        const hasActive = queue.jobs.some(isActive);

        if (!hasActive) {
            activeProgress = 0;
            activeMessage = "";
        }

        renderQueue();
    },
);

await listen<TranscribeProgress>(
    "transcribe-status",
    (event) => {
        activeProgress = event.payload.progress ?? 0;
        activeMessage = event.payload.message ?? "";
        renderQueue();
    },
);

addButton.addEventListener("click", async () => {
    try {
        const paths =
            await invoke<string[] | null>("select_files");

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

        if (result.ignoredPaths.length > 0) {
            console.log(
                "Unsupported files ignored:",
                result.ignoredPaths,
            );
        }
    } catch (error) {
        summary.textContent =
            `Adding files failed: ${String(error)}`;
    }
});

startButton.addEventListener("click", async () => {
    if (!settings) return;

    try {
        await invoke<QueueSnapshot>(
            "start_job_queue",
            { settings },
        );
    } catch (error) {
        summary.textContent =
            `Queue failed: ${String(error)}`;

        await refreshQueue();
    }
});

clearButton.addEventListener("click", async () => {
    try {
        queue =
            await invoke<QueueSnapshot>(
                "clear_job_queue",
            );

        activeProgress = 0;
        activeMessage = "";
        renderQueue();
    } catch (error) {
        summary.textContent =
            `Clear failed: ${String(error)}`;
    }
});

jobsContainer.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;

    const button = target.closest<HTMLButtonElement>(
        "button[data-action][data-job-id]",
    );

    if (!button) return;

    const action = button.dataset.action;
    const jobId = button.dataset.jobId;

    if (!action || !jobId) return;

    const index = queue.jobs.findIndex(
        (job) => job.id === jobId,
    );

    if (index < 0) return;

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
        summary.textContent =
            `${action} failed: ${String(error)}`;

        await refreshQueue();
    }
});

initialize().catch((error) => {
    summary.textContent =
        `Initialization failed: ${String(error)}`;
});
