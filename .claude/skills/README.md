# Project skills

`deploy` and `ticket` are written for this repo. The rest are third-party:

| Skill | Source | Licence |
| --- | --- | --- |
| `grill-me`, `grilling` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT (`LICENSE` in each folder) |
| `security-review` | [getsentry/skills](https://github.com/getsentry/skills) | Apache-2.0; OWASP-derived references CC BY-SA 4.0 (`security-review/LICENSE`) |

`near-dapp` and `near-intents` come from [near/agent-skills](https://github.com/near/agent-skills), which has no
licence, so they are not committed here. Install them locally:

```bash
npx skills add near/agent-skills --skill near-dapp -a claude-code
npx skills add near/agent-skills --skill near-intents -a claude-code
```
