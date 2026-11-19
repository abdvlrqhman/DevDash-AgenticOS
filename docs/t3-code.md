# T3 Code connection

Choose **T3 Code** in **New session → Agent**. DevDash uses the providers and model accounts configured in that member’s T3 Code instance through its Streamable HTTP MCP integration. T3 keeps the conversation; DevDash stores a transcript for Chat.

Each member needs a separate T3 process running as their own Linux user, with a private data directory and their own provider sign-ins. Shared, root-owned and remote T3 instances are rejected. Before sending credentials, the agent checks the local listener owner and the actual connected peer’s Linux UID. Credentials stay in the member’s private config and are never sent to the browser.

## Administrator setup

Install a trusted T3 executable at `/opt/devdash/t3code/current/t3`, readable and executable by members but writable only by the administrator. The supplied `deploy/systemd/devdash-t3@.service` uses that path; adjust it if your install differs. These examples use the member `alice` and a dedicated unused loopback port, `3781`. Give every member a different port.

```sh
install -m 644 deploy/systemd/devdash-t3@.service /etc/systemd/system/devdash-t3@.service
install -d -m 700 -o alice -g alice /home/alice/.local/share/devdash-t3
install -d -m 700 -o alice -g alice /home/alice/.config/devdash
printf 'DEVDASH_T3_PORT=3781\n' | install -m 600 -o alice -g alice /dev/stdin /home/alice/.config/devdash/t3-service.env
systemctl daemon-reload
systemctl enable --now devdash-t3@alice
```

Configure provider accounts in Alice’s T3 instance. Do not copy another user’s T3 data or credentials. Existing conversations from a shared instance cannot be resumed through the member connection; start new sessions.

Run the connection helper **as Alice**, from an installation directory she can read:

```sh
runuser -u alice -- node /opt/devdash/current/deploy/t3-connect.mjs \
  --t3-bin /opt/devdash/t3code/current/t3 \
  --base-dir /home/alice/.local/share/devdash-t3 \
  --url http://127.0.0.1:3781/mcp \
  --config /home/alice/.config/devdash/t3code.json
```

Use the actual path to your DevDash release in place of `/opt/devdash/current`. The helper requires Node 24.7 or newer. It refuses root/system users, existing destinations, nonprivate directories and listeners owned by another user. It uses T3’s OAuth pairing and PKCE flow and writes a mode-0600 config directly as the member. It prints the expiry, never the token.

The config contains the local `/mcp` URL, bearer token and private T3 base directory. `DEVDASH_T3_CONFIG` overrides its path for tests or custom service configuration. Do not commit it. **Agent setup → T3 Code connection → Refresh connection** reconnects and refreshes provider and model choices. Discovery has a short timeout so an unavailable T3 service does not hold up the other agents.

Credentials currently expire after 30 days. To renew, run the helper with a new output filename, replace the member’s config with that file, and revoke the old DevDash integration session in that member’s T3 settings. A failed save revokes the unused session; temporary pairing credentials are revoked after each attempt. Revoke any previous DevDash credential on a shared/root instance and remove its member config before switching.

T3 0.1.9 requires the `orchestration:read`, `orchestration:operate`, `settings:write` and `source-control:write` scopes for its full-access OAuth grant. These grant access to the member’s entire T3 instance, not one conversation. The Linux user and separate private T3 data directory provide the boundary between members.

## Supported behavior

- Only providers T3 reports enabled, installed and ready appear in setup and model pickers.
- Text Chat, streaming replies, tool activity, saved history, model/effort changes, resuming the same native T3 conversation and stopping a turn.
- **Full access only**, selected explicitly when creating a session. DevDash cannot enforce its approval decisions through this bridge, so Ask and Plan are rejected and permissions cannot be changed later. T3 questions still require a response in the linked T3 conversation.
- The exact folder DevDash selected is registered as a T3 project when needed, without cloning or changing branches. File operations run as that member.
- New sessions may use T3’s default model. Switching an existing conversation requires an explicit model choice; model and effort are validated and applied together.
- Choose a model in **New session** or **Agent setup** to see its **Thinking level** choices. DevDash reads these from T3, including Codex reasoning effort, OpenCode variants and Antigravity thinking levels. **Default** lets the provider choose. In an idle Chat, change the level in session settings or type `/effort` to see the available choices.
- Owners and teammates given full access may send. Watch-only sharing works. Guests and restricted roles cannot execute T3 sessions.
- A DevDash restart does not queue a second “Continue” prompt into an active T3 conversation. Reopening the conversation resumes its existing history.

## Hamasa and Autopilot

In **Hamasa → Settings and access**, choose **T3 Code** and confirm **Full access**. Use the model menu in Hamasa’s chat to choose a provider, model and thinking level. Its schedules inherit those settings and each runs in its own private conversation. Hamasa can use its DevDash tools through a temporary command available during its turn.

In **Autopilot → Settings**, turn on **Include T3 Code sessions** to apply your rules to your full-access T3 Chat sessions. Existing Autopilot settings leave T3 enrollment off until you select it. When T3 asks for a native approval or an answer, open the linked T3 conversation to respond.

The **Supervisor** model is a separate choice. A supervisor reads transcripts and returns decisions with tools disabled. Choose **T3 Code**, then an eligible model and its offered thinking level. DevDash looks for a local T3 OpenCode instance with an absolute executable path in its provider settings. It lists models found in both T3 and OpenCode’s native model catalog, with the thinking levels the native model accepts. Supervisor decisions use OpenCode’s stateless text-generation endpoint. Hamasa and enrolled chats can use any connected T3 provider, including Codex and Antigravity.

Ordinary T3 Chat uses the connections configured in T3. DevDash reserves its workflow commands for Hamasa and enrolled Autopilot turns. Terminal view, attachments, Drive provisioning, tailnet forwarding, Claude fast/remote/advisor features and restricted team roles remain unavailable. Token costs and context percentages are available in T3 Code.

## Verification

Run `npm run typecheck`, `npm test` and `npm run build`. Transport and bridge tests use isolated HTTP MCP fixtures; production credentials and models are unnecessary. Socket-owner tests include refusing root and other-user listeners before any HTTP headers are sent. The connection-helper tests exercise OAuth callback checks, private config writes, refusal to overwrite, and unused credential cleanup with a fake CLI and HTTP server. Positive transport checks must also run as an ordinary Linux member; root processes cannot create T3 connections.
