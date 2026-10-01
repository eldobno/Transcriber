import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type HardwareInfo = {
  os: string;
  architecture: string;

  nvidia_available: boolean;
  gpu_name: string | null;
  driver_version: string | null;
  cuda_version: string | null;

  ffmpeg_available: boolean;
  ffmpeg_version: string | null;
};

async function loadHardwareInfo() {
  const output = document.querySelector<HTMLPreElement>("#output");

  if (!output) return;

  output.textContent = "Detecting hardware...";

  try {
    const info = await invoke<HardwareInfo>("get_hardware_info");

    output.textContent = JSON.stringify(info, null, 2);
  } catch (error) {
    output.textContent = `Hardware detection failed:\n${String(error)}`;
  }
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main>
    <h1>Transcriber</h1>
    <p>Backend diagnostics</p>

    <button id="detect-button">
      Detect Hardware
    </button>

    <pre id="output">Ready.</pre>
  </main>
`;

document
    .querySelector<HTMLButtonElement>("#detect-button")
    ?.addEventListener("click", loadHardwareInfo);