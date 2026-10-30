# VibeCab host

`@vibecab/host` manages one engine process for a workspace. CLI, app and MCP relay clients use the same host and local HTTP endpoints. The app's HTTP admin token is atomically stored in `.vibecab/app-token` (file mode `0600`, directory mode `0700`). CLI credentials stay in the OS keychain. `.vibecab/server.json` contains endpoint metadata only.

For end-to-end tests, set `VIBECAB_DEV=1` and run `vibecab-host serve --workspace <dir> --fake-provider <script.json>`. Scripts contain a `defaultSequence` array, with one array of gateway events per model call:

Tests can set `VIBECAB_DEV=1 VIBECAB_KEYSTORE=memory` to keep provider keys and host-managed token maps in process memory. The host only honors the memory selection when the development flag is enabled; otherwise it uses the OS keychain.

```json
{
  "defaultSequence": [
    [
      { "type": "output", "json": { "text": "A concise reply." } },
      { "type": "done", "finishReason": "stop" }
    ],
    [
      { "type": "output", "json": { "items": [] } },
      { "type": "done", "finishReason": "stop" }
    ],
    [
      { "type": "output", "json": { "changes": [] } },
      { "type": "done", "finishReason": "stop" }
    ]
  ]
}
```

Configure test models with provider `vibecab-fake`. The host refuses `--fake-provider` unless `VIBECAB_DEV=1`.
