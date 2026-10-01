import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type WhisperSettings = Record<string, any>;

type FileMetadata = {
  name: string;
  path: string;
  format: string;
  size: string;
  durationSec: number;
  exists: boolean;
};

type DownloadProgress = {
  modelName: string;
  phase: "starting" | "downloading" | "paused" | "completed" | "failed";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  error: string | null;
};

type TranscribeProgress = {
  progress: number;
  message: string;
  active: boolean;
  stage?: string;
};

type TranscriptionResult = {
  durationMs: number;
  speedFactor: number;
  generatedFiles: string[];
  outputDir: string;
};

type ModelScanResult = {
  transModels: string[];
  vadModels: string[];
};

let settings: WhisperSettings | null = null;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main>
    <h1>Transcriber</h1>
    <p>CUDA transcription verification</p>

    <div style="display:flex; gap:12px; flex-wrap:wrap;">
      <button id="download-model">Download tiny.en</button>
      <button id="transcribe-file" disabled>Choose File & Transcribe</button>
    </div>

    <pre id="output">Initializing backend...</pre>
  </main>
`;

const output = document.querySelector<HTMLPreElement>("#output")!;
const downloadButton =
    document.querySelector<HTMLButtonElement>("#download-model")!;
const transcribeButton =
    document.querySelector<HTMLButtonElement>("#transcribe-file")!;

function show(message: string) {
  output.textContent = message;
}

async function refreshModelState() {
  if (!settings) return;

  const scan = await invoke<ModelScanResult>("scan_models", {
    modelsDir: settings.modelsDir,
    backend: "CUDA",
  });

  const installed = scan.transModels.some(
      (model) => model.replace(/\\/g, "/").split("/").pop() === "ggml-tiny.en.bin",
  );

  if (installed) {
    downloadButton.textContent = "tiny.en Installed";
    downloadButton.disabled = true;
    transcribeButton.disabled = false;

    show(
        [
          "Backend ready.",
          "",
          `Backend: CUDA`,
          `Model: ggml-tiny.en.bin`,
          `Models directory: ${settings.modelsDir}`,
          "",
          "Choose a media file to run the first real transcription.",
        ].join("\n"),
    );
  } else {
    downloadButton.disabled = false;
    transcribeButton.disabled = true;

    show(
        [
          "Backend ready.",
          "",
          `Backend: CUDA`,
          `Models directory: ${settings.modelsDir}`,
          "",
          "tiny.en is not installed yet.",
          "Click Download tiny.en.",
        ].join("\n"),
    );
  }
}

async function initialize() {
  settings = await invoke<WhisperSettings>("load_settings");

  // Configure only what we need for this verification run.
  settings.selectedBackend = "CUDA";
  settings.modelPath = "ggml-tiny.en.bin";

  settings.outputTxt = true;
  settings.outputSrt = false;
  settings.outputVtt = false;
  settings.outputLrc = false;
  settings.outputCsv = false;
  settings.outputJson = false;
  settings.outputJsonFull = false;

  // Keep the first test simple.
  settings.vad = false;
  settings.diarize = false;
  settings.tinyDiarize = false;

  // We now have the bundled FFmpeg package copied into resources.
  settings.ffmpegSource = "bundled";

  // Put output beside the source file.
  settings.outputDirMode = "input_dir";
  settings.outputDirPath = "";

  await invoke("save_settings", { settings });

  await refreshModelState();
}

listen<DownloadProgress>("model-download-status", async (event) => {
  const p = event.payload;

  if (p.modelName !== "tiny.en") return;

  if (p.phase === "starting") {
    show("Connecting to model download...");
    return;
  }

  if (p.phase === "downloading") {
    const percent = Math.round(p.progress * 100);
    const downloadedMb = (p.downloadedBytes / 1024 / 1024).toFixed(1);
    const totalMb = (p.totalBytes / 1024 / 1024).toFixed(1);
    const speedMbps =
        p.speedBps > 0 ? ((p.speedBps * 8) / 1_000_000).toFixed(1) : "...";

    show(
        [
          "Downloading tiny.en...",
          "",
          `${percent}%`,
          `${downloadedMb} MB / ${totalMb} MB`,
          `${speedMbps} Mbps`,
        ].join("\n"),
    );
    return;
  }

  if (p.phase === "completed") {
    show("Model downloaded and verified successfully.");
    await refreshModelState();
    return;
  }

  if (p.phase === "failed") {
    show(`Model download failed:\n${p.error ?? "Unknown error"}`);
  }
});

listen<TranscribeProgress>("transcribe-status", (event) => {
  const p = event.payload;
  const percent = Math.round((p.progress || 0) * 100);

  show(
      [
        "Transcription running...",
        "",
        `Stage: ${p.stage ?? "working"}`,
        `Progress: ${percent}%`,
        p.message,
      ].join("\n"),
  );
});

downloadButton.addEventListener("click", async () => {
  if (!settings) return;

  downloadButton.disabled = true;

  try {
    await invoke("start_download_model_task", {
      modelsDir: settings.modelsDir,
      modelName: "tiny.en",
    });
  } catch (error) {
    downloadButton.disabled = false;
    show(`Could not start model download:\n${String(error)}`);
  }
});

transcribeButton.addEventListener("click", async () => {
  if (!settings) return;

  try {
    const files = await invoke<string[] | null>("select_files");

    if (!files || files.length === 0) {
      return;
    }

    const filePath = files[0];

    show(`Inspecting:\n${filePath}`);

    const metadata = await invoke<FileMetadata>("probe_media_file", {
      filePath,
    });

    if (!metadata.exists) {
      throw new Error("Selected file does not exist.");
    }

    settings.inputFile = filePath;
    settings.selectedBackend = "CUDA";
    settings.modelPath = "ggml-tiny.en.bin";
    settings.outputTxt = true;
    settings.outputSrt = false;
    settings.vad = false;

    await invoke("save_settings", { settings });

    show(
        [
          "Media ready.",
          "",
          `File: ${metadata.name}`,
          `Type: ${metadata.format}`,
          `Size: ${metadata.size}`,
          `Duration: ${metadata.durationSec.toFixed(1)} seconds`,
          "",
          "Converting to 16 kHz WAV...",
        ].join("\n"),
    );

    const wavPath = await invoke<string>("convert_media_file", {
      filePath,
    });

    show(
        [
          "WAV conversion complete.",
          "",
          wavPath,
          "",
          "Starting CUDA transcription...",
        ].join("\n"),
    );

    const result = await invoke<TranscriptionResult>(
        "start_transcription_task",
        {
          settings,
          wavPath,
          durationSec: metadata.durationSec || 60,
        },
    );

    show(
        [
          "TRANSCRIPTION COMPLETE ✓",
          "",
          `Backend: CUDA`,
          `Time: ${(result.durationMs / 1000).toFixed(2)} seconds`,
          `Speed: ${result.speedFactor.toFixed(2)}x realtime`,
          `Output directory: ${result.outputDir}`,
          "",
          "Generated files:",
          ...result.generatedFiles.map((file) => `  ${file}`),
        ].join("\n"),
    );
  } catch (error) {
    show(`Transcription failed:\n${String(error)}`);
  }
});

initialize().catch((error) => {
  show(`Initialization failed:\n${String(error)}`);
});