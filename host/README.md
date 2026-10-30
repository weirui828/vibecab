# VibeCab host

`@vibecab/host` manages one engine process for a workspace. CLI, app and MCP relay clients use the same host and local HTTP endpoints. The host stores only endpoint metadata in `.vibecab/server.json`; app and CLI credentials stay in the OS keychain.

For end-to-end tests, set `VIBECAB_DEV=1` and run `vibecab-host serve --workspace <dir> --fake-provider <script.json>`. Scripts contain a `defaultSequence` array, with one array of gateway events per model call:

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
