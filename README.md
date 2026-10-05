# MoST Dashboard Frontend

Frontend dashboard for visualizing experiment data served by MoST-API.

## Features

- Header with LLM name and GPU used (fetched from API)
- Experiment list on the left with selection highlight
- Per-experiment ZIP download including only `results.csv` files, preserving iteration folder structure
- Two formats behind the download icon of the Experiments Matrix / Additive Experiments header, which opens a small menu (`aria-haspopup="menu"`, closed on an outside click, on `Escape` or after choosing an entry; both entries share the busy state and the download guard): *ZIP (folder structure)* builds `<results source>-iterations-results-csv.zip` in the browser, one `results.csv` per iteration inside `<experiment>/<iteration>/`; *Merged CSV (single file)* downloads `<results source>-iterations-results-merged.csv` from `GET /api/experiments/download/merged-results.csv?resultsScope=...&experiments=...`, one row per iteration with the experiment folder in an `IDENTIFIER` column (e.g. `1-100_1-100`) and the iteration timestamp in a `DATE` column (the first non-empty `Date`/`date`/`Timestamp`/`timestamp`/`created_at` value of the row, else the iteration folder name), followed by the union of the `results.csv` columns so archives stored with different headers still merge into one file. The file is named after the archive folder of the selected results source (e.g. `Experiment_MIT_2026-09-29_10-00-00-iterations-results-merged.csv`), while the live `current` source keeps the generic `matrix-...` prefix. Both entries cover the experiments the panel shows — the interval matrix cells, or the `mix_...` sub-experiments of an additive source, which merge because the explicit `experiments` list is forwarded to the helper (it only skips `mix_...` folders when no list is given) — and are disabled while the panel has no experiments or a download is running.
- `EXPERIMENT_TYPE` from `results.csv` is shown in the Experiments Matrix title, the chart title, and as the prefix of the absolute value of each matrix cell (for example `MST Experiments Matrix`, `MST · 1-100/1-100`, `MST: 256`). When the field is missing from a `results.csv` that has results, it defaults to `MST`; when an experiment has no results, no type is displayed and the titles stay unchanged.
- Additive experiments (`WORKLOAD_MIXES` runs; `Experiment_MIX_*` results sources holding `mix_...` folders) replace the interval matrix with a panel that pairs a vertical list of the sub-experiments of that run with a workload-profile matrix on its right (below the list when the window is narrower than 1200px). Each list row shows the canonical mix and the absolute `LARGEST_TRUE` (prefixed with `EXPERIMENT_TYPE`), reusing the same finished/pending colors as the matrix cells. The matrix draws every input/output combination configured in `VITE_EXPERIMENT_LIST` (the dashboard mirror of the environment `TOKENS_LIST`) and leaves the combinations no mix uses blank; only the cells of the selected mix are highlighted in red with the alpha that mix assigns to them (`0.5`, `0.333333`, `1`), so the selection stays comparable across mixes; selecting a row plots that sub-experiment in the chart and the Iteration Detail table. The panel title becomes `MST Additive Experiments` and the chart title shows the canonical mix instead of the raw folder name. Its download icon downloads every `mix_...` sub-experiment of the run in both formats (ZIP and merged CSV), even though the mixes are not assembled as an interval matrix.
- `MIT/MST results to compare` picker above the additive workload-profile matrix: it lists only the results sources of the experiment type of that run (`Experiment_MIT_*` for an MIT additive source, `Experiment_MST_*` for an MST one, never a `Experiment_MIX_*` source) and keeps the main *Results source* untouched, since it is fetched with its own `/api/experiments?resultsScope=...` calls. With a source selected, every mix gets the additivity metrics of the model, computed against that source instead of the main one: `Sigma` is the largest `LARGEST_TRUE` of the source (finished or not), `sigma(p) = Sigma / MST(p)` per profile, `expected_sigma = Σ alpha(p)·sigma(p)`, `expected_throughput = Sigma / expected_sigma`, `true_sigma = Sigma / true_throughput` (the `LARGEST_TRUE` of the mix) and `distance = (true_throughput - expected_throughput) / expected_throughput` (signed percentage, raw ratio in the tooltip). The four metrics are shown in a block under the matrix for the selected mix and repeated on every list row; a mix whose profiles are not all measured in the comparison source shows `n/a` for the expected values plus the list of the missing profiles.
- Line chart in the center:
	- X axis: iteration count
	- Y axis: requests sent per minute
	- Stage 1 line in blue
	- Stage 2 line in orange
	- Circle node when evaluation is `TRUE`
	- Triangle node when evaluation is `FALSE`
- Tooltip on hover with date, RPM, evaluation, and success rate
- Detail panel on click showing full `results.csv` fields for the selected iteration
- Download buttons for `results.csv` and `results.json` in detail panel
- Warning confirmation before `results.json` download
- Automatic SSH tunnel startup when running `npm run dev`
- Tunnel status strip in the frontend with per-port controls:
	- switch active API source per port
	- restart each tunnel independently
- Per-port experiment run status shown on each API card (green bubble with "Running" when the latest slurm job is active on `squeue`, orange bubble with "Stopped" when it is not)
- Per-card GPU count: each API card calls `GET /api/job-gpu-count?model=MODEL_ID&node=NODE&port=PORT` and shows how many GPUs the model's serving job uses (`GPUs: N`). The model, node and port are resolved from the MoST project `.env` model URL (surfaced by `GET /api/gpu-used`), falling back to the `URL`/`MODEL_USED` columns of the latest `results.csv` when no env URL is available.
- Log viewer at the very bottom of the screen: pressing "View log" shows the last 100 lines of the latest `slurm-*.out` log via `GET /api/experiment-log?lines=100`, with a manual "Reload" button
- GitHub upload of finished results (optional, disabled until `GITHUB_TOKEN` and `GITHUB_REPO` are set): the third entry of the Experiments Matrix / Additive Experiments download menu (`Upload to GitHub (folder structure)`) commits the finished experiments the panel lists, the `Upload` icon next to the per-experiment ZIP icon commits the selected cell or mix, and every API card gets an `Upload results` button that commits every finished experiment found on that port. All three send the same folder-style `results.csv` tree as the ZIP download (`<experiment>/<iteration>/results.csv`), so one upload is exactly one commit, and the commit itself is created by `tunnel-manager.mjs`, which keeps the GitHub token in the server-side `.env` (a `VITE_*` token would be readable by anyone loading the bundle). Only experiments whose latest `results.csv` reports `FINISHED` are uploaded, and re-uploading identical content is detected as a no-op instead of creating an empty commit. The model, host and GPU count that name the folder are read from the live API first and from the `MODEL_USED`, `URL` and `GPU_COUNT` columns of the uploaded results when the serving job can no longer answer (see [Upload Results to GitHub](#upload-results-to-github)).

## Install

```bash
npm install
```

## Configure API Base URL

The dashboard reads API base URL from `VITE_API_BASE_URL`.

Create `.env` from `.env.example` and set your local tunnel target.

```bash
cp .env.example .env
```

Example:

```env
VITE_API_BASE_URL=http://localhost:4000
VITE_TUNNEL_MANAGER_URL=http://localhost:4100
VITE_API_PORTS=4000,4001,4002

REMOTE_TUNNEL_HOST=c03
REMOTE_TUNNEL_USER=
REMOTE_TUNNEL_PORT=4000
REMOTE_TUNNEL_PORTS=4000,4001,4002
REMOTE_TUNNEL_TARGET_HOST=
LOCAL_TUNNEL_BIND=127.0.0.1
TUNNEL_MANAGER_PORT=4100
```

For your command style:

```bash
ssh -L 4000:c03:4000 matbwyler@172.16.46.6
```

Use:

```env
REMOTE_TUNNEL_HOST=c03
REMOTE_TUNNEL_USER=matbwyler@172.16.46.6
REMOTE_TUNNEL_PORT=4000
REMOTE_TUNNEL_TARGET_HOST=
```

Alternatively, split user and gateway:

```env
REMOTE_TUNNEL_HOST=c03
REMOTE_TUNNEL_USER=matbwyler
REMOTE_TUNNEL_GATEWAY=172.16.46.6
REMOTE_TUNNEL_PORT=4000
```

## Automatic Tunnel Manager

`npm run dev` now starts two local processes:

- Vite frontend server
- `tunnel-manager.mjs`, which creates and monitors the SSH tunnel

The manager exposes:

- `GET /status` to report all configured tunnels and API reachability
- `GET /status/:port` to report a single tunnel
- `POST /restart` with optional JSON body `{ "port": 4001 }` to restart one tunnel
- `POST /restart/:port` to restart one tunnel
- `GET /github/status` to report whether a GitHub token and repository are configured
- `POST /github/upload` to commit one upload (see *Upload Results to GitHub*)

The dashboard calls these endpoints to show per-port status, switch API view across ports, restart each tunnel from the UI, and commit finished results to GitHub.

## Upload Results to GitHub

The three upload entry points commit finished `results.csv` files to a results repository, one commit per upload:

```text
<GITHUB_RESULTS_PATH>/<model>-<gpuType>-<N>gpus/<experiment>/<sub-experiment>/<iteration>/results.csv
```

The `<experiment>` level names the experiment the results belong to: the results source the files were read from, which is the archive folder of a finished run (`Experiment_<EXPERIMENT_TYPE>_<timestamp>` / `Experiment_MIX_<EXPERIMENT_TYPE>_<timestamp>`, for example `Experiment_MIT_2026-09-29_10-00-00`). It is what keeps the sub-experiments of two runs apart, because two archives normally reuse the same cell names (`1-100_1-100`).

- *Upload to GitHub (folder structure)* in the download menu of the Experiments Matrix / Additive Experiments header: every finished sub-experiment of every completed results source of the port the dashboard is connected to, in one commit — all interval matrix cells, or all `mix_...` sub-experiments of the additive runs. The ongoing `current` folder is not part of it: the matrix of a run that is still executing can still change, and the archive that run becomes is uploaded by the next upload once it ends.
- The `Upload` icon next to the per-experiment ZIP icon: every finished sub-experiment of the panel the dashboard is showing at once — all matrix cells, or all `mix_...` sub-experiments of the additive source — read from the selected results source, which names the experiment level of the commit. A sub-experiment that has not finished yet is skipped and reported instead of blocking the rest. The icon is disabled while the panel shows the ongoing `current` results folder: that folder has no archive name yet, so there is nothing to name the experiment after.
- *Upload results* on an API card: every finished sub-experiment of every completed results source of that port, in one commit, whether or not the dashboard is currently viewing that port. The ongoing `current` folder is skipped here as well.

The folder is named after the model, the GPU type of the node that served it and the number of GPUs of the serving job, for example `results/deepseek-ai_DeepSeek-R1-Distill-Qwen-7B-A40-2gpus/Experiment_MST_2026-09-29_10-00-00/1-100_100-300/2026-09-29_10-00-00/results.csv`. The live API answers first: the model and the host it was served on come from the model URL of the MoST project `.env` (`GET /api/gpu-used`) and from the model that is serving (`GET /api/llm-name`), and the count from the serving job (`GET /api/job-gpu-count`, which reads `squeue` and then falls back to the `GPU_COUNT` recorded in the latest `results.csv` of the scope). Whatever those cannot answer is taken from what the uploaded results record about themselves — the `MODEL_USED`, `URL` and `GPU_COUNT` columns of the `results.csv` files being committed, an extra request that is only made when a live value is missing — so an archive whose serving job has already ended is still filed under the folder of the run that produced it instead of prompting for a count. A recorded value never overrides one the live API could answer. The GPU type is resolved from that host through `GPU_TYPE_MAP`; if the host is not mapped, or if the GPU count is unknown to every source, the dashboard asks for it (once per port per session) instead of guessing.

Every level of that layout is length-capped before the commit, because a folder name longer than 255 bytes cannot be checked out on the filesystems the repository is cloned on (`File name too long` on ext4/APFS/NTFS) and a path longer than ~260 characters breaks `git clone` on Windows (Git for Windows ships `core.longpaths=false`). The caps are 48 characters for the model part of `<model>-<gpuType>-<N>gpus`, 16 for the GPU type, 56 for the experiment (archive) level, 48 for the sub-experiment and 32 for the iteration level. A name that fits is committed exactly as it is; a longer one keeps its readable head plus `-<8 hex digits>` of a SHA-256 digest of the full name, so a long `mix_...` name (one entry per configured profile) becomes `mix_1-100:1-100,0.5_300-600:100-300,0-a69e419a`. That digest is what preserves the identity of the experiment, the sub-experiment and the iteration, and because the trimming is deterministic the same results always land in the same folders: folders created by earlier uploads keep their spelling, so re-uploading them still creates no commit. Archive and iteration folders keep their trailing `<timestamp>` behind the digest (`Experiment_MIX_MST_<head>-7c41d0ab_2026-09-29_10-00-00`), the whole path is held under 200 characters by lowering the caps of the deepest levels (down to floors of 40 characters for the experiment, 36 for the sub-experiment and 24 for the iteration) when the model/GPU folder is already long, and two different names that would nevertheless trim to the same folder are refused with an error instead of silently merging two experiments. The dashboard notice says how many names were shortened, and `tunnel-manager.mjs` logs `<trimmed> (was <full name>)` for each of them, which is where a folder found in the repository maps back to the run it came from.

Configure it in `.env` (these values are read by `tunnel-manager.mjs`, not by the browser):

```env
GITHUB_TOKEN=github_pat_...
GITHUB_REPO=owner/results-repository
GITHUB_BRANCH=main
GITHUB_RESULTS_PATH=results
GPU_TYPE_MAP=A30:gpu01:gpu02,A40:gpu03:gpu04:gpu05:gpu06,A100:gpu07:gpu08
```

- `GITHUB_TOKEN`: fine-grained personal access token with *Contents: Read and write* on that repository only. Keep it out of `VITE_*` variables.
- `GITHUB_REPO`: `owner/repository`. A full `https://github.com/owner/repository` URL is also accepted.
- `GITHUB_BRANCH`: created from the first upload when it does not exist yet.
- `GITHUB_RESULTS_PATH`: folder holding the uploads. Leave it empty to commit at the repository root.
- `GITHUB_API_BASE_URL`: GitHub Enterprise API base URL (`https://github.example.com/api/v3`), optional.
- `GPU_TYPE_MAP`: `type:node:node,...` mapping of the cluster nodes to their GPU type.

Uploads are disabled (with the reason in the tooltip) while `GITHUB_TOKEN` or `GITHUB_REPO` are missing, and only experiments whose latest `results.csv` reports `FINISHED` are uploaded, and only from a results source that already ended (an `Experiment_*` archive; the matrix icon additionally requires the panel to show such an archive and is disabled while the ongoing `current` folder is selected, because that folder has no archive name yet). Every upload names the experiment level after the archive it read, so the iterations of `1-100_100-300` of two runs land in two different experiment folders — `results/<model>-<gpuType>-<N>gpus/<archive>/1-100_100-300/<iteration>/results.csv` — in chronological order within each one, and a commit that sweeps several archives writes one experiment folder per archive. Every experiment of a port is uploaded under the folder of the model/GPU the port serves *now*, so an experiment left behind by an earlier model on the same port is placed under the current model folder. Sweeping a long history into one commit is bounded by the uploader limits (`MAX_UPLOAD_FILES` / `MAX_UPLOAD_TOTAL_BYTES`, 5000 files / 64 MB per commit): a history larger than that is rejected and has to be uploaded in smaller steps. Identical content produces no commit: the button reports that the repository already has those results.

## Manual SSH Tunnel Example (optional)

If MoST-API runs on remote HPC and exposes port `4000` remotely:

```bash
ssh -N -L 4000:127.0.0.1:4000 your_user@your_hpc_host
```

Then run this frontend locally and keep `VITE_API_BASE_URL=http://localhost:4000`.

## Development

```bash
npm run dev
```

## Production Build

```bash
npm run build
npm run preview
```

## Deploy on an External Machine

The frontend is a static Vite build. The machine hosting it must also be able to
reach the MoST-API, either directly or through the SSH tunnel manager. Run these
commands on the external machine:

```bash
npm ci
npm run build
npm start
```

The dashboard is built with the public base path `/MoST-dashboard/`. `npm start`
listens on the internal application port `4173`; that port is not part of the
public URL when a reverse proxy is configured.

The public URL is:

```text
https://YOUR_DOMAIN/MoST-dashboard
```

The reverse proxy redirects `/MoST-dashboard` to `/MoST-dashboard/` so the
browser receives the canonical path. A complete Nginx example is provided at
[`deploy/nginx.conf.example`](deploy/nginx.conf.example). Install it on the
public machine, replace `YOUR_DOMAIN`, and set the TLS certificate paths. The
locations must be inside the HTTPS virtual host (`listen 443 ssl`), because the
public URL uses HTTPS. Then validate and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Do not expose port `4173` directly; it is only the upstream port used by Nginx.
After changing the public path or environment values, run `npm run build` again.

Before `npm run build`, create `.env` on that machine. The tunnel manager also
reads this file when `npm run dev:tunnel` starts, so keep the SSH settings there:

```env
VITE_API_BASE_URL=http://127.0.0.1:4000
VITE_API_PROXY_PATH=/most-api
VITE_TUNNEL_MANAGER_URL=/most-tunnel
VITE_API_PORTS=4000,4001,4002

REMOTE_TUNNEL_HOST=c06
REMOTE_TUNNEL_USER=matbwyler@172.16.46.6
REMOTE_TUNNEL_PORTS=4000,4001,4002
LOCAL_TUNNEL_BIND=127.0.0.1
TUNNEL_MANAGER_BIND=127.0.0.1
TUNNEL_MANAGER_PORT=4100
```

With that configuration, users access only:

```text
https://YOUR_DOMAIN/MoST-dashboard/
```

The SSH tunnels are created by `npm run dev:tunnel` on the public machine, not
by users' computers. Run it as a service alongside `npm start`, and ensure the
machine's SSH key can authenticate to the gateway without an interactive
terminal prompt.

Do not use `npm run dev` for this deployment: it starts the development server
and the SSH tunnel manager together, and the `-k` behavior stops both when SSH
fails. Use `npm run dev:web` for frontend-only local troubleshooting, or run
`npm run dev:tunnel` separately to diagnose SSH authentication, host, and port
forwarding problems.
