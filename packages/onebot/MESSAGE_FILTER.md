# Message Filter

SnowLuma can filter and rewrite the OneBot v11 traffic between an account and each connected bot application. This ports the rule model of the standalone OneBotFilter reverse-WebSocket proxy into SnowLuma itself: instead of running a separate middleman process, every network adapter owns a rule set and the filtering happens inside the event and action pipelines.

The typical use case is unchanged: several bot applications share one QQ account, and only some of them should see a given group, user, or message — preventing duplicate replies.

## Scope and semantics

- **Inbound (events)**: only `post_type: message` / `message_sent` events are considered. Notice, request, and meta events always pass.
- **Outbound (actions)**: only `send_msg`, `send_private_msg`, and `send_group_msg` are considered. A blocked action fails with `retcode 100` (`ACTION_FAILED`, wording `blocked by output message filter`) instead of being silently swallowed, so the caller learns immediately.
- **History is never rewritten.** Filtered or rewritten events only affect what adapters deliver. The local message store, logs, and debug stream keep the original QQ content (`get_msg` returns the original). This mirrors the built-in `#sl` swallow behavior.
- Rewrites (prefix replacement, AT removal) are applied to a **clone** of the event; the canonical event object shared across adapters is never mutated, so one adapter's rewrite cannot leak into another's payload.

## Configuration

Rules live in the per-account OneBot config (`config/onebot_<uin>.json`) under `messageFilter` (account-level defaults), and optionally under `networks.*[].messageFilter` (per-adapter override). The WebUI exposes both: 配置 → 通用设置 → 消息过滤（账号默认）, and each network node's 消息过滤 section.

```jsonc
{
    "messageFilter": {
        "userId":       { "mode": "blacklist", "ids": [10001, 10002] },
        "groupId":      { "mode": "on", "ids": [] },
        "message": {
            "mode": "blacklist",
            "filters": ["spam\\d+"],
            "prefix": ["#", "b1"],
            "prefixReplace": "/"
        },
        "privateMessage": { "mode": "default", "filters": [], "prefix": [], "prefixReplace": "" },
        "groupMessage":   { "mode": "whitelist", "filters": ["^!"], "prefix": [], "prefixReplace": "" },
        "outputMessage": { "mode": "blacklist", "filters": ["广告"] },
        "removeAts": ["131415"]
    }
}
```

### Sections

| Section | Applies to | Modes |
| --- | --- | --- |
| `userId` | sender QQ (private and group) | `on`, `off`, `whitelist`, `blacklist` |
| `groupId` | group messages | `on`, `off`, `whitelist`, `blacklist` |
| `message` | base content rules | `on`, `off`, `whitelist`, `blacklist` |
| `privateMessage` | private-chat content | previous + `default` |
| `groupMessage` | group content | previous + `default` |
| `outputMessage` | outgoing send actions | `on`, `off`, `blacklist` |
| `removeAts` | `at` segments to strip | list of QQ number strings |

### Inheritance (`default`)

Per-adapter overrides may set any section to `default`:

- `userId` / `groupId` / `message` / `outputMessage` `default` → inherit the account-level counterpart (or all-pass when the account config omits it).
- `privateMessage` / `groupMessage` `default` → inherit the account-level same-name section; when that is also `default`, inherit the resolved `message` section. Account-level configs treat `default` as `on`.
- A present adapter config **replaces** the account `removeAts` list (an empty list disables removal for that adapter).

### Content matching order

For a message event that survives the id lists, the selected content section (`privateMessage` or `groupMessage`) is evaluated in this order:

1. Configured `at` segments are removed (rewrite).
2. `off` → drop; `on`/empty → pass.
3. `prefix`: if the first text segment starts with a configured prefix, the message passes and the prefix is rewritten to `prefixReplace` (empty removes it). An emptied text segment is dropped from the array.
4. Each `text` segment is tested against every regex (trimmed text, `u` flag):
   - `blacklist`: any match → drop; no match → pass.
   - `whitelist`: any match → pass; no match → drop.

Regexes are validated at save time (WebUI POST and config load); an invalid pattern is rejected with a config-validation error rather than skipped silently at runtime.

### Outbound matching

`outputMessage` extracts the plain text from `params.raw_message`, a string `params.message`, or the concatenated `text` segments of an array `params.message`, then applies the regexes (`off` blocks everything; `blacklist` blocks matches; `on`/empty passes).

## Where filtering runs

- Events: `OneBotNetworkManager.emitEvent` (`packages/onebot/src/network/network-manager.ts`), after message caching and logging, before per-adapter payload shaping. Adapters without rules share one prebuilt payload; each adapter with rules gets its own verdict (drop → skipped with a debug log; rewrite → its own rebuilt payload).
- Actions: `ApiHandler.handle(action, params, sink?, source?)` (`packages/onebot/src/api-handler.ts`). Adapters pass their network name as `source`; internal callers (the `#sl` reply, quick operations, debug tester) pass none and are never blocked.
- Rules are compiled during network reconcile, so a config save hot-reloads them without reconnecting.

## Limitations

- OneBot action responses and non-message events are not filtered.
- Rewrites affect only `message` and `raw_message`; other fields (e.g. sender info) are untouched.
- The engine uses JavaScript `RegExp` (Unicode mode). Lookbehind and named groups work; .NET-only constructs from the original Go proxy do not.
