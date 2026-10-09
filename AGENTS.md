# AGENTS.md

These are the shared baseline instructions for Don's AbaWeather repositories. More specific repository instructions override them.

## Git workflow

- Before changing code, check the current branch and working tree, fetch the remote, and confirm that `main` is current. Pull the latest `main` when it is safe to do so. If local changes or another problem make that unsafe, stop and tell Don before editing.
- Create or switch to a separate test/work branch based on the updated `main`. Never do implementation work directly on `main`.
- Never push changes directly to `main`. Push the test/work branch and create a pull request for review before anything is merged.
- Preserve unrelated local changes and never discard or overwrite them.

## Scope and communication

- Focus only on the specific request. Make the smallest change needed to complete it.
- Ask Don for clarification when an ambiguity could materially change the result.
- Do not fix, refactor, or investigate tangential issues unless they block the requested work. Briefly report them and let Don decide whether to address them.
- Read the relevant repository documentation and nearby code before editing, and preserve the existing architecture and conventions.

## Documentation

- Read `docs/README.md` before changing code. It indexes this repository's architecture, configuration, data and flow documents.
- Update the matching document in `docs/` in the same pull request when a change affects behavior, configuration, data handling or a documented flow.

## Security and verification

- Take a security-first approach. Protect secrets and production data, preserve trust boundaries, validate untrusted input, and do not weaken authentication, App Attest, Cloudflare Worker/D1/KV/QStash, or other security controls.
- Do not deploy, change production data, rotate credentials, or perform destructive operations without Don's explicit approval.
- Run the relevant tests, lint checks, and build checks before handing off. Clearly report what passed, what failed, and what could not be run.
- Summarize the requested change clearly in commits and pull requests, including any meaningful security or behavior impact.
