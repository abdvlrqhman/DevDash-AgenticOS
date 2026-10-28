# Contributing to DevDash

Thanks for helping. DevDash is a self-hosted workspace that hands its members a shell, so changes are reviewed with
security and reliability in mind first, and features second.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened, plus your OS, browser or app version.
- **Features:** open an issue first and describe the problem it solves. Small, focused changes get merged fastest.
- **Security issues:** never in a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Node 24.7 or newer and, for the pre-commit secret scan, [gitleaks](https://github.com/gitleaks/gitleaks).

```sh
cp .env.example .env                    # then set DEVDASH_MASTER_KEY
npm install
git config core.hooksPath .githooks
npm run dev:server & npm run dev:web    # http://localhost:5173
npm run invite -- --email you@example.com --username you --role admin
```

The web app, accounts, projects, tasks and notes work locally. Features that need the host (member agents, terminals,
services, the root helper) need a real install on an Ubuntu 24.04 server; see the README.

The native apps in `apps/shell` build with Tauri 2 and Rust: from that folder, `npm install`, then `npx tauri dev` for
the desktop app (`npx tauri android init` / `npx tauri ios init` first for the phones). CI builds the Windows and Android
apps on every change to `apps/shell`, and the iOS app when its own files change.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one feature or fix per pull request.
3. Add or update tests next to the code (`*.test.ts`, run with Node's test runner).
4. Run the checks:

   ```sh
   npm run typecheck
   npm test
   ```

5. Open a pull request that explains the problem, the change and how you tested it. Include screenshots for UI changes,
   on desktop and phone widths.

## Code style

- **TypeScript everywhere**, run directly by Node (no build step for the server and agent). Node's
  `erasableSyntaxOnly` applies: no enums, namespaces or constructor parameter properties.
- **Read the code around you and match it**: naming, comment style, how errors are reported. Comments explain *why*,
  in plain language.
- **Database changes** are new numbered files in `apps/server/migrations/`; never edit one that has shipped.
- **UI** uses the existing components in `apps/web/src/components` (shadcn/ui on Tailwind CSS). It must work on a
  phone, in the native apps' WebViews and with a keyboard.
- **User-facing text** is short, plain and specific: say what happened and what to do next.
- **Security**: validate input at the edges, keep secrets out of logs and the repository, and run nothing as root that
  doesn't have to be. Root operations go through `deploy/helper`, which validates every argument.

## Commit messages

Use the imperative or a short statement of the outcome, prefixed with the area when it helps:

```
files: share links can have a download limit
```

Explain the reason in the body when it isn't obvious from the change.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
