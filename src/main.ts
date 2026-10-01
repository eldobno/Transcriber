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
    <p>Sequential CUDA queue verification</p>

    <div style="display:flex; gap:12px; flex-wrap:wrap;">
      <button id="add-files">Add Files</button>
      <button id="start-queue" disabled>Start Queue</button>
      <button id="clear-queue">Clear</button>
    </div>

    <pre id="output">Initializing...</pre>
  </main>
`;

const output =
    document.querySelector<HTMLPreElement>("#output")!;

const addButton =
    document.querySelector<HTMLButtonElement>("#add-files")!;

const startButton =
    document.querySelector<HTMLButtonElement>("#start-queue")!;

const clearButton =
    document.querySelector<HTMLButtonElement>("#clear-queue")!;

function statusLabel(status: JobStatus): string {
    switch (status) {
        case "inspecting":
            return "INSPECTING";
        case "ready":
            return "READY";
        case "queued":
            return "QUEUED";
        case "converting":
            return "CONVERTING";
        case "transcribing":
            return "TRANSCRIBING";
        case "completed":
            return "COMPLETED ✓";
        case "failed":
            return "FAILED ✗";
        case "cancelled":
            return "CANCELLED";
    }
}

function renderQueue() {
    const lines: string[] = [];

    lines.push(
        queue.running
            ? "QUEUE RUNNING"
            : "QUEUE IDLE",
    );

    lines.push(
        `Files: ${queue.jobs.length}`,
    );

    lines.push(
        `Total media duration: ${queue.totalDurationSec.toFixed(1)} sec`,
    );

    lines.push("");

    if (queue.jobs.length === 0) {
        lines.push("No files.");
        lines.push("");
        lines.push("Add 2–3 short audio/video files.");
    }

    queue.jobs.forEach((job, index) => {
        let progress = "";

        if (
            job.status === "converting" ||
            job.status === "transcribing"
        ) {
            progress =
                `  ${Math.round(activeProgress * 100)}%`;

            if (activeMessage) {
                progress += `  ${activeMessage}`;
            }
        }

        lines.push(
            `${index + 1}. [${statusLabel(job.status)}]${progress}`,
        );

        lines.push(`   ${job.fileName}`);

        if (job.durationSec > 0) {
            lines.push(
                `   ${job.format} • ${job.size} • ${job.durationSec.toFixed(1)} sec`,
            );
        }

        if (job.outputFiles.length > 0) {
            lines.push("   Output:");

            for (const file of job.outputFiles) {
                lines.push(`     ${file}`);
            }
        }

        if (job.error) {
            lines.push(`   ERROR: ${job.error}`);
        }

        lines.push("");
    });

    output.textContent = lines.join("\n");

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

async function initialize() {
    settings =
        await invoke<WhisperSettings>("load_settings");

    // Keep using the known-good test configuration.
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

    // Output beside the original media file.
    settings.outputDirMode = "input_dir";
    settings.outputDirPath = "";

    await invoke("save_settings", { settings });

    queue =
        await invoke<QueueSnapshot>("get_job_queue");

    renderQueue();
}

await listen<QueueSnapshot>(
    "job-queue-updated",
    (event) => {
        queue = event.payload;

        const active = queue.jobs.some(
            (job) =>
                job.status === "converting" ||
                job.status === "transcribing",
        );

        if (!active) {
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
                "Unsupported files:",
                result.ignoredPaths,
            );
        }
    } catch (error) {
        output.textContent =
            `Adding files failed:\n${String(error)}`;
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
        output.textContent =
            `Queue failed:\n${String(error)}`;
    }
});

clearButton.addEventListener("click", async () => {
    try {
        queue =
            await invoke<QueueSnapshot>(
                "clear_job_queue",
            );

        renderQueue();
    } catch (error) {
        output.textContent =
            `Clear failed:\n${String(error)}`;
    }
});

initialize().catch((error) => {
    output.textContent =
        `Initialization failed:\n${String(error)}`;
});