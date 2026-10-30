# VibeCab CLI

Install the workspace package after `pnpm build` to use the `vibecab` binary. The default workspace is the current directory; pass `--workspace <directory>` to select another one.

```sh
vibecab start [--workspace <directory>]
vibecab stop [--workspace <directory>]
vibecab status [--workspace <directory>]
vibecab cmd vc.ImportContent --json payload.json
vibecab query vc.Artifact --args '{"artifactId":"..."}'
vibecab events --follow --after 0
vibecab blob put image.png --media-type image/png
vibecab blob get <sha256> --output image.png
vibecab export --artifact <id> --format markdown
vibecab backup
vibecab restore-backup <archive> --destination <empty-directory>
vibecab purge --kind artifact --id <id> [--yes]
vibecab tokens create --name "MCP read" --channel mcp --scope read
vibecab tokens list
vibecab tokens revoke <token-id>
vibecab keys set <model-alias>
tmr submit --question "Review this proposal" --input proposal.md --preset independent-review --budget 2.00
tmr status <run-id>
tmr report <run-id> [--markdown]
tmr cancel <run-id>
tmr resume <run-id>
```

The CLI uses the `VibeCab/cli` OS keychain entry. `tokens create` prints a token secret once. `purge` without `--yes` returns only its preview. Add `--json` to print JSON for wrapper commands; `cmd` emits JSON and uses its required `--json <file|->` option for the payload.

Exit codes: 0 success; 2 invalid input; 3 unauthenticated; 4 forbidden; 5 not found; 6 conflict, stale base, or locked; 7 budget exceeded or rate limited; 8 unsupported; 9 unavailable or uncertain; 10 internal error.

The tmr binary is included in the same package and uses the same workspace credentials. Submissions run in demo mode unless --mode live is specified. Participant configuration is a JSON array supplied with --participants <file>.
