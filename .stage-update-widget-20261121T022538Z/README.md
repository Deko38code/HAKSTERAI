# haksterAI

haksterAI is the web app, API server, and universal CLI shell for local/cloud AI agents.

## CLI Install

Install globally from npm:

```bash
npm install -g haksterai
```

Or from the repo:

```bash
git clone https://github.com/Deko38code/HAKSTERAI.git
cd HAKSTERAI
npm install -g .
```

Initialize and configure:

```bash
hakster init                              # interactive setup
hakster config set server http://localhost:3579
hakster config set apiKey hkai_yourkey
hakster health                            # check server connection
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `hakster init` | Interactive setup — server URL + API key |
| `hakster chat` | Interactive AI chat with streaming + tool loop |
| `hakster agent "<prompt>"` | One-shot agent task with full tool loop |
| `hakster models` | List available AI models from all providers |
| `hakster mcp` | List MCP tools (filesystem, nmap, playwright, etc) |
| `hakster ls [path]` | List files in server workspace |
| `hakster download <path>` | Download a file from the server |
| `hakster health` | Check if server is online |
| `hakster status` | Show CLI config and connection status |
| `hakster guardian <cmd>` | Run Guardian pentest commands (scan, recon, report) |
| `hakster config set <key> <val>` | Set config value |
| `hakster config get <key>` | Get config value |
| `hakster config list` | List all config |

## 🚀 Project Structure

## 🔐 Guardian Integration

The `hakster guardian` command requires the **Guardian** CLI to be installed. Follow these steps to set it up:

```bash
# Clone the repository (if not already present)
git clone https://github.com/zakirkun/guardian-cli.git $HOME/guardian-cli

# Create a virtual environment and install
cd $HOME/guardian-cli && python3 -m venv venv && source venv/bin/activate && pip install -e .
```

The CLI uses the wrapper script at `~/.local/bin/guardian-wrapper` to invoke Guardian. Ensure the wrapper is executable:

```bash
chmod +x ~/.local/bin/guardian-wrapper
```

After installation, you can run:

```bash
hakster guardian scan --target 10.10.10.1
```

to perform a quick scan.



Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
