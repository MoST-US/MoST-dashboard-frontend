# MoST Dashboard Frontend

Frontend dashboard for visualizing experiment data served by MoST-API.

## Features

- Header with LLM name and GPU used (fetched from API)
- Experiment list on the left with selection highlight
- Per-experiment ZIP download including only `results.csv` files, preserving iteration folder structure
- `EXPERIMENT_TYPE` from `results.csv` is shown in the Experiments Matrix title, the chart title, and as the prefix of the absolute value of each matrix cell (for example `MST Experiments Matrix`, `MST · 1-100/1-100`, `MST: 256`). When the field is missing from a `results.csv` that has results, it defaults to `MST`; when an experiment has no results, no type is displayed and the titles stay unchanged.
- Additive experiments (`WORKLOAD_MIXES` runs; `Experiment_MIX_*` results sources holding `mix_...` folders) replace the interval matrix with a vertical list of the sub-experiments of that run. Each row shows the canonical mix, the absolute `LARGEST_TRUE` (prefixed with `EXPERIMENT_TYPE`) and its inverse-normalized value, reusing the same finished/pending colors as the matrix cells; selecting a row plots that sub-experiment in the chart and the Iteration Detail table. The panel title becomes `MST Additive Experiments` and the chart title shows the canonical mix instead of the raw folder name.
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

The dashboard calls these endpoints to show per-port status, switch API view across ports, and restart each tunnel from the UI.

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
